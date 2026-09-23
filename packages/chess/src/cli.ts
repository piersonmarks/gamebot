#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { FileTraceSink, SessionRuntime, evaluate, aiSdkReflex, type EvaluationConfiguration } from "@gamebot/core";
import { ChessGame, type ChessState } from "./game.js";

const watch = process.argv.includes("--watch");
const useAi = process.argv.includes("--ai");
const toolDrafts = resolve(".gamebot", "games", "chess", "tools");
await mkdir(toolDrafts, { recursive: true });
const seed = Number(process.argv.find(arg => arg.startsWith("--seed="))?.slice(7) ?? 1);
if (!Number.isSafeInteger(seed)) throw new Error("--seed must be an integer");
const model = useAi ? process.env.GAMEBOT_REFLEX_MODEL ?? process.env.GAMEBOT_MODEL : undefined;
if (useAi && !model) throw new Error("Set GAMEBOT_REFLEX_MODEL or GAMEBOT_MODEL to an AI Gateway model ID");
let lastGame: ChessGame;
const tokens = { input: 0, output: 0 };

const configuration: EvaluationConfiguration = {
  name: useAi ? "chess-ai" : "chess-heuristic",
  create(seed, record) {
    const game = new ChessGame(seed);
    lastGame = game;
    const traceSink = new FileTraceSink(resolve(".gamebot", "traces", `chess-${seed}-${randomUUID()}.jsonl`));
    const runtime = new SessionRuntime<ChessState, string>({
      adapter: game,
      candidates: {
        generate(context) {
          return context.observation.state.legalMoves.map(move => ({
            id: move.id, description: move.san, action: move.id,
          }));
        },
      },
      reflex: useAi ? aiSdkReflex<ChessState, string>({
        model: model!,
        maxOutputTokens: 96,
        timeoutMs: 15_000,
        render(context, candidates) {
          return JSON.stringify({
            goal: context.authority.goal.description,
            fen: context.observation.state.fen,
            board: context.observation.state.board,
            recentMoves: context.observation.state.recentMoves,
            legalMoves: candidates.map(({ id, description }) => ({ id, san: description })),
          });
        },
        onCall(report) {
          tokens.input += report.usage.inputTokens ?? 0;
          tokens.output += report.usage.outputTokens ?? 0;
        },
      }) : {
        choose(_context, candidates) {
          const score = (san: string) => san.includes("#") ? 100 :
            san.includes("=") ? 20 : san.includes("x") ? 10 : san.includes("+") ? 1 : 0;
          return [...candidates].sort((a, b) => score(b.description) - score(a.description))[0]!.id;
        },
      },
      verifier: {
        verify({ before, after, executionError }) {
          if (executionError) return { status: "unknown", reason: String(executionError) };
          return { status: before.state.fen === after.state.fen ? "failure" : "success" };
        },
      },
      trace: { async record(event) { record(event); await traceSink.record(event); } },
    }, { id: "win-chess", description: "Win as White against the seeded opponent" });
    return {
      async step() {
        await runtime.step();
        if (watch) {
          console.log(`White / Black: ${game.lastTurn}\n${(await game.observe()).state.board}\n`);
          await new Promise(resolve => setTimeout(resolve, 120));
        }
      },
      finish: () => runtime.finish(),
      outcome: () => game.outcome(),
      tracePath: traceSink.path,
      ...(model ? { models: { reflex: model }, tokens: () => ({ ...tokens }) } : {}),
    };
  },
};

if (watch) console.log(`Gamebot plays White against a seeded legal-move opponent.\n${(await new ChessGame(seed).observe()).state.board}\n`);
const [result] = await evaluate([configuration], [seed], 100);
console.log(JSON.stringify({ result, status: lastGame!.status(), toolDrafts }, null, 2));
