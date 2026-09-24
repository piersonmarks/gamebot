import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { z } from "zod";
import { SessionRuntime } from "../core/index.js";
import { HierarchicalPlayer, initializePlayer } from "./player.js";
import { ModelBudgetExceeded, PlayerModelRunner, type LearningReporter } from "./models.js";
import { codeContract, latestPlayerPath, loadPlayer, playerPolicySchema, policyId, type LearningGame, type PlayerPolicy } from "./policy.js";

export interface EpisodeResult {
  seed: number;
  won: boolean;
  score: number;
  steps: number;
  stopReason: "won" | "game-over" | "turn-limit" | "error";
  error?: string;
  finalState: unknown;
  trajectory: unknown[];
  elapsedMs: number;
}

export async function playEpisode<State, Action>(game: LearningGame<State, Action>, policy: PlayerPolicy,
  models: PlayerModelRunner, options: { seed: number; maxSteps: number; signal: AbortSignal; report?: LearningReporter }): Promise<EpisodeResult> {
  const adapter = await game.create(options.seed);
  const started = performance.now();
  const runtime = new SessionRuntime({
    adapter, candidates: game.candidates, verifier: game.verifier,
    reflex: new HierarchicalPlayer({ game, policy, models, report: options.report }),
    trace: { record: event => options.report?.({ type: `runtime.${event.type}`, detail: event }) },
  }, game.goal);
  const stop = () => runtime.stop();
  options.signal.addEventListener("abort", stop, { once: true });
  let state = (await adapter.observe()).state;
  let steps = 0;
  let error: string | undefined;
  const trajectory: unknown[] = [];
  try {
    while (steps < options.maxSteps && !game.outcome(state).done) {
      options.signal.throwIfAborted();
      const result = await runtime.step();
      options.signal.throwIfAborted();
      state = (result.after ?? await adapter.observe()).state;
      if (!result.candidate) throw new Error("No action was selected before the episode ended");
      steps++;
      const transition = { step: steps, before: result.before.state, action: result.candidate.action, after: state, verification: result.verification };
      trajectory.push(transition);
      await options.report?.({ type: "episode.step", detail: transition });
      if (result.verification?.status === "unknown") throw new Error(result.verification.reason ?? "Unverified game transition");
      if (result.verification?.status === "failure" && !game.outcome(state).done) throw new Error(result.verification.reason ?? "Action verification failed");
      // Yield so SIGINT can interrupt a fast generated policy too.
      await setImmediate();
    }
  } catch (cause) {
    if (options.signal.aborted || cause instanceof ModelBudgetExceeded) throw cause;
    error = String(cause);
  } finally {
    options.signal.removeEventListener("abort", stop);
    await runtime.finish();
  }
  const outcome = game.outcome(state);
  const sample = trajectory.filter((_, index) => index % Math.max(1, Math.ceil(trajectory.length / 12)) === 0);
  return {
    seed: options.seed, won: !error && outcome.won, score: outcome.score, steps, error,
    stopReason: error ? "error" : outcome.won ? "won" : outcome.done ? "game-over" : "turn-limit",
    finalState: state, trajectory: [...sample, ...trajectory.slice(-12)], elapsedMs: Math.round(performance.now() - started),
  };
}

function metrics(results: EpisodeResult[]) {
  return {
    wins: results.filter(result => result.won).length,
    errors: results.filter(result => result.error).length,
    meanScore: results.reduce((sum, result) => sum + result.score, 0) / results.length,
    meanMs: results.reduce((sum, result) => sum + result.elapsedMs, 0) / results.length,
  };
}
function better(candidate: ReturnType<typeof metrics>, incumbent: ReturnType<typeof metrics>) {
  return candidate.errors === 0 && (incumbent.errors > 0 || candidate.wins > incumbent.wins ||
    candidate.wins === incumbent.wins && candidate.meanScore > incumbent.meanScore);
}

