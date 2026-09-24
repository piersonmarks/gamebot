#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, join, dirname, delimiter } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { z } from "zod";
import { FileTraceSink, SessionRuntime, aiSdkVisionExtractor, HierarchicalPlayer, PlayerModelRunner,
  playerModelsFromEnv, loadPlayer, type PlayerPolicy, type TraceEvent, type LearningEvent } from "@gamebot/core";
import { Game2048, previewMove, type Direction, type Game2048State } from "./index.js";
import { candidates2048, defaultPolicy, policyReflex, policySchema, type Policy2048 } from "./policy.js";
import { learning2048 } from "./learning.js";

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
if (argument("steps") !== undefined && argument("turns") !== undefined) {
  throw new Error("Use either --turns or --steps, not both");
}
const stepLimit = argument("turns") ?? argument("steps");
const steps = stepLimit === undefined ? undefined : Number(stepLimit);
const target = Number(argument("target") ?? 2048);
const seed = Number(argument("seed") ?? 1);
const pace = Number(argument("pace") ?? 200);
const policyPath = argument("policy");
const useAi = process.argv.includes("--ai");
if (useAi && policyPath !== undefined) throw new Error("Use either --ai or --policy, not both");
const definition = learning2048(target);
let policy: Policy2048 | undefined;
let learnedPolicy: PlayerPolicy | undefined;
if (policyPath === "builtin") policy = defaultPolicy;
else if (policyPath === "latest") {
  try { learnedPolicy = await loadPlayer(policyPath, definition); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    policy = policySchema.parse(JSON.parse(await readFile(resolve(".gamebot", "games", "2048", "active-policy.json"), "utf8")));
  }
}
else if (policyPath !== undefined) {
  if (!policyPath) throw new Error("--policy requires a file path or latest");
  const saved = JSON.parse(await readFile(resolve(policyPath), "utf8"));
  if (saved.format === "gamebot-player-v1") learnedPolicy = await loadPlayer(policyPath, definition);
  else policy = policySchema.parse(saved); // Explicit legacy weight-file replay remains supported.
}
if ((steps !== undefined && (!Number.isSafeInteger(steps) || steps < 1)) ||
    !Number.isSafeInteger(target) || target < 2 || !Number.isSafeInteger(seed) || !Number.isSafeInteger(pace) || pace < 0) {
  throw new Error("--turns/--steps (if provided) and --target must be positive integers; --seed must be an integer; --pace must be a nonnegative integer");
}
const headless = process.argv.includes("--headless");
const verbose = process.argv.includes("--verbose");
const observer = argument("observe") ?? "dom";
if (observer !== "dom" && observer !== "vision") throw new Error("--observe must be dom or vision");
const playerModels = policy ? undefined : playerModelsFromEnv();
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

