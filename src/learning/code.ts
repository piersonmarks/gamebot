import { getQuickJS } from "quickjs-emscripten";

/** WASM interpreter: no host objects, imports or I/O are exposed to candidate code. */
export async function runPolicyProgram(source: string, entry: "choose" | "prepare" | "select", input: unknown, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  const engine = await getQuickJS();
  const deadline = performance.now() + 100;
  let result: unknown;
  try {
    result = engine.evalCode(`
    "use strict";
    globalThis.Date = undefined;
    Math.random = undefined;
    const answer = JSON.stringify((() => {
      ${source}
      return ${entry}(${JSON.stringify(input)});
    })());
    if (typeof answer !== "string" || answer.length > 131072) throw new Error("Policy result must be JSON of at most 131072 characters");
    answer;
    `, {
      memoryLimitBytes: 32 * 1024 * 1024,
      maxStackSizeBytes: 512 * 1024,
      shouldInterrupt: () => signal.aborted || performance.now() >= deadline,
    });
  } catch (error) {
    throw new Error(`Policy code failed: ${error instanceof Error ? error.message : JSON.stringify(error)}`);
  }
  signal.throwIfAborted();
  if (typeof result !== "string" || result.length > 131072) throw new Error("Invalid policy program result");
  return JSON.parse(result);
}

export type ProgramDecision = { candidateId: string | null; review: "tactician" | "strategist" | null };

export async function runPolicyDecision(source: string, input: unknown, signal: AbortSignal): Promise<ProgramDecision> {
  const result = await runPolicyProgram(source, "choose", input, signal);
  if (result === null || typeof result === "string" && result.length <= 1024) return { candidateId: result, review: null };
  if (typeof result !== "object") throw new Error("choose must return an ID, null, or { candidateId, review }");
  const decision = result as ProgramDecision;
  if ((decision.candidateId !== null && (typeof decision.candidateId !== "string" || decision.candidateId.length > 1024)) ||
      ![null, "tactician", "strategist"].includes(decision.review)) throw new Error("Invalid program decision");
  return decision;
}

export async function runPolicyCode(source: string, input: unknown, signal: AbortSignal): Promise<string | null> {
  const result = (await runPolicyDecision(source, input, signal)).candidateId;
  if (result !== null && (typeof result !== "string" || result.length > 1024)) throw new Error("choose must return a candidate ID or null");
  return result;
}
