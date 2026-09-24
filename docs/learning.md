# AI-first play and research

2048 and Snake use the same three-tier player and research runner from `@gamebot/core`. Each game supplies rules, observations, legal actions, a fresh environment, and a fixed evaluator. No game-specific winning strategy is included in the initial model prompts.

## Configure models once

Install dependencies with `npm install`. Configure AI Gateway credentials and model IDs from its current catalog:

```sh
export AI_GATEWAY_API_KEY='your-key'
export GAMEBOT_STRATEGIST_MODEL='provider/strong-model-id'
export GAMEBOT_TACTICIAN_MODEL='provider/tactical-model-id'
export GAMEBOT_REFLEX_MODEL='provider/fast-model-id'
```

These are placeholders. Use the strongest available reasoning model for strategist, such as Astra when available through your provider. GameBot does not assume a provider ID for that name. `GAMEBOT_MODEL` supplies a fallback for any unset role; `GAMEBOT_RESEARCH_MODEL` is also accepted as a strategist fallback. Programmatic callers can pass any AI SDK `LanguageModel` implementation.

## Play or research

```sh
npm run game -- --game=2048 --verbose
npm run autoplay -- --game=2048 --fresh --rounds=5 --games=3 --verbose
npm run game -- --game=2048 --policy=latest
npm run autoplay -- --game=snake --fresh --rounds=5 --games=3
```

Ordinary play starts a new AI player unless `--policy=latest` or an explicit artifact path is supplied. It does not read prior research implicitly. `--policy=builtin` explicitly selects the older hand-written heuristic for an offline comparison. In 2048, explicit legacy weight JSON paths also remain playable; `--policy=latest` falls back to a legacy `active-policy.json` only if no new player artifact exists.

Research resumes the latest evaluated player and prior findings by default. `--fresh` starts from rules and an AI player without loading prior policies or findings. This is a new experiment, and its selected player replaces the latest pointer when it completes successfully. `--policy=/absolute/path/player.json` selects a particular starting revision. Policies carry the game ID, rule version and goal; mismatches fail rather than silently replaying a policy for another task.

## Cold-start evaluation

To test whether a new GameBot instance can develop a successful player from its rules and goal:

```sh
npm run autoplay -- --game=2048 --cold-start --seed=1 --verbose
```

Each invocation starts a new process and a separate experiment directory. It loads no previous policies, findings, skills, tool drafts or memory, and does not modify the shared research history or latest policy. `--policy` is rejected in this mode. The first player is AI-only. Subsequent revisions may use evidence and code produced inside this experiment. The models receive the rules, observations, legal actions and goal, with the general three-tier research instructions and execution interface. No example solution, strategy hints, game implementation source, or assertion that the goal is achievable is supplied. Built-in heuristics are not used.

The experiment saves its rules, goal, seed and model/budget configuration in `experiment.json`, and all gameplay/revision evidence in `runs.jsonl`. `result.json` distinguishes the initial player, the first observed win (episode, policy, steps and cumulative model calls), and the selected player's performance on previously unused test seeds. `goalReachedOnTest` means at least one verified goal achievement on that final set; it is not a guarantee of reliable wins. If the initial AI player already wins, that is recorded separately from improvement through research. An interrupted or budget-exhausted run retains its journal but has no completed final-audit result.

Repeat with other `--seed` values for independent cold starts. Reusing a seed reproduces the game random streams, not necessarily model outputs. `--rounds`, `--games`, `--turns` and `--max-calls` bound the experiment. `--watch` explicitly replays its selected artifact; subsequent ordinary play still does not load it automatically.

This tests a cold harness, not a model with erased pretraining: a pretrained model may already know 2048. No saved GameBot knowledge or demonstrations are supplied, and learning from the run's own feedback is intentional.

Research defaults to five rounds, three games per seed set and 5,000 decisions per game. `--rounds`, `--games`, `--turns`, `--seed` and `--max-calls` are configurable. The shared model-call budget defaults to 10,000; retries are disabled and each request has a two-minute timeout. These commands make model calls and can incur substantial provider costs. A small turn limit is useful for checking setup, but a truncated game is not evidence of a loss. Ctrl+C aborts in-flight model work and leaves completed evidence on disk. `--watch` opens a game with the selected artifact after research.