const browserOptions = {
  headless,
  handleSIGINT: false,
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
      browser = await chromium.launch({ ...browserOptions, channel });
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
      browser = await chromium.launch({ ...browserOptions, executablePath: candidate });
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
let session: SessionRuntime<Game2048State, Direction> | undefined;
const visionAbort = new AbortController();
let resolveInterrupted!: () => void;
const interrupted = new Promise<void>(resolve => { resolveInterrupted = resolve; });
const onInterrupt = () => {
  stop = true;
  session?.stop();
  visionAbort.abort();
  resolveInterrupted();
  console.log("\nStopping Gamebot...");
};
process.once("SIGINT", onInterrupt);
try {
  const page = await browser.newPage({ viewport: { width: 760, height: 850 } });
  await page.addInitScript(initialSeed => {
    let randomState = initialSeed >>> 0;
    Math.random = () => ((randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0) / 0x100000000);
  }, seed);
  await page.goto(gameUrl);
  if (observer === "vision") await page.locator(".tile-container .tile").first().waitFor();
  else await page.waitForFunction(() => localStorage.getItem("gameState") !== null);

  const visionUsage = { calls: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0 };
  const readVision = visionModel ? aiSdkVisionExtractor({
    model: visionModel,
    schema: visionSchema,
    prompt: "Read the visible 2048 board. Return a 4x4 board from top row to bottom row, left to right, using 0 for empty cells. Read the main score number, ignoring any animated +points label. Set over or won only when the corresponding end-game overlay is visible. Set uncertain to true if any tile or score cannot be read. Do not infer hidden state.",
    maxOutputTokens: 512,
    timeoutMs: 30_000,
    onCall(report) {
      visionUsage.calls++;
      visionUsage.inputTokens += report.usage.inputTokens ?? 0;
      visionUsage.outputTokens += report.usage.outputTokens ?? 0;
      visionUsage.latencyMs += report.latencyMs;
      if (verbose) console.log(`[verbose] vision model ${visionModel}: ${Math.round(report.latencyMs)} ms, ${report.usage.inputTokens ?? 0} input / ${report.usage.outputTokens ?? 0} output tokens`);
    },
  }) : undefined;
  const game = new Game2048(page, readVision ? async () => {
    const { uncertain, ...state } = await readVision(await page.screenshot({ type: "png" }), visionAbort.signal);
    if (uncertain) throw new Error("Vision could not read the 2048 board confidently");
    return state;
  } : undefined);
  const runId = randomUUID();
  const trace = new FileTraceSink(resolve(".gamebot", "traces", `2048-${seed}-${runId}.jsonl`));
  const liveTrace = { async record(event: TraceEvent) {
    await trace.record(event);
    if (verbose && event.type !== "observation") {
      console.log(`[verbose] ${event.type}${event.detail === undefined ? "" : `: ${JSON.stringify(event.detail)}`}`);
    }
  } };
  let playerSequence = 0;
  const reportLearning = async (event: LearningEvent) => liveTrace.record({
    sequence: playerSequence, time: new Date().toISOString(), type: event.type,
    authority: session?.getAuthority() ?? { goal: definition.goal, goalRevision: 1, directiveRevision: 0 },
    detail: event.detail,
  });
  const models = playerModels ? new PlayerModelRunner(playerModels, maxCalls, reportLearning) : undefined;
  session = new SessionRuntime<Game2048State, Direction>({
    adapter: game,
    candidates: policy ? { generate: candidates2048 } : definition.candidates,
    reflex: policy ? policyReflex(policy, verbose ? ranking => console.log(`[verbose] policy ranking: ${JSON.stringify(ranking)}`) : undefined)
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
  }, definition.goal);

  console.log(`Gamebot controls the separate 2048 window. Seed ${seed}; target ${target}; turns ${steps ?? "unlimited"}; observer ${observer}${visionModel ? ` (${visionModel})` : ""}.`);
  console.log(`Player: ${policy ? "explicit heuristic" : `strategist → tactician → reflex/JEV (${learnedPolicy?.kind ?? "initial AI"})`}.`);
  let finalState: Game2048State | undefined;
  let moves = 0;
  let stopReason = "no-action";
  try {
    finalState = (await game.observe()).state;
    for (let step = 0; (steps === undefined || step < steps) && !stop; step++) {
      if (finalState.over || finalState.won || Math.max(...finalState.board.flat()) >= target) break;
      if (verbose) console.log(`[verbose] turn ${step + 1} board: ${JSON.stringify(finalState.board)}`);
      playerSequence = step + 1;
      const result = await session.step();
      if (stop) break;
      finalState = (result.after ?? await game.observe()).state;
      if (!result.candidate) break;
      moves++;
      console.log(`Move ${step + 1}: ${result.candidate.id}; score ${finalState.score}; max ${Math.max(...finalState.board.flat())}${observer === "vision" ? `; verification ${result.verification?.status ?? "unknown"}` : ""}`);
      if (observer === "vision" && result.verification?.status !== "success") {
        stopReason = "unverified";
        break;
      }
      if (pace) await delay(pace);
    }
  } catch (error) {
    if (!stop) throw error;
  } finally { await session.finish(); }
  const maxTile = finalState ? Math.max(...finalState.board.flat()) : 0;
  if (stop) stopReason = "interrupted";
  else if (finalState?.won) stopReason = "won";
  else if (finalState?.over) stopReason = "game-over";
  else if (maxTile >= target) stopReason = "target-reached";
  else if (stopReason === "no-action" && steps !== undefined && moves >= steps) stopReason = "step-limit";
  const screenshotPath = headless ? resolve(".gamebot", "screenshots", `2048-${seed}-${runId}.png`) : undefined;
  if (screenshotPath && finalState) {
    await delay(500);
    await mkdir(dirname(screenshotPath), { recursive: true });
    await page.screenshot({ path: screenshotPath });
  }
  console.log(JSON.stringify({
    score: finalState?.score,
    maxTile,
    reachedTarget: maxTile >= target,
    over: finalState?.over,
    stopReason,
    tracePath: trace.path,
    toolDrafts,
    ...(models ? { modelUsage: models.usage } : {}),
    ...(visionModel ? { visionUsage } : {}),
    ...(screenshotPath && finalState ? { screenshotPath } : {}),
  }, null, 2));
  if (!headless && !stop) {
    console.log("The game window stays open. Press Ctrl+C to close it.");
    await interrupted;
  }
} finally {
  process.removeListener("SIGINT", onInterrupt);
  await browser.close();
}
