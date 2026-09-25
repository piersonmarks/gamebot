#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { FileTraceSink, aiSdkVisionExtractor, HierarchicalPlayer, PlayerModelRunner, runOrdinaryGame,
  createLearningTerminal, playerModelsFromEnv, resolveGameGoal, loadPlayer, learningArgument as argument,
  type PlayerPolicy, type TraceEvent, type LearningEvent, type SessionOptions, type SessionRuntime, type ContinualLearningSession } from "@gamebot/core";
import { Game2048, previewMove, type Direction, type Game2048State } from "./index.js";
import { candidates2048, defaultPolicy, policyReflex, policySchema, type Policy2048 } from "./policy.js";
import { learning2048 } from "./learning.js";
import { Browser2048Session } from "./browser.js";

const browser = new Browser2048Session(argument("game-dir"));
const toolDrafts = resolve(".gamebot", "games", "2048", "tools");
await mkdir(toolDrafts, { recursive: true });
if (argument("steps") !== undefined && argument("turns") !== undefined) {
  throw new Error("Use either --turns or --steps, not both");
}
const stepLimit = argument("turns") ?? argument("steps");
const steps = stepLimit === undefined ? undefined : Number(stepLimit);
const target = Number(argument("target") ?? 2048);
if (process.argv.some(arg => /^--learn-(every|ms)(=|$)/.test(arg))) {
  throw new Error("Review schedules were removed; the supervising model decides when to request learning");
}
const seed = Number(argument("seed") ?? 1);
const pace = Number(argument("pace") ?? 200);
const policyPath = argument("policy");
const useAi = process.argv.includes("--ai");
if (useAi && policyPath !== undefined) throw new Error("Use either --ai or --policy, not both");
const definition = learning2048(seed => browser.create(seed, definition.goal.id === "maximize-score"), target, argument("goal"));
let maximizeScore = definition.goal.id === "maximize-score";
if (maximizeScore && argument("target") !== undefined) throw new Error('--target only applies to --goal="win"');
let policy: Policy2048 | undefined;
let learnedPolicy: PlayerPolicy | undefined;
if ((steps !== undefined && (!Number.isSafeInteger(steps) || steps < 1)) ||
    !Number.isSafeInteger(target) || target < 2 || !Number.isSafeInteger(seed) || !Number.isSafeInteger(pace) || pace < 0) {
  throw new Error("--turns/--steps (if provided) and --target must be positive integers; --seed must be an integer; --pace must be a nonnegative integer");
}
const headless = process.argv.includes("--headless");
const verbose = process.argv.includes("--verbose");
const observer = argument("observe") ?? "dom";
if (observer !== "dom" && observer !== "vision") throw new Error("--observe must be dom or vision");
const playerModels = playerModelsFromEnv();
const maxCalls = Number(argument("max-calls") ?? 10000);
if (!Number.isSafeInteger(maxCalls) || maxCalls < 1) throw new Error("--max-calls must be positive");
const visionModel = observer === "vision" ? process.env.GAMEBOT_VISION_MODEL ?? process.env.GAMEBOT_MODEL ?? "google/gemini-3.8-flash" : undefined;
const visionSchema = z.object({
  board: z.array(z.array(z.number().int().nonnegative().refine(value => value === 0 || value >= 2 && Number.isInteger(Math.log2(value)))).length(4)).length(4),
  score: z.number().int().nonnegative(),
  over: z.boolean(),
  won: z.boolean(),
  uncertain: z.boolean(),
});

