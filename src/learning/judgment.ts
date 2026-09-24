import { z } from "zod";
import { runPolicyProgram } from "./code.js";
import type { Candidate } from "../core/index.js";

/** The preparation and composition of judgments evolve together as one policy revision. */
export const jevPolicySchema = z.object({
  prepare: z.string().min(1).max(60000),
  select: z.string().min(1).max(60000),
}).strict();
export type JevPolicy = z.infer<typeof jevPolicySchema>;

const description = z.string().min(1).max(6000);
const questionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("choice"), instructions: description,
    criteria: z.record(z.string().min(1).max(1024), description.nullable())
      .refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= 255, "Choice requires 1–255 options"),
  }).strict(),
  z.object({ type: z.literal("score"), instructions: description, criteria: z.array(description).min(2).max(255) }).strict(),
  z.object({ type: z.literal("boolean"), instructions: description }).strict(),
]);
const requestSchema = z.object({
  // prepare() already crosses a bounded JSON-only interpreter boundary.
  state: z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())]),
  questions: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/), questionSchema)
    .refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= 32, "Use 1–32 independent questions"),
}).strict();
export type JudgmentRequest = z.infer<typeof requestSchema>;

export async function prepareJudgments(policy: JevPolicy, input: unknown, signal: AbortSignal): Promise<JudgmentRequest> {
  return requestSchema.parse(await runPolicyProgram(policy.prepare, "prepare", input, signal));
}

export async function selectJudgmentAction<Action>(policy: JevPolicy, input: unknown,
  candidates: readonly Candidate<Action>[], signal: AbortSignal): Promise<string> {
  const choice = await runPolicyProgram(policy.select, "select", input, signal);
  if (typeof choice !== "string" || !candidates.some(candidate => candidate.id === choice)) {
    throw new Error("Jev policy selected an unoffered candidate ID");
  }
  return choice;
}

export const judgmentContract = `A policy's jev field is null for the default action Choice, or { prepare, select } with JavaScript source strings.
prepare must define function prepare(input) returning { state, questions }. It computes relevant facts from the observation and builds questions.
input has the same fields as choose(input), plus rules and responsibilities. Returned state is a string, JSON object or array.
The runtime sends { goal: authoritativeGoal, evidence: returnedState } to Jev. Questions should reference state.evidence and state.goal.
questions is a map of 1–32 IDs (letters followed by letters, digits or underscores, max 64 characters) to:
{ type: "choice", instructions: string, criteria: { optionID: descriptionStringOrNull } } with 1–255 options;
{ type: "score", instructions: string, criteria: [at least two ordered descriptive levels, at most 255] };
or { type: "boolean", instructions: string } (TypeSafe's Noul).
Instructions/descriptions are at most 6000 characters; Choice option IDs are at most 1024 characters.
Ask narrow judgments with explicit references to the relevant state. All questions share one state and are answered independently in one call.
Question IDs are for code, not context. Keep arithmetic in code. Do not assume another question's answer is available in this batch.
select must define function select(input) returning one of input.context.candidates' IDs. It receives:
{ context: originalInput, request: {state, questions}, answers, providerMetadata }.
Choice answers have type, choice and optional probabilities; Score answers have type, score and optional probabilities;
Boolean answers have type and probability (probability of true). Confidence may be in providerMetadata.typesafe.confidence by question ID.
Combine these answers with computed facts in code. Probabilities are judgments, not measured chances of winning.
Both functions run in separate fresh interpreters with the same isolation and time/memory limits as choose.
No globals persist between them; computed facts needed by select belong in request.state (the state returned by prepare).
Each result is limited to 131072 JSON characters.
Errors or unoffered final actions fail the experiment; no silent fallback. The goal, legal candidate set and game evaluator remain authoritative.`;
