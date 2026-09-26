#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { FileTraceSink, HierarchicalPlayer, PlayerModelRunner, playerModelsFromEnv, runOrdinaryGame,
  createLearningTerminal, loadPlayer, learningArgument, type LearningEvent, type SessionOptions,
  type SessionRuntime, type ContinualLearningSession } from "@gamebot/core";
import { builtinDirection, type PacmanState, type Direction } from "./game.js";
import { learningPacman } from "./learning.js";
import { PacmanSession } from "./session.js";

if (process.argv.some(arg => /^--learn-(every|ms)(=|$)/.test(arg))) {
  throw new Error("Review schedules were removed; the supervising model decides when to request learning");
}
const seed = Number(learningArgument("seed") ?? 1);
const turns = Number(learningArgument("turns") ?? learningArgument("steps") ?? 5000);
const holdMs = Number(learningArgument("hold-ms") ?? 220);
const maxCalls = Number(learningArgument("max-calls") ?? 10000);
if (!Number.isSafeInteger(seed) || !Number.isSafeInteger(turns) || turns < 1 ||
    !Number.isSafeInteger(holdMs) || holdMs < 1 || holdMs > 2000 || !Number.isSafeInteger(maxCalls) || maxCalls < 1) {
  throw new Error("Invalid --seed, --turns, --hold-ms or --max-calls");
}
const world = new PacmanSession(holdMs);
const definition = learningPacman(world);
const selection = learningArgument("policy");
if (selection !== undefined && process.argv.includes("--ai")) throw new Error("Use either --ai or --policy");
const builtin = selection === "builtin";
const policy = selection === undefined || builtin ? undefined : await loadPlayer(selection, definition);
const modelConfig = builtin ? undefined : playerModelsFromEnv();
const watch = process.argv.includes("--watch");
const verbose = process.argv.includes("--verbose");
const headless = process.argv.includes("--headless");
await world.open(headless);
const game = await world.create(seed);
const trace = new FileTraceSink(resolve(".gamebot", "traces", `pacman-${seed}-${randomUUID()}.jsonl`));
let session: SessionRuntime<PacmanState, Direction> | ContinualLearningSession<PacmanState, Direction> | undefined;
let steps = 0;
const report = async (event: LearningEvent) => {
  await trace.record({ sequence: steps + 1, time: new Date().toISOString(), type: event.type,
    authority: session?.getAuthority() ?? { goal: definition.goal, goalRevision: 1, directiveRevision: 0 }, detail: event.detail });
  if (terminal.enabled) terminal.report(event);
  else if (verbose || event.type === "learning.created" || event.type === "learning.saved") console.log(`[${event.type}] ${JSON.stringify(event.detail)}`);
};
const models = modelConfig ? new PlayerModelRunner(modelConfig, maxCalls, report) : undefined;
const sessionOptions: SessionOptions<PacmanState, Direction> = {
  adapter: game, candidates: definition.candidates, verifier: definition.verifier,
  reflex: builtin ? {
    choose(context, candidates) {
      return builtinDirection(context.observation.state, candidates.map(candidate => candidate.action));
    },
  } : new HierarchicalPlayer({ game: definition, policy, models: models!, report }),
  trace,
};
let interrupted = false;
let resolveStop!: () => void;
const stopped = new Promise<void>(resolve => { resolveStop = resolve; });
const terminal = createLearningTerminal({ game: "pacman", mode: "game", goal: definition.goal.description, verbose });
terminal.report({ type: "terminal.trace", detail: { tracePath: trace.path } });
const controller = new AbortController();
const stop = () => { terminal.report({ type: "terminal.stopping", detail: {} }); interrupted = true; controller.abort(); resolveStop(); };
world.onClose = stop;
process.once("SIGINT", stop);
try {
  if (!headless) {
    terminal.log(`Watch Pac-Man at ${world.url}. Arrow keys also control the game. Ctrl+C closes it.`);
  }
  terminal.start();
  await runOrdinaryGame({ game: definition, adapter: game, session: sessionOptions,
    learning: builtin || process.argv.includes("--no-learn") ? undefined : {
      models: models!, policy, seed, coldStart: process.argv.includes("--cold-start"),
    },
    signal: controller.signal, maxSteps: turns, report,
    onSession(current) {
      session = current;
      terminal.report({ type: "terminal.player", detail: { source: builtin ? "heuristic" : policy?.kind ?? "Jev" } });
      terminal.log(`Player: ${builtin ? "explicit heuristic" : `strategist → tactician → reflex/JEV (${policy?.kind ?? "initial AI"})`}.`);
    },
    reportEpisode: event => { if (terminal.enabled) terminal.report(event); },
    afterStep(_result, state, count) {
      steps = count;
      if (watch && !terminal.enabled) console.log(`Tick ${state.tick}; pellets ${state.pelletsRemaining}; lives ${state.lives}\n${state.terrain.join("\n")}\n`);
    },
  });
  const state = (await game.observe()).state;
  const summary = { ...definition.outcome(state), steps, lives: state.lives, pelletsRemaining: state.pelletsRemaining,
    status: interrupted ? "interrupted" : state.won ? "Maze cleared" : state.over ? "Game over" : "Step limit reached",
    tracePath: trace.path, modelUsage: models?.usage };
  if (terminal.enabled) terminal.report({ type: "terminal.result", detail: summary });
  else console.log(JSON.stringify(summary, null, 2));
  if (!headless && !interrupted) await stopped;
} catch (error) {
  if (!interrupted) { terminal.report({ type: "terminal.error", detail: { message: String(error) } }); throw error; }
} finally {
  try {
    process.removeListener("SIGINT", stop);
    await world.close();
  } finally { terminal.close(); }
}
