#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { FileTraceSink, SessionRuntime, evaluate, aiSdkReflex, type EvaluationConfiguration } from "@gamebot/core";
import { SnakeGame, foodDistance, legalDirections, wouldCollide, type Direction, type SnakeState } from "./game.js";
import { startViewer } from "./viewer.js";

const watch = process.argv.includes("--watch");
const windowed = process.argv.includes("--window");
const viewer = windowed ? await startViewer() : undefined;
if (viewer) console.log(`Open ${viewer.url} to watch Gamebot play Snake. Press Ctrl+C when finished.`);
const useAi = process.argv.includes("--ai");
const toolDrafts = resolve(".gamebot", "games", "snake", "tools");
await mkdir(toolDrafts, { recursive: true });
const seed = Number(process.argv.find(arg => arg.startsWith("--seed="))?.slice(7) ?? 1);
if (!Number.isSafeInteger(seed)) throw new Error("--seed must be an integer");
const model = useAi ? process.env.GAMEBOT_REFLEX_MODEL ?? process.env.GAMEBOT_MODEL : undefined;
if (useAi && !model) throw new Error("Set GAMEBOT_REFLEX_MODEL or GAMEBOT_MODEL to an AI Gateway model ID");
let lastGame: SnakeGame;
const tokens = { input: 0, output: 0 };

const configuration: EvaluationConfiguration = {
  name: useAi ? "snake-ai" : "snake-heuristic",
  create(seed, record) {
    const game = new SnakeGame(seed);
    lastGame = game;
    if (viewer) void game.observe().then(observation => viewer.publish(observation.state));
    const traceSink = new FileTraceSink(resolve(".gamebot", "traces", `snake-${seed}-${randomUUID()}.jsonl`));
    const runtime = new SessionRuntime<SnakeState, Direction>({
      adapter: game,
      candidates: {
        generate(context) {
          const state = context.observation.state;
          return legalDirections(state).map(direction => ({
            id: direction, action: direction,
            description: `${direction}: ${wouldCollide(state, direction) ? "collision" : "safe"}, food distance ${foodDistance(state, direction)}`,
          }));
        },
      },
      reflex: useAi ? aiSdkReflex<SnakeState, Direction>({
        model: model!,
        maxOutputTokens: 96,
        timeoutMs: 15_000,
        render(context, candidates) {
          return JSON.stringify({
            goal: context.authority.goal.description,
            board: context.observation.state.board,
            direction: context.observation.state.direction,
            foodEaten: context.observation.state.foodEaten,
            candidates: candidates.map(({ id, description }) => ({ id, description })),
          });
        },
        onCall(report) {
          tokens.input += report.usage.inputTokens ?? 0;
          tokens.output += report.usage.outputTokens ?? 0;
        },
      }) : {
        choose(context, candidates) {
          const state = context.observation.state;
          return [...candidates].sort((a, b) =>
            Number(wouldCollide(state, a.action)) - Number(wouldCollide(state, b.action)) ||
            foodDistance(state, a.action) - foodDistance(state, b.action))[0]!.id;
        },
      },
      verifier: {
        verify({ before, after, executionError }) {
          if (executionError) return { status: "unknown", reason: String(executionError) };
          if (!after.state.alive) return { status: "failure", reason: "collision" };
          return { status: after.state.foodEaten > before.state.foodEaten ? "success" : "pending" };
        },
      },
      trace: { async record(event) { record(event); await traceSink.record(event); } },
    }, { id: "eat-food", description: "Eat five pieces of food without colliding" });
    return {
      async step() {
        const result = await runtime.step();
        if (viewer) viewer.publish((result.after ?? await game.observe()).state);
        if (watch) {
          const state = (await game.observe()).state;
          console.log(`Tick ${state.tick} · food ${state.foodEaten}/${game.targetFood}\n${state.board}\n`);
          await new Promise(resolve => setTimeout(resolve, 120));
        }
        if (viewer && !watch) await new Promise(resolve => setTimeout(resolve, 120));
      },
      finish: () => runtime.finish(),
      outcome: () => game.outcome(),
      tracePath: traceSink.path,
      ...(model ? { models: { reflex: model }, tokens: () => ({ ...tokens }) } : {}),
    };
  },
};

if (watch) console.log(`Gamebot Snake: @ head, o body, * food.\n${(await new SnakeGame(seed).observe()).state.board}\n`);
const [result] = await evaluate([configuration], [seed], 100);
console.log(JSON.stringify({ result, status: lastGame!.status(), toolDrafts }, null, 2));
if (viewer) await new Promise<void>(resolve => process.once("SIGINT", resolve)).finally(() => viewer.close());
