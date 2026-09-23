#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, join, dirname, delimiter } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { FileTraceSink, SessionRuntime, aiSdkReflex } from "@gamebot/core";
import { Game2048, previewMove, type Direction, type Game2048State } from "./index.js";

function argument(name: string): string | undefined {
  return process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

const run = promisify(execFile);
const gameDir = argument("game-dir") ?? process.env.GAMEBOT_2048_DIR;
const gameIndex = gameDir ? join(resolve(gameDir), "index.html") : undefined;
if (gameIndex) await access(gameIndex);
const gameUrl = gameIndex ? pathToFileURL(gameIndex).href : "https://classic.play2048.co/";
const toolDrafts = resolve(".gamebot", "games", "2048", "tools");
await mkdir(toolDrafts, { recursive: true });
const steps = Number(argument("steps") ?? 100);
const target = Number(argument("target") ?? 128);
const seed = Number(argument("seed") ?? 1);
if (![steps, target, seed].every(Number.isSafeInteger) || steps < 1 || target < 2) {
  throw new Error("--steps, --target and --seed must be valid positive integers");
}
const headless = process.argv.includes("--headless");
const useAi = process.argv.includes("--ai");
const model = useAi ? process.env.GAMEBOT_REFLEX_MODEL ?? process.env.GAMEBOT_MODEL : undefined;
if (useAi && !model) throw new Error("Set GAMEBOT_REFLEX_MODEL or GAMEBOT_MODEL for --ai");

const browserOptions = {
  headless,
  ...(process.env.GAMEBOT_CHROME ? { executablePath: process.env.GAMEBOT_CHROME } : {}),
};
const browserMissing = (error: unknown) =>
  String(error).includes("Executable doesn't exist") || String(error).includes("is not found at");
let browser;
try {
  browser = await chromium.launch(browserOptions);
} catch (error) {
  if (process.env.GAMEBOT_CHROME || !browserMissing(error)) throw error;
  for (const channel of ["chrome", "msedge"] as const) {
    try {
      browser = await chromium.launch({ headless, channel });
      console.log(`Using installed ${channel === "chrome" ? "Google Chrome" : "Microsoft Edge"}.`);
      break;
    } catch (channelError) {
      if (!browserMissing(channelError)) throw channelError;
    }
  }
  if (!browser) {
    const candidates = process.platform === "darwin"
      ? ["/Applications/Chromium.app/Contents/MacOS/Chromium", join(homedir(), "Applications/Chromium.app/Contents/MacOS/Chromium")]
      : (process.env.PATH ?? "").split(delimiter).filter(Boolean).flatMap(dir => ["chromium", "chromium-browser"].map(name => join(dir, name)));
    for (const candidate of candidates) {
      if (!await access(candidate, constants.X_OK).then(() => true, () => false)) continue;
      browser = await chromium.launch({ headless, executablePath: candidate });
      console.log(`Using installed Chromium at ${candidate}.`);
      break;
    }
  }
  if (!browser) {
    console.log("Installing Playwright Chromium because no installed Chrome or Chromium was found...");
    await run(process.platform === "win32" ? "npx.cmd" : "npx", ["playwright", "install", "chromium"], {
      shell: process.platform === "win32",
    });
    browser = await chromium.launch(browserOptions);
  }
}
let stop = false;
process.once("SIGINT", () => { stop = true; });
try {
  const page = await browser.newPage({ viewport: { width: 760, height: 850 } });
  await page.addInitScript(initialSeed => {
    let randomState = initialSeed >>> 0;
    Math.random = () => ((randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0) / 0x100000000);
  }, seed);
  await page.goto(gameUrl);
  await page.waitForFunction(() => localStorage.getItem("gameState") !== null);

  const game = new Game2048(page);
  const runId = randomUUID();
  const trace = new FileTraceSink(resolve(".gamebot", "traces", `2048-${seed}-${runId}.jsonl`));
  const session = new SessionRuntime<Game2048State, Direction>({
    adapter: game,
    candidates: { generate(context) {
      const board = context.observation.state.board;
      return (["up", "right", "down", "left"] as const).flatMap(direction => {
        const preview = previewMove(board, direction);
        return preview.changed ? [{
          id: direction, action: direction,
          description: `${direction}; immediate merge points ${preview.points}; empty cells ${preview.board.flat().filter(value => value === 0).length}`,
        }] : [];
      });
    } },
    reflex: useAi ? aiSdkReflex<Game2048State, Direction>({
      model: model!,
      maxOutputTokens: 96,
      render(context, candidates) {
        return JSON.stringify({
          goal: context.authority.goal.description,
          board: context.observation.state.board,
          score: context.observation.state.score,
          candidates: candidates.map(({ id, description }) => ({ id, description })),
        });
      },
    }) : { choose(_context, candidates) {
      return [...candidates].sort((a, b) => {
        const score = (direction: Direction) => {
          const preview = previewMove(_context.observation.state.board, direction);
          const empty = preview.board.flat().filter(value => value === 0).length;
          const corner = preview.board[0]![0] === Math.max(...preview.board.flat()) ? 20 : 0;
          return preview.points * 2 + empty * 10 + corner;
        };
        return score(b.action) - score(a.action);
      })[0]!.id;
    } },
    verifier: { verify({ before, after, executionError }) {
      if (executionError) return { status: "failure", reason: String(executionError) };
      return JSON.stringify(after.state.board) !== JSON.stringify(before.state.board)
        ? { status: "success" } : { status: "failure", reason: "board did not change" };
    } },
    trace,
  }, { id: "reach-tile", description: `Reach a ${target} tile in 2048` });

  console.log(`Gamebot controls the separate 2048 window. Seed ${seed}; target ${target}.`);
  let finalState = (await game.observe()).state;
  try {
    for (let step = 0; step < steps && !stop; step++) {
      if (finalState.over || finalState.won || Math.max(...finalState.board.flat()) >= target) break;
      const result = await session.step();
      finalState = (result.after ?? await game.observe()).state;
      if (!result.candidate) break;
      console.log(`Move ${step + 1}: ${result.candidate.id}; score ${finalState.score}; max ${Math.max(...finalState.board.flat())}`);
      await delay(200);
    }
  } finally { await session.finish(); }
  const screenshotPath = headless ? resolve(".gamebot", "screenshots", `2048-${seed}-${runId}.png`) : undefined;
  if (screenshotPath) {
    await delay(500);
    await mkdir(dirname(screenshotPath), { recursive: true });
    await page.screenshot({ path: screenshotPath });
  }
  console.log(JSON.stringify({
    score: finalState.score,
    maxTile: Math.max(...finalState.board.flat()),
    reachedTarget: Math.max(...finalState.board.flat()) >= target,
    over: finalState.over,
    tracePath: trace.path,
    toolDrafts,
    ...(screenshotPath ? { screenshotPath } : {}),
  }, null, 2));
  if (!headless && !stop) {
    console.log("The game window stays open. Press Ctrl+C to close it.");
    await new Promise<void>(resolve => process.once("SIGINT", resolve));
  }
} finally { await browser.close(); }
