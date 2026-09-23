# @gamebot/2048

A visible-browser Gamebot bridge for the creator's [Classic 2048 website](https://classic.play2048.co/). The game source is not bundled in this package. This integration uses `@gamebot/browser` for keyboard input and reads the current board, score, and terminal flags without screenshots. Gamebot's `SessionRuntime` chooses and verifies each move.

Install Gamebot's dependencies, then run the demo:

```sh
npm install
npm run game -- --game=2048
```

By default, the bridge opens the live Classic website; it does not download the game. It reuses Playwright's browser if present, then looks for installed Chrome, Edge, or Chromium before downloading Playwright Chromium. You can play offline from an existing checkout of the [original game source](https://github.com/gabrielecirulli/2048) with `--game-dir=/path/to/2048` or `GAMEBOT_2048_DIR`.

The command opens the game in a visible browser window and plays until it reaches 2048, loses, or runs out of legal moves. The result stays visible until Ctrl+C. Pass `--steps=200` for a bounded experiment, `--target=256` for an earlier goal, or `--seed=42` to change the run. The final output includes the stop reason. The default policy is a deterministic slide heuristic. Add `--ai` and set `GAMEBOT_REFLEX_MODEL` or `GAMEBOT_MODEL` to an AI Gateway model ID to let a model choose among legal directions; this uses paid model calls when configured.

To test screenshot-based observation instead of the site's structured state, set `AI_GATEWAY_API_KEY` and run `npm run game -- --game=2048 --observe=vision --steps=10`. Vision defaults to the current `google/gemini-3.8-flash` Gateway model; set `GAMEBOT_VISION_MODEL` to another vision-capable model ID to swap it. Each observation sends a screenshot to the model and reports token use and latency, so this mode is slower and incurs model charges. Gamebot validates the returned 4×4 board and checks each observed move against 2048's transition rules before accepting it.

On a machine without a graphical desktop, use `--headless` for a smoke run; it saves a final board screenshot under `.gamebot/screenshots/`. `GAMEBOT_CHROME=/path/to/chrome` can point Playwright at a browser in a nonstandard location. To watch a run on a remote server, provide a remote desktop or browser stream; headed Chromium appears on the machine that launches it.

This bridge is tailored to the Classic site's `gameState` snapshot and rendered tiles. It does not support the redesigned site at play2048.co. Each new browser game should have its own package with its own observation, action, and verification rules.

The runner creates `.gamebot/games/2048/tools/` for game-scoped agent tool drafts. Drafts are inert until the bridge explicitly registers a reviewed implementation; `tools/` in this package is reserved for those implementations.
