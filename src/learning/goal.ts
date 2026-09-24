import { z } from "zod";
import type { LearningGame } from "./policy.js";
import type { PlayerModelRunner } from "./models.js";

export const evaluationSchema = z.object({
  option: z.string(), objective: z.enum(["achievement", "score"]), description: z.string(), request: z.string(), efficiency: z.enum(["steps", "model-calls"]),
});
export type GoalEvaluation = z.infer<typeof evaluationSchema>;

/** Interpret intent against game-owned evaluators once. The editable player cannot change the scoring contract. */
export async function resolveGameGoal<State, Action>(game: LearningGame<State, Action>, models: PlayerModelRunner,
  signal: AbortSignal, saved?: GoalEvaluation): Promise<void> {
  if (!game.requestedGoal) return;
  const options = game.goalOptions;
  if (!options || !Object.keys(options).length) throw new Error(`Game ${game.id} does not expose evaluators for custom goals`);
  let selection = saved?.option;
  let efficiency = saved?.efficiency ?? "steps";
  if (saved && saved.request !== game.requestedGoal) throw new Error("Saved evaluation does not match the requested goal");
  if (!selection) {
    const result = await models.ask("strategist", z.object({
      option: z.enum(Object.keys(options) as [string, ...string[]]), supported: z.boolean(), explanation: z.string(), efficiency: z.enum(["steps", "model-calls"]),
    }), `Map the authoritative user goal to one of the game's fixed evaluators. This is goal interpretation, not strategy design.
Do not invent a metric or silently drop constraints. Set supported=false if no evaluator can measure the requested outcome,
including any required restrictions. Explain the mismatch. Winning quickly means achievement with fewest decisions;
score means maximize measured score. Set efficiency to model-calls when the user prioritizes reducing AI use, otherwise steps. Efficiency only breaks ties in goal performance; model calls and tokens are tracked, not estimated monetary cost.`, {
      goal: game.requestedGoal, rules: game.rules,
      evaluators: Object.fromEntries(Object.entries(options).map(([id, option]) => [id,
        { objective: option.objective, description: option.description }])),
    }, signal);
    if (!result.supported) throw new Error(`Goal cannot be evaluated by this bridge: ${result.explanation}`);
    selection = result.option;
    efficiency = result.efficiency;
  }
  const option = options[selection];
  if (!option) throw new Error("Saved goal evaluator is unavailable in this game version");
  const evaluation = { option: selection, objective: option.objective, description: option.description, request: game.requestedGoal, efficiency };
  if (saved && JSON.stringify(saved) !== JSON.stringify(evaluation)) throw new Error("Saved goal evaluator has changed");
  game.goal = { id: selection, description: game.requestedGoal };
  game.outcome = option.outcome;
  game.evaluation = evaluation;
  await models.report?.({ type: "goal.resolved", detail: { goal: game.goal, evaluation } });
}