const terminal = createLearningTerminal({ game: "2048", mode: "game", goal: definition.goal.description, verbose });
let stop = false;
let session: SessionRuntime<Game2048State, Direction> | ContinualLearningSession<Game2048State, Direction> | undefined;
const visionAbort = new AbortController();
let resolveInterrupted!: () => void;
const interrupted = new Promise<void>(resolve => { resolveInterrupted = resolve; });
const onInterrupt = () => {
  if (stop) return;
  stop = true;
  session?.stop();
  visionAbort.abort();
  resolveInterrupted();
  terminal.report({ type: "terminal.stopping", detail: {} });
  terminal.log("Stopping Gamebot...");
};
process.once("SIGINT", onInterrupt);
const setupEvents: LearningEvent[] = [];
const models = new PlayerModelRunner(playerModels, maxCalls, event => { setupEvents.push(event); });
try {
  await resolveGameGoal(definition, models, visionAbort.signal);
  maximizeScore = definition.evaluation?.objective === "score";
  if (maximizeScore && argument("target") !== undefined) throw new Error('--target only applies to achievement goals');
  if (policyPath === "builtin") policy = defaultPolicy;
  else if (policyPath === "latest") {
    try { learnedPolicy = await loadPlayer(policyPath, definition); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (maximizeScore || target !== 2048 || definition.requestedGoal) throw error;
      policy = policySchema.parse(JSON.parse(await readFile(resolve(".gamebot", "games", "2048", "active-policy.json"), "utf8")));
    }
  }
  else if (policyPath !== undefined) {
    if (!policyPath) throw new Error("--policy requires a file path or latest");
    const saved = JSON.parse(await readFile(resolve(policyPath), "utf8"));
    if (saved.format === "gamebot-player-v1" || saved.format === "gamebot-player-v2") learnedPolicy = await loadPlayer(policyPath, definition);
    else policy = policySchema.parse(saved); // Explicit legacy weight-file replay remains supported.
  }
  await browser.open(headless, visionAbort.signal, onInterrupt);
  await browser.create(seed, maximizeScore);
  const page = browser.page;
  terminal.start();

  const visionUsage = { calls: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0 };
  const readVision = visionModel ? aiSdkVisionExtractor({
    model: visionModel,
    schema: visionSchema,
    prompt: "Read the visible 2048 board. Return a 4x4 board from top row to bottom row, left to right, using 0 for empty cells. Read the main score number, ignoring any animated +points label. Set over or won only when the corresponding end-game overlay is visible. Set uncertain to true if any tile or score cannot be read. Do not infer hidden state.",
    timeoutMs: 30_000,
    onCall(report) {
      visionUsage.calls++;
      visionUsage.inputTokens += report.usage.inputTokens ?? 0;
      visionUsage.outputTokens += report.usage.outputTokens ?? 0;
      visionUsage.latencyMs += report.latencyMs;
      if (verbose) terminal.log(`[verbose] vision model ${visionModel}: ${Math.round(report.latencyMs)} ms, ${report.usage.inputTokens ?? 0} input / ${report.usage.outputTokens ?? 0} output tokens`);
    },
  }) : undefined;
  const game = new Game2048(page, readVision ? async () => {
    const { uncertain, ...state } = await readVision(await page.screenshot({ type: "png" }), visionAbort.signal);
    if (uncertain) throw new Error("Vision could not read the 2048 board confidently");
    return state;
  } : undefined, maximizeScore);
  const runId = randomUUID();
  const trace = new FileTraceSink(resolve(".gamebot", "traces", `2048-${seed}-${runId}.jsonl`));
  terminal.report({ type: "terminal.trace", detail: { tracePath: trace.path } });
  const liveTrace = { async record(event: TraceEvent) {
    await trace.record(event);
    if (!terminal.enabled && verbose && event.type !== "observation") {
      console.log(`[verbose] ${event.type}${event.detail === undefined ? "" : `: ${JSON.stringify(event.detail)}`}`);
    }
  } };
  let playerSequence = 0;
  const reportLearning = async (event: LearningEvent) => {
    if (terminal.enabled) terminal.report(event);
    else if (!verbose && (event.type === "learning.created" || event.type === "learning.saved")) console.log(`[${event.type}] ${JSON.stringify(event.detail)}`);
    await liveTrace.record({
    sequence: playerSequence, time: new Date().toISOString(), type: event.type,
    authority: session?.getAuthority() ?? { goal: definition.goal, goalRevision: 1, directiveRevision: 0 },
    detail: event.detail,
    });
  };
  models.report = reportLearning;
  for (const event of setupEvents) await reportLearning(event);
  const sessionOptions: SessionOptions<Game2048State, Direction> = {
    adapter: game,
    candidates: policy ? { generate: candidates2048 } : definition.candidates,
    reflex: policy ? policyReflex(policy, verbose ? ranking => terminal.log(`[verbose] policy ranking: ${JSON.stringify(ranking)}`) : undefined)
      : new HierarchicalPlayer({ game: definition, models: models!, policy: learnedPolicy, report: reportLearning }),
    verifier: { verify({ before, after, candidate, executionError }) {
      if (executionError) return { status: "failure", reason: String(executionError) };
      if (observer === "vision") {
        const preview = previewMove(before.state.board, candidate.action);
        let spawned = 0;
        for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
          const expected = preview.board[y]![x]!;
          const actual = after.state.board[y]![x]!;
          if (actual !== expected) {
            if (expected !== 0 || (actual !== 2 && actual !== 4)) return { status: "unknown", reason: "vision board is not a legal 2048 transition" };
            spawned++;
          }
        }
        if (spawned !== 1 || after.state.score !== before.state.score + preview.points) {
          return { status: "unknown", reason: "vision board or score is inconsistent with the move" };
        }
      }
      return JSON.stringify(after.state.board) !== JSON.stringify(before.state.board)
        ? { status: "success" } : { status: "failure", reason: "board did not change" };
    } },
    trace: liveTrace,
  };
  let finalState: Game2048State | undefined;
  let moves = 0;
  let stopReason = "no-action";
  const played = await runOrdinaryGame({ game: definition, adapter: game, session: sessionOptions,
    learning: policy || process.argv.includes("--no-learn") ? undefined : {
      models, policy: learnedPolicy, seed, coldStart: process.argv.includes("--cold-start"),
    },
    signal: visionAbort.signal, maxSteps: steps, report: reportLearning,
    onSession(current) {
      session = current;
      terminal.log(`Gamebot controls the separate 2048 window. Seed ${seed}; goal: ${definition.goal.description}; turns ${steps ?? "unlimited"}; observer ${observer}${visionModel ? ` (${visionModel})` : ""}.`);
      terminal.log(`Evaluation: ${definition.evaluation?.description}; efficiency priority: ${definition.evaluation?.efficiency}.`);
      terminal.report({ type: "terminal.player", detail: { source: policy ? "heuristic" : learnedPolicy?.kind ?? "Jev" } });
      terminal.log(`Player: ${policy ? "explicit heuristic" : `strategist → tactician → reflex/JEV (${learnedPolicy?.kind ?? "initial AI"})`}.`);
    },
    reportEpisode: terminal.enabled ? event => terminal.report(event) : undefined,
    beforeStep(state, count) {
      if (verbose) terminal.log(`[verbose] turn ${count + 1} board: ${JSON.stringify(state.board)}`);
      playerSequence = count + 1;
    },
    async afterStep(result, state, count) {
      moves = count;
      if (!terminal.enabled) console.log(`Move ${count}: ${result.candidate!.id}; score ${state.score}; max ${Math.max(...state.board.flat())}${observer === "vision" ? `; verification ${result.verification?.status ?? "unknown"}` : ""}`);
      if (observer === "vision" && result.verification?.status !== "success") {
        stopReason = "unverified";
        return "stop";
      }
      if (pace) await delay(pace);
    },
  });
  finalState = played.state;
  moves = played.steps;
  const maxTile = finalState ? Math.max(...finalState.board.flat()) : 0;
  if (stop) stopReason = "interrupted";
  else if (finalState && definition.outcome(finalState).won) stopReason = finalState.won ? "won" : "target-reached";
  else if (finalState?.over) stopReason = "game-over";
  else if (stopReason === "no-action" && steps !== undefined && moves >= steps) stopReason = "step-limit";
  const screenshotPath = headless ? resolve(".gamebot", "screenshots", `2048-${seed}-${runId}.png`) : undefined;
  if (screenshotPath && finalState && !page.isClosed()) {
    await delay(500);
    await mkdir(dirname(screenshotPath), { recursive: true });
    await page.screenshot({ path: screenshotPath });
  }
  const summary = {
    steps: moves,
    goal: definition.goal,
    score: finalState?.score,
    maxTile,
    ...(!maximizeScore ? { reachedTarget: maxTile >= target } : {}),
    over: finalState?.over,
    stopReason,
    tracePath: trace.path,
    toolDrafts,
    ...(models ? { modelUsage: models.usage } : {}),
    ...(visionModel ? { visionUsage } : {}),
    ...(screenshotPath && finalState ? { screenshotPath } : {}),
  };
  if (terminal.enabled) terminal.report({ type: "terminal.result", detail: { ...summary, ...(finalState ? definition.outcome(finalState) : {}) } });
  else console.log(JSON.stringify(summary, null, 2));
  if (!headless && !stop) {
    terminal.log("The game window stays open. Press Ctrl+C to close it.");
    await interrupted;
  }
} catch (error) {
  if (!stop) terminal.report({ type: "terminal.error", detail: { message: String(error) } });
  throw error;
} finally {
  process.removeListener("SIGINT", onInterrupt);
  try { await browser.close(); } finally { terminal.close(); }
}
