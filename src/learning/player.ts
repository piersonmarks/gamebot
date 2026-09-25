import { z } from "zod";
import type { Candidate, DecisionContext, Observation, Reflex } from "../core/index.js";
import { playerPolicySchema, policyId, type LearningGame, type PlayerPolicy } from "./policy.js";
import { PlayerModelRunner, type LearningReporter } from "./models.js";
import { runPolicyDecision } from "./code.js";
import { observerContract, observerSourceSchema, runObserver, ObserverError } from "./observer.js";

export async function initializePlayer<State, Action>(
  game: LearningGame<State, Action>, observation: Observation<State>, models: PlayerModelRunner,
  signal: AbortSignal, report?: LearningReporter,
): Promise<PlayerPolicy> {
  const plan = await models.ask("strategist", z.object({
    policy: playerPolicySchema,
    alternatives: z.array(z.string()).min(2).max(5),
    rationale: z.string(),
  }), `Understand this game and establish the initial three-tier player. Assign responsibilities to the tactician and fast reflex/JEV layer.
Enumerate competing approaches and choose an initial hypothesis. The tactician supervises reflex decisions and outcomes and decides when to involve you or request learning.
There are no scheduled reviews. Set the legacy tacticianEvery and strategistEvery fields to null.
Start with an AI action policy (kind ai, code null, jev null), plus an observer program that defines when tactical attention is needed.
Collect gameplay evidence before proposing action-selection code or custom Jev questions. The observer only monitors evidence.
${observerContract}
The goal defines success; do not assume it is attainable. No built-in solution or examples are supplied.`, {
    rules: game.rules, goal: game.goal, evaluation: game.evaluation, observation,
  }, signal);
  if (plan.policy.kind !== "ai" || plan.policy.jev !== null) throw new Error("Initial player must be AI-first with default Jev questions");
  await report?.({ type: "player.initialized", detail: plan });
  return plan.policy;
}

/** Control flow, not a failed game action: only a supervising model can request learning. */
export class LearningReviewRequested extends Error {
  constructor(readonly requestedBy: "tactician" | "strategist", reason: string) { super(reason); }
}

export interface PlayerControllerState<State> {
  policyId: string;
  strategy?: string;
  tactic?: string;
  observer?: string;
  baseline?: { observation: Observation<State>; outcome: { done: boolean; won: boolean; score: number } };
  recent: unknown[];
}

/** A model-authored observer gates Sol; Jev answers judgments, never routes escalation. */
export class HierarchicalPlayer<State, Action> implements Reflex<State, Action> {
  private policy?: PlayerPolicy;
  private strategy?: string;
  private tactic?: string;
  private observer?: string;
  private baseline?: PlayerControllerState<State>["baseline"];
  private goalRevision?: number;
  private recent: unknown[] = [];

  constructor(private readonly options: {
    game: LearningGame<State, Action>;
    models: PlayerModelRunner;
    policy?: PlayerPolicy;
    controller?: PlayerControllerState<State>;
    reflex?: Reflex<State, Action>;
    report?: LearningReporter;
    learning?: { evidence(): unknown };
  }) {
    this.policy = options.policy && playerPolicySchema.parse(options.policy);
    this.observer = this.policy?.observer ?? undefined;
    const saved = options.controller;
    if (saved) {
      if (!this.policy || saved.policyId !== policyId(this.policy)) throw new Error("Controller does not match the active player policy");
      this.strategy = saved.strategy;
      this.tactic = saved.tactic;
      this.observer = saved.observer ?? this.observer;
      this.baseline = structuredClone(saved.baseline);
      this.recent = structuredClone(saved.recent);
    }
  }

  snapshot(): PlayerControllerState<State> | undefined {
    if (!this.policy) return undefined;
    return structuredClone({ policyId: policyId(this.policy), strategy: this.strategy, tactic: this.tactic,
      observer: this.observer, baseline: this.baseline, recent: this.recent });
  }

  replacePolicy(policy: PlayerPolicy): void {
    this.policy = playerPolicySchema.parse(policy);
    this.strategy = this.policy.strategy;
    this.tactic = undefined;
    this.observer = this.policy.observer ?? undefined;
    this.baseline = undefined;
  }

