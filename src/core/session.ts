import type { SkillExecution } from "../skills/executor.js";
import type {
  Authority, Candidate, CandidateGenerator, DecisionContext, Directive, DirectiveProposal,
  Executor, GameAdapter, Goal, Observation, ProposalValidator, Reasoner, ReasoningRole,
  Reflex, Scheduler, Signals, TraceEvent, TraceSink, Verification, Verifier,
} from "./types.js";

export interface SessionOptions<State, Action, Assumptions = unknown> {
  adapter: GameAdapter<State, Action>;
  candidates: CandidateGenerator<State, Action>;
  /** Omit for deterministic first-candidate selection. */
  reflex?: Reflex<State, Action>;
  /** Starts a registered skill for selected actions; ordinary actions use the adapter. */
  executor?: Executor<State, Action>;
  verifier: Verifier<State, Action>;
  scheduler?: Scheduler<State>;
  tactician?: Reasoner<State, Assumptions>;
  strategist?: Reasoner<State, Assumptions>;
  proposalValidator?: ProposalValidator<State, Assumptions>;
  trace?: TraceSink;
}

export interface StepResult<State, Action> {
  before: Observation<State>;
  after?: Observation<State>;
  candidate?: Candidate<Action>;
  verification?: Verification;
}

/** Owns one session's ordering, authority and execution. Call step at the game's chosen pace. */
export class SessionRuntime<State, Action, Assumptions = unknown> {
  private authority: Authority;
  private sequence = 0;
  private latest?: Observation<State>;
  private lastVerification?: Verification;
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;
  private disposal?: Promise<void>;
  private readonly running = new Map<ReasoningRole, AbortController>();
  private readonly background = new Set<Promise<void>>();
  private readonly cancellations = new Set<Promise<void>>();
  private reflexDecision?: AbortController;
  private execution?: AbortController;
  private activeSkill?: { run: SkillExecution<Action, unknown>; candidate: Candidate<Action>; before: Observation<State>; controller: AbortController };
  private pendingAuthorityChange = 0;
  private readonly scheduler?: Scheduler<State>;

  constructor(private readonly options: SessionOptions<State, Action, Assumptions>, goal: Goal) {
    this.authority = { goal, goalRevision: 1, directiveRevision: 0 };
    this.scheduler = options.scheduler;
  }

  getAuthority(): Readonly<Authority> {
    return { ...this.authority };
  }

  getLatestObservation(): Observation<State> | undefined {
    return this.latest;
  }

  hasActiveSkill(): boolean {
    return this.activeSkill !== undefined;
  }

  /** Serialize user intent with observations and asynchronous proposals. */
  setGoal(goal: Goal): Promise<void> {
    this.pendingAuthorityChange++;
    this.reflexDecision?.abort();
    this.execution?.abort();
    this.cancelSkill("goal changed");
    this.cancelReasoning();
    return this.enqueue(async () => {
      try {
        this.ensureRunning();
        this.authority = { goal, goalRevision: this.authority.goalRevision + 1, directiveRevision: this.authority.directiveRevision + 1 };
        await this.emit("goal.changed", { goal, revision: this.authority.goalRevision });
      } finally {
        this.pendingAuthorityChange--;
      }
    });
  }

  /** Useful for operator direction or a promoted policy; goal remains authoritative. */
  setDirective(directive?: Directive): Promise<void> {
    this.pendingAuthorityChange++;
    this.reflexDecision?.abort();
    this.execution?.abort();
    this.cancelSkill("directive changed");
    this.cancelReasoning();
    return this.enqueue(async () => {
      try {
        this.ensureRunning();
        this.authority = { ...this.authority, directive, directiveRevision: this.authority.directiveRevision + 1 };
        await this.emit("directive.changed", { directive, revision: this.authority.directiveRevision });
      } finally {
        this.pendingAuthorityChange--;
      }
    });
  }

