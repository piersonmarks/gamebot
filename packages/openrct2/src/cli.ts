#!/usr/bin/env node
import { SessionRuntime } from "@gamebot/core";
import { OpenRct2Bridge } from "./index.js";

const port = Number(process.argv.find(arg => arg.startsWith("--port="))?.slice(7) ?? 20020);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be a TCP port");
const bridge = new OpenRct2Bridge(port);
const before = await bridge.observe();
console.log(JSON.stringify({ before }, null, 2));
if (process.argv.includes("--pause")) {
  const session = new SessionRuntime({
    adapter: bridge,
    candidates: { generate: () => [{ id: "pause", description: "Pause the running park", action: { endpoint: "pause" } }] },
    verifier: { verify({ after, executionError }) {
      if (executionError) return { status: "failure", reason: String(executionError) };
      const status = after.state.status;
      if (status && typeof status === "object" && "paused" in status && status.paused === true) return { status: "success" };
      return { status: "unknown", reason: "Plugin accepted pause, but get_status did not confirm paused=true" };
    } },
  }, { id: "pause-park", description: "Pause the current park" });
  try { console.log(JSON.stringify({ step: await session.step() }, null, 2)); }
  finally { await session.finish(); }
}