export async function runResearch<State, Action>(options: {
  game: LearningGame<State, Action>; models: PlayerModelRunner; rounds: number; games: number;
  maxSteps: number; firstSeed: number; signal: AbortSignal; policy?: PlayerPolicy; fresh?: boolean;
  /** Isolated experiment: no prior policies/findings and no writes to shared learning state. */
  coldStart?: boolean;
  report?: LearningReporter;
}) {
  const { game, models, signal } = options;
  if (options.coldStart && options.policy) throw new Error("Cold-start experiments cannot use a supplied policy");
  const startEmpty = options.fresh || options.coldStart;
  for (const value of [options.rounds, options.games, options.maxSteps]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("Research rounds, games and turn limits must be positive integers");
  }
  const lastSeed = options.firstSeed + (options.rounds + 2) * options.games;
  if (!Number.isSafeInteger(options.firstSeed) || options.firstSeed < 0 || lastSeed > 0xffffffff) throw new Error("Research seeds must fit in distinct unsigned 32-bit values");
  const directory = resolve(".gamebot", "research", game.id, randomUUID());
  await mkdir(directory, { recursive: true });
  const journal = join(directory, "runs.jsonl");
  const experiment = {
    game: game.id, gameVersion: game.version, rules: game.rules, goal: game.goal,
    coldStart: options.coldStart ?? false, rounds: options.rounds, games: options.games,
    maxSteps: options.maxSteps, firstSeed: options.firstSeed, maxCalls: models.maxCalls,
    models: Object.fromEntries(Object.entries(models.models).map(([role, model]) => [role, typeof model === "string" ? model : model.modelId])),
  };
  await writeFile(join(directory, "experiment.json"), JSON.stringify(experiment, null, 2) + "\n");
  const report: LearningReporter = async event => {
    await appendFile(journal, JSON.stringify({ time: new Date().toISOString(), ...event }) + "\n");
    await options.report?.(event);
  };
  const artifact = (policy: PlayerPolicy) => ({ format: "gamebot-player-v1", gameId: game.id, gameVersion: game.version, goal: game.goal, policy });
  const save = async (policy: PlayerPolicy) => {
    const path = join(directory, `${policyId(policy)}.json`);
    await writeFile(path, JSON.stringify(artifact(policy), null, 2) + "\n");
    return path;
  };
  const seeds = (set: number) => Array.from({ length: options.games }, (_, index) => options.firstSeed + set * options.games + index);
  let episodes = 0;
  let firstWin: { episode: number; policyId: string; set: string; seed: number; steps: number; modelCalls: number } | undefined;
  const evaluate = async (policy: PlayerPolicy, set: string, seedSet: number[]) => {
    const results: EpisodeResult[] = [];
    for (const seed of seedSet) {
      signal.throwIfAborted();
      const result = await playEpisode(game, policy, models, { seed, maxSteps: options.maxSteps, signal,
        report: event => report({ ...event, detail: { policyId: policyId(policy), set, seed, event: event.detail } }),
      });
      results.push(result);
      episodes++;
      if (result.won && !firstWin) {
        firstWin = { episode: episodes, policyId: policyId(policy), set, seed, steps: result.steps, modelCalls: models.usage.calls };
        await report({ type: "research.first-win", detail: firstWin });
      }
      await report({ type: "episode.completed", detail: { policyId: policyId(policy), set, ...result } });
    }
    return { metrics: metrics(results), results };
  };
  let baseline = options.policy;
  if (!baseline && !startEmpty) {
    try { baseline = await loadPlayer("latest", game); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  baseline ??= await initializePlayer(game, await (await game.create(options.firstSeed)).observe(), models, signal, report);
  await save(baseline);
  await report({ type: "research.started", detail: { ...experiment, baseline: policyId(baseline), journal } });
  const historyPath = options.coldStart ? join(directory, "research-history.jsonl")
    : resolve(".gamebot", "games", game.id, "research-history.jsonl");
  let history: unknown[] = [];
  try {
    history = startEmpty ? [] : (await readFile(historyPath, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line))
      .filter(item => item.gameVersion === game.version && item.goal === game.goal.description).slice(-20);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let champion = baseline;
  const initialTrain = await evaluate(champion, "train", seeds(0));
  let championTrain = initialTrain;
  const tried = new Set([policyId(champion)]);
  for (let round = 1; round <= options.rounds; round++) {
    signal.throwIfAborted();
    const proposal = await models.ask("strategist", z.object({
      diagnosis: z.string(), alternatives: z.array(z.string()).min(2).max(5),
      hypothesis: z.string(), policy: playerPolicySchema,
    }), `You are the research strategist improving a three-tier game player. Investigate the gameplay evidence and failures.
Enumerate competing explanations and approaches; propose one executable experiment. You can change strategy, tactical/reflex instructions,
review intervals, or replace AI leaf decisions with generated code or a hybrid. Choose the implementation based on your findings.
Keep the user goal authoritative. Do not assume a win or optimality. Errors, rejected hypotheses and computation cost are evidence.
Avoid repeating tried policies. Only measured performance on fresh matched games can promote a revision.
${codeContract}`, {
      rules: game.rules, goal: game.goal, currentPolicy: champion, training: championTrain,
      history, tried: [...tried], round,
    }, signal);
    const candidate = proposal.policy;
    const id = policyId(candidate);
    await save(candidate);
    await report({ type: "research.proposal", detail: { round, id, ...proposal } });
    let accepted = false;
    let reason = "duplicate";
    let candidateMetrics: ReturnType<typeof metrics> | undefined;
    let errors: string[] = [];
    if (!tried.has(id)) {
      tried.add(id);
      const train = await evaluate(candidate, "train", seeds(0));
      candidateMetrics = train.metrics;
      errors = train.results.flatMap(result => result.error ? [result.error] : []);
      reason = "training";
      if (better(train.metrics, championTrain.metrics)) {
        const previous = await evaluate(champion, "validation", seeds(round));
        const validation = await evaluate(candidate, "validation", seeds(round));
        candidateMetrics = validation.metrics;
        errors = validation.results.flatMap(result => result.error ? [result.error] : []);
        reason = "validation";
        if (better(validation.metrics, previous.metrics)) {
          champion = candidate;
          championTrain = train;
          accepted = true;
        }
      }
    }
    const finding = { gameVersion: game.version, goal: game.goal.description, round, id, hypothesis: proposal.hypothesis,
      diagnosis: proposal.diagnosis, accepted, reason, metrics: candidateMetrics, errors };
    history.push(finding);
    history = history.slice(-20);
    await mkdir(dirname(historyPath), { recursive: true });
    await appendFile(historyPath, JSON.stringify(finding) + "\n");
    await report({ type: "research.revision", detail: finding });
  }
  const baselineTest = await evaluate(baseline, "test", seeds(options.rounds + 1));
  const championTest = policyId(champion) === policyId(baseline) ? baselineTest : await evaluate(champion, "test", seeds(options.rounds + 1));
  const promoted = policyId(champion) !== policyId(baseline) && better(championTest.metrics, baselineTest.metrics);
  const selected = promoted ? champion : baseline;
  const selectedTest = promoted ? championTest : baselineTest;
  await mkdir(dirname(historyPath), { recursive: true });
  await appendFile(historyPath, JSON.stringify({ gameVersion: game.version, goal: game.goal.description,
    id: policyId(champion), selectedId: policyId(selected), accepted: promoted, reason: "final-audit",
    candidateMetrics: championTest.metrics, baselineMetrics: baselineTest.metrics,
  }) + "\n");
  const path = await save(selected);
  signal.throwIfAborted();
  // Only evaluated, error-free policies may become latest. Ordinary play never loads this implicitly.
  if (!options.coldStart && selectedTest.metrics.errors === 0) {
    const latest = latestPlayerPath(game.id);
    await mkdir(dirname(latest), { recursive: true });
    const temporary = `${latest}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(artifact(selected), null, 2) + "\n");
    signal.throwIfAborted();
    await rename(temporary, latest);
  }
  const result = { policyPath: path, policyId: policyId(selected), promoted, coldStart: options.coldStart ?? false,
    episodes, firstWin: firstWin ?? null, initialTrain: initialTrain.metrics, baselineTest: baselineTest.metrics,
    goalReachedOnTest: selectedTest.metrics.errors === 0 && selectedTest.metrics.wins > 0,
    candidateTest: championTest.metrics, selectedTest: selectedTest.metrics, usage: models.usage, journal };
  await writeFile(join(directory, "result.json"), JSON.stringify(result, null, 2) + "\n");
  await report({ type: "research.completed", detail: result });
  return result;
}