  step(): Promise<StepResult<State, Action>> {
    return this.enqueue(async () => {
      this.ensureRunning();
      const before = await this.options.adapter.observe();
      this.latest = before;
      this.sequence++;
      const base = this.context(before, {});
      const signals = await this.options.adapter.signals?.(base) ?? {};
      const context = this.context(before, signals);
      await this.emit("observation", { ...before, signals });
      for (const role of this.scheduler?.wake(context) ?? []) this.wake(role, context);

      if (this.activeSkill) return this.advanceSkill(before);

      const candidates = await this.options.candidates.generate(context);
      await this.emit("candidates", candidates);
      if (this.pendingAuthorityChange || this.stopped) {
        await this.emit("decision.interrupted");
        return { before };
      }
      if (candidates.length === 0) {
        await this.emit("decision.unavailable");
        return { before };
      }

      let choice: string;
      if (this.options.reflex) {
        const controller = new AbortController();
        this.reflexDecision = controller;
        try {
          choice = await this.options.reflex.choose(context, candidates, controller.signal);
        } catch (error) {
          if (!controller.signal.aborted) throw error;
          await this.emit("decision.interrupted");
          return { before };
        } finally {
          this.reflexDecision = undefined;
        }
      } else {
        choice = candidates[0]!.id;
      }
      const candidate = candidates.find(item => item.id === choice);
      if (!candidate) {
        await this.emit("decision.invalid", { choice });
        throw new Error(`Reflex selected unoffered candidate: ${choice}`);
      }
      await this.emit("decision", { candidateId: candidate.id });
      if (this.pendingAuthorityChange || this.stopped) {
        await this.emit("decision.interrupted");
        return { before };
      }
      const current = await this.options.adapter.observe();
      this.latest = current;
      const legal = this.options.adapter.validateAction
        ? await this.options.adapter.validateAction(candidate.action, current)
        : before.revision !== undefined && before.revision === current.revision;
      if (!legal) {
        await this.emit("decision.stale", { candidateId: candidate.id, revision: current.revision });
        return { before, after: current };
      }
      if (this.pendingAuthorityChange || this.stopped) {
        await this.emit("decision.interrupted");
        return { before, after: current };
      }
      const controller = new AbortController();
      this.execution = controller;
      let executionError: unknown;
      try {
        const run = await this.options.executor?.start(candidate.action, current);
        if (controller.signal.aborted || this.stopped || this.pendingAuthorityChange) {
          if (run) await run.cancel("interrupted");
          return { before, after: current };
        }
        if (run) {
          this.activeSkill = { run, candidate, before: current, controller };
          await this.emit("skill.started", { candidateId: candidate.id });
          return this.advanceSkill(before);
        }
        await this.options.adapter.execute(candidate.action, controller.signal);
      } catch (error) {
        executionError = error;
        await this.emit("execution.error", { message: String(error) });
      } finally {
        this.execution = undefined;
      }
      if (this.stopped) return { before, candidate };
      const after = await this.options.adapter.observe();
      this.latest = after;
      const verification = await this.options.verifier.verify({ before: current, after, candidate, executionError });
      this.lastVerification = verification;
      await this.emit("verification", { candidateId: candidate.id, before: current, after, ...verification });
      return { before, after, candidate, verification };
    });
  }

  /** Stops new work and interrupts in-flight providers and execution. */
  stop(): void {
    this.stopped = true;
    this.cancelReasoning();
    this.reflexDecision?.abort();
    this.execution?.abort();
    this.cancelSkill("session stopped");
  }

  /** Stop new work and settle in-flight work before reading final trace and usage. */
  async finish(): Promise<void> {
    this.stop();
    await this.queue;
    await Promise.all([...this.background, ...this.cancellations]);
    await this.queue;
    this.disposal ??= Promise.resolve().then(() => this.options.adapter.dispose?.());
    await this.disposal;
  }

  private async advanceSkill(before: Observation<State>): Promise<StepResult<State, Action>> {
    const active = this.activeSkill!;
    let executionError: unknown;
    try {
      const progress = await active.run.progress(before);
      if (active.controller.signal.aborted || this.stopped || this.pendingAuthorityChange) {
        return { before };
      }
      if (progress.status === "finished") {
        if (progress.outcome.status !== "succeeded") throw new Error(progress.outcome.reason);
        await this.emit("skill.finished", { candidateId: active.candidate.id });
      } else {
        if (progress.action !== undefined) {
          const current = await this.options.adapter.observe();
          this.latest = current;
          const legal = this.options.adapter.validateAction
            ? await this.options.adapter.validateAction(progress.action, current)
            : before.revision !== undefined && before.revision === current.revision;
          if (!legal) throw new Error("Skill action is no longer valid");
          if (active.controller.signal.aborted || this.stopped || this.pendingAuthorityChange) return { before, after: current };
          await this.options.adapter.execute(progress.action, active.controller.signal);
        }
        const after = await this.options.adapter.observe();
        this.latest = after;
        return { before, after, candidate: active.candidate };
      }
    } catch (error) {
      executionError = error;
      this.cancelSkill("execution failed");
      await this.emit("execution.error", { message: String(error) });
    }
    this.activeSkill = undefined;
    this.execution = undefined;
    const after = await this.options.adapter.observe();
    this.latest = after;
    const verification = await this.options.verifier.verify({ before: active.before, after, candidate: active.candidate, executionError });
    this.lastVerification = verification;
    await this.emit("verification", { candidateId: active.candidate.id, before: active.before, after, ...verification });
    return { before, after, candidate: active.candidate, verification };
  }

