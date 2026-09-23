# Gamebot

Gamebot is an early TypeScript runtime for comparing ways to play games with fast decisions, optional slower reasoning, and executable skills. Local path, Chess, and Snake games are runnable in this workspace. The 2048 browser bridge plays the creator's live Classic website; other external-game bridges require their games to be installed and running separately.

## Start a game

```sh
npm install
npm run game -- --game=2048
```

The launcher lists installed playable bridges with `npm run game -- --list`. Choose `--game=chess` for a terminal board or `--game=snake` for a local browser viewer. Game options follow the ID, for example `npm run game -- --game=2048 --seed=42` or `npm run game -- --game=chess --ai`. Each bridge declares its own launch defaults; the launcher builds core, the selected local bridge, and its local dependencies before starting it. `npm run build` remains the explicit full-workspace build.

To watch the path game play out in the terminal, run `npm run watch`. It shows the agent's position, chosen action, verification result, and any tactical or strategic directive change at a readable pace.

Chess and Snake are separate installable workspace bridges, not part of the core runtime. The older `npm run chess` and `npm run snake` shortcuts still work. Pass `--seed=42` to vary the starting game, or `--ai` to use `GAMEBOT_REFLEX_MODEL` / `GAMEBOT_MODEL` instead of the deterministic heuristic:

```sh
npm run chess -- --seed=42
npm run snake -- --ai
npm run snake:window
```

