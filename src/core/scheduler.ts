import type { DecisionContext, ReasoningRole, Scheduler } from "./types.js";

export interface SchedulerOptions {
  /** Minimum observation steps between wakes of the same role. */
  tacticianCooldown?: number;
  strategistCooldown?: number;
}

/** Small replaceable routing policy. It never starts concurrent work itself. */
export class RuleScheduler<State> implements Scheduler<State> {
  private lastTactician = -Infinity;
  private lastStrategist = -Infinity;
  private readonly tacticianCooldown: number;
  private readonly strategistCooldown: number;

  constructor(options: SchedulerOptions = {}) {
    this.tacticianCooldown = options.tacticianCooldown ?? 3;
    this.strategistCooldown = options.strategistCooldown ?? 10;
  }

  wake(context: DecisionContext<State>): readonly ReasoningRole[] {
    const result: ReasoningRole[] = [];
    const { signals, sequence } = context;
    if ((signals.goalBlocked || signals.novel) && sequence - this.lastStrategist >= this.strategistCooldown) {
      this.lastStrategist = sequence;
      result.push("strategist");
    }
    if ((signals.tacticFailed || signals.invalidated || signals.urgent) &&
        sequence - this.lastTactician >= this.tacticianCooldown) {
      this.lastTactician = sequence;
      result.push("tactician");
    }
    return result;
  }
}