  private cancelSkill(reason: string): void {
    const active = this.activeSkill;
    if (!active) return;
    this.activeSkill = undefined;
    active.controller.abort();
    const cancellation = active.run.cancel(reason).then(() =>
      this.emit("skill.cancelled", { candidateId: active.candidate.id, reason }), error =>
      this.emit("skill.cancel.error", { candidateId: active.candidate.id, message: String(error) })).catch(() => undefined);
    this.cancellations.add(cancellation);
    void cancellation.then(() => this.cancellations.delete(cancellation));
  }

  private wake(role: ReasoningRole, context: DecisionContext<State>): void {
    const reasoner = role === "tactician" ? this.options.tactician : this.options.strategist;
    if (!reasoner || this.running.has(role)) return;
    const controller = new AbortController();
    this.running.set(role, controller);
    const goalRevision = context.authority.goalRevision;
    const directiveRevision = context.authority.directiveRevision;
    const sequence = context.sequence;
    const observed = context.observation;
    const startedAt = performance.now();
    const work = (async () => {
      try {
        await this.emit("reasoning.started", { role, sequence });
        const proposal = await reasoner.propose({ ...context, role }, controller.signal);
        if (proposal && !controller.signal.aborted && !this.stopped) {
          await this.enqueue(() => this.activateProposal(role, proposal, goalRevision, directiveRevision, sequence, observed));
        }
      } catch (error) {
        if (!controller.signal.aborted) await this.emit("reasoning.error", { role, message: String(error) });
      } finally {
        if (this.running.get(role) === controller) this.running.delete(role);
        await this.emit("reasoning.completed", { role, latencyMs: performance.now() - startedAt });
      }
    })().catch(() => undefined);
    this.background.add(work);
    void work.then(() => this.background.delete(work));
  }

  private async activateProposal(role: ReasoningRole, proposal: DirectiveProposal<Assumptions>, goalRevision: number, directiveRevision: number, sequence: number, observed: Observation<State>): Promise<void> {
    if (this.stopped) return;
    if (this.pendingAuthorityChange) {
      await this.emit("proposal.rejected", { role, reason: "authority change pending" });
      return;
    }
    if (goalRevision !== this.authority.goalRevision || directiveRevision !== this.authority.directiveRevision) {
      await this.emit("proposal.rejected", { role, reason: "authority changed" });
      return;
    }
    const current = this.latest;
    if (!current) return;
    const validator = this.options.proposalValidator;
    const applicable = validator ? await validator.validate(proposal, current) : sequence === this.sequence && observed === current;
    if (this.stopped) return;
    if (this.pendingAuthorityChange || goalRevision !== this.authority.goalRevision ||
        directiveRevision !== this.authority.directiveRevision || current !== this.latest) {
      await this.emit("proposal.rejected", { role, reason: "authority or observation changed during validation" });
      return;
    }
    if (!applicable) {
      await this.emit("proposal.rejected", { role, reason: "assumptions invalid or observation advanced" });
      return;
    }
    this.cancelSkill("directive changed");
    this.authority = { ...this.authority, directive: proposal.directive, directiveRevision: directiveRevision + 1 };
    await this.emit("proposal.activated", { role, directive: proposal.directive, revision: this.authority.directiveRevision });
  }

  private context(observation: Observation<State>, signals: Signals): DecisionContext<State> {
    return { observation, sequence: this.sequence, authority: this.getAuthority(), lastVerification: this.lastVerification, signals };
  }

  private cancelReasoning(): void {
    for (const controller of this.running.values()) controller.abort();
    this.running.clear();
  }

  private ensureRunning(): void {
    if (this.stopped) throw new Error("Session is stopped");
  }

  private async emit(type: string, detail?: unknown): Promise<void> {
    const event: TraceEvent = {
      sequence: this.sequence,
      time: new Date().toISOString(),
      type,
      authority: this.getAuthority(),
      observationRevision: this.latest?.revision,
      detail,
    };
    await this.options.trace?.record(event);
  }

  private enqueue<Result>(work: () => Promise<Result>): Promise<Result> {
    const result = this.queue.then(work);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}
