# @gamebot/runebench

Gamebot adapter for the **separate** [rs-sdk](https://github.com/MaxBittker/rs-sdk) RuneScape-style emulator. It does not connect to official RuneScape. rs-sdk owns the game engine, browser client, gateway, and bot connection. Watch play in rs-sdk's browser client (or a dashboard such as [Jevscape](https://github.com/Skyvern-AI/jevscape)).

This first bridge handles a walking action. Pass the `sdk` and `bot` supplied by rs-sdk's `runScript` callback to `new RuneBenchBridge(sdk, bot)`, then use it as a `SessionRuntime` adapter with `walkVerifier`. The bridge observes rs-sdk's current tick and player position, uses `bot.walkTo`, and verifies arrival from a later state snapshot. Call `sdk.waitForReady()` before starting a session. Candidate destinations and goals belong to the game-specific runner, not Gamebot core.

For a first live check, install built `@gamebot/core` and `@gamebot/runebench` from this workspace into an rs-sdk checkout, then put a script like this under its `bots/<name>/` directory (adjust the import path to rs-sdk's runner):

```ts
import { runScript } from "../../sdk/runner";
import { SessionRuntime } from "@gamebot/core";
import { RuneBenchBridge, walkVerifier } from "@gamebot/runebench";

await runScript(async ({ sdk, bot }) => {
  await sdk.waitForReady();
  const adapter = new RuneBenchBridge(sdk, bot);
  const session = new SessionRuntime({
    adapter,
    candidates: { generate: () => [{ id: "walk", description: "Walk to the target", action: { x: 3222, z: 3218 } }] },
    verifier: walkVerifier,
  }, { id: "walk-target", description: "Reach the target tile" });
  try { console.log(await session.step()); }
  finally { await session.finish(); }
});
```

The adapter is designed for use **inside an rs-sdk checkout**; the external game and its SDK are not installed or run by this package. rs-sdk's high-level `walkTo` may run for multiple ticks and does not accept an AbortSignal, so stopping a Gamebot session cannot cancel a walk already underway. Do not use it for rapid goal switching until the external action can be cancelled reliably.
