import type { LearningGame, PlayerPolicy } from "./policy.js";
import { runPolicyDecision } from "./code.js";
import { runObserver } from "./observer.js";
import { prepareJudgments, selectJudgmentAction } from "./judgment.js";

/** Contract checks on real recorded observations, not simulated games or a substitute for evaluation. */
export async function preflightPolicy<State, Action>(game: LearningGame<State, Action>, policy: PlayerPolicy,
  states: readonly State[], signal: AbortSignal) {
  if (!policy.code && !policy.jev && !policy.observer) return { passed: true, states: 0, calls: 0, maxMs: 0 };
  let calls = 0;
  let playable = 0;
  let maxMs = 0;
  const checked = new Set<string>();
  try {
    for (const state of states) {
      const key = JSON.stringify(state);
      if (checked.has(key)) continue;
      checked.add(key);
      if (policy.observer) {
        const started = performance.now();
        await runObserver(policy.observer, { observation: { state }, outcome: game.outcome(state),
          authority: { goal: game.goal, goalRevision: 1, directiveRevision: 0 }, rules: game.rules, evaluation: game.evaluation,
          strategy: policy.strategy, tactic: policy.tactics, baseline: { observation: { state }, outcome: game.outcome(state) },
          signals: {}, recent: [], learningAvailable: false, detail: { reason: "preflight" } }, signal);
        maxMs = Math.max(maxMs, performance.now() - started);
        calls++;
      }
      if (game.outcome(state).done) continue;
      const candidates = await game.candidates.generate({ observation: { state }, sequence: 1,
        authority: { goal: game.goal, goalRevision: 1, directiveRevision: 0 }, signals: {} });
      if (!candidates.length) continue;
      playable++;
      const input = { state, candidates, goal: game.goal, directive: null, strategy: policy.strategy,
        tactic: policy.tactics, immediateAction: null, recent: [], signals: {}, rules: game.rules, responsibilities: policy.reflex };
      for (let repeat = 0; repeat < 2; repeat++) {
        signal.throwIfAborted();
        const started = performance.now();
        if (policy.code) {
          const decision = await runPolicyDecision(policy.code, { ...input, reviewCompleted: repeat === 1 }, signal);
          if (repeat === 1 && decision.review) throw new Error("Program requests another review after reviewCompleted");
          if (!decision.review && (decision.candidateId === null ? policy.kind === "code"
            : !candidates.some(candidate => candidate.id === decision.candidateId))) throw new Error("Program returned no legal offered action");
        }
        if (policy.jev) {
          const request = await prepareJudgments(policy.jev, input, signal);
          // Exercise composition with valid extreme answers; these are fixtures, not model judgments.
          const answers = Object.fromEntries(Object.entries(request.questions).map(([id, question]) => [id,
            question.type === "choice" ? { type: "choice", choice: Object.keys(question.criteria).at(repeat === 0 ? 0 : -1) }
              : question.type === "score" ? { type: "score", score: repeat }
                : { type: "boolean", probability: repeat }]));
          await selectJudgmentAction(policy.jev, { context: input, request, answers, providerMetadata: {} }, candidates, signal);
        }
        maxMs = Math.max(maxMs, performance.now() - started);
        calls++;
      }
    }
    if ((policy.code || policy.jev) && !playable) throw new Error("No playable recorded observations available for preflight");
    if (policy.observer && !checked.size) throw new Error("No recorded observations available to check observer");
    return { passed: true, states: checked.size, calls, maxMs };
  } catch (error) {
    signal.throwIfAborted();
    return { passed: false, states: checked.size, calls, maxMs, error: String(error) };
  }
}
