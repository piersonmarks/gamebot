import { z } from "zod";
import type { Candidate, DecisionContext, Observation, Reflex } from "../core/index.js";
import { playerPolicySchema, type LearningGame, type PlayerPolicy } from "./policy.js";
import { PlayerModelRunner, type LearningReporter } from "./models.js";
import { runPolicyDecision } from "./code.js";

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
Start with an AI policy (kind ai, code null, jev null). We must collect gameplay evidence before proposing executable code or custom Jev questions.
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

/** Sol supervises each observation; Jev answers judgments, never routes escalation. */
export class HierarchicalPlayer<State, Action> implements Reflex<State, Action> {
  private policy?: PlayerPolicy;
  private strategy?: string;
  private tactic?: string;
  private goalRevision?: number;
  private recent: unknown[] = [];

  constructor(private readonly options: {
    game: LearningGame<State, Action>;
    models: PlayerModelRunner;
    policy?: PlayerPolicy;
    reflex?: Reflex<State, Action>;
    report?: LearningReporter;
    learning?: { evidence(): unknown };
  }) {
    this.policy = options.policy && playerPolicySchema.parse(options.policy);
  }

  replacePolicy(policy: PlayerPolicy): void {
    this.policy = playerPolicySchema.parse(policy);
    this.strategy = this.policy.strategy;
    this.tactic = undefined;
  }

  private async prepare(context: DecisionContext<State>, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.goalRevision !== undefined && this.goalRevision !== context.authority.goalRevision) {
      this.policy = undefined;
      this.recent = [];
      this.strategy = this.tactic = undefined;
    }
    this.goalRevision = context.authority.goalRevision;
    if (!this.policy) this.policy = await initializePlayer({ ...this.options.game, goal: context.authority.goal },
      context.observation, this.options.models, signal, this.options.report);
    this.strategy ??= this.policy.strategy;
  }

  /** Also consumes terminal, unavailable-action and error observations without asking Jev for a move. */
  async supervise(context: DecisionContext<State>, signal: AbortSignal, detail?: unknown): Promise<string | null> {
    await this.prepare(context, signal);
    const evidence = {
      rules: this.options.game.rules, evaluation: this.options.game.evaluation, authority: context.authority,
      observation: context.observation, outcome: this.options.game.outcome(context.observation.state),
      signals: context.signals, lastVerification: context.lastVerification, recent: this.recent, detail,
      learningAvailable: !!this.options.learning, learning: this.options.learning?.evidence(),
    };
    const reviewTactics = (strategyReviewed: boolean) => this.options.models.ask("tactician", z.object({
      instruction: z.string().min(1).max(6000), immediateAction: z.string().max(2000).nullable(),
      review: z.enum(["none", "strategist", "learning"]), reason: z.string(),
    }), `Supervise the reflex player using the current observation, previous judgments and their verified outcomes.
You decide whether to continue, adjust tactics, ask the strategist for a new plan, or request a learning review to revise the saved policy/program.
Game signals, milestones, setbacks, elapsed time and terminal outcomes are evidence, never automatic review triggers.
Do not invent fixed check-in intervals. Request help when the evidence warrants it, including opportunities to improve efficiency after success.
Use instruction for a lasting objective and immediateAction only for advice about this decision.
If learningAvailable is false, learning is disabled for this replay/benchmark: choose none or strategist.
If strategyReviewed is true, use the updated strategy or request learning; do not request the strategist again for the same observation.
The user goal remains authoritative.`, { ...evidence, strategy: this.strategy, responsibilities: this.policy!.tactics,
      previousTactic: this.tactic, strategyReviewed }, signal);
    let result = await reviewTactics(false);
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
      await this.options.report?.({ type: "supervisor.decision", detail: result });
      if (result.review === "strategist") throw new Error("Supervisor requested the same strategic review twice without new evidence");
    }
    this.tactic = result.instruction;
    await this.options.report?.({ type: "tactic.updated", detail: { ...result, immediateActionExpiresAfter: context.sequence } });
    if (result.review === "learning") this.requestLearning("tactician", result.reason);
    return result.immediateAction;
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
    immediateAction = await this.supervise(context, signal, { candidates, programProposal: proposal });
    const decision = this.policy!.kind === "ai" ? { candidateId: null, review: null }
      : await runPolicyDecision(this.policy!.code!, input(true), signal);
    if (decision.review) throw new Error("Program requested another review after supervision");
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
