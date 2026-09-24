#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { FileTraceSink, SessionRuntime, HierarchicalPlayer, PlayerModelRunner, playerModelsFromEnv,
  loadPlayer, learningArgument, openGameWindow, type LearningEvent } from "@gamebot/core";
import { SnakeGame, foodDistance, wouldCollide, type SnakeState, type Direction } from "./game.js";
import { learningSnake } from "./learning.js";
import { startViewer } from "./viewer.js";

const seed = Number(learningArgument("seed") ?? 1);
const turns = Number(learningArgument("turns") ?? learningArgument("steps") ?? 5000);
const pace = Number(learningArgument("pace") ?? 120);
const maxCalls = Number(learningArgument("max-calls") ?? 10000);
if (!Number.isSafeInteger(seed) || !Number.isSafeInteger(turns) || turns < 1 ||
    !Number.isSafeInteger(pace) || pace < 0 || !Number.isSafeInteger(maxCalls) || maxCalls < 1) {
  throw new Error("Invalid --seed, --turns, --pace or --max-calls");
}
const definition = learningSnake(Number(learningArgument("target") ?? 5));
const selection = learningArgument("policy");
if (selection !== undefined && process.argv.includes("--ai")) throw new Error("Use either --ai or --policy");
const builtin = selection === "builtin";
const policy = selection === undefined || builtin ? undefined : await loadPlayer(selection, definition);
const modelConfig = builtin ? undefined : playerModelsFromEnv();
const watch = process.argv.includes("--watch");
const verbose = process.argv.includes("--verbose");
const viewer = process.argv.includes("--headless") ? undefined : await startViewer();
const game = new SnakeGame(seed, Number(learningArgument("target") ?? 5));
const trace = new FileTraceSink(resolve(".gamebot", "traces", `snake-${seed}-${randomUUID()}.jsonl`));
let session: SessionRuntime<SnakeState, Direction>;
let steps = 0;
const report = async (event: LearningEvent) => {
  await trace.record({ sequence: steps + 1, time: new Date().toISOString(), type: event.type,
    authority: session?.getAuthority() ?? { goal: definition.goal, goalRevision: 1, directiveRevision: 0 }, detail: event.detail });
  if (verbose) console.log(`[${event.type}] ${JSON.stringify(event.detail)}`);
};
const models = modelConfig ? new PlayerModelRunner(modelConfig, maxCalls, report) : undefined;
session = new SessionRuntime({
  adapter: game, candidates: definition.candidates, verifier: definition.verifier,
  reflex: builtin ? {
    choose(context, candidates) {
      return [...candidates].sort((a, b) =>
        Number(wouldCollide(context.observation.state, a.action)) - Number(wouldCollide(context.observation.state, b.action)) ||
        foodDistance(context.observation.state, a.action) - foodDistance(context.observation.state, b.action))[0]!.id;
    },
  } : new HierarchicalPlayer({ game: definition, policy, models: models!, report }),
  trace,
}, definition.goal);
let interrupted = false;
let resolveStop!: () => void;
const stopped = new Promise<void>(resolve => { resolveStop = resolve; });
const stop = () => { interrupted = true; session.stop(); resolveStop(); };
process.once("SIGINT", stop);
try {
  if (viewer) {
    console.log(`Watch Gamebot at ${viewer.url}. Ctrl+C stops play and closes the viewer.`);
    openGameWindow(viewer.url);
  }
  console.log(`Player: ${builtin ? "explicit heuristic" : `strategist → tactician → reflex/JEV (${policy?.kind ?? "initial AI"})`}.`);
  let state: SnakeState = (await game.observe()).state;
  viewer?.publish(state);
  while (steps < turns && !definition.outcome(state).done && !interrupted) {
    const result = await session.step();
    state = (result.after ?? await game.observe()).state;
    if (!result.candidate) break;
    steps++;
    viewer?.publish(state);
    if (watch) console.log(`Tick ${state.tick}; food ${state.foodEaten}/${game.targetFood}\n${state.board}\n`);
    if (pace && (viewer || watch)) await delay(pace);
  }
  await session.finish();
  console.log(JSON.stringify({ ...definition.outcome(state), steps, status: interrupted ? "interrupted" : game.status(),
    tracePath: trace.path, modelUsage: models?.usage }, null, 2));
  if (viewer && !interrupted) await stopped;
} catch (error) {
  if (!interrupted) throw error;
} finally {
  await session.finish();
  process.removeListener("SIGINT", stop);
  await viewer?.close();
}