## The three tiers

Before the first action, the strategist understands the rules, enumerates alternatives, chooses an initial AI approach, assigns tactical/reflex responsibilities, and selects review intervals. Its setup completes before play starts.

The tactician translates the strategy into immediate objectives and reviews recent outcomes. It can escalate to the strategist. The reflex/JEV role chooses an offered action. Strategy and tactics are distinct session state; tactical updates do not overwrite the strategic plan. Reviews occur at the selected intervals and on game signals. The current turn-based integrations await these reviews. The underlying session runtime still reobserves and validates the action before dispatch, and a changed user goal cancels in-flight work and starts fresh planning.

The default fast backend uses the configured AI SDK model. A dedicated Open-Jev model is not bundled. `HierarchicalPlayer` also accepts an optional `reflex` implementation through the existing `Reflex<State, Action>` interface, allowing a local/JEV backend to receive the current strategy and tactic without changing the higher tiers.

## What research can change

A versioned player artifact includes strategic, tactical and reflex instructions, review intervals, and a policy kind:

- `ai`: model decisions at the leaves.
- `code`: generated JavaScript chooses actions.
- `hybrid`: generated JavaScript chooses actions or returns `null` to delegate to the AI reflex.

The research strategist receives sampled trajectories (including the end of each game), fixed evaluation results, previous hypotheses and rejection/error evidence. It diagnoses failures, enumerates alternatives, and proposes an entire revised player. It can invent scoring features, simulation/search code or a different algorithm. There is no predefined list of weight adjustments or winning implementations. The researcher proposes one experiment each round; this implementation does not yet expose arbitrary investigative tool calls to it.

Candidate code defines `function choose(input)` and returns an offered candidate ID. Input contains observed state, candidates, the authoritative goal and directive, current strategy/tactic, and recent decisions. Plain JavaScript helper functions are allowed. Code executes in QuickJS WebAssembly with a fresh context, 32 MiB memory and 100 ms execution deadline per decision. No host objects, filesystem, network or imports are exposed; clock and random APIs are disabled. Invalid actions, exceptions and timeouts become failed experiments. Hybrid fallback is explicit; errors do not silently trigger AI rescue. Higher tiers continue to supervise even when leaf decisions use code.

The runtime and game evaluator remain outside the editable player. The candidate is evaluated on matched training seeds. An improvement must also beat the incumbent on fresh matched validation seeds. A final, previously unused seed set compares the selected candidate with the starting player before publication. More wins outrank score; candidates with execution errors cannot be promoted. Runtime and model use are reported separately. These are empirical comparisons with stochastic models, not statistical proof of superiority or guarantees of optimal play; increase `--games` for stronger evidence.

## Evidence and extension

Artifacts and complete transition journals live under `.gamebot/research/<game>/<run>/`. The latest evaluated artifact is `.gamebot/games/<game>/latest-player.json`. A separate research ledger retains hypotheses, diagnoses, acceptance/rejection and errors across experiments. Research evidence is not automatically treated as validated general-purpose memory or promoted across games. Ordinary gameplay traces include strategy/tactic updates, reflex summaries, code-versus-AI selection and model token usage. The launcher runs from the selected package directory, so these paths are relative to that directory.

To add a game, implement `LearningGame<State, Action>`:

- `id`, `version`, `rules`, and the authoritative `goal`.
- `create(seed)` returning a fresh game adapter.
- `candidates` and `verifier` using the native game types.
- `outcome(state)` returning terminal status, success and a fixed score.

Use `HierarchicalPlayer` as the session's reflex and `runResearch` for experiments. A tiny research entry point can call `runResearchCli`; its package advertises `gamebot.researchBin`. See the 2048 and Snake `learning.ts` files for two implementations. Research currently requires fresh episodic environments; checkpoint creation for persistent worlds must be supplied by their game integration. Browser perception, live-game connections and rules stay in game packages.

The old `tools/` draft area remains inert. Executable policy artifacts are a separate, explicitly evaluated route; this does not enable arbitrary scripts in skill folders.
