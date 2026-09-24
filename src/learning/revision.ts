import { z } from "zod";
import { codeContract, playerPolicySchema } from "./policy.js";
import { judgmentContract } from "./judgment.js";
import { PlayerModelRunner } from "./models.js";

export const revisionSchema = z.object({
  diagnosis: z.string(), alternatives: z.array(z.string()).min(2).max(5), hypothesis: z.string(),
  policy: playerPolicySchema.nullable(),
  trialVerdict: z.enum(["keep", "reject", "inconclusive"]).default("inconclusive"),
  nextReviewIn: z.number().int().min(1).max(2048).default(64),
});
export type Revision = z.infer<typeof revisionSchema>;

/** The same research decision consumes either a live learning window or matched benchmark evidence. */
export function proposeRevision(models: PlayerModelRunner, input: unknown, signal: AbortSignal): Promise<Revision> {
  return models.ask("strategist", revisionSchema, `You are the research strategist improving a three-tier game player. Investigate the gameplay evidence and failures.
Enumerate competing explanations and approaches; propose one executable experiment. You can change strategy, tactical/reflex instructions,
review intervals, the Jev questions and supporting computations, or replace AI leaf decisions with generated code or a hybrid. Choose the implementation based on your findings.
Keep the user goal authoritative. Do not assume a win or optimality. Errors, rejected hypotheses and computation cost are evidence.
Inspect recorded judgment requests, answers, selections and their observed outcomes. Distinguish missing context, bad question design,
composition-code errors and model errors. You may add, revise or remove questions and change preparation/selection code as one experiment.
A win is evidence, not the end of research: preserve goal success while reducing decisions and model calls.
Distinguish provider outages from game losses and program failures. Do not infer policy quality from an outage.
Available checks: bounded generated-code/Jev contract checks on recorded states, followed by the configured real-game trials.
There is no arbitrary test runner or simulator: do not claim that a proposed fixture or larger seed count was executed.
Autonomous code calls higher tiers only when it explicitly requests a review; choose where supervision can affect behavior.
Avoid repeating tried policies. Matched benchmarks require measured performance on fresh matched games to promote a revision. Live windows provide observational evidence, not controlled proof.
${codeContract}
${judgmentContract}
Learning is continuous: a window can end on a milestone, setback, stalled progress, review deadline, win, or loss.
Do not wait for a terminal game state. Return policy=null when there is no justified change; choose nextReviewIn adaptively.
If a live trial exists, assess it with trialVerdict: keep locally, reject, or inconclusive (collect more evidence).
Do not compare absolute accumulated scores across different starting states. Inspect progress, opportunities, costs and confounders.
Incomparable live windows cannot establish causal improvement. Keeping a live revision is provisional, not benchmark promotion.
A setback may be an intentional investment toward the authoritative goal; explain the evidence rather than changing the evaluator.`, input, signal);
}