  private async prepare(context: DecisionContext<State>, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.goalRevision !== undefined && this.goalRevision !== context.authority.goalRevision) {
      this.policy = undefined;
      this.recent = [];
      this.strategy = this.tactic = this.observer = undefined;
      this.baseline = undefined;
    }
    this.goalRevision = context.authority.goalRevision;
    if (!this.policy) this.policy = await initializePlayer({ ...this.options.game, goal: context.authority.goal },
      context.observation, this.options.models, signal, this.options.report);
    this.strategy ??= this.policy.strategy;
    this.observer ??= this.policy.observer ?? undefined;
    this.baseline ??= structuredClone({ observation: context.observation, outcome: this.options.game.outcome(context.observation.state) });
  }

  /** Also consumes terminal, unavailable-action and error observations without asking Jev for a move. */
  async supervise(context: DecisionContext<State>, signal: AbortSignal, detail?: unknown): Promise<{ reviewed: boolean; immediateAction: string | null }> {
    await this.prepare(context, signal);
    const evidence = {
      rules: this.options.game.rules, evaluation: this.options.game.evaluation, authority: context.authority,
      observation: context.observation, outcome: this.options.game.outcome(context.observation.state),
      signals: context.signals, lastVerification: context.lastVerification, recent: this.recent, detail,
      learningAvailable: !!this.options.learning, learning: this.options.learning?.evidence(),
      strategy: this.strategy, tactic: this.tactic ?? this.policy!.tactics, baseline: this.baseline,
    };
    const attention = this.observer ? await runObserver(this.observer, evidence, signal)
      : { wake: true, reason: "Initialize monitoring for a legacy policy without an observer" };
    await this.options.report?.({ type: "observer.decision", detail: attention });
    if (!attention.wake) return { reviewed: false, immediateAction: null };
    const adoptObserver = async (replacement: string | null, tactic: string) => {
      const source = replacement ?? this.observer;
      if (!source) throw new ObserverError("A player without monitoring requires observer source, not null");
      const baseline = structuredClone({ observation: context.observation, outcome: evidence.outcome });
      await runObserver(source, { ...evidence, strategy: this.strategy, tactic, baseline }, signal);
      this.observer = source;
      this.tactic = tactic;
      this.baseline = baseline;
      await this.options.report?.({ type: "observer.configured", detail: { source, baseline } });
    };
    const reviewTactics = (strategyReviewed: boolean) => this.options.models.ask("tactician", z.object({
      instruction: z.string().min(1).max(6000), immediateAction: z.string().max(2000).nullable(),
      review: z.enum(["none", "strategist", "learning"]), reason: z.string(), observer: observerSourceSchema.nullable(),
    }), `The observer requested your attention. Supervise the reflex player using the current observation, previous judgments and their verified outcomes.
You decide whether to continue, adjust tactics, ask the strategist for a new plan, or request a learning review to revise the saved policy/program.
Game signals, milestones, setbacks, elapsed time and terminal outcomes are evidence, never automatic review triggers.
Do not invent fixed check-in intervals. Request help when the evidence warrants it, including opportunities to improve efficiency after success.
Use instruction for a lasting objective and immediateAction only for advice about this decision.
When detail has no candidates (an outcome-only observation), return immediateAction=null; express future guidance in instruction.
If learningAvailable is false, learning is disabled for this replay/benchmark: choose none or strategist.
If strategyReviewed is true, use the updated strategy or request learning; do not request the strategist again for the same observation.
The user goal remains authoritative. Return observer=null to retain the current observer without copying its source. Supply source only when changing monitoring, or when no observer exists.
${observerContract}`, { ...evidence, attention, observer: this.observer, strategy: this.strategy, responsibilities: this.policy!.tactics,
      previousTactic: this.tactic, strategyReviewed }, signal);
    let result = await reviewTactics(false);
    await adoptObserver(result.observer, result.instruction);
    await this.options.report?.({ type: "supervisor.decision", detail: result });
    if (result.review === "strategist") {
      const plan = await this.options.models.ask("strategist", z.object({
        strategy: z.string().min(1).max(12000), reason: z.string(), learn: z.boolean(),
      }), `The tactician requested strategic help. Revise the strategy and delegate concrete objectives.
You may request a learning review with learn=true to revise the saved policy/program when learningAvailable is true.
Otherwise return learn=false. There are no periodic reviews; the supervising model decides when more reasoning is needed.
Preserve the user goal. Do not claim to execute code in this planning response.`,
      { ...evidence, policy: this.policy, strategy: this.strategy, trigger: result.reason }, signal);
      this.strategy = plan.strategy;
      await this.options.report?.({ type: "strategy.updated", detail: plan });
      if (plan.learn) this.requestLearning("strategist", plan.reason);
      result = await reviewTactics(true);
      await adoptObserver(result.observer, result.instruction);
      await this.options.report?.({ type: "supervisor.decision", detail: result });
      if (result.review === "strategist") throw new Error("Supervisor requested the same strategic review twice without new evidence");
    }
    this.tactic = result.instruction;
    await this.options.report?.({ type: "tactic.updated", detail: { ...result, immediateActionExpiresAfter: context.sequence } });
    if (result.review === "learning") this.requestLearning("tactician", result.reason);
    return { reviewed: true, immediateAction: result.immediateAction };
  }

  private requestLearning(role: "tactician" | "strategist", reason: string): never {
    if (!this.options.learning) throw new Error("Learning is disabled for this player");
    throw new LearningReviewRequested(role, reason);
  }

  async choose(context: DecisionContext<State>, candidates: readonly Candidate<Action>[], signal: AbortSignal): Promise<string> {
    await this.prepare(context, signal);
    let immediateAction: string | null = null;
    const input = (reviewCompleted = false) => ({
      state: context.observation.state, candidates, goal: context.authority.goal, directive: context.authority.directive,
      strategy: this.strategy, tactic: this.tactic ?? this.policy!.tactics, immediateAction,
      // Do not feed full judgment requests back into later requests recursively.
      recent: this.recent.map(item => { const { judgments, ...decision } = item as Record<string, unknown>; return decision; }),
      signals: context.signals, lastVerification: context.lastVerification, reviewCompleted,
    });
    const proposal = this.policy!.kind === "ai" ? undefined : await runPolicyDecision(this.policy!.code!, input(), signal);
    const supervision = await this.supervise(context, signal, { candidates, programProposal: proposal });
    immediateAction = supervision.immediateAction;
    const decision = !proposal ? { candidateId: null, review: null } : supervision.reviewed
      ? await runPolicyDecision(this.policy!.code!, input(true), signal) : proposal;
    if (supervision.reviewed && decision.review) throw new Error("Program requested another review after supervision");
    let choice = decision.candidateId;
    let source = "code";
    const judgments: Record<string, unknown> = {};
    if (choice === null && this.policy!.kind === "code") throw new Error("Code policy returned null; only hybrid policies may delegate to AI");
    if (choice === null) {
      source = this.options.reflex ? "reflex-backend" : "evaluation";
      if (this.options.reflex) {
        choice = await this.options.reflex.choose({ ...context, authority: { ...context.authority,
          directive: { id: "hierarchical-player", instruction: [context.authority.directive?.instruction,
            this.strategy, this.tactic, immediateAction, this.policy!.reflex].filter(Boolean).join("\n"),
            parameters: { strategy: this.strategy, tactic: this.tactic, immediateAction } },
        } }, candidates, signal);
      } else {
        choice = await this.options.models.choose(candidates,
          { ...input(), rules: this.options.game.rules, responsibilities: this.policy!.reflex }, signal, this.policy!.jev,
          async event => {
            if (event.type.startsWith("reflex.")) judgments[event.type.slice(7)] = event.detail;
            await this.options.report?.(event);
          });
      }
    }
    if (!candidates.some(candidate => candidate.id === choice)) throw new Error(`Player selected unoffered candidate: ${choice}`);
    this.recent.push({ state: context.observation.state, candidateId: choice, lastVerification: context.lastVerification, judgments });
    this.recent = this.recent.slice(-8);
    await this.options.report?.({ type: "player.decision", detail: { candidateId: choice, source,
      strategy: this.strategy, tactic: this.tactic, immediateAction } });
    return choice;
  }
}
