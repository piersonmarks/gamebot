import { RuleScheduler } from "./scheduler.js";
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
  /** Omit to dispatch through the adapter. A skill executor can own this seam. */
  executor?: Executor<Action>;
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
  private readonly running = new Map<ReasoningRole, AbortController>();
  private reflexDecision?: AbortController;
  private execution?: AbortController;
  private pendingAuthorityChange = 0;
  private readonly scheduler: Scheduler<State>;

  constructor(private readonly options: SessionOptions<State, Action, Assumptions>, goal: Goal) {
    this.authority = { goal, goalRevision: 1, directiveRevision: 0 };
    this.scheduler = options.scheduler ?? new RuleScheduler<State>();
  }

  getAuthority(): Readonly<Authority> {
    return { ...this.authority };
  }

  getLatestObservation(): Observation<State> | undefined {
    return this.latest;
  }

  /** Serialize user intent with observations and asynchronous proposals. */
  setGoal(goal: Goal): Promise<void> {
    this.pendingAuthorityChange++;
    this.reflexDecision?.abort();
    this.execution?.abort();
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
      await this.emit("observation", { revision: before.revision, events: before.events, signals });
      for (const role of this.scheduler.wake(context)) this.wake(role, context);

      const candidates = await this.options.candidates.generate(context);
      await this.emit("candidates", candidates.map(({ id, description }) => ({ id, description })));
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
        if (this.options.executor) await this.options.executor.execute(candidate.action, controller.signal);
        else await this.options.adapter.execute(candidate.action, controller.signal);
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
      await this.emit("verification", { candidateId: candidate.id, ...verification });
      return { before, after, candidate, verification };
    });
  }

  /** Stops new work and interrupts in-flight providers and execution. */
  stop(): void {
    this.stopped = true;
    this.cancelReasoning();
    this.reflexDecision?.abort();
    this.execution?.abort();
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
    void this.emit("reasoning.started", { role, sequence }).catch(() => undefined);
    void reasoner.propose({ ...context, role }, controller.signal).then(proposal => {
      if (!proposal || controller.signal.aborted) return;
      void this.enqueue(() => this.activateProposal(role, proposal, goalRevision, directiveRevision, sequence, observed))
        .catch(error => this.emit("proposal.error", { role, message: String(error) }).catch(() => undefined));
    }).catch(error => {
      if (!controller.signal.aborted) void this.emit("reasoning.error", { role, message: String(error) }).catch(() => undefined);
    }).finally(() => {
      if (this.running.get(role) === controller) this.running.delete(role);
      void this.emit("reasoning.completed", { role, latencyMs: performance.now() - startedAt })
        .catch(() => undefined);
    });
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
