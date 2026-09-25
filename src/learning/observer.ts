import { z } from "zod";
import { runPolicyProgram } from "./code.js";

export const observerSourceSchema = z.string().min(1).max(60000);
const decisionSchema = z.object({ wake: z.boolean(), reason: z.string().max(6000) }).strict();

/** An invalid observer stops play; the harness must not invent an escalation policy in its place. */
export class ObserverError extends Error {}

export async function runObserver(source: string, input: unknown, signal: AbortSignal) {
  try {
    return decisionSchema.parse(await runPolicyProgram(source, "observe", input, signal));
  } catch (error) {
    signal.throwIfAborted();
    throw new ObserverError(`Observer failed: ${String(error)}`, { cause: error });
  }
}

export const observerContract = `observer is JavaScript source defining function observe(input) returning {wake: boolean, reason: string}.
It runs cheaply on observations, without a language-model call. It may only request the tactician, never take actions or directly invoke the strategist/researcher.
You author the conditions for needing attention from game evidence; the harness supplies no thresholds, timers, periodic checks or default failure/terminal triggers.
Use event/assumption/progress conditions, not fixed check-in intervals. Balance useful supervision against model cost and response latency.
In real-time games reflex control continues while higher models think. supervisionPending reports an outstanding review; requests are coalesced while it is pending.
modelUsage contains call counts and cumulative latencyMs by role; observation may expose game timing and deadlines.
Input includes observation (with state), outcome {done,won,score}, authority {goal,directive}, rules, evaluation,
signals, lastVerification, recent decisions with Jev judgment receipts, strategy, tactic, detail, learningAvailable, and learning evidence when available.
baseline is {observation,outcome} from the last supervision (or the initial observation); compare it with current evidence when useful.
detail may contain candidates/programProposal before an action, or reason/error/judgments on a final, failed or unavailable-action observation.
Handle missing optional fields and empty recent arrays, terminal observations and legacy/reconnected sessions.
The interpreter is fresh on every call: no persistent globals, imports, filesystem, network, clock, or random APIs.
Execution is limited to 100 ms, 32 MiB and 131072 JSON output characters. Invalid programs stop play without an automatic model fallback.
Astra supplies the initial observer. Tactical responses return observer=null to keep the current source, or supply new source to change it.
When no observer exists, source is required; null cannot initialize monitoring.
This is monitoring code, not a game solver. Jev remains responsible only for its typed judgments.`;
