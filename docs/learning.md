# Continual game learning

2048, Snake, and Pac-Man use the same three-tier player and learning session from `@gamebot/core`. Games supply rules, observations, actions and fixed evaluators. The harness supplies one learning cycle, whether a game lasts seconds or has no ending. No winning strategy is included in the initial model prompts.

## Configure models once

Install dependencies with `npm install`, then configure your AI Gateway key:

```sh
export AI_GATEWAY_API_KEY='your-key'
```

2048, Snake, and Pac-Man use these pinned defaults, verified in the [Gateway catalog](https://ai-gateway.vercel.sh/v1/models) on 2026-09-24:

| Role | Default model | Purpose |
| --- | --- | --- |
| Strategist/researcher | `openai/gpt-6-astra` | Overall strategy, failure analysis and program revisions |
| Tactician | `openai/gpt-6-sol` | Tactical planning and escalation |
| Reflex | `typesafe-ai/jev` | Native typed choice among offered legal actions |

Astra and Sol generate structured plans; [Jev](https://vercel.com/ai-gateway/models/jev) uses the AI SDK's `experimental_evaluate` API to answer a typed choice question. All three use the same Gateway credentials. No model ID configuration is required to start.

`GAMEBOT_STRATEGIST_MODEL` and `GAMEBOT_TACTICIAN_MODEL` override individual language models. Their resolution order is the role-specific variable, then `GAMEBOT_RESEARCH_MODEL` for strategist only, then `GAMEBOT_MODEL`, then the built-in default. `GAMEBOT_REFLEX_MODEL` independently overrides Jev and must identify an evaluation model; `GAMEBOT_MODEL` does not replace it. Empty overrides are rejected; unset a variable to restore its fallback. Programmatic callers pass AI SDK `LanguageModel` implementations for the higher tiers and an `Experimental_EvaluationModel` for reflex decisions. These defaults are initial research choices, not game-specific benchmark winners.

## Play and autoplay

```sh
npm run game -- --game=2048 --verbose
npm run autoplay -- --game=2048 --cold-start --verbose
npm run autoplay -- --game=snake --fresh --turns=1000
npm run game -- --game=2048 --policy=/absolute/path/player.json
npm run game -- --game=2048 --policy=/absolute/path/player.json --no-learn
```

Both ordinary AI play and autoplay learn during play. `game` plays one game; `autoplay` can restart a terminal episodic game and carry the learner forward. Learning reviews themselves never reset the world. Persistent worlds are never automatically recreated, even when their goal becomes terminal. The actual game opens by default. `--headless` hides the browser window; 2048 still uses the real game and keyboard bridge. Closing the window or pressing Ctrl+C interrupts work and saves the learning checkpoint.

Ordinary play starts from a new AI player unless you explicitly choose `--policy=latest` or an artifact path. Autoplay starts from the latest benchmark-qualified player if one exists; `--fresh` starts without that policy. `--cold-start` also isolates the experiment from shared learning. Live revisions and evidence stay in their experiment directory. Neither mode injects a built-in solution. Explicit `--policy=builtin` and legacy 2048 weight files remain frozen heuristic comparisons; `--no-learn` freezes an AI/code artifact for replay.

Autoplay runs until interrupted or a budget is reached. `--turns` caps total decisions in the learning session, `--rounds` caps learning reviews, and `--games` caps completed episodic games. These are optional; the shared `--max-calls` budget still defaults to 10,000. Research/model calls consume that budget too. Retryable provider failures get at most two retries, and every attempt counts. Tokens spent on incomplete responses are recorded. A provider outage or exhausted budget stops work without becoming a game loss or a reason to rewrite the player.

Game and autoplay model generation uses the selected provider's default output allowance. GameBot adds no output token ceiling; provider limits still apply.

## One learning cycle

The cycle is: collect observations and outcomes → review evidence → propose a revision or retain the current player → check executable code → try the revision during play → collect more evidence.

A model-authored observer program inspects observations, Jev judgments, verified outcomes and recent learning evidence. It wakes Sol only when its conditions request attention. Sol then examines the accumulated evidence. It returns an explicit choice: continue (`none`), ask Astra for strategic help (`strategist`), or request a policy/program learning review (`learning`). Astra can also request learning when Sol asks it for strategic help. Jev only answers typed judgments; it does not decide when to escalate.

Milestones, setbacks, native signals, failures, elapsed time and terminal outcomes are evidence for Sol. None automatically invokes Astra or the researcher. Terminal and unavailable-action observations go through the same observer without asking Jev for an impossible move. There are no review timers, turn-count thresholds, or fallback schedules. Removed `--learn-every` and `--learn-ms` flags produce an error; legacy policy interval fields remain readable but are ignored, and new policies use null.

There is no separate post-game learner. A model-requested review closes the current evidence window. Each window records starting and ending states, goal outcomes, progress, model usage, sampled transitions and failed-decision evidence. Unreviewed experience survives game boundaries and interruption. The full journal retains every transition. No whole-game win is required before a model can request a programmatic experiment.

Observation runs as bounded code without inference. Quiet AI play uses Jev alone; quiet generated-code play needs no model calls. For games declaring `realtime: true`, tactical, strategic, and learning reviews run alongside reflex control. Turn-based games can await reviews between actions. Neither mode pauses an external world's clock. The runtime reobserves and validates actions before dispatch. User budgets and Ctrl+C stop work and save evidence; they never initiate a review.

Snake and Pac-Man run their physics and browser views in separate processes and advances on its own real-time clock after the first direction input. Blocking or suspending the agent cannot freeze either. Snake attempts end on collision or a full board, with food eaten as the score; there is no artificial food cutoff. Agent-session disposal only detaches controls. Jev or the active code policy keeps supplying directions during tactical, strategic, and learning reviews; if a reflex decision itself is late, the snake continues straight. The observer decides when to request intelligence with timing information in its observations; the harness does not pause the game or insert automatic fallback moves. Only one supervision/research chain is pending at a time; observer requests coalesce until it completes. Responses become proposals that apply between decisions, retaining the user goal and checking the current state. Stale immediate actions are discarded, and policy or authority changes invalidate outstanding tactical proposals. Revisions are preflighted before activation. Requested reviews settle at game over; Ctrl+C cancels work and saves available evidence. Viewer updates follow game ticks and show which models are busy. For Snake and Pac-Man, `--pace` is the positive native tick interval in milliseconds (defaults 120 and 140), including in headless mode.

The strategist/researcher can revise prompts, Jev questions and composition code, supervision instructions and observer programs, or a generated action-selection program. It can also return no revision and gather more evidence. Rules, goal evaluation and native action legality remain outside the editable player.

## The three tiers

Astra establishes the initial strategy, delegates responsibilities and writes the initial observer. The tactician turns that strategy into lasting objectives; Jev answers typed judgments to choose an offered action. Ordinary planning reviews adapt the current strategy and tactics. Learning reviews can also revise the saved player implementation.

The tactician controls escalation based on evidence. Its tactical `instruction` is a lasting objective; `immediateAction` expires after that decision. Astra is called initially to establish the player, then only when requested by a supervising model during live play. Frozen replay/benchmark players still use tactical supervision, but cannot request live policy revisions.

Player kinds are `ai`, `code`, and `hybrid`. Code defines `choose(input)` and returns an offered ID; hybrid code can return null to delegate to Jev. A program may propose `{ candidateId: null, review: "strategist" }` or request `"tactician"`. The observer sees the proposal and decides whether to wake Sol; program requests do not bypass monitoring. If Sol is awakened, the program runs again with updated context and `reviewCompleted: true`. Otherwise the initial result must supply an action (or delegate to Jev for hybrid policies). Inputs include state, candidates, goal/directive, strategy, tactic, immediate advice, recent decisions, verification and game signals.

Programs run in fresh QuickJS interpreters with 100 ms and 32 MiB limits. They have no imports, filesystem, network, clock or random APIs. Generated code and Jev programs receive preflight contract checks on recorded states before activation. These check bounded execution and legal outputs, not whether an algorithm is optimal. The active program only changes between actions.

## Model-authored monitoring

The policy's `observer` field contains JavaScript defining `observe(input)`, returning `{ wake: boolean, reason: string }`. It cannot act or call a model directly. The harness executes the model's conditions before decisions and after outcomes, including terminal and failed observations. No game-specific wake conditions are built in. A false result makes no Sol/Astra call.

Input includes observation/outcome, authoritative goal/directive, strategy/tactic, native signals, verification, bounded recent decisions with Jev receipts, event details and learning evidence when available. `baseline` contains the observation and outcome from the last supervision, initially the starting observation. Sol returns `observer: null` to retain its current source without rewriting it, or supplies replacement source when monitoring needs to change. Setup requires source when no observer exists. This lets it express what evidence should require attention next without polling through language-model calls.

Observer programs use the same isolated QuickJS limits as action programs. New research revisions check observers on recorded states; tactical replacements are checked on the current observation before activation. A malformed or failing observer stops play and saves evidence. It does not silently wake a model or install a harness-defined fallback.

Checkpoint `controller` state preserves the active observer, baseline, strategy, tactic and recent decisions across persistent-world reconnects. A new episodic world retains its observer but starts a fresh baseline and tactical context. Unreviewed experience remains available to the observer; resuming alone does not wake Sol. A new explicit policy replay starts with that artifact's observer and a fresh baseline, while `--resume` restores the ongoing controller. Older policies without an observer use one Sol setup call to author monitoring, then follow the same event-driven path. Existing artifact IDs are preserved.

## Trying a revision in a persistent world

A passing revision becomes a live trial. The next learning windows provide evidence to keep it locally, reject it, or remain inconclusive. Program failures restore the previous player. Rejection restores behavior, not the world: already executed game actions cannot be undone by rolling back code. Inconclusive revisions retain the original fallback if Astra revises them again.

The researcher sees progress within each window, not just absolute accumulated scores. Bridges can declare a `comparisonKey` for comparable opportunities; measured regressions in progress per decision then reject a trial. Without that key, the harness does not assume that two successive situations are comparable. A locally retained revision is observational evidence, not proof of causal improvement or generality. User goals remain authoritative, including when progress requires an investment before a payoff.

Live learning saves explicit player artifacts and prints their paths. Replay one with `--policy=/path/to/player.json`. It does not overwrite the benchmark-qualified `latest` pointer. This allows persistent worlds to improve and resume with their current player without claiming the guarantees of a controlled experiment.

## Goals

2048 resolves `--goal="win"` and `--goal="maximize score"` directly. Other plain-text requests, such as `--goal="win while reducing model calls"`, ask Astra to choose a fixed evaluator exposed by the bridge. The original request stays authoritative, and the chosen evaluation contract is printed and saved. Unsupported constraints must be reported rather than silently mapped to a different objective.

Win mode stops at the target tile; score mode continues beyond 2048 until game over or a run limit. Goal performance comes first, then efficiency. The evaluator and user intent guide live reviews. For controlled comparisons, wins outrank partial progress, and efficiency breaks ties in achieved performance. Costs include decisions, model calls, tokens and latency; they are not estimated monetary prices.

## Checkpoints and resume

```sh
npm run autoplay -- --game=2048 --resume=.gamebot/research/2048/<run-id>
```

The top-level `.gamebot/research/<game>/<run>/` directory contains:

- `experiment.json`: game, rules, goal, evaluation, model configuration and budgets.
- `runs.jsonl`: full observations/actions, planning and learning decisions, provider events and usage.
- `checkpoint.json`: active policy, fallback/trial, learning history, partial window, pending proposal, observer/controller state and cumulative usage.
- Policy JSON artifacts for explicit replay, plus `result.json` when an autoplay invocation reaches its limit.

Each episode has a stable ID and records its decisions and policies used. A bridge-reported terminal state writes `episode.completed` with the outcome, score, and final state before model review. Stopping a nonterminal episode writes `episode.stopped` with a separate interruption, limit, budget, or error reason; it is not a loss. The current episode record also lives in the checkpoint. Episodic restarts get new IDs, while persistent-world reconnects retain their ID.

Ctrl+C saves the partial window without starting another model call. Resume makes unreviewed evidence available to the observer and Sol; only a review already requested by a model is resumed automatically, reusing any saved proposal. Legacy scheduled review requests are retained as evidence rather than executed. It preserves the model budget; raise `--max-calls` explicitly when necessary. Autoplay resumes its saved total turn/review/game limits; increase those limits to continue beyond them. Keep the same game version, goal and models. Supply bridge options such as `--game-dir` and a nondefault `--target` again.

An episodic bridge starts a fresh board on process resume. A persistent bridge must provide `reconnect()` to attach to its existing world; otherwise resume fails rather than resetting it. Changes that occurred offline are logged separately and excluded from the previous policy's progress window. This is a learning checkpoint, not a universal world save/restore implementation.

Ordinary traces still live under `.gamebot/traces/`. The launcher resolves data and relative paths from the repository root. Older package-local saves are imported without overwriting existing root files; cold-start and resume launches skip that migration.

## Explain a saved player

```sh
npm run report -- .gamebot/research/2048/<run-id>
```

You can also pass that run's `result.json` or `checkpoint.json`. The command writes `report.md` in the run directory, with the saved strategy, tactical and Jev responsibilities, current controller updates, revision history, per-game evidence, model usage, exact generated programs, and a replay command. It uses recorded explanations; it does not call a model, run code from the policy, build connectors, or launch a game.

Reports work for live learning and matched benchmarks, including interrupted runs with a checkpoint. The live checkpoint takes precedence over an older result after resume. Live trials are labeled observational, and benchmark reports include the selected player's held-out results. For older live traces, reports recover outcomes from learning-window records, observer baselines, and checkpoint history only when the structured evidence matches the episode's recorded state. Each result cites its evidence; model prose is never interpreted as a win or loss. Missing or ambiguous evidence remains unknown. A successful game during a changing policy is not treated as proof of the final player's win rate. Keep the whole run directory together when copying it to another machine.

## Optional matched benchmarks

```sh
npm run autoplay -- --game=2048 --benchmark --policy=/absolute/path/player.json --rounds=5 --games=3 --turns=5000
```

A benchmark is a validation method, not a different kind of learning. It uses the same research proposal function, player, goals and program checks. Its evaluated revisions are held fixed while matched seed sets compare them. Training improvements must also pass fresh validation and a final audit before updating `.gamebot/games/<game>/goals/<goal-key>/latest-player.json`.

For `--benchmark`, `--rounds` means revision experiments, `--games` means games per seed set, and `--turns` is the per-game limit. Defaults remain 5, 3 and 5,000. Persistent-world definitions cannot use this reset-based runner. Existing benchmark checkpoints remain resumable, and their mode is detected from their manifest. Small sample sizes provide evidence, not guarantees of universal or optimal play.

Cold-start runs begin with AI decisions and the game's rules/goal, without saved GameBot knowledge, solver examples or assurances that the goal is attainable. The underlying pretrained models may already know a game. To measure transfer, repeat cold starts across different games; a stronger 2048 score alone is insufficient.

### Learned Jev programs

The policy's `jev` field is either `null` (the default legal-action Choice) or an object with two JavaScript source strings:

- `prepare`: defines `function prepare(input)` and returns `{ state, questions }`. It can compute features, filter context, and generate questions for the current candidates. Input includes the observed state, candidates, authoritative goal/directive, strategy, tactic, recent decisions, rules and reflex responsibilities.
- `select`: defines `function select(input)` and returns an offered candidate ID. It receives `{ context, request, answers, providerMetadata }`, where `context` is the original input and `request` is the preparation result. It can combine scores, apply experimentally chosen thresholds, and use computed facts from `request.state`.

Questions use the AI SDK evaluation shapes: Choice (`type: "choice"`, `instructions`, a `criteria` map of option IDs to descriptions or null), Score (`type: "score"`, `instructions`, ordered descriptive `criteria`), or Boolean (`type: "boolean"`, `instructions`; TypeSafe's Noul). One batch supports 1–32 independent questions, with 1–255 options per Choice and 2–255 levels per Score. Instructions and descriptions are strings of up to 6,000 characters. Question IDs start with a letter, contain only letters/digits/underscores, and are at most 64 characters. Choice option IDs are at most 1,024 characters.

The runtime supplies Jev with `{ goal: authoritativeGoal, evidence: preparedState }` and adds the goal-authority instruction to every question. Questions should reference `state.evidence` and `state.goal`. Each answer sees the same state and cannot depend on another answer in that batch. Choice answers contain `choice`, Score answers contain `score`, and Boolean answers contain `probability`. Choice/Score distributions may be absent; provider-specific confidence may appear under `providerMetadata.typesafe.confidence`. Neither is a measured probability of winning.

Preparation and selection each run in a fresh QuickJS interpreter with the same 100 ms / 32 MiB limits as direct policy code. They share no globals or host access. Results are limited to 131,072 JSON characters. The runtime validates questions before any evaluation call, and validates the selected action against the original candidates. Errors reject the decision without a fallback. Custom programs still use one budgeted Jev call per delegated decision; code-only policies require `jev: null`, while hybrid policies use their Jev program when `choose` returns null.

Initial cold-start setup requires `kind: "ai"`, `code: null` and `jev: null`, plus model-authored monitoring code in `observer`. After gameplay, Astra can propose preparation code, question changes and answer-composition code together, evaluated under the same training, validation and final-audit gates as any other policy. No game-specific feature definitions, thresholds or winning questions are supplied by the harness. This follows the [official TypeSafe skill](https://github.com/typesafe-ai/skills/blob/main/skills/typesafe-ai/SKILL.md) and adapts the question-revision pattern from its [autoresearch cookbook](https://docs.typesafe.ai/cookbooks/autoresearch_feature_discovery).

New artifacts use `gamebot-player-v2`; existing `gamebot-player-v1` files load with `jev: null`. The Jev source participates in the policy ID, so each revision and its evaluation evidence remain distinguishable. Verbose output and research journals include the exact evaluation request, returned answers and selected action.

## Integrating a game

Implement `LearningGame<State, Action>` with `id`, `version`, `rules`, `goal`, `create(seed)`, `candidates`, `verifier`, and a fixed `outcome(state)`. A non-ending world can return `done: false` indefinitely; score should measure progress toward the user's goal. The core does not inspect game-specific state fields.

For longer-horizon integrations:

- Set `continuity: "persistent"` and supply `reconnect()` that attaches to the existing world without resetting it.
- Optionally supply `learningFeedback({ before, after, steps, elapsedMs })`, returning `progress` and optional `milestone`, `setback`, or `comparisonKey`. These are bridge-owned measurements, not metrics the learner may rewrite.
- Use native adapter signals for blocked goals, failed tactics and novel situations.
- For custom text goals, expose fixed `goalOptions` and resolve the request before starting the session.

`ContinualLearningSession.open(...)` accepts the game, model runner, cancellation signal and an optional already-connected adapter. `step()` runs the observer around gameplay and fulfills any model-requested supervision/learning. `finish()` cancels work and saves without requesting more AI. `restart()` is allowed only after a terminal episodic game. `runContinualLearning` drives this session for autoplay; `runResearch` remains the optional matched benchmark runner.

A research entry point uses `runResearchCli(game, window)`. A bridge with its own game window supplies `open({ headless, signal, onClose })` returning a closeable handle. 2048 uses the real browser page; Snake and Pac-Man each own a standalone game process and native browser window. Their optional bridges observe and control them; connecting is a bridge responsibility, while rendering belongs to the game. The OpenRCT2 and RuneBench transport bridges still need their own complete learning-game definitions and goal feedback before they can use this loop for autonomous persistent-world play.

The old skill `tools/` draft area remains inert. Generated player artifacts are an explicitly checked execution route; arbitrary scripts in skill folders are not enabled.
