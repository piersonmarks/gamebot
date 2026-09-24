import { randomInt } from "node:crypto";
import { spawn } from "node:child_process";
import { loadPlayer, type LearningGame } from "./policy.js";
import { PlayerModelRunner, playerModelsFromEnv, type LearningReporter } from "./models.js";
import { runResearch } from "./research.js";

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

export async function runResearchCli<State, Action>(game: LearningGame<State, Action>, playCli: string, watchArgs: readonly string[] = []): Promise<void> {
  const controller = new AbortController();
  const stop = () => { console.log("Stopping research..."); controller.abort(); };
  process.once("SIGINT", stop);
  const report = learningConsole(process.argv.includes("--verbose"));
  try {
    const models = new PlayerModelRunner(playerModelsFromEnv(), Number(learningArgument("max-calls") ?? 10000), report);
    const selection = learningArgument("policy");
    if (selection !== undefined && process.argv.includes("--fresh")) throw new Error("Use either --fresh or --policy");
    const policy = selection === undefined ? undefined : await loadPlayer(selection, game);
    console.log(`Researching ${game.id}: strategist → tactician → reflex/JEV; model-call budget ${models.maxCalls}. Ctrl+C stops the run.`);
    const result = await runResearch({
      game, models, policy, fresh: process.argv.includes("--fresh"),
      rounds: Number(learningArgument("rounds") ?? 5), games: Number(learningArgument("games") ?? 3),
      maxSteps: Number(learningArgument("turns") ?? 5000), firstSeed: Number(learningArgument("seed") ?? randomInt(1, 2 ** 30)),
      signal: controller.signal, report,
    });
    if (process.argv.includes("--watch") && !controller.signal.aborted) {
      const forwarded = process.argv.slice(2).filter(arg => /^--(target|game-dir|pace)=/.test(arg) || arg === "--verbose");
      const child = spawn(process.execPath, [playCli, ...watchArgs, `--policy=${result.policyPath}`, ...forwarded], { stdio: "inherit" });
      const interrupt = () => child.kill("SIGINT");
      controller.signal.addEventListener("abort", interrupt, { once: true });
      try {
        await new Promise<void>((resolve, reject) => {
          child.once("error", reject);
          child.once("exit", code => code && !controller.signal.aborted ? reject(new Error(`Playback exited ${code}`)) : resolve());
        });
      } finally { controller.signal.removeEventListener("abort", interrupt); }
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    process.exitCode = 130;
  } finally { process.removeListener("SIGINT", stop); }
}
