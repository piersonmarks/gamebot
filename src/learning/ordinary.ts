import type { GameAdapter, SessionOptions, StepResult } from "../core/index.js";
import { SessionRuntime } from "../core/index.js";
import { ContinualLearningSession } from "./continual.js";
import type { LearningReporter, PlayerModelRunner } from "./models.js";
import type { LearningGame, PlayerPolicy } from "./policy.js";

/** Run one game with either a fixed player or continual learning. Game-specific input and display stay in the bridge. */
export async function runOrdinaryGame<State, Action>(options: {
  game: LearningGame<State, Action>;
  adapter: GameAdapter<State, Action>;
  session: SessionOptions<State, Action>;
  learning?: { models: PlayerModelRunner; policy?: PlayerPolicy; seed: number; coldStart?: boolean };
  signal: AbortSignal;
  maxSteps?: number;
  report: LearningReporter;
  reportEpisode?: LearningReporter;
  onSession?: (session: SessionRuntime<State, Action> | ContinualLearningSession<State, Action>) => void;
  beforeStep?: (state: State, steps: number) => void | Promise<void>;
  afterStep?: (result: StepResult<State, Action>, state: State, steps: number) => void | "stop" | Promise<void | "stop">;
}): Promise<{ state: State | undefined; steps: number }> {
  const { game, adapter, signal } = options;
  signal.throwIfAborted();
  const session = options.learning
    ? await ContinualLearningSession.open({ game: { ...game, verifier: options.session.verifier }, adapter,
      models: options.learning.models, policy: options.learning.policy, seed: options.learning.seed,
      signal, trace: options.session.trace, report: options.report, coldStart: options.learning.coldStart })
    : new SessionRuntime(options.session, game.goal);
  const stop = () => session.stop();
  signal.addEventListener("abort", stop, { once: true });
  let state: State | undefined;
  let steps = 0;
  try {
    options.onSession?.(session);
    state = (await adapter.observe()).state;
    if (session instanceof SessionRuntime) await options.reportEpisode?.({ type: "episode.started", detail: { state } });
    while (!signal.aborted && (options.maxSteps === undefined || steps < options.maxSteps) && !game.outcome(state).done) {
      await options.beforeStep?.(state, steps);
      const result = await session.step();
      if (signal.aborted) break;
      state = (game.realtime ? await adapter.observe() : result.after ?? await adapter.observe()).state;
      if (!result.candidate) {
        if (session instanceof ContinualLearningSession || game.realtime) continue;
        break;
      }
      steps++;
      if (session instanceof SessionRuntime) await options.reportEpisode?.({ type: "episode.step", detail: {
        step: steps, action: result.candidate.action, after: state, outcome: game.outcome(state),
      } });
      if (await options.afterStep?.(result, state, steps) === "stop") break;
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    signal.removeEventListener("abort", stop);
    await session.finish();
  }
  return { state, steps };
}
