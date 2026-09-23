import type { TraceEvent } from "../core/index.js";

export interface EvaluationSession {
  step(): Promise<void>;
  outcome(): { complete: boolean; score: number };
  tracePath?: string;
  models?: Readonly<Record<string, string>>;
  tokens?(): { input: number; output: number };
  /** Omit when the provider cannot report cost. */
  costUsd?(): number | undefined;
}

export interface EvaluationConfiguration {
  name: string;
  create(seed: number, trace: (event: TraceEvent) => void): EvaluationSession | Promise<EvaluationSession>;
}

export interface EvaluationResult {
  configuration: string;
  seed: number;
  complete: boolean;
  score: number;
  steps: number;
  decisions: number;
  tacticianCalls: number;
  strategistCalls: number;
  failures: number;
  elapsedMs: number;
  tracePath?: string;
  models?: Readonly<Record<string, string>>;
  tokens?: { input: number; output: number };
  costUsd?: number;
}

/** Each configuration receives a fresh session for every seed. */
export async function evaluate(
  configurations: readonly EvaluationConfiguration[],
  seeds: readonly number[],
  maxSteps: number,
): Promise<EvaluationResult[]> {
  if (!Number.isInteger(maxSteps) || maxSteps < 1) throw new Error("maxSteps must be positive");
  const results: EvaluationResult[] = [];
  for (const configuration of configurations) {
    for (const seed of seeds) {
      const counts = { decisions: 0, tacticianCalls: 0, strategistCalls: 0, failures: 0 };
      const session = await configuration.create(seed, event => {
        if (event.type === "decision") counts.decisions++;
        if (event.type === "reasoning.started") {
          const role = (event.detail as { role?: string } | undefined)?.role;
          if (role === "tactician") counts.tacticianCalls++;
          if (role === "strategist") counts.strategistCalls++;
        }
        if (event.type === "verification" &&
            (event.detail as { status?: string } | undefined)?.status === "failure") counts.failures++;
      });
      const started = performance.now();
      let steps = 0;
      while (steps < maxSteps && !session.outcome().complete) {
        await session.step();
        steps++;
      }
      const { complete, score } = session.outcome();
      const costUsd = session.costUsd?.();
      const tokens = session.tokens?.();
      results.push({
        configuration: configuration.name,
        seed,
        complete,
        score,
        steps,
        ...counts,
        elapsedMs: Math.round((performance.now() - started) * 100) / 100,
        ...(session.tracePath === undefined ? {} : { tracePath: session.tracePath }),
        ...(session.models === undefined ? {} : { models: session.models }),
        ...(tokens === undefined ? {} : { tokens }),
        ...(costUsd === undefined ? {} : { costUsd }),
      });
    }
  }
  return results;
}
