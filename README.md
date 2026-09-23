# Gamebot

Gamebot is an early TypeScript runtime for comparing ways to play games with fast decisions, optional slower reasoning, and executable skills. The first runnable slice uses a small local path game; it does not yet control RCT2 or any other real game.

## Run the slice

```sh
npm ci
npm run build
npm run demo
```

The demo runs the same deterministic environment with reflex only, reflex plus tactician, and all three reasoning roles. It prints completion, score, decisions, reasoning calls, failures, elapsed time, and paths to JSON Lines traces under `.gamebot/traces/`. Its scripted reasoners demonstrate wiring; the scores are **not** evidence about model quality. Provider cost is omitted until a provider reports it. The evaluator accepts fresh sessions per configuration and seed, so real adapters can use the same harness.

## Modules and ownership

- [`src/core`](src/core/index.ts) owns one session's goal, current directive, revision checks, candidate selection, action dispatch, verification, scheduling, and trace events. The game adapter owns native state and action meaning. The reflex chooses an offered candidate ID. Reasoners submit proposals; the coordinator checks the proposal's basis before activation. A file trace sink persists authority and observation revisions with each event.
- [`src/skills`](src/skills/index.ts) discovers standard [`SKILL.md`](https://agentskills.io/specification) packages and loads instructions on demand. The injector selects descriptions for a model. Executable skills require separate registration and return one proposed action or a terminal outcome per progress call. Their caller validates and dispatches actions.
- [`src/memory`](src/memory/index.ts) records scoped episodes, validates proposed lessons against cited episodes, writes versioned snapshots, and lets research runs pin a snapshot. Retrieval is replaceable; its initial implementation uses lexical matching. Game version and world/save scope prevent accidental cross-game recall.
- [`src/eval`](src/eval/harness.ts) runs configurations on fresh sessions and reports gameplay and reasoning metrics separately.

The demo in [`src/demo.ts`](src/demo.ts) shows how a game integration supplies observations, candidate generation, action validation, verification, signals, and optional reasoners. [`examples/skills`](examples/skills) contains example Agent Skills packages. The package surface is exported from [`src/index.ts`](src/index.ts).

## Current contracts

An adapter should provide a revision on each observation or validate the selected action against a fresh observation before dispatch. It should translate native events and outcomes into scheduler signals. A verifier should return `success`, `failure`, `pending`, or `unknown`; an unknown outcome must not be treated as proof of success. The runtime can use a deterministic first-candidate selector when no reflex model is configured. The scheduler is a replaceable deterministic rule set with cooldowns; tactician and strategist providers are optional and asynchronous.

Skill instruction loading, skill selection, and executable registration are separate. `SKILL.md` does not grant permission to run scripts. The example registers the two executable skills explicitly and checks their proposed actions with the game adapter.

## Next milestones

1. Add a real structured-state adapter and a contrasting turn-based adapter. RCT2 is in the target set, with integration feasibility to assess before committing to an approach.
2. Add concrete model-provider adapters with structured output validation, cost and latency reporting, and bounded tool access. Preserve the same coordinator interface for local and remote providers.
3. Let long-running skills advance while observations and interrupts continue. Add explicit skill ownership and cancellation handoff in the coordinator.
4. Wire run-end episode recording and evidence-based consolidation into the session lifecycle. Keep research runs pinned to a selected memory snapshot.
5. Use the evaluation harness for matched runs across architectures, with game-specific success metrics and shared cost/latency reporting.

The runtime is intentionally one process today. The game adapter, candidate generator, reflex, scheduler, executor, verifier, reasoning providers, trace sink, skill injector, and memory retriever are replaceable at session setup. Goals remain user-authoritative; model proposals can change the directive but not the user goal.
