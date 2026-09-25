import { createReadStream } from "node:fs";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { isDeepStrictEqual } from "node:util";

const usage = "Usage: npm run report -- <run-directory | result.json | checkpoint.json>";

async function readJson(path, optional = false) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if (optional && error.code === "ENOENT") return undefined;
    throw new Error(`${path}: ${error.message}`);
  }
}

const quote = text => `> ${String(text).replaceAll("\n", "\n> ")}`;
const cell = value => String(value ?? "Not recorded").replaceAll("|", "\\|").replaceAll("\n", " ");
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
function code(text, language = "javascript") {
  const fence = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(match => match[0].length + 1)));
  return `${fence}${language}\n${text}\n${fence}`;
}

async function report(input) {
  const directory = (await stat(input)).isDirectory() ? input : dirname(input);
  if (directory !== input && !["result.json", "checkpoint.json"].includes(basename(input))) throw new Error(usage);
  const experiment = await readJson(join(directory, "experiment.json"));
  const checkpoint = await readJson(join(directory, "checkpoint.json"), true);
  const result = await readJson(join(directory, "result.json"), true);
  const live = experiment.mode === "continual-v1";
  const identity = live ? experiment.identity : experiment;
  if (!identity?.game || !identity.goal) throw new Error("The experiment does not contain a game and goal");
  if (!checkpoint && !result) throw new Error("The run has no checkpoint or result yet");

  // A live checkpoint can be newer than result.json after resuming a run.
  let policy = live ? checkpoint?.policy : undefined;
  let artifactName;
  if (!policy && result?.policyPath && (live || checkpoint?.completed !== false)) {
    artifactName = basename(result.policyPath);
    const artifact = await readJson(join(directory, artifactName));
    policy = artifact.policy;
  }
  if (policy && !artifactName) {
    for (const name of (await readdir(directory)).filter(name => /^[a-f0-9]{16}\.json$/.test(name))) {
      const artifact = await readJson(join(directory, name));
      if (isDeepStrictEqual(artifact.policy, policy)) { artifactName = name; break; }
    }
  }

  const lines = [`# ${identity.game}: learned player report`,
    `Generated ${new Date().toISOString()}. Source run:`, code(directory, "text"),
    "## Goal", quote(identity.goal.description),
    "This report reproduces saved plans and evidence without calling a model or executing the saved programs. Recorded model explanations are hypotheses, not proof that the implementation is optimal."];
  if (identity.evaluation?.description) lines.push(`Evaluation: ${identity.evaluation.description}`);
  lines.push("## The saved solution");
  if (policy) {
    lines.push(`Player type: **${policy.kind}**. ${live
      ? checkpoint?.trial ? "This is an active trial, not a validated winner." : "This is the current live player; evidence is observational."
      : "This is the player selected by the completed benchmark."}`,
    "### Strategy", quote(policy.strategy), "### Tactical responsibilities", quote(policy.tactics),
    "### Reflex responsibilities", quote(policy.reflex));
    if (live && checkpoint?.controller) {
      const controller = checkpoint.controller;
      if (controller.strategy && controller.strategy !== policy.strategy) lines.push("### Latest in-game strategy", quote(controller.strategy));
      if (controller.tactic) lines.push("### Latest in-game tactic", quote(controller.tactic));
    }
    lines.push(policy.kind === "code"
      ? "The saved action program chooses moves directly. The observer can still wake the tactical model."
      : policy.kind === "hybrid"
        ? "The action program can choose a move or delegate to Jev. The observer controls when tactical supervision is requested."
        : "Jev selects actions using the strategy and tactic. The observer controls when tactical supervision is requested.");
  } else lines.push("No final player is available. This run may have stopped before initialization or before the benchmark selected its result.");

  const timeline = [], games = [], sources = new Map(), warnings = [];
  let currentGame, lineNumber = 0, pendingLine;
  function eventLine(raw) {
    lineNumber++;
    if (!raw.trim()) return;
    const event = JSON.parse(raw);
    const detail = event.detail?.event ?? event.detail ?? {};
    const source = `runs.jsonl:${lineNumber}${event.time ? `; ${event.time}` : ""}`;
    if (event.type === "player.decision") sources.set(detail.source, (sources.get(detail.source) ?? 0) + 1);
    if (live && event.type === "episode.started") {
      currentGame = { label: `Game ${detail.episode ?? "?"} (start ${games.length + 1})`, steps: 0 };
      games.push(currentGame);
    }
    if (live && event.type === "episode.step" && currentGame) {
      if (detail.action !== undefined) currentGame.steps++;
      if (detail.outcome) {
        currentGame.score = detail.outcome.score;
        currentGame.status = detail.outcome.done ? detail.outcome.won ? "Won" : "Game over" : "Unfinished";
      }
    }
    if (!live && event.type === "episode.completed") games.push({ label: `${detail.set} seed ${detail.seed}; ${detail.policyId}`,
      steps: detail.steps, score: detail.score, status: detail.stopReason });
    const notes = [];
    if (event.type === "player.initialized") {
      notes.push(`Initial strategy: ${detail.policy?.strategy ?? "Not recorded"}`, `Rationale: ${detail.rationale}`);
      if (detail.alternatives?.length) notes.push(`Alternatives: ${detail.alternatives.join("; ")}`);
    }
    if (["learning.proposal", "research.proposal", "research.revision"].includes(event.type)) {
      for (const field of ["diagnosis", "hypothesis", "trialVerdict", "reason", "accepted"]) {
        if (detail[field] !== undefined) notes.push(`${field}: ${detail[field]}`);
      }
      if (detail.alternatives?.length) notes.push(`Alternatives: ${detail.alternatives.join("; ")}`);
      if (detail.policy) notes.push(`Proposed ${detail.policy.kind} strategy: ${detail.policy.strategy}`);
    }
    if (event.type === "strategy.updated") notes.push(`Strategy: ${detail.strategy}`, `Reason: ${detail.reason}`);
    if (["learning.policy-activated", "learning.trial-reviewed", "learning.preflight", "research.preflight"].includes(event.type)) notes.push(JSON.stringify(detail));
    if (event.type === "model.failed") notes.push(`Provider failure (${detail.role}): ${detail.error}. Retrying: ${detail.retry}.`);
    if (event.type === "learning.execution-error" || event.type === "research.interrupted") notes.push(detail.error ?? detail.reason);
    if (notes.length) timeline.push(`### ${event.type} (${source})\n\n${notes.map(quote).join("\n\n")}`);
  }
  // Stream large traces; only an incomplete last record is tolerated after an interrupted write.
  try {
    for await (const line of createInterface({ input: createReadStream(join(directory, "runs.jsonl")), crlfDelay: Infinity })) {
      if (pendingLine !== undefined) eventLine(pendingLine);
      pendingLine = line;
    }
    if (pendingLine !== undefined) {
      try { eventLine(pendingLine); }
      catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        warnings.push(`Skipped incomplete final journal record at line ${lineNumber}.`);
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error(`runs.jsonl near line ${lineNumber}: ${error.message}`);
    warnings.push("No runs.jsonl was available; only saved checkpoint/result evidence is shown.");
  }

  lines.push("## Recorded results");
  const totals = live ? checkpoint ?? result : result;
  if (totals) lines.push(`${live ? "Completed games" : "Evaluated episodes"}: ${totals.episodes ?? "Not recorded"}. Decisions: ${totals.steps ?? "Not recorded"}. Learning reviews: ${totals.reviews ?? "Not recorded"}.`);
  if (live) lines.push("Live play can change policy within a game. These outcomes do not establish a win rate for the final policy. Older journals may omit outcomes; unknown outcomes are not counted as losses. A resumed process can start a new board with the same game number.");
  if (games.length) lines.push(["| Game / evaluation | Decisions | Score | Outcome |", "| --- | ---: | ---: | --- |",
    ...games.map(game => `| ${cell(game.label)} | ${cell(game.steps)} | ${cell(game.score)} | ${cell(game.status)} |`)].join("\n"));
  else lines.push("No per-game results were recorded in the available journal.");
  if (!live && result?.selectedTest) lines.push("### Selected player on held-out games", code(JSON.stringify(result.selectedTest, null, 2), "json"));
  if (sources.size) lines.push(`Recorded decision sources: ${[...sources].map(([source, count]) => `${source}: ${count}`).join("; ")}.`);
  const modelUsage = checkpoint?.usage ?? result?.usage;
  if (modelUsage) {
    lines.push("### Model usage", ["| Role / model | Calls | Input tokens | Output tokens | Failures |", "| --- | ---: | ---: | ---: | ---: |",
      ...Object.entries(modelUsage.roles ?? {}).map(([role, item]) => `| ${cell(role)} / ${cell(identity.models?.[role])} | ${cell(item.calls)} | ${cell(item.inputTokens)} | ${cell(item.outputTokens)} | ${cell(item.failures)} |`)].join("\n"));
  }
  if (warnings.length) lines.push(...warnings);
  lines.push("## How the strategy evolved", ...(timeline.length ? timeline : ["No strategy revisions were recorded in the available journal."]));
  if (policy) {
    lines.push("## Exact saved programs", "These are the executable policy and monitoring sources, not newly generated suggestions.");
    if (policy.code) lines.push("### Action selection", code(policy.code));
    if (policy.jev) lines.push("### Jev question preparation", code(policy.jev.prepare), "### Jev answer selection", code(policy.jev.select));
    if (policy.observer) lines.push("### Saved observer", code(policy.observer));
    if (live && checkpoint?.controller?.observer && checkpoint.controller.observer !== policy.observer) {
      lines.push("### Latest in-game observer", "This controller update is in the checkpoint, not in the replay artifact.", code(checkpoint.controller.observer));
    }
    if (artifactName) lines.push("## Replay this player", "Run from your GameBot checkout. Add the same bridge settings and goal/target options used for this run. `--no-learn` freezes policy revisions; models can still make tactical decisions.",
      code(`npm run game -- --game=${shellQuote(identity.game)} --policy=${shellQuote(join(directory, artifactName))} --no-learn`, "bash"),
      "Replay starts from the saved policy; transient in-game strategy/tactic updates belong to the checkpoint.");
  }
  lines.push("## Source files", ["[Experiment](experiment.json)",
    ...(lineNumber ? ["[Journal](runs.jsonl)"] : []),
    ...(checkpoint ? ["[Checkpoint](checkpoint.json)"] : []),
    ...(result ? ["[Result](result.json)"] : [])].join(" · "));
  const output = join(directory, "report.md");
  await writeFile(output, lines.join("\n\n") + "\n");
  console.log(`Report written to ${output}`);
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
  console.log(`${usage}\nWrites report.md beside the saved run. No models, game, or build required.`);
} else {
  try {
    if (args.length !== 1) throw new Error(usage);
    await report(resolve(args[0]));
  } catch (error) {
    console.error(`Report failed: ${error.message}`);
    process.exitCode = 1;
  }
}
