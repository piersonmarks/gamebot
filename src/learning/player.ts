import { z } from "zod";
import type { Candidate, DecisionContext, Observation, Reflex } from "../core/index.js";
import { playerPolicySchema, type LearningGame, type PlayerPolicy } from "./policy.js";
import { PlayerModelRunner, type LearningReporter } from "./models.js";
import { runPolicyCode } from "./code.js";

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
Start with an AI policy (kind ai, code null). We must collect gameplay evidence before proposing executable code.
The goal defines success; do not assume it is attainable. No built-in solution or examples are supplied.`, {
    rules: game.rules, goal: game.goal, observation,
  }, signal);
  if (plan.policy.kind !== "ai") throw new Error("Initial player must be AI-first");
  await report?.({ type: "player.initialized", detail: plan });
  return plan.policy;
}

/** One session's three-tier controller. SessionRuntime retains action authority and legality checks. */
export class HierarchicalPlayer<State, Action> implements Reflex<State, Action> {
  private policy?: PlayerPolicy;
  private strategy?: string;
  private tactic?: string;
  private lastStrategist = -Infinity;
  private lastTactician = -Infinity;
  private goalRevision?: number;
  private directiveRevision?: number;
  private recent: unknown[] = [];

  constructor(private readonly options: {
    game: LearningGame<State, Action>;
    models: PlayerModelRunner;
    policy?: PlayerPolicy;
    /** Optional JEV/local backend at the existing fast-decision interface. */
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
      this.lastStrategist = context.sequence;
    }
    const evidence = {
      rules: this.options.game.rules, authority: context.authority, observation: context.observation,
      signals: context.signals, lastVerification: context.lastVerification, recent: this.recent,
    };
    const reviseStrategy = async (reason: string) => {
      const result = await this.options.models.ask("strategist", z.object({ strategy: z.string().min(1).max(12000), reason: z.string() }),
        "Review progress toward the user goal. Revise the overall strategy and delegate concrete objectives to the tactician. Code changes belong to evaluated research revisions; do not claim to execute code here.",
        { ...evidence, policy: this.policy, strategy: this.strategy, trigger: reason }, signal);
      this.strategy = result.strategy;
      this.lastStrategist = context.sequence;
      await this.options.report?.({ type: "strategy.updated", detail: result });
    };
    const reviewStrategy = !this.strategy || directiveChanged || context.signals.goalBlocked || context.signals.novel ||
      context.sequence - this.lastStrategist >= this.policy.strategistEvery;
    if (reviewStrategy) await reviseStrategy("initial setup, review interval or game signal");
    if (!this.tactic || reviewStrategy || context.signals.tacticFailed || context.signals.urgent || context.signals.invalidated ||
        context.lastVerification?.status === "failure" || context.sequence - this.lastTactician >= this.policy.tacticianEvery) {
      const reviewTactics = () => this.options.models.ask("tactician", z.object({
        instruction: z.string().min(1).max(6000), escalate: z.boolean(), reason: z.string(),
      }), "Translate the strategist's plan into an immediate objective for the reflex/JEV layer. Inspect recent outcomes. Escalate if the overall strategy needs reconsideration; preserve the authoritative user goal.",
      { ...evidence, strategy: this.strategy, responsibilities: this.policy!.tactics, previousTactic: this.tactic }, signal);
      let result = await reviewTactics();
      if (result.escalate && !reviewStrategy) {
        await reviseStrategy(result.reason);
        result = await reviewTactics();
      }
      this.tactic = result.instruction;
      this.lastTactician = context.sequence;
      await this.options.report?.({ type: "tactic.updated", detail: result });
    }
    const input = {
      state: context.observation.state, candidates, goal: context.authority.goal,
      directive: context.authority.directive, strategy: this.strategy, tactic: this.tactic, recent: this.recent,
    };
    let choice: string | null = null;
    let source = "ai";
    if (this.policy.kind !== "ai") {
      choice = await runPolicyCode(this.policy.code!, input, signal);
      source = "code";
      if (choice === null && this.policy.kind === "code") throw new Error("Code policy returned null; only hybrid policies may delegate to AI");
    }
    if (choice === null) {
      source = this.options.reflex ? "reflex-backend" : "ai";
      if (this.options.reflex) {
        choice = await this.options.reflex.choose({ ...context, authority: { ...context.authority,
          directive: { id: "hierarchical-player", instruction: [context.authority.directive?.instruction,
            this.strategy, this.tactic, this.policy.reflex].filter(Boolean).join("\n"),
            parameters: { strategy: this.strategy, tactic: this.tactic } },
        } }, candidates, signal);
      } else {
        const result = await this.options.models.ask("reflex", z.object({ candidateId: z.string(), reason: z.string().max(1000) }),
          "You are the fast reflex/JEV layer. Choose exactly one offered candidate ID using the current strategy and tactic. Give a brief decision summary.",
          { ...input, rules: this.options.game.rules, responsibilities: this.policy.reflex }, signal);
        choice = result.candidateId;
        await this.options.report?.({ type: "reflex.summary", detail: result });
      }
    }
    if (!candidates.some(candidate => candidate.id === choice)) throw new Error(`Player selected unoffered candidate: ${choice}`);
    this.recent.push({ state: context.observation.state, candidateId: choice, lastVerification: context.lastVerification });
    this.recent = this.recent.slice(-8);
    await this.options.report?.({ type: "player.decision", detail: { candidateId: choice, source } });
    return choice;
  }
}
