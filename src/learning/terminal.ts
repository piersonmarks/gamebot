import { stripVTControlCharacters } from "node:util";
import type { LearningReporter } from "./models.js";

type Detail = Record<string, any>;
const clean = (value: unknown) => stripVTControlCharacters(String(value ?? "")).replace(/[\x00-\x1f\x7f-\x9f\p{Cf}]/gu, " ").trim();
// Conservatively count non-ASCII characters as two cells so wide game text cannot wrap the frame.
function fit(text: string, width: number): string {
  let result = "", used = 0;
  for (const char of text) {
    const cells = char.codePointAt(0)! > 127 ? 2 : 1;
    if (used + cells > width) return [...result].slice(0, -3).join("") + "...";
    result += char; used += cells;
  }
  return result;
}
const duration = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};
const count = (value: number) => value >= 10000 ? `${(value / 1000).toFixed(1)}k` : String(value);

/** Presentation only: consumes receipts, never awaits rendering or changes gameplay. */
export function createLearningTerminal(options: { game: string; mode: "game" | "autoplay"; verbose?: boolean; goal?: string }) {
  const output = process.stdout;
  const enabled = !!output.isTTY && process.env.TERM !== "dumb" && !process.env.CI && !process.argv.includes("--no-tui");
  const plain = learningConsole(options.verbose);
  const startedAt = Date.now();
  let started = false, closed = false, blocked = false, timer: ReturnType<typeof setInterval> | undefined;
  let phase = "Starting", goal = options.goal ?? "", game = 1, decisions = 0, reviews = 0, wins = 0, losses = 0;
  let score: unknown = "-", strategy = "Waiting for the strategist", tactic = "Waiting for the tactician", action = "-";
  let directory = "", trace = "", player = "-";
  const messages: string[] = [];
  const seenModels = new WeakSet<object>();
  const completedGames = new Set<string | number>();
  let attempts = 0;
  const models = new Map(["strategist", "tactician", "reflex"].map(role => [role,
    { name: "", calls: 0, tokens: 0, latency: 0, settled: 0, active: [] as number[] }]));
  const note = (message: unknown) => {
    const text = clean(message);
    if (text) messages.push(`${duration(Date.now() - startedAt)}  ${text}`);
    if (messages.length > 30) messages.splice(0, messages.length - 30);
  };
  const color = (text: string, code: number) => process.env.NO_COLOR !== undefined ? text : `\x1b[${code}m${text}\x1b[0m`;
  function frame() {
    const width = Math.max(10, Math.min(120, (output.columns ?? 80) - 1));
    const height = Math.max(4, (output.rows ?? 24) - 1);
    const line = (text: string) => fit(clean(text), width);
    const lines = [color(line(`GAMEBOT / ${options.game.toUpperCase()} / ${options.mode}    ${duration(Date.now() - startedAt)}`), 36),
      color(line(`${phase} | Game ${game} | ${decisions} decisions | ${reviews} reviews | W ${wins} / L ${losses}`), 1),
      line(`Goal: ${goal || "Resolving goal"}`), line(`Score: ${score} | Last: ${action} | Control: ${player}`), "",
      color(line(width < 65 ? "MODELS / ACTIVITY / CALLS / TOKENS" : `${"MODELS".padEnd(30)} ${"ACTIVITY".padEnd(20)} CALLS / TOKENS`), 36)];
    for (const [role, model] of models) {
      const label = `${role === "strategist" ? "Strategy" : role === "tactician" ? "Tactics" : "Reflex"}${model.name ? ` / ${model.name.split("/").at(-1)}` : ""}`;
      const activity = model.active.length ? `thinking ${duration(Date.now() - model.active[0]!)}`
        : model.settled ? `idle (${Math.round(model.latency / model.settled)}ms avg)` : "idle";
      const row = line(width < 65
        ? `${role.padEnd(11)} ${model.active.length ? `busy ${duration(Date.now() - model.active[0]!)}` : "idle"}  ${model.calls} / ${count(model.tokens)}`
        : `${fit(label, 29).padEnd(30)} ${activity.padEnd(20)} ${model.calls} / ${count(model.tokens)}`);
      lines.push(model.active.length ? color(row, 33) : row);
    }
    lines.push("", color(line("STRATEGY"), 36), line(strategy), color(line("TACTIC"), 36), line(tactic));
    const footer = [line(directory ? `Run: ${directory}` : trace ? `Trace: ${trace}` : "Full evidence is saved in .gamebot"),
      color(line(`Ctrl+C stop | ${options.verbose ? "Verbose events" : "--verbose for details"} | --no-tui for plain logs`), 90)];
    if (height < lines.length + footer.length + 3) {
      return [...lines.slice(0, Math.max(1, height - footer.length)), ...footer].slice(0, height).join("\n");
    }
    lines.push("", color(line("RECENT EVENTS"), 36));
    const available = height - lines.length - footer.length - 1;
    lines.push(...(available > 0 ? messages.slice(-available).map(line) : []));
    while (lines.length < height - footer.length) lines.push("");
    return [...lines, ...footer].join("\n");
  }
  function draw() {
    if (!started || closed || blocked) return;
    blocked = !output.write(`\x1b[H\x1b[J${frame()}`);
  }
  const drained = () => { blocked = false; };
  function restore() {
    if (started) output.write("\x1b[?25h\x1b[?1049l");
    started = false;
  }
  function close() {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
    output.removeListener("resize", draw);
    output.removeListener("drain", drained);
    process.removeListener("exit", restore);
    if (phase === "Stopping") phase = "Interrupted";
    const wasStarted = started;
    restore();
    if (wasStarted) {
      output.write(`${clean(`GameBot ${options.game}: ${phase}. ${decisions} decisions; score ${score}; ${reviews} reviews; W ${wins} / L ${losses}.`)}\n`);
      if (directory) output.write(`Run: ${clean(directory)}\n`);
      if (trace) output.write(`Trace: ${clean(trace)}\n`);
      const error = [...messages].reverse().find(message => message.includes("Error:"));
      if (error) output.write(`${error}\n`);
    }
  }
  const report: LearningReporter = event => {
    if (closed) return;
    if (!enabled) { plain(event); return; }
    const envelope = (event.detail ?? {}) as Detail;
    const detail: Detail = envelope.event ?? envelope;
    if (event.type.startsWith("model.")) {
      if (seenModels.has(detail)) return;
      seenModels.add(detail);
      const model = models.get(detail.role);
      if (model) {
        if (event.type === "model.started") { model.calls++; model.name = clean(detail.model); model.active.push(Date.now()); }
        else if (event.type === "model.completed" || event.type === "model.failed") {
          model.active.shift(); model.settled++; model.latency += detail.latencyMs ?? 0;
          model.tokens += (detail.usage?.inputTokens ?? 0) + (detail.usage?.outputTokens ?? 0);
        }
      }
      if (event.type === "model.failed") note(`Error: ${detail.role} provider: ${detail.error}${detail.retry ? " (retrying)" : ""}`);
      else if (options.verbose) note(`${detail.role}: ${event.type === "model.started" ? "started thinking" : `finished in ${detail.latencyMs}ms`}`);
      return;
    }
    switch (event.type) {
      case "goal.resolved": goal = clean(detail.goal?.description); break;
      case "learning.created": directory = clean(detail.directory); note(`Run ${detail.resumed ? "resumed" : "created"}`); break;
      case "learning.started": case "learning.resumed": goal = clean(detail.goal?.description); break;
      case "episode.started": case "episode.resumed":
        phase = "Playing"; game = detail.episode ?? ++attempts; action = "-";
        score = detail.state?.score ?? detail.state?.foodEaten ?? "-";
        if (detail.strategy) strategy = clean(detail.strategy);
        note(`Game ${game} ${event.type === "episode.resumed" ? "resumed" : "started"}`); break;
      case "episode.step":
        phase = "Playing"; decisions = envelope.seed !== undefined ? decisions + (detail.action === undefined ? 0 : 1) : detail.step ?? decisions;
        action = clean(typeof detail.action === "string" ? detail.action : JSON.stringify(detail.action ?? "-"));
        score = detail.outcome?.score ?? detail.after?.score ?? detail.after?.foodEaten ?? score;
        if (options.verbose) note(`Move ${decisions}: ${action}; score ${score}`);
        break;
      case "player.initialized": strategy = clean(detail.policy?.strategy); tactic = clean(detail.policy?.tactics); player = detail.policy?.kind ?? player; note(`Initial player: ${player}`); break;
      case "player.decision":
        strategy = clean(detail.strategy ?? strategy); tactic = clean(detail.tactic ?? tactic); player = clean(detail.source === "evaluation" ? "reflex" : detail.source); break;
      case "strategy.updated": strategy = clean(detail.strategy); note(`Strategy: ${strategy}`); break;
      case "tactic.updated": tactic = clean(detail.instruction); note(`Tactic: ${tactic}`); break;
      case "supervision.applied": strategy = clean(detail.strategy); tactic = clean(detail.instruction); note(`Review applied: ${tactic}${detail.discardedImmediateAction ? " (stale immediate advice discarded)" : ""}`); break;
      case "supervisor.decision": note(`Supervisor: ${detail.reason} [${detail.review}]`); break;
      case "observer.decision": if (options.verbose && detail.wake) note(`Observer: ${detail.reason}${detail.reviewPending ? " (review already pending)" : ""}`); break;
      case "learning.window": note(`Review requested: ${detail.reason}`); break;
      case "learning.proposal": case "research.proposal": note(`Proposal: ${detail.hypothesis ?? detail.diagnosis ?? "Testing a revision"}`); if (options.verbose && detail.diagnosis) note(detail.diagnosis); break;
      case "learning.policy-activated": note(`Policy activated: ${detail.policyId}`); break;
      case "learning.trial-reviewed": note(detail.retained ? "Trial retained" : "Trial rejected; previous policy restored"); break;
      case "learning.preflight": case "research.preflight": if (!detail.passed) note(`Program check failed: ${detail.error}`); break;
      case "learning.reviewed": reviews = detail.reviews; note(`Review ${reviews} complete: ${detail.diagnosis}`); break;
      case "episode.completed": {
        const outcome = detail.outcome ?? detail;
        score = outcome.score ?? score;
        phase = detail.stopReason === "won" ? "Won" : detail.stopReason === "game-over" ? "Game over" : clean(detail.stopReason);
        const id = detail.episodeId ?? `${envelope.policyId ?? ""}:${envelope.set ?? ""}:${envelope.seed ?? game}`;
        if (!completedGames.has(id)) { completedGames.add(id); if (outcome.won) wins++; else if (detail.stopReason === "game-over") losses++; }
        note(`${phase}: score ${score}; ${detail.steps} decisions`); break;
      }
      case "episode.stopped": phase = clean(detail.stopReason); note(`Stopped: ${phase}`); break;
      case "learning.completed": case "research.completed": phase = detail.interrupted ? "Interrupted" : "Finished"; break;
      case "terminal.stopping": if (["Starting", "Playing"].includes(phase)) phase = "Stopping"; break;
      case "terminal.error": phase = "Failed"; note(`Error: ${detail.message}`); break;
      case "terminal.player": player = clean(detail.source === "evaluation" ? "reflex" : detail.source); break;
      case "terminal.trace": trace = clean(detail.tracePath); break;
      case "terminal.result":
        phase = clean(detail.stopReason ?? detail.status ?? "Finished"); decisions = detail.steps ?? decisions; score = detail.score ?? score; trace = clean(detail.tracePath ?? trace);
        if (detail.done && !completedGames.size) { completedGames.add(game); if (detail.won) wins++; else losses++; }
        break;
      default:
        if (options.verbose && ["supervision.discarded", "learning.execution-error", "research.revision"].includes(event.type)) note(`${event.type}: ${detail.reason ?? detail.error ?? detail.accepted}`);
    }
  };
  return {
    enabled,
    report,
    start() {
      if (!enabled || started || closed) return;
      started = true;
      output.write("\x1b[?1049h\x1b[?25l");
      output.on("resize", draw); output.on("drain", drained); process.once("exit", restore);
      draw(); timer = setInterval(draw, 250); timer.unref();
    },
    log(message: string) { if (enabled) note(message); if (!enabled || !started || closed) console.log(message); },
    close,
  };
}
export function learningConsole(verbose = false): LearningReporter {
  return event => {
    if (event.type === "goal.resolved") {
      const { goal, evaluation } = event.detail as { goal: { description: string }; evaluation: { description: string; efficiency: string } };
      console.log(`Goal: ${goal.description}. Evaluation: ${evaluation.description}. Efficiency priority: ${evaluation.efficiency}.`);
      return;
    }
    if (!verbose && (event.type === "research.proposal" || event.type === "learning.proposal" || event.type === "player.initialized")) {
      const { policy, ...summary } = event.detail as { policy: { kind: string }; [key: string]: unknown };
      console.log(`[${event.type}] ${JSON.stringify({ ...summary, policyKind: policy?.kind ?? "no-change" })}`);
      return;
    }
    if (!verbose && event.type === "learning.window") {
      const item = event.detail as { reason: string; steps: number; progress: number };
      console.log(`[learning.window] ${item.reason}; ${item.steps} decisions; progress ${item.progress}`);
      return;
    }
    if (event.type === "episode.completed") {
      const item = event.detail as { episode?: number; seed?: number; set?: string; stopReason: string;
        score?: number; outcome?: { score: number }; steps: number };
      const label = item.episode === undefined ? `${item.set} seed ${item.seed}` : `Game ${item.episode}`;
      console.log(`${label}: ${item.stopReason}; score ${item.outcome?.score ?? item.score}; ${item.steps} decisions`);
    } else if (event.type.startsWith("research.") || event.type.startsWith("learning.") || event.type === "player.initialized" ||
      verbose && !event.type.startsWith("runtime.") && event.type !== "episode.step") {
      console.log(`[${event.type}] ${JSON.stringify(event.detail)}`);
    }
  };
}

