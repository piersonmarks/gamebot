export type SkillOutcome<Result> =
  | { readonly status: "succeeded"; readonly result: Result }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "unknown"; readonly reason: string };

export type SkillProgress<Action, Result> =
  | { readonly status: "running"; readonly action?: Action; readonly detail?: string }
  | { readonly status: "finished"; readonly outcome: SkillOutcome<Result> };

/** A run owns execution until it finishes or is cancelled by the coordinator. */
export interface SkillExecution<Action, Result> {
  /** Emits at most one proposed action; the coordinator validates and dispatches it. */
  progress(observation: unknown): Promise<SkillProgress<Action, Result>>;
  cancel(reason: string): Promise<void>;
}

/** The game integration validates its native observation and skill parameters. */
export interface SkillExecutor<Params, Action, Result> {
  parseParams(input: unknown): Params;
  start(params: Params, observation: unknown): Promise<SkillExecution<Action, Result>>;
}

type Starter<Action> = (params: unknown, observation: unknown) => Promise<SkillExecution<Action, unknown>>;

/** Registration is explicit; a SKILL.md never grants executable authority. */
export class SkillExecutorRegistry<Action = unknown> {
  private readonly starters = new Map<string, Starter<Action>>();

  register<Params, Result>(
    name: string,
    executor: SkillExecutor<Params, Action, Result>,
  ): void {
    if (this.starters.has(name)) throw new Error(`Executor already registered: ${name}`);
    this.starters.set(name, (input, observation) =>
      executor.start(executor.parseParams(input), observation),
    );
  }

  has(name: string): boolean {
    return this.starters.has(name);
  }

  async start(
    name: string,
    params: unknown,
    observation: unknown,
  ): Promise<SkillExecution<Action, unknown>> {
    const starter = this.starters.get(name);
    if (!starter) throw new Error(`No executor registered for skill: ${name}`);
    return starter(params, observation);
  }
}
