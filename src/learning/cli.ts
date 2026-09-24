import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolveGameGoal } from "./goal.js";
import { randomInt } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { loadPlayer, type LearningGame } from "./policy.js";
import { PlayerModelRunner, playerModelsFromEnv, type LearningReporter, type LearningEvent } from "./models.js";
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

export function learningConsole(verbose = false): LearningReporter {
  return event => {
    if (event.type === "goal.resolved") {
      const { goal, evaluation } = event.detail as { goal: { description: string }; evaluation: { description: string; efficiency: string } };
      console.log(`Goal: ${goal.description}. Evaluation: ${evaluation.description}. Efficiency priority: ${evaluation.efficiency}.`);
      return;
    }
    if (!verbose && (event.type === "research.proposal" || event.type === "player.initialized")) {
      const { policy, ...summary } = event.detail as { policy: { kind: string }; [key: string]: unknown };
      console.log(`[${event.type}] ${JSON.stringify({ ...summary, policyKind: policy.kind })}`);
      return;
    }
    if (event.type === "episode.completed") {
      const item = event.detail as { seed: number; set: string; stopReason: string; score: number; steps: number };
      console.log(`${item.set} seed ${item.seed}: ${item.stopReason}; score ${item.score}; ${item.steps} decisions`);
    } else if (event.type.startsWith("research.") || event.type === "player.initialized" ||
      verbose && !event.type.startsWith("runtime.") && event.type !== "episode.step") {
      console.log(`[${event.type}] ${JSON.stringify(event.detail)}`);
    }
  };
}

/** Bridges with their own game window open it even in headless mode. */
export interface ResearchGameWindow {
  open(options: { headless: boolean; signal: AbortSignal; onClose: () => void }): Promise<{ close(): Promise<void> }>;
}

export async function runResearchCli<State, Action>(game: LearningGame<State, Action>, view?: ResearchViewerOptions | ResearchGameWindow): Promise<void> {
  const controller = new AbortController();
  let resolveStop!: () => void;
  const stopped = new Promise<void>(resolve => { resolveStop = resolve; });
  const stop = () => {
    if (controller.signal.aborted) return;
    console.log("Stopping research..."); controller.abort(); resolveStop();
  };
  process.once("SIGINT", stop);
  let viewer: Awaited<ReturnType<typeof startResearchViewer>> | undefined;
  let gameWindow: Awaited<ReturnType<ResearchGameWindow["open"]>> | undefined;
  const headless = process.argv.includes("--headless");
  const consoleReport = learningConsole(process.argv.includes("--verbose"));
  const pace = Number(learningArgument("pace") ?? 200);
  const report: LearningReporter = async event => {
    await consoleReport(event);
    viewer?.report(event);
    if (!headless && pace && (event.type === "episode.step" || event.type === "episode.completed")) {
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
    if (learningArgument("goal") !== undefined && !game.goalOptions && !game.requestedGoal) game.requestedGoal = learningArgument("goal");
    if (saved?.evaluation && learningArgument("goal") === undefined && !game.requestedGoal && JSON.stringify(game.goal) !== JSON.stringify(saved.goal)) game.requestedGoal = saved.evaluation.request;
    await resolveGameGoal(game, models, controller.signal, saved?.evaluation);
    models.report = report;
    const policy = selection === undefined ? undefined : await loadPlayer(selection, game);
    if (view && "open" in view) {
      gameWindow = await view.open({ headless, signal: controller.signal, onClose: stop });
      console.log(`GameBot controls the real ${game.id} game${headless ? " in a headless browser" : " window"}. Ctrl+C stops research.`);
    } else if (!headless) {
      if (!view) throw new Error(`Game ${game.id} has no research viewer. Use --headless to run without a window.`);
      viewer = await startResearchViewer(view);
      console.log(`Watch GameBot live at ${viewer.url}. Ctrl+C stops research.`);
      openGameWindow(viewer.url);
    }
    console.log(`Researching ${game.id}: strategist → tactician → reflex/JEV; model-call budget ${models.maxCalls}. Ctrl+C stops the run.`);
    if (coldStart) console.log("Cold start: rules and goal only; prior learning is excluded and results stay in this experiment.");
    await runResearch({
      game, models, policy, resume, setupEvents, fresh: saved?.fresh ?? process.argv.includes("--fresh"), coldStart,
      rounds: Number(learningArgument("rounds") ?? saved?.rounds ?? 5), games: Number(learningArgument("games") ?? saved?.games ?? 3),
      maxSteps: Number(learningArgument("turns") ?? saved?.maxSteps ?? 5000), firstSeed: Number(learningArgument("seed") ?? saved?.firstSeed ?? randomInt(1, 2 ** 30)),
      signal: controller.signal, report,
    });
    if (!headless && !controller.signal.aborted) {
      console.log("Research complete. The final board stays visible until Ctrl+C.");
      await stopped;
    }
  } catch (error) {
    viewer?.report({ type: "research.error", detail: { message: controller.signal.aborted ? "Interrupted" : String(error) } });
    if (!controller.signal.aborted) throw error;
    process.exitCode = 130;
  } finally {
    process.removeListener("SIGINT", stop);
    await viewer?.close();
    await gameWindow?.close();
  }
}
