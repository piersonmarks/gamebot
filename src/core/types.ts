export interface GameTime {
  wallMs?: number;
  gameMs?: number;
  frame?: number;
  turn?: number;
  episode?: number;
}

/** Game-specific data stays opaque to the runtime. */
export interface Observation<State> {
  state: State;
  time?: GameTime;
  /** A monotonically increasing adapter revision, if available. */
  revision?: string;
  events?: readonly string[];
}

export interface Goal {
  id: string;
  description: string;
}

/** Structured, inspectable intent; game integrations interpret its details. */
export interface Directive {
  id: string;
  instruction: string;
  parameters?: Readonly<Record<string, unknown>>;
}

export interface Candidate<Action> {
  id: string;
  description: string;
  action: Action;
}

export type VerificationStatus = "success" | "failure" | "pending" | "unknown";

export interface Verification {
  status: VerificationStatus;
  reason?: string;
}

export interface Signals {
  progress?: boolean;
  tacticFailed?: boolean;
  goalBlocked?: boolean;
  invalidated?: boolean;
  novel?: boolean;
  urgent?: boolean;
}

export interface Authority {
  goal: Goal;
  goalRevision: number;
  directive?: Directive;
  directiveRevision: number;
}

export interface DecisionContext<State> {
  observation: Observation<State>;
  sequence: number;
  authority: Readonly<Authority>;
  lastVerification?: Verification;
  signals: Signals;
}

export interface GameAdapter<State, Action> {
  observe(): Promise<Observation<State>>;
  /** Optional last-moment legality check against a fresh observation. */
  validateAction?(action: Action, observation: Observation<State>): boolean | Promise<boolean>;
  /** Adapter owns game legality and the final action dispatch. */
  execute(action: Action, signal: AbortSignal): Promise<void>;
  /** Signals are game-native interpretations of observations and outcomes. */
  signals?(context: DecisionContext<State>): Signals | Promise<Signals>;
}

export interface CandidateGenerator<State, Action> {
  generate(context: DecisionContext<State>): readonly Candidate<Action>[] | Promise<readonly Candidate<Action>[]>;
}

export interface Reflex<State, Action> {
  /** Returns only an offered candidate ID. The runtime rejects any other ID. */
  choose(context: DecisionContext<State>, candidates: readonly Candidate<Action>[]): string | Promise<string>;
}

export interface Executor<Action> {
  execute(action: Action, signal: AbortSignal): Promise<void>;
}

export interface Verifier<State, Action> {
  verify(input: {
    before: Observation<State>;
    after: Observation<State>;
    candidate: Candidate<Action>;
    executionError?: unknown;
  }): Verification | Promise<Verification>;
}

export type ReasoningRole = "tactician" | "strategist";

export interface ReasoningRequest<State> extends DecisionContext<State> {
  role: ReasoningRole;
}

export interface DirectiveProposal<Assumptions = unknown> {
  directive: Directive;
  /** Checked against a later observation before a delayed proposal activates. */
  assumptions?: Assumptions;
}

export interface Reasoner<State, Assumptions = unknown> {
  propose(request: ReasoningRequest<State>, signal: AbortSignal): Promise<DirectiveProposal<Assumptions> | undefined>;
}

export interface ProposalValidator<State, Assumptions = unknown> {
  validate(proposal: DirectiveProposal<Assumptions>, observation: Observation<State>): boolean | Promise<boolean>;
}

export interface Scheduler<State> {
  wake(context: DecisionContext<State>): readonly ReasoningRole[];
}

export interface TraceEvent {
  sequence: number;
  time: string;
  type: string;
  authority: Readonly<Authority>;
  observationRevision?: string;
  detail?: unknown;
}

export interface TraceSink {
  record(event: TraceEvent): void | Promise<void>;
}
