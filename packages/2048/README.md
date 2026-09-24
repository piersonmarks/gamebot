# @gamebot/2048

A visible-browser Gamebot bridge for the creator's [Classic 2048 website](https://classic.play2048.co/). The game source is not bundled in this package. This integration uses `@gamebot/browser` for keyboard input and reads the current board, score, and terminal flags without screenshots. Gamebot's `SessionRuntime` chooses and verifies each move.

Install Gamebot's dependencies and [configure the three models](../../docs/learning.md), then start play:

```sh
npm install
npm run game -- --game=2048
```

By default, the bridge opens the live Classic website; it does not download the game. It reuses Playwright's browser if present, then looks for installed Chrome, Edge, or Chromium before downloading Playwright Chromium. You can play offline from an existing checkout of the [original game source](https://github.com/gabrielecirulli/2048) with `--game-dir=/path/to/2048` or `GAMEBOT_2048_DIR`.

The command opens the game in a visible browser window and plays until it reaches 2048, loses, or runs out of legal moves. The result stays visible until Ctrl+C. Pass `--turns=200` for a bounded experiment (`--steps=200` also works), `--target=256` for an earlier goal, or `--seed=42` to change the run. `--pace=0` removes the default 200 ms pause between moves for faster replay. Ctrl+C interrupts the active decision and closes the window; the final output includes the stop reason. The default is a new AI player: the strategist establishes the approach before the first move, the tactician supervises progress, and the reflex/JEV layer chooses actions. Pass `--policy=latest` to explicitly use the latest evaluated player, `--policy=/path/to/player.json` for a particular revision, or `--policy=builtin` for the original heuristic benchmark. Explicit legacy weight JSON paths remain supported. If no new player artifact exists, `--policy=latest` can still replay a legacy `active-policy.json`. `--ai` is now an alias for the default behavior.

Choose the objective with a plain-text goal in either play or autoplay:

```sh
npm run autoplay -- --game=2048 --goal="win"
npm run autoplay -- --game=2048 --goal="maximize score"
npm run game -- --game=2048 --goal="maximize score" --policy=latest
```

`win` is the default: reach 2048 (or `--target=256`, for example), then stop. `maximize score` (also `max score` or `maximise score`) clicks **Keep going** after reaching 2048 and plays until game over or the turn limit. Research compares raw final scores for this goal; it has no binary win threshold, so `firstWin` remains null and `goalReachedOnTest` remains false. Compare `selectedTest.meanScore` instead. Use the same `--turns` budget when comparing score experiments. Names ignore case and extra whitespace; `--goal "maximize score"` also works. Unsupported goals are rejected, and `--target` cannot be combined with score mode. Winning retains the existing win-first evaluation; this option does not add speed or model-cost optimization.

`--policy=latest` selects the saved player for the chosen goal and target. Explicit artifacts from another goal are rejected. Older game-wide artifacts are reused only when their goal matches; legacy `active-policy.json` fallback applies only to the default 2048 win goal.

Add `--verbose` to print board state, strategic setup and revisions, tactical reviews, reflex decision summaries, code-versus-AI choices, verification and model usage. These are recorded decisions and summaries, not private model reasoning. The session trace is saved under `.gamebot/traces/`.

To test screenshot-based observation instead of the site's structured state, set `AI_GATEWAY_API_KEY` and run `npm run game -- --game=2048 --observe=vision --steps=10`. Vision defaults to the current `google/gemini-3.8-flash` Gateway model; set `GAMEBOT_VISION_MODEL` to another vision-capable model ID to swap it. Each observation sends a screenshot to the model and reports token use and latency, so this mode is slower and incurs model charges. Gamebot validates the returned 4×4 board and checks each observed move against 2048's transition rules before accepting it.

On a machine without a graphical desktop, use `--headless` for a smoke run; it saves a final board screenshot under `.gamebot/screenshots/`. `GAMEBOT_CHROME=/path/to/chrome` can point Playwright at a browser in a nonstandard location. To watch a run on a remote server, provide a remote desktop or browser stream; headed Chromium appears on the machine that launches it.

This bridge is tailored to the Classic site's `gameState` snapshot and rendered tiles. It does not support the redesigned site at play2048.co. Each new browser game should have its own package with its own observation, action, and verification rules.

The runner creates `.gamebot/games/2048/tools/` for game-scoped agent tool drafts. Drafts are inert until the bridge explicitly registers a reviewed implementation; `tools/` in this package is reserved for those implementations.

To run the outer research loop with one command:

```sh
npm run autoplay -- --game=2048
```

For a separate rules-and-goal-only evaluation, use `npm run autoplay -- --game=2048 --cold-start --seed=1 --verbose`. It excludes prior GameBot knowledge and keeps all results inside the experiment without replacing your saved player. The final report separates the initial player's results, first win, and final evaluation on new seeds. See [cold-start evaluation](../../docs/learning.md#cold-start-evaluation).

Research starts with rules and an AI policy, records gameplay from the actual browser page, and asks the strategist to diagnose outcomes and propose a revised player. Revisions can change prompts, review intervals, or introduce executable search/scoring code and hybrid AI delegation. Ordinary play and research share the browser session and keyboard bridge. Every training, validation, and final evaluation attempt runs the original game at `https://classic.play2048.co/` (or your separate `--game-dir` checkout). Between attempts, the same page reloads with saved board state cleared and a seeded random stream for matched comparisons. The game window opens by default and stays visible when research finishes; Ctrl+C or closing the window stops the run. `--headless` hides the browser window and exits on completion; it does not substitute a simulator. Research currently reads structured board state; `--observe=vision` remains available for ordinary play. Game rules and evaluation stay fixed outside the editable policy.

Promising revisions must improve matched training and fresh validation games, then pass a final comparison on previously unseen seeds. Research resumes the latest evaluated player; `--fresh` starts over without prior policies or findings. Use `--rounds=5 --games=3 --turns=5000 --seed=1 --max-calls=10000` to configure the experiment. Autoplay opens a live view of the actual research boards by default, including strategy and tactical updates. Use `--headless` to opt out and `--pace=0` for full speed. `--watch` is an explicit alias for the default visible mode. The final board stays visible until Ctrl+C. Ctrl+C interrupts the loop. More evaluation games provide stronger evidence; the loop does not guarantee a win or optimality.

Policies and full journals are saved under `.gamebot/research/2048/`; `.gamebot/games/2048/goals/<goal-key>/latest-player.json` stores the selected evaluated player separately for each goal and target. These paths are relative to the GameBot repository root under the unified launcher, which prints the data directory at startup. Relative `--policy` and `--game-dir` paths also resolve from that root. On the first non-cold-start launch, missing files from the old package-local `.gamebot/` directory are copied into the root directory; existing root files take precedence and originals are retained. Ordinary play never loads research implicitly. See the [shared learning guide](../../docs/learning.md) for the policy code contract, execution limits, model configuration and extension interface.