To watch Gamebot control the **separate [2048 game](https://github.com/gabrielecirulli/2048)** in a browser window, run the [`@gamebot/2048`](packages/2048) bridge:

```sh
npm run game -- --game=2048
```

The bridge opens [Classic 2048](https://classic.play2048.co/) directly, so no game download is needed. It reuses an installed Chrome or Chromium when Playwright's own browser is absent, downloading Chromium only if it cannot find one. Use `--game-dir=/path/to/2048` for an existing checkout when you want to play offline.

The default run plays until 2048 or game over; pass `--steps=100` or `--target=128` when you want a shorter experiment. The final output reports why it stopped.

For a vision experiment, set `AI_GATEWAY_API_KEY` and run `npm run game -- --game=2048 --observe=vision --steps=10`. This sends browser screenshots to a vision-capable AI Gateway model, defaulting to Gemini, and validates the returned board state. Set `GAMEBOT_VISION_MODEL` to compare another model. The usual run reads structured state from the page without model calls.

The bridge packages are [`@gamebot/chess`](packages/chess), [`@gamebot/snake`](packages/snake), [`@gamebot/browser`](packages/browser), [`@gamebot/2048`](packages/2048), [`@gamebot/openrct2`](packages/openrct2), and [`@gamebot/runebench`](packages/runebench). Snake's `--window` option serves a read-only local browser viewer and keeps the final board visible until Ctrl+C. The browser bridge controls separately hosted HTML5 games in a visible Playwright page, using game-specific DOM or structured state; screenshots are optional. The 2048 package is the first game-specific browser integration. OpenRCT2 connects to the separately installed openrct2-bridge plugin; RuneBench accepts the SDK and bot supplied by a separate rs-sdk checkout. OpenRCT2 and RuneBench have not been exercised against live games in this workspace. Runs write traces under `.gamebot/traces/` in the current working directory. The root package `@gamebot/core` has no game dependency. These packages are available locally through npm workspaces; they have not been published to a registry.

Each bridge runner creates a writable `.gamebot/games/<game>/tools/` area for game-scoped tool drafts and prints its path. Drafts are not loaded or run automatically; reviewed implementations belong in that bridge's `tools/` source directory and require explicit registration.

To run the same demo through actual models, set an [AI Gateway](https://ai-sdk.dev/docs/getting-started/choosing-a-provider) key and a current model ID, then run `npm run watch:ai`:

```sh
export AI_GATEWAY_API_KEY='your-key'
export GAMEBOT_MODEL='provider/model-id'
npm run watch:ai
```

Replace the model ID with one from the [current Gateway catalog](https://ai-gateway.vercel.sh/v1/models). `GAMEBOT_REFLEX_MODEL`, `GAMEBOT_TACTICIAN_MODEL`, and `GAMEBOT_STRATEGIST_MODEL` can override the common model individually. The command makes paid model calls when valid credentials and model IDs are supplied. It reports token use, while dollar cost stays unset until pricing is available. The regular `watch` and `demo` commands use no model service.

The demo runs the same deterministic environment with reflex only, reflex plus tactician, and all three reasoning roles. It prints completion, score, decisions, reasoning calls, failures, elapsed time, and paths to JSON Lines traces under `.gamebot/traces/`. Its scripted reasoners demonstrate wiring; the scores are **not** evidence about model quality. Provider cost is omitted until a provider reports it. The evaluator accepts fresh sessions per configuration and seed, so real adapters can use the same harness.

## Modules and ownership

- [`src/core`](src/core/index.ts) owns one session's goal, current directive, revision checks, candidate selection, action dispatch, skill progress and cancellation, verification, scheduling, and trace events. The game adapter owns native state and action meaning. The reflex chooses an offered candidate ID. Reasoners submit proposals; the coordinator checks the proposal's basis before activation. Each step advances at most one skill action so observations and interrupts can occur between actions. A file trace sink persists authority and observation revisions with each event.
- [`src/skills`](src/skills/index.ts) discovers standard [`SKILL.md`](https://agentskills.io/specification) packages and loads instructions on demand. A replaceable injector selects relevant skills for each model decision. Executable skills require separate registration and return one proposed action or a terminal outcome per progress call. The session runtime validates and dispatches proposed actions.
- [`src/memory`](src/memory/index.ts) records scoped episodes, validates proposed lessons against cited episodes, writes versioned snapshots, and lets research runs pin a snapshot. Retrieval is replaceable; its initial implementation uses lexical matching. Game version and world/save scope prevent accidental cross-game recall.
- [`src/eval`](src/eval/harness.ts) runs configurations on fresh sessions, waits for a terminal skill outcome after a game goal is reached, settles background work, then reports gameplay and reasoning metrics.
- [`src/models`](src/models/ai-sdk.ts) adapts Vercel AI SDK `generateText` to the reflex, reasoning, and screenshot-to-state interfaces. Model selection is supplied at session setup as a Gateway ID or any AI SDK language model. Game integrations choose what context to send. Structured output is validated, candidate IDs are checked, cancellation reaches the provider, and token use and latency are reported through a callback.

The demo in [`src/demo.ts`](src/demo.ts) shows how a game integration supplies observations, candidate generation, action validation, verification, signals, and optional reasoners. The separate chess and Snake bridges use the same runtime and evaluation harness; the external-game packages provide initial adapters and connection smoke paths. [`examples/skills`](examples/skills) contains example Agent Skills packages. The core package surface is exported from [`src/index.ts`](src/index.ts).

## Current contracts

An adapter should provide a revision on each observation or validate the selected action against a fresh observation before dispatch. It should translate native events and outcomes into scheduler signals. A verifier should return `success`, `failure`, `pending`, or `unknown`; an unknown outcome must not be treated as proof of success. The runtime can use a deterministic first-candidate selector when no reflex model is configured. The scheduler is a replaceable deterministic rule set with cooldowns; tactician and strategist providers are optional and asynchronous.

Skill instruction loading, skill selection, and executable registration are separate. `SKILL.md` does not grant permission to run scripts. The example registers the two executable skills explicitly; the runtime checks their proposed actions with the game adapter. Selected skill instructions reach the model prompt at each decision, while executable authority remains with the registered skill and runtime.

## Next milestones

1. Exercise the OpenRCT2 and RuneBench bridges against live game instances, then add game-specific tasks, candidate generation, verification, and evaluation runs. RCT2 remains in the target set.
2. Extend the AI SDK adapter with bounded, role-specific tools and dollar cost reporting. Preserve the same coordinator interface for local and remote providers.
3. Wire run-end episode recording and evidence-based consolidation into the session lifecycle. Keep research runs pinned to a selected memory snapshot.
4. Use the evaluation harness for matched runs across architectures, with game-specific success metrics and shared cost/latency reporting.

The runtime is intentionally one process today. The game adapter, candidate generator, reflex, scheduler, executor, verifier, reasoning providers, trace sink, skill injector, and memory retriever are replaceable at session setup. Goals remain user-authoritative; model proposals can change the directive but not the user goal.
