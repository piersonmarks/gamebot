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
Enumerate competing approaches, choose an initial hypothesis, and choose review intervals measured in decisions.
Start with an AI policy (kind ai, code null, jev null). We must collect gameplay evidence before proposing executable code or custom Jev questions.
The goal defines success; do not assume it is attainable. No built-in solution or examples are supplied.`, {
    rules: game.rules, goal: game.goal, evaluation: game.evaluation, observation,
  }, signal);
  if (plan.policy.kind !== "ai" || plan.policy.jev !== null) throw new Error("Initial player must be AI-first with default Jev questions");
  await report?.({ type: "player.initialized", detail: plan });
  return plan.policy;
}

/** One session's three-tier controller. SessionRuntime retains action authority and legality checks. */
export class HierarchicalPlayer<State, Action> implements Reflex<State, Action> {
  private policy?: PlayerPolicy;
  private strategy?: string;
  private tactic?: string;
  private nextStrategist = 0;
  private nextTactician = 0;
  private goalRevision?: number;
  private directiveRevision?: number;
  private recent: unknown[] = [];

  constructor(private readonly options: {
    game: LearningGame<State, Action>;
    models: PlayerModelRunner;
    policy?: PlayerPolicy;
    /** Optional alternative backend; otherwise use the configured evaluation model (Jev by default). */
    reflex?: Reflex<State, Action>;
    report?: LearningReporter;
  }) {
    this.policy = options.policy && playerPolicySchema.parse(options.policy);
  }

  async choose(context: DecisionContext<State>, candidates: readonly Candidate<Action>[], signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    if (this.goalRevision !== undefined && this.goalRevision !== context.authority.goalRevision) {
      this.policy = undefined;
      this.recent = [];
      this.strategy = this.tactic = undefined;
    }
    const directiveChanged = this.directiveRevision !== undefined && this.directiveRevision !== context.authority.directiveRevision;
    this.goalRevision = context.authority.goalRevision;
    this.directiveRevision = context.authority.directiveRevision;
    if (!this.policy) {
      this.policy = await initializePlayer({ ...this.options.game, goal: context.authority.goal }, context.observation,
        this.options.models, signal, this.options.report);
      this.strategy = this.policy.strategy;
      this.tactic = undefined;
      this.nextStrategist = context.sequence + this.policy!.strategistEvery;
    }
    const evidence = {
      rules: this.options.game.rules, evaluation: this.options.game.evaluation, authority: context.authority, observation: context.observation,
      signals: context.signals, lastVerification: context.lastVerification, recent: this.recent,
    };
    this.strategy ??= this.policy.strategy;
    let immediateAction: string | null = null;
    const input = (reviewCompleted = false) => ({
      state: context.observation.state, candidates, goal: context.authority.goal,
      directive: context.authority.directive, strategy: this.strategy, tactic: this.tactic ?? this.policy!.tactics,
      immediateAction, recent: this.recent, signals: context.signals, reviewCompleted,
    });
    // An autonomous program must explicitly request supervision; otherwise reviews cannot affect it.
    let decision = this.policy.kind === "ai" ? { candidateId: null, review: null }
      : await runPolicyDecision(this.policy.code!, input(), signal);
    const usesAI = this.policy.kind === "ai" || this.policy.kind === "hybrid" && decision.candidateId === null;
    const reviseStrategy = async (reason: string) => {
      const result = await this.options.models.ask("strategist", z.object({
        strategy: z.string().min(1).max(12000), reason: z.string(),
        nextReviewIn: z.number().int().min(1).max(2048).default(this.policy!.strategistEvery),
      }), "Review progress toward the user goal. Revise the overall strategy and delegate concrete objectives to the tactician. Choose nextReviewIn decisions based on current risk and progress: extend autonomy when reliable, shorten it when uncertain. Code changes belong to evaluated research revisions; do not claim to execute code here.",
        { ...evidence, policy: this.policy, strategy: this.strategy, trigger: reason }, signal);
      this.strategy = result.strategy;
      this.nextStrategist = context.sequence + result.nextReviewIn;
      await this.options.report?.({ type: "strategy.updated", detail: result });
    };
    const reviewStrategy = decision.review === "strategist" || usesAI && (directiveChanged ||
      context.signals.goalBlocked || context.signals.novel || context.sequence >= this.nextStrategist);
    if (reviewStrategy) await reviseStrategy(decision.review ? "program requested review" : "review due or game signal");
    if (decision.review || usesAI && (!this.tactic || reviewStrategy || context.signals.tacticFailed || context.signals.urgent ||
        context.signals.invalidated || context.lastVerification?.status === "failure" || context.sequence >= this.nextTactician)) {
      const reviewTactics = () => this.options.models.ask("tactician", z.object({
        instruction: z.string().min(1).max(6000), immediateAction: z.string().max(2000).nullable().default(null),
        nextReviewIn: z.number().int().min(1).max(256).default(this.policy!.tacticianEvery),
        escalate: z.boolean(), reason: z.string(),
      }), "Translate the strategist's plan into a lasting objective in instruction, never a move to repeat blindly. Put any advice about the current move ONLY in immediateAction; it expires after this decision. Choose nextReviewIn decisions adaptively from current risk and progress. Inspect recent outcomes and escalate when strategy needs reconsideration. Preserve the authoritative user goal.",
      { ...evidence, strategy: this.strategy, responsibilities: this.policy!.tactics, previousTactic: this.tactic }, signal);
      let result = await reviewTactics();
      if (result.escalate && !reviewStrategy) {
        await reviseStrategy(result.reason);
        result = await reviewTactics();
      }
      this.tactic = result.instruction;
      immediateAction = result.immediateAction;
      this.nextTactician = context.sequence + result.nextReviewIn;
      await this.options.report?.({ type: "tactic.updated", detail: { ...result, immediateActionExpiresAfter: context.sequence } });
    }
    if (decision.review || usesAI && this.policy.kind === "hybrid") {
      decision = await runPolicyDecision(this.policy.code!, input(true), signal);
      if (decision.review) throw new Error("Program requested a second review in the same decision");
    }
    let choice = decision.candidateId;
    let source = "code";
    if (choice === null && this.policy.kind === "code") throw new Error("Code policy returned null; only hybrid policies may delegate to AI");
    if (choice === null) {
      source = this.options.reflex ? "reflex-backend" : "evaluation";
      if (this.options.reflex) {
        choice = await this.options.reflex.choose({ ...context, authority: { ...context.authority,
          directive: { id: "hierarchical-player", instruction: [context.authority.directive?.instruction,
            this.strategy, this.tactic, immediateAction, this.policy.reflex].filter(Boolean).join("\n"),
            parameters: { strategy: this.strategy, tactic: this.tactic, immediateAction } },
        } }, candidates, signal);
      } else {
        choice = await this.options.models.choose(candidates,
          { ...input(), rules: this.options.game.rules, responsibilities: this.policy.reflex }, signal, this.policy.jev, this.options.report);
      }
    }
    if (!candidates.some(candidate => candidate.id === choice)) throw new Error(`Player selected unoffered candidate: ${choice}`);
    this.recent.push({ state: context.observation.state, candidateId: choice, lastVerification: context.lastVerification });
    this.recent = this.recent.slice(-8);
    await this.options.report?.({ type: "player.decision", detail: { candidateId: choice, source, strategy: this.strategy, tactic: this.tactic, immediateAction, nextStrategist: this.nextStrategist, nextTactician: this.nextTactician } });
    return choice;
  }
}
