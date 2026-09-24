import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { CandidateGenerator, GameAdapter, Goal, Verifier } from "../core/index.js";
import { jevPolicySchema } from "./judgment.js";

/** Rules and evaluation stay in the game package, outside the editable player. State/actions must serialize as JSON. */
export interface LearningGame<State, Action> {
  id: string;
  version: string;
  rules: string;
  goal: Goal;
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
  tacticianEvery: z.number().int().min(1).max(256),
  strategistEvery: z.number().int().min(1).max(2048),
  // Required, nullable fields work with providers using strict structured output.
  code: z.string().max(60000).nullable(),
};
const legacyPolicySchema = z.object(policyFields).strict();
export const playerPolicySchema = z.object({ ...policyFields, jev: jevPolicySchema.nullable() }).strict().superRefine((policy, context) => {
  if (policy.kind === "ai" ? policy.code !== null : !policy.code?.trim()) {
    context.addIssue({ code: "custom", message: "AI policies require null code; code and hybrid policies require JavaScript" });
  }
  if (policy.kind === "code" && policy.jev !== null) {
    context.addIssue({ code: "custom", message: "Code-only policies require null jev; use hybrid to delegate to Jev" });
  }
});
export type PlayerPolicy = z.infer<typeof playerPolicySchema>;

const artifactFields = {
  gameId: z.string(),
  gameVersion: z.string(),
  goal: z.object({ id: z.string(), description: z.string() }),
};
export const playerArtifactSchema = z.union([
  z.object({ ...artifactFields, format: z.literal("gamebot-player-v2"), policy: playerPolicySchema }),
  z.object({ ...artifactFields, format: z.literal("gamebot-player-v1"), policy: legacyPolicySchema })
    .transform(artifact => ({ ...artifact, format: "gamebot-player-v2" as const, policy: { ...artifact.policy, jev: null } })),
]).pipe(z.object({ ...artifactFields, format: z.literal("gamebot-player-v2"), policy: playerPolicySchema }));

export function policyId(policy: PlayerPolicy): string {
  return createHash("sha256").update(JSON.stringify(playerPolicySchema.parse(policy))).digest("hex").slice(0, 16);
}

export function latestPlayerPath(gameId: string): string {
  if (!/^[a-z0-9-]+$/.test(gameId)) throw new Error("Invalid game ID");
  return resolve(".gamebot", "games", gameId, "latest-player.json");
}

export async function loadPlayer<State, Action>(selection: string, game: LearningGame<State, Action>): Promise<PlayerPolicy> {
  if (!selection) throw new Error("--policy requires latest or a file path");
  const path = selection === "latest" ? latestPlayerPath(game.id) : resolve(selection);
  const artifact = playerArtifactSchema.parse(JSON.parse(await readFile(path, "utf8")));
  if (artifact.gameId !== game.id || artifact.gameVersion !== game.version ||
      artifact.goal.id !== game.goal.id || artifact.goal.description !== game.goal.description) {
    throw new Error("Policy game, version or goal does not match this run");
  }
  return artifact.policy;
}

export const codeContract = `Code must define a synchronous function choose(input) returning an offered candidate ID.
For hybrid policies only, return null to delegate the current decision to the AI reflex.
input contains state (the observed game state), candidates (id, description, action), goal, directive, strategy, tactic, and recent decisions.
Use plain JavaScript with helper functions as needed. Each invocation is fresh: no persistent globals.
There are no imports, filesystem, network, process, clock or random APIs. Only JSON observations enter the isolated engine.
Execution is bounded to 100 ms and 32 MiB per invocation. The game rules, success evaluator and budgets are not editable.
Use only the supplied observations and rules. Do not assume access to hidden state or future randomness.`;
