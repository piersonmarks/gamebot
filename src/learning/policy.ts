import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { CandidateGenerator, GameAdapter, Goal, Verifier } from "../core/index.js";
import { evaluationSchema, type GoalEvaluation } from "./goal.js";
import { jevPolicySchema } from "./judgment.js";
import { observerSourceSchema } from "./observer.js";

/** Rules and evaluation stay in the game package, outside the editable player. State/actions must serialize as JSON. */
export interface LearningGame<State, Action> {
  id: string;
  version: string;
  rules: string;
  goal: Goal;
  evaluation?: GoalEvaluation;
  requestedGoal?: string;
  goalOptions?: Record<string, { description: string; objective: "achievement" | "score";
    outcome(state: State): { done: boolean; won: boolean; score: number } }>;

  /** Persistent worlds are never recreated automatically at a learning checkpoint or terminal event. */
  continuity?: "episodic" | "persistent";
  /** Attach to the existing world on process resume; must not reset it. */
  reconnect?(): GameAdapter<State, Action> | Promise<GameAdapter<State, Action>>;
  /** Fixed bridge-owned feedback. comparisonKey asserts comparable opportunities, not identical worlds. */
  learningFeedback?(window: { before: State; after: State; steps: number; elapsedMs: number }): {
    progress: number; comparisonKey?: string; milestone?: string; setback?: string;
  };
  create(seed: number): GameAdapter<State, Action> | Promise<GameAdapter<State, Action>>;
  candidates: CandidateGenerator<State, Action>;
  verifier: Verifier<State, Action>;
  outcome(state: State): { done: boolean; won: boolean; score: number };
}

const policyFields = {
  kind: z.enum(["ai", "code", "hybrid"]),
  strategy: z.string().min(1).max(12000),
  tactics: z.string().min(1).max(6000),
  reflex: z.string().min(1).max(6000),
  // Legacy artifact fields are accepted but never schedule model calls. New policies use null.
  tacticianEvery: z.number().int().min(1).max(256).nullable(),
  strategistEvery: z.number().int().min(1).max(2048).nullable(),
  // Required, nullable fields work with providers using strict structured output.
  code: z.string().max(60000).nullable(),
};
const legacyPolicySchema = z.object(policyFields).strict();
export const playerPolicySchema = z.object({ ...policyFields, jev: jevPolicySchema.nullable(), observer: observerSourceSchema.nullable().default(null) }).strict().superRefine((policy, context) => {
  if (policy.kind === "ai" ? policy.code !== null : !policy.code?.trim()) {
    context.addIssue({ code: "custom", message: "AI policies require null code; code and hybrid policies require JavaScript" });
  }
  if (policy.kind === "code" && policy.jev !== null) {
    context.addIssue({ code: "custom", message: "Code-only policies require null jev; use hybrid to delegate to Jev" });
  }
});
export type PlayerPolicy = z.infer<typeof playerPolicySchema>;

const artifactFields = {
  evaluation: evaluationSchema.optional(),
  gameId: z.string(),
  gameVersion: z.string(),
  goal: z.object({ id: z.string(), description: z.string() }),
};
export const playerArtifactSchema = z.union([
  z.object({ ...artifactFields, format: z.literal("gamebot-player-v2"), policy: playerPolicySchema }),
  z.object({ ...artifactFields, format: z.literal("gamebot-player-v1"), policy: legacyPolicySchema })
    .transform(artifact => ({ ...artifact, format: "gamebot-player-v2" as const, policy: playerPolicySchema.parse({ ...artifact.policy, jev: null }) })),
]);

export function policyId(policy: PlayerPolicy): string {
  const parsed = playerPolicySchema.parse(policy);
  // Adding monitoring support must not rename existing policy artifacts.
  const { observer, ...legacy } = parsed;
  return createHash("sha256").update(JSON.stringify(observer === null ? legacy : parsed)).digest("hex").slice(0, 16);
}

export function latestPlayerPath(gameId: string, goal?: Goal): string {
  if (!/^[a-z0-9-]+$/.test(gameId)) throw new Error("Invalid game ID");
  if (goal) {
    const key = createHash("sha256").update(JSON.stringify([goal.id, goal.description])).digest("hex").slice(0, 16);
    return resolve(".gamebot", "games", gameId, "goals", key, "latest-player.json");
  }
  return resolve(".gamebot", "games", gameId, "latest-player.json");
}

export async function loadPlayer<State, Action>(selection: string, game: LearningGame<State, Action>): Promise<PlayerPolicy> {
  if (!selection) throw new Error("--policy requires latest or a file path");
  const path = selection === "latest" ? latestPlayerPath(game.id, game.goal) : resolve(selection);
  let contents: string;
  try { contents = await readFile(path, "utf8"); }
  catch (error) {
    if (selection !== "latest" || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // Older installations had one latest policy per game. Reuse it only for its matching goal.
    const legacy = playerArtifactSchema.parse(JSON.parse(await readFile(latestPlayerPath(game.id), "utf8")));
    if (legacy.goal.id !== game.goal.id || legacy.goal.description !== game.goal.description) throw error;
    contents = JSON.stringify(legacy);
  }
  const artifact = playerArtifactSchema.parse(JSON.parse(contents));
  if (artifact.gameId !== game.id || artifact.gameVersion !== game.version ||
      artifact.goal.id !== game.goal.id || artifact.goal.description !== game.goal.description) {
    throw new Error("Policy game, version or goal does not match this run");
  }
  if (artifact.evaluation && JSON.stringify(artifact.evaluation) !== JSON.stringify(game.evaluation)) {
    throw new Error("Policy evaluation contract does not match this run");
  }
  return artifact.policy;
}

export const codeContract = `Code must define a synchronous function choose(input) returning an offered candidate ID.
For hybrid policies only, return null to delegate the current decision to the AI reflex.
Alternatively return {candidateId: an offered ID or null, review: "tactician" | "strategist" | null}.
The model-authored observer inspects observations and program proposals and decides when to wake the tactician.
The tactician decides whether higher reasoning is needed. A program review request is evidence for the observer, not an automatic model call.
There are no scheduled reviews. Legacy tacticianEvery and strategistEvery fields are ignored; set them to null.
Request a review conditionally using current observations when it can affect your decision. If the observer wakes the tactician, after supervision,
choose is called once more with updated strategy/tactic and reviewCompleted=true; it must not request another review.
If the observer declines to wake, your original candidateId must be actionable (or null for hybrid AI delegation); a review-only result cannot execute.
The tactic is a lasting objective; immediateAction is advice valid only for this decision. Code cannot rewrite its own program during play.
input contains state (the observed game state), candidates (id, description, action), goal, directive, strategy, tactic, and recent decisions.
Use plain JavaScript with helper functions as needed. Each invocation is fresh: no persistent globals.
There are no imports, filesystem, network, process, clock or random APIs. Only JSON observations enter the isolated engine.
Execution is bounded to 100 ms and 32 MiB per invocation. The game rules, success evaluator and budgets are not editable.
Use only the supplied observations and rules. Do not assume access to hidden state or future randomness.`;
