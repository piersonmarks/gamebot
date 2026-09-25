#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { FileTraceSink, SessionRuntime, ContinualLearningSession, HierarchicalPlayer, PlayerModelRunner, playerModelsFromEnv,
  loadPlayer, learningArgument, openGameWindow, type LearningEvent, type SessionOptions } from "@gamebot/core";
import { SnakeGame, foodDistance, wouldCollide, type SnakeState, type Direction } from "./game.js";
import { learningSnake } from "./learning.js";
import { startViewer } from "./viewer.js";

if (process.argv.some(arg => /^--learn-(every|ms)(=|$)/.test(arg))) {
  throw new Error("Review schedules were removed; the supervising model decides when to request learning");
}
const seed = Number(learningArgument("seed") ?? 1);
const turns = Number(learningArgument("turns") ?? learningArgument("steps") ?? 5000);
const pace = Number(learningArgument("pace") ?? 120);
const maxCalls = Number(learningArgument("max-calls") ?? 10000);
if (!Number.isSafeInteger(seed) || !Number.isSafeInteger(turns) || turns < 1 ||
    !Number.isSafeInteger(pace) || pace < 1 || !Number.isSafeInteger(maxCalls) || maxCalls < 1) {
  throw new Error("Invalid --seed, --turns, --pace or --max-calls");
}
const definition = learningSnake(Number(learningArgument("target") ?? 5), pace);
const selection = learningArgument("policy");
if (selection !== undefined && process.argv.includes("--ai")) throw new Error("Use either --ai or --policy");
const builtin = selection === "builtin";
const policy = selection === undefined || builtin ? undefined : await loadPlayer(selection, definition);
const modelConfig = builtin ? undefined : playerModelsFromEnv();
const watch = process.argv.includes("--watch");
const verbose = process.argv.includes("--verbose");
const viewer = process.argv.includes("--headless") ? undefined : await startViewer();
const game = new SnakeGame(seed, Number(learningArgument("target") ?? 5), pace, state => viewer?.publish(state));
const trace = new FileTraceSink(resolve(".gamebot", "traces", `snake-${seed}-${randomUUID()}.jsonl`));
let session: SessionRuntime<SnakeState, Direction> | ContinualLearningSession<SnakeState, Direction> | undefined;
let steps = 0;
const report = async (event: LearningEvent) => {
  await trace.record({ sequence: steps + 1, time: new Date().toISOString(), type: event.type,
    authority: session?.getAuthority() ?? { goal: definition.goal, goalRevision: 1, directiveRevision: 0 }, detail: event.detail });
  if (verbose || event.type === "learning.created" || event.type === "learning.saved") console.log(`[${event.type}] ${JSON.stringify(event.detail)}`);
};
const models = modelConfig ? new PlayerModelRunner(modelConfig, maxCalls, report) : undefined;
const sessionOptions: SessionOptions<SnakeState, Direction> = {
  adapter: game, candidates: definition.candidates, verifier: definition.verifier,
  reflex: builtin ? {
    choose(context, candidates) {
      return [...candidates].sort((a, b) =>
        Number(wouldCollide(context.observation.state, a.action)) - Number(wouldCollide(context.observation.state, b.action)) ||
        foodDistance(context.observation.state, a.action) - foodDistance(context.observation.state, b.action))[0]!.id;
    },
  } : new HierarchicalPlayer({ game: definition, policy, models: models!, report }),
  trace,
};
let interrupted = false;
let resolveStop!: () => void;
const stopped = new Promise<void>(resolve => { resolveStop = resolve; });
const controller = new AbortController();
const stop = () => { interrupted = true; controller.abort(); session?.stop(); resolveStop(); };
process.once("SIGINT", stop);
try {
  if (viewer) {
    console.log(`Watch Gamebot at ${viewer.url}. Ctrl+C stops play and closes the viewer.`);
    viewer.publish((await game.observe()).state);
    openGameWindow(viewer.url);
  }
  session = builtin || process.argv.includes("--no-learn") ? new SessionRuntime(sessionOptions, definition.goal)
    : await ContinualLearningSession.open({ game: definition, adapter: game, models: models!, policy, seed,
      signal: controller.signal, trace, report, coldStart: process.argv.includes("--cold-start") });
  console.log(`Player: ${builtin ? "explicit heuristic" : `strategist → tactician → reflex/JEV (${policy?.kind ?? "initial AI"})`}.`);
  let state: SnakeState = (await game.observe()).state;
  viewer?.publish(state);
  while (steps < turns && !definition.outcome(state).done && !interrupted) {
    const result = await session.step();
    state = (await game.observe()).state;
    if (!result.candidate) continue;
    steps++;
    viewer?.publish(state);
    if (watch) console.log(`Tick ${state.tick}; food ${state.foodEaten}/${game.targetFood}\n${state.board}\n`);
  }
  await session.finish();
  state = (await game.observe()).state;
  console.log(JSON.stringify({ ...definition.outcome(state), steps, status: interrupted ? "interrupted" : game.status(),
    tracePath: trace.path, modelUsage: models?.usage }, null, 2));
  if (viewer && !interrupted) await stopped;
} catch (error) {
  if (!interrupted) throw error;
} finally {
  await session?.finish();
  game.dispose();
  process.removeListener("SIGINT", stop);
  await viewer?.close();
}
