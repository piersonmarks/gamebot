import { randomInt } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { loadPlayer, type LearningGame } from "./policy.js";
import { PlayerModelRunner, playerModelsFromEnv, type LearningReporter } from "./models.js";
import { runResearch } from "./research.js";
import { openGameWindow, startResearchViewer, type ResearchViewerOptions } from "./viewer.js";

export function learningArgument(name: string): string | undefined {
  return process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

export function learningConsole(verbose = false): LearningReporter {
  return event => {
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

export async function runResearchCli<State, Action>(game: LearningGame<State, Action>, view?: ResearchViewerOptions): Promise<void> {
  const controller = new AbortController();
  let resolveStop!: () => void;
  const stopped = new Promise<void>(resolve => { resolveStop = resolve; });
  const stop = () => { console.log("Stopping research..."); controller.abort(); resolveStop(); };
  process.once("SIGINT", stop);
  let viewer: Awaited<ReturnType<typeof startResearchViewer>> | undefined;
  const consoleReport = learningConsole(process.argv.includes("--verbose"));
  const pace = Number(learningArgument("pace") ?? 200);
  const report: LearningReporter = async event => {
    await consoleReport(event);
    viewer?.report(event);
    if (viewer && pace && (event.type === "episode.step" || event.type === "episode.completed")) {
      await delay(pace, undefined, { signal: controller.signal });
    }
  };
  try {
    if (!Number.isSafeInteger(pace) || pace < 0) throw new Error("--pace must be a nonnegative integer in milliseconds");
    if (process.argv.includes("--headless") && process.argv.includes("--watch")) throw new Error("Use either --headless or --watch");
    const selection = learningArgument("policy");
    const coldStart = process.argv.includes("--cold-start");
    if (selection !== undefined && (process.argv.includes("--fresh") || coldStart)) throw new Error("--policy cannot be combined with --fresh or --cold-start");
    const models = new PlayerModelRunner(playerModelsFromEnv(), Number(learningArgument("max-calls") ?? 10000), report);
    const policy = selection === undefined ? undefined : await loadPlayer(selection, game);
    if (!process.argv.includes("--headless")) {
      if (!view) throw new Error(`Game ${game.id} has no research viewer. Use --headless to run without a window.`);
      viewer = await startResearchViewer(view);
      console.log(`Watch GameBot live at ${viewer.url}. Ctrl+C stops research.`);
      openGameWindow(viewer.url);
    }
    console.log(`Researching ${game.id}: strategist → tactician → reflex/JEV; model-call budget ${models.maxCalls}. Ctrl+C stops the run.`);
    if (coldStart) console.log("Cold start: rules and goal only; prior learning is excluded and results stay in this experiment.");
    await runResearch({
      game, models, policy, fresh: process.argv.includes("--fresh"), coldStart,
      rounds: Number(learningArgument("rounds") ?? 5), games: Number(learningArgument("games") ?? 3),
      maxSteps: Number(learningArgument("turns") ?? 5000), firstSeed: Number(learningArgument("seed") ?? randomInt(1, 2 ** 30)),
      signal: controller.signal, report,
    });
    if (viewer && !controller.signal.aborted) {
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
  }
}
