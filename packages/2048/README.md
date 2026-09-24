# @gamebot/2048

A visible-browser Gamebot bridge for the creator's [Classic 2048 website](https://classic.play2048.co/). The game source is not bundled in this package. This integration uses `@gamebot/browser` for keyboard input and reads the current board, score, and terminal flags without screenshots. Gamebot's `SessionRuntime` chooses and verifies each move.

Install Gamebot's dependencies and [configure the three models](../../docs/learning.md), then start play:

```sh
npm install
npm run game -- --game=2048
```

By default, the bridge opens the live Classic website; it does not download the game. It reuses Playwright's browser if present, then looks for installed Chrome, Edge, or Chromium before downloading Playwright Chromium. You can play offline from an existing checkout of the [original game source](https://github.com/gabrielecirulli/2048) with `--game-dir=/path/to/2048` or `GAMEBOT_2048_DIR`.

The command opens the game in a visible browser window and plays until it reaches 2048, loses, or runs out of legal moves. The result stays visible until Ctrl+C. Pass `--turns=200` for a bounded experiment (`--steps=200` also works), `--target=256` for an earlier goal, or `--seed=42` to change the run. `--pace=0` removes the default 200 ms pause between moves for faster replay. Ctrl+C interrupts the active decision and closes the window; the final output includes the stop reason. The default is a new AI player: the strategist establishes the approach before the first move, the tactician supervises progress, and the reflex/JEV layer chooses actions. Pass `--policy=latest` to explicitly use the latest evaluated player, `--policy=/path/to/player.json` for a particular revision, or `--policy=builtin` for the original heuristic benchmark. Explicit legacy weight JSON paths remain supported. If no new player artifact exists, `--policy=latest` can still replay a legacy `active-policy.json`. `--ai` is now an alias for the default behavior.

Add `--verbose` to print board state, strategic setup and revisions, tactical reviews, reflex decision summaries, code-versus-AI choices, verification and model usage. These are recorded decisions and summaries, not private model reasoning. The session trace is saved under `.gamebot/traces/`.

To test screenshot-based observation instead of the site's structured state, set `AI_GATEWAY_API_KEY` and run `npm run game -- --game=2048 --observe=vision --steps=10`. Vision defaults to the current `google/gemini-3.8-flash` Gateway model; set `GAMEBOT_VISION_MODEL` to another vision-capable model ID to swap it. Each observation sends a screenshot to the model and reports token use and latency, so this mode is slower and incurs model charges. Gamebot validates the returned 4×4 board and checks each observed move against 2048's transition rules before accepting it.

On a machine without a graphical desktop, use `--headless` for a smoke run; it saves a final board screenshot under `.gamebot/screenshots/`. `GAMEBOT_CHROME=/path/to/chrome` can point Playwright at a browser in a nonstandard location. To watch a run on a remote server, provide a remote desktop or browser stream; headed Chromium appears on the machine that launches it.

This bridge is tailored to the Classic site's `gameState` snapshot and rendered tiles. It does not support the redesigned site at play2048.co. Each new browser game should have its own package with its own observation, action, and verification rules.

The runner creates `.gamebot/games/2048/tools/` for game-scoped agent tool drafts. Drafts are inert until the bridge explicitly registers a reviewed implementation; `tools/` in this package is reserved for those implementations.

To run the outer research loop with one command:

```sh
npm run autoplay -- --game=2048
```

Research starts with rules and an AI policy, records simulated gameplay, and asks the strategist to diagnose outcomes and propose a revised player. Revisions can change prompts, review intervals, or introduce executable search/scoring code and hybrid AI delegation. The same player implementation runs against the simulator and browser. Game rules and evaluation stay fixed outside the editable policy.

Promising revisions must improve matched training and fresh validation games, then pass a final comparison on previously unseen seeds. Research resumes the latest evaluated player; `--fresh` starts over without prior policies or findings. Use `--rounds=5 --games=3 --turns=5000 --seed=1 --max-calls=10000` to configure the experiment. `--watch` replays the selected artifact in a visible browser. Ctrl+C interrupts the loop. More evaluation games provide stronger evidence; the loop does not guarantee a win or optimality.

Policies and full journals are saved under `.gamebot/research/2048/`; `.gamebot/games/2048/latest-player.json` points to the selected evaluated player. These paths are relative to the package directory under the unified launcher. Ordinary play never loads research implicitly. See the [shared learning guide](../../docs/learning.md) for the policy code contract, execution limits, model configuration and extension interface.
