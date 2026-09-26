import { createLearningTerminal } from "./terminal.js";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolveGameGoal } from "./goal.js";
import { randomInt } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { loadPlayer, type LearningGame } from "./policy.js";
import { PlayerModelRunner, playerModelsFromEnv, type LearningReporter, type LearningEvent } from "./models.js";
import { runContinualLearning } from "./continual.js";
import { runResearch } from "./research.js";
import { openGameWindow, startResearchViewer, type ResearchViewerOptions } from "./viewer.js";

export function learningArgument(name: string): string | undefined {
  const index = process.argv.findIndex(arg => arg === `--${name}` || arg.startsWith(`--${name}=`));
  if (index < 0) return undefined;
  if (process.argv[index] !== `--${name}`) return process.argv[index]!.slice(name.length + 3);
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`--${name} requires a value`);
  return value;
}

export { learningConsole } from "./terminal.js";

/** Bridges with their own game window open it even in headless mode. */
export interface ResearchGameWindow {
  open(options: { headless: boolean; signal: AbortSignal; onClose: () => void; log: (message: string) => void }): Promise<{ close(): Promise<void>; report?: LearningReporter }>;
}

export async function runResearchCli<State, Action>(game: LearningGame<State, Action>, view?: ResearchViewerOptions | ResearchGameWindow): Promise<void> {
  if (process.argv.some(arg => /^--learn-(every|ms)(=|$)/.test(arg))) {
    throw new Error("Review schedules were removed; the supervising model decides when to request learning");
  }
  const terminal = createLearningTerminal({ game: game.id, mode: "autoplay", goal: game.goal.description, verbose: process.argv.includes("--verbose") });
  const controller = new AbortController();
  let resolveStop!: () => void;
  const stopped = new Promise<void>(resolve => { resolveStop = resolve; });
  const stop = () => {
    if (controller.signal.aborted) return;
    terminal.report({ type: "terminal.stopping", detail: {} });
    terminal.log("Stopping research..."); controller.abort(); resolveStop();
  };
  process.once("SIGINT", stop);
  let viewer: Awaited<ReturnType<typeof startResearchViewer>> | undefined;
  let gameWindow: Awaited<ReturnType<ResearchGameWindow["open"]>> | undefined;
  const headless = process.argv.includes("--headless");
  const consoleReport = terminal.report;
  const pace = Number(learningArgument("pace") ?? 200);
  const report: LearningReporter = async event => {
    await consoleReport(event);
    viewer?.report(event);
    await gameWindow?.report?.(event);
    if (!game.realtime && !headless && pace && (event.type === "episode.step" || event.type === "episode.completed")) {
      await delay(pace, undefined, { signal: controller.signal });
    }
  };
  try {
    if (!Number.isSafeInteger(pace) || pace < 0) throw new Error("--pace must be a nonnegative integer in milliseconds");
    if (process.argv.includes("--headless") && process.argv.includes("--watch")) throw new Error("Use either --headless or --watch");
    const resume = learningArgument("resume");
    const saved = resume ? JSON.parse(await readFile(join(resolve(resume), "experiment.json"), "utf8")) : undefined;
    if (resume && ["policy", "fresh", "cold-start"].some(name => process.argv.some(arg => arg === `--${name}` || arg.startsWith(`--${name}=`)))) {
      throw new Error("--resume restores its experiment; do not combine it with --policy, --fresh or --cold-start");
    }
    const selection = learningArgument("policy");
    const coldStart = saved?.coldStart ?? process.argv.includes("--cold-start");
    if (selection !== undefined && (process.argv.includes("--fresh") || coldStart)) throw new Error("--policy cannot be combined with --fresh or --cold-start");
    const models = new PlayerModelRunner(playerModelsFromEnv(), Number(learningArgument("max-calls") ?? saved?.maxCalls ?? 10000), report);
    const setupEvents: LearningEvent[] = [];
    models.report = async event => { setupEvents.push(event); await report(event); };
    const requestedGoal = learningArgument("goal");
    if (requestedGoal !== undefined && game.evaluation?.request !== requestedGoal) game.requestedGoal = requestedGoal;
    if ((saved?.identity?.evaluation ?? saved?.evaluation) && requestedGoal === undefined && !game.requestedGoal && JSON.stringify(game.goal) !== JSON.stringify(saved.identity?.goal ?? saved.goal)) game.requestedGoal = (saved.identity?.evaluation ?? saved.evaluation).request;
    await resolveGameGoal(game, models, controller.signal, saved?.identity?.evaluation ?? saved?.evaluation);
    models.report = report;
    let policy = selection === undefined ? undefined : await loadPlayer(selection, game);
    if (view && "open" in view) {
      gameWindow = await view.open({ headless, signal: controller.signal, onClose: stop, log: terminal.log });
      terminal.log(`GameBot controls ${game.id}${headless ? " without a visible window" : " in its game window"}. Ctrl+C stops research.`);
    } else if (!headless) {
      if (!view) throw new Error(`Game ${game.id} has no research viewer. Use --headless to run without a window.`);
      viewer = await startResearchViewer(view);
      terminal.log(`Watch GameBot live at ${viewer.url}. Ctrl+C stops research.`);
      openGameWindow(viewer.url, terminal.log);
    }
    terminal.start();
    terminal.log(`Researching ${game.id}: strategist → tactician → reflex/JEV; model-call budget ${models.maxCalls}. Ctrl+C stops the run.`);
    if (coldStart) terminal.log("Cold start: rules and goal only; prior learning is excluded and results stay in this experiment.");
    const benchmark = saved ? saved.mode !== "continual-v1" : process.argv.includes("--benchmark");
    if (saved?.mode === "continual-v1" && process.argv.includes("--benchmark")) throw new Error("Cannot resume live learning as a benchmark");
    if (!benchmark) {
      if (!policy && !resume && !coldStart && !process.argv.includes("--fresh")) {
        try { policy = await loadPlayer("latest", game); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      await runContinualLearning({ game, models, policy, resume, setupEvents, signal: controller.signal, report,
        coldStart, fresh: saved?.fresh ?? process.argv.includes("--fresh"),
        seed: Number(learningArgument("seed") ?? saved?.seed ?? randomInt(1, 2 ** 30)),
        maxSteps: learningArgument("turns") === undefined ? undefined : Number(learningArgument("turns")),
        maxReviews: learningArgument("rounds") === undefined ? undefined : Number(learningArgument("rounds")),
        maxGames: learningArgument("games") === undefined ? undefined : Number(learningArgument("games")),
      });
    } else await runResearch({
      game, models, policy, resume, setupEvents, fresh: saved?.fresh ?? process.argv.includes("--fresh"), coldStart,
      rounds: Number(learningArgument("rounds") ?? saved?.rounds ?? 5), games: Number(learningArgument("games") ?? saved?.games ?? 3),
      maxSteps: Number(learningArgument("turns") ?? saved?.maxSteps ?? 5000), firstSeed: Number(learningArgument("seed") ?? saved?.firstSeed ?? randomInt(1, 2 ** 30)),
      signal: controller.signal, report,
    });
    if (!headless && !controller.signal.aborted) {
      terminal.log("Research complete. The final board stays visible until Ctrl+C.");
      await stopped;
    }
  } catch (error) {
    if (!controller.signal.aborted) terminal.report({ type: "terminal.error", detail: { message: String(error) } });
    viewer?.report({ type: "research.error", detail: { message: controller.signal.aborted ? "Interrupted" : String(error) } });
    if (!controller.signal.aborted) throw error;
    process.exitCode = 130;
  } finally {
    process.removeListener("SIGINT", stop);
    try { await viewer?.close(); await gameWindow?.close(); } finally { terminal.close(); }
  }
}
