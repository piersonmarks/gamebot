# AI-first play and research

2048 and Snake use the same three-tier player and research runner from `@gamebot/core`. Each game supplies rules, observations, legal actions, a fresh environment, and a fixed evaluator. No game-specific winning strategy is included in the initial model prompts.

## Configure models once

Install dependencies with `npm install`, then configure your AI Gateway key:

```sh
export AI_GATEWAY_API_KEY='your-key'
```

2048 and Snake use these pinned defaults, verified in the [Gateway catalog](https://ai-gateway.vercel.sh/v1/models) on 2026-09-24:

| Role | Default model | Purpose |
| --- | --- | --- |
| Strategist/researcher | `openai/gpt-6-astra` | Overall strategy, failure analysis and program revisions |
| Tactician | `openai/gpt-6-sol` | Tactical planning and escalation |
| Reflex | `typesafe-ai/jev` | Native typed choice among offered legal actions |

Astra and Sol generate structured plans; [Jev](https://vercel.com/ai-gateway/models/jev) uses the AI SDK's `experimental_evaluate` API to answer a typed choice question. All three use the same Gateway credentials. No model ID configuration is required to start.

`GAMEBOT_STRATEGIST_MODEL` and `GAMEBOT_TACTICIAN_MODEL` override individual language models. Their resolution order is the role-specific variable, then `GAMEBOT_RESEARCH_MODEL` for strategist only, then `GAMEBOT_MODEL`, then the built-in default. `GAMEBOT_REFLEX_MODEL` independently overrides Jev and must identify an evaluation model; `GAMEBOT_MODEL` does not replace it. Empty overrides are rejected; unset a variable to restore its fallback. Programmatic callers pass AI SDK `LanguageModel` implementations for the higher tiers and an `Experimental_EvaluationModel` for reflex decisions. These defaults are initial research choices, not game-specific benchmark winners.

## Play or research

```sh
npm run game -- --game=2048 --verbose
npm run autoplay -- --game=2048 --fresh --rounds=5 --games=3 --verbose
npm run game -- --game=2048 --policy=latest
npm run autoplay -- --game=2048 --goal="maximize score"
npm run game -- --game=2048 --goal="maximize score" --policy=latest
npm run autoplay -- --game=snake --fresh --rounds=5 --games=3
```

Ordinary play starts a new AI player unless `--policy=latest` or an explicit artifact path is supplied. It does not read prior research implicitly. `--policy=builtin` explicitly selects the older hand-written heuristic for an offline comparison. In 2048, explicit legacy weight JSON paths also remain playable; `--policy=latest` falls back to a legacy `active-policy.json` only for the default 2048 win goal if no matching new player artifact exists.

Research resumes the latest evaluated player and prior findings by default. `--fresh` starts from rules and an AI player without loading prior policies or findings. This is a new experiment, and its selected player replaces the latest pointer when it completes successfully. `--policy=/absolute/path/player.json` selects a particular starting revision. Policies carry the game ID, rule version and goal; mismatches fail rather than silently replaying a policy for another task.

## Cold-start evaluation

To test whether a new GameBot instance can develop a successful player from its rules and goal:

```sh
npm run autoplay -- --game=2048 --cold-start --seed=1 --verbose
```

Each invocation starts a new process and a separate experiment directory. It loads no previous policies, findings, skills, tool drafts or memory, and does not modify the shared research history or latest policy. `--policy` is rejected in this mode. The first player is AI-only. Subsequent revisions may use evidence and code produced inside this experiment. The models receive the rules, observations, legal actions and goal, with the general three-tier research instructions and execution interface. No example solution, strategy hints, game implementation source, or assertion that the goal is achievable is supplied. Built-in heuristics are not used.

The experiment saves its rules, goal, seed and model/budget configuration in `experiment.json`, and all gameplay/revision evidence in `runs.jsonl`. `result.json` distinguishes the initial player, the first observed win (episode, policy, steps and cumulative model calls), and the selected player's performance on previously unused test seeds. `goalReachedOnTest` means at least one verified goal achievement on that final set; it is not a guarantee of reliable wins. If the initial AI player already wins, that is recorded separately from improvement through research. An interrupted or budget-exhausted run retains its journal but has no completed final-audit result.

Repeat with other `--seed` values for independent cold starts. Reusing a seed reproduces the game random streams, not necessarily model outputs. `--rounds`, `--games`, `--turns` and `--max-calls` bound the experiment. A live browser view opens by default and follows each research attempt; subsequent ordinary play still does not load the result automatically.

This tests a cold harness, not a model with erased pretraining: a pretrained model may already know 2048. No saved GameBot knowledge or demonstrations are supplied, and learning from the run's own feedback is intentional.

Research defaults to five rounds, three games per seed set and 5,000 decisions per game. `--rounds`, `--games`, `--turns`, `--seed` and `--max-calls` are configurable. The shared model-call budget defaults to 10,000; retries are disabled and each request has a two-minute timeout. These commands make model calls and can incur substantial provider costs. A small turn limit is useful for checking setup, but a truncated game is not evidence of a loss. Ctrl+C aborts in-flight model work and leaves completed evidence on disk. The game opens before play starts and keeps the final board visible until Ctrl+C. 2048 research controls the original browser game through the same keyboard bridge as ordinary play, including training, validation, and final evaluation. It reloads the same page between attempts, clearing the saved board and seeding the game’s random stream for matched comparisons. Closing that window also stops research. `--headless` hides the window and exits when research completes; 2048 still runs in a real browser. `--watch` is an optional explicit alias for the default visible mode. `--pace` sets the viewing delay in milliseconds (default 200; use 0 for full speed). 2048 shares ordinary play’s browser discovery and installation behavior. Snake’s viewer uses the installed default browser.

## The three tiers

Before the first action, the strategist understands the rules, enumerates alternatives, chooses an initial AI approach, assigns tactical/reflex responsibilities, and selects review intervals. Its setup completes before play starts.

The tactician translates the strategy into immediate objectives and reviews recent outcomes. It can escalate to the strategist. The reflex/JEV role chooses an offered action. Strategy and tactics are distinct session state; tactical updates do not overwrite the strategic plan. Reviews occur at the selected intervals and on game signals. The current turn-based integrations await these reviews. The underlying session runtime still reobserves and validates the action before dispatch, and a changed user goal cancels in-flight work and starts fresh planning.

The default reflex backend is TypeSafe AI's Jev through Gateway (`typesafe-ai/jev`). Each call supplies the current state, goal, strategy, tactic, reflex instructions and recent outcomes, and asks Jev to choose among the offered candidate IDs. Jev does not generate explanations or code. Verbose events record the chosen ID, its probability distribution when supplied, provider metadata, latency and token use. Model errors and invalid choices fail the decision; they do not silently switch to a language model. Jev calls share the same call budget, cancellation and timeout as the higher tiers.

`HierarchicalPlayer` still accepts an optional `reflex` implementation through the existing `Reflex<State, Action>` interface. It receives the strategy and tactic and replaces Jev for AI decisions without changing the higher tiers. Generated code policies can handle actions directly; hybrid policies return `null` to delegate to Jev (or the explicitly injected backend).

## What research can change

A versioned player artifact includes strategic, tactical and reflex instructions, review intervals, an optional Jev program, and a policy kind:

- `ai`: Jev judgments at the leaves, optionally with learned preparation and answer-composition code.
- `code`: generated JavaScript chooses actions.
- `hybrid`: generated JavaScript chooses actions or returns `null` to delegate to the AI reflex.

The research strategist receives sampled trajectories (including the end of each game), Jev requests and answers for those decisions, fixed evaluation results, previous hypotheses and rejection/error evidence. Failed decisions also retain the observation and any available judgment evidence. It diagnoses failures, enumerates alternatives, and proposes an entire revised player. It can invent scoring features, simulation/search code or a different algorithm. There is no predefined list of weight adjustments or winning implementations. The researcher proposes one experiment each round; this implementation does not yet expose arbitrary investigative tool calls to it.

Candidate code defines `function choose(input)` and returns an offered candidate ID. Input contains observed state, candidates, the authoritative goal and directive, current strategy/tactic, and recent decisions. Plain JavaScript helper functions are allowed. Code executes in QuickJS WebAssembly with a fresh context, 32 MiB memory and a 100 ms execution deadline per invocation. No host objects, filesystem, network or imports are exposed; clock and random APIs are disabled. Invalid actions, exceptions and timeouts become failed experiments. Hybrid fallback is explicit; errors do not silently trigger AI rescue. Higher tiers continue to supervise even when leaf decisions use code.

### Learned Jev programs

The policy's `jev` field is either `null` (the default legal-action Choice) or an object with two JavaScript source strings:

- `prepare`: defines `function prepare(input)` and returns `{ state, questions }`. It can compute features, filter context, and generate questions for the current candidates. Input includes the observed state, candidates, authoritative goal/directive, strategy, tactic, recent decisions, rules and reflex responsibilities.
- `select`: defines `function select(input)` and returns an offered candidate ID. It receives `{ context, request, answers, providerMetadata }`, where `context` is the original input and `request` is the preparation result. It can combine scores, apply experimentally chosen thresholds, and use computed facts from `request.state`.

Questions use the AI SDK evaluation shapes: Choice (`type: "choice"`, `instructions`, a `criteria` map of option IDs to descriptions or null), Score (`type: "score"`, `instructions`, ordered descriptive `criteria`), or Boolean (`type: "boolean"`, `instructions`; TypeSafe's Noul). One batch supports 1–32 independent questions, with 1–255 options per Choice and 2–255 levels per Score. Instructions and descriptions are strings of up to 6,000 characters. Question IDs start with a letter, contain only letters/digits/underscores, and are at most 64 characters. Choice option IDs are at most 1,024 characters.

The runtime supplies Jev with `{ goal: authoritativeGoal, evidence: preparedState }` and adds the goal-authority instruction to every question. Questions should reference `state.evidence` and `state.goal`. Each answer sees the same state and cannot depend on another answer in that batch. Choice answers contain `choice`, Score answers contain `score`, and Boolean answers contain `probability`. Choice/Score distributions may be absent; provider-specific confidence may appear under `providerMetadata.typesafe.confidence`. Neither is a measured probability of winning.

Preparation and selection each run in a fresh QuickJS interpreter with the same 100 ms / 32 MiB limits as direct policy code. They share no globals or host access. Results are limited to 131,072 JSON characters. The runtime validates questions before any evaluation call, and validates the selected action against the original candidates. Errors reject the decision without a fallback. Custom programs still use one budgeted Jev call per delegated decision; code-only policies require `jev: null`, while hybrid policies use their Jev program when `choose` returns null.

Initial cold-start setup requires `kind: "ai"`, `code: null` and `jev: null`. After gameplay, Astra can propose preparation code, question changes and answer-composition code together, evaluated under the same training, validation and final-audit gates as any other policy. No game-specific feature definitions, thresholds or winning questions are supplied by the harness. This follows the [official TypeSafe skill](https://github.com/typesafe-ai/skills/blob/main/skills/typesafe-ai/SKILL.md) and adapts the question-revision pattern from its [autoresearch cookbook](https://docs.typesafe.ai/cookbooks/autoresearch_feature_discovery).

New artifacts use `gamebot-player-v2`; existing `gamebot-player-v1` files load with `jev: null`. The Jev source participates in the policy ID, so each revision and its evaluation evidence remain distinguishable. Verbose output and research journals include the exact evaluation request, returned answers and selected action.

The runtime and game evaluator remain outside the editable player. The candidate is evaluated on matched training seeds. An improvement must also beat the incumbent on fresh matched validation seeds. A final, previously unused seed set compares the selected candidate with the starting player before publication. More wins outrank score; candidates with execution errors cannot be promoted. For 2048, `--goal="win"` (default) stops at the target tile. `--goal="maximize score"` continues past 2048 and compares raw scores at game over or the turn limit; there is no binary win for that objective. Use consistent turn budgets for comparable score experiments. Speed and model cost are not selection objectives. Runtime and model use are reported separately. These are empirical comparisons with stochastic models, not statistical proof of superiority or guarantees of optimal play; increase `--games` for stronger evidence.

## Evidence and extension

Artifacts and complete transition journals live under `.gamebot/research/<game>/<run>/`. The latest evaluated artifact is `.gamebot/games/<game>/goals/<goal-key>/latest-player.json`, keyed by the goal ID and description. `--policy=latest` resolves the current goal; older game-wide artifacts remain readable only for matching goals. A separate research ledger retains hypotheses, diagnoses, acceptance/rejection and errors across experiments. Research evidence is not automatically treated as validated general-purpose memory or promoted across games. Ordinary gameplay traces include strategy/tactic updates, reflex summaries, code-versus-evaluation selection and model token usage. The launcher runs every bridge from the GameBot repository root, so all games share the top-level `.gamebot/` directory. It prints that absolute directory at startup. Relative `--policy` and `--game-dir` arguments resolve from the repository root too. Directly invoked bridge binaries still use their working directory.

On the first standard launch of each bridge, the launcher copies missing files from its old package-local `.gamebot/` directory into the root directory. Existing root files are never overwritten, and the original files remain in place. A `.imported-<game>` marker prevents repeated imports. Cold-start launches skip this import and keep shared learning untouched.

To add a game, implement `LearningGame<State, Action>`:

- `id`, `version`, `rules`, and the authoritative `goal`.
- `create(seed)` returning a fresh game adapter.
- `candidates` and `verifier` using the native game types.
- `outcome(state)` returning terminal status, success and a fixed score.

Use `HierarchicalPlayer` as the session's reflex and `runResearch` for experiments. A research entry point calls `runResearchCli(game, window)` with an `open({ headless, signal, onClose })` method returning a handle with `close()`. This opens the bridge’s actual game connection even in headless mode; `game.create(seed)` resets that connection for each attempt. The window must clean up if opening fails, stop work on abort, and call `onClose` when the user closes it. 2048 uses this interface to reuse the real browser page. A game that needs a viewer can instead pass `{ title, render }`, supplying trusted bridge JavaScript that defines `renderGame(state)` for the shared viewer, as Snake does. Game rendering stays in the bridge; core owns the research lifecycle. Its package advertises `gamebot.researchBin`. A game without a viewer can still run with `--headless`. See the 2048 and Snake `learning.ts` files for two implementations. Research currently requires fresh episodic environments; checkpoint creation for persistent worlds must be supplied by their game integration. Browser perception, live-game connections and rules stay in game packages.

The old `tools/` draft area remains inert. Executable policy artifacts are a separate, explicitly evaluated route; this does not enable arbitrary scripts in skill folders.
