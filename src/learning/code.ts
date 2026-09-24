import { getQuickJS } from "quickjs-emscripten";

/** WASM interpreter: no host objects, imports or I/O are exposed to candidate code. */
export async function runPolicyCode(source: string, input: unknown, signal: AbortSignal): Promise<string | null> {
  signal.throwIfAborted();
  const engine = await getQuickJS();
  const deadline = performance.now() + 100;
  let result: unknown;
  try {
    result = engine.evalCode(`
    "use strict";
    globalThis.Date = undefined;
    Math.random = undefined;
    ${source}
    const answer = choose(${JSON.stringify(input)});
    if (answer !== null && (typeof answer !== "string" || answer.length > 1024)) throw new Error("choose must return a candidate ID or null");
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
  if (result !== null && typeof result !== "string") throw new Error("Invalid code policy result");
  return result;
}
