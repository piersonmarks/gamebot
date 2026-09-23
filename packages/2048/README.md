# @gamebot/2048

A visible-browser Gamebot bridge for the **separate** [open-source 2048 game](https://github.com/gabrielecirulli/2048). The game source is not bundled in this package. This integration uses `@gamebot/browser` for keyboard input and reads the current board, score, and terminal flags without screenshots. Gamebot's `SessionRuntime` chooses and verifies each move.

Install Gamebot's dependencies, then run the demo:

```sh
npm install
npm run 2048
```

On first run, the bridge downloads a pinned copy of the original game into your user cache and installs Playwright's Chromium if needed. Neither is bundled into Gamebot. You can use an existing game checkout instead with `--game-dir=/path/to/2048` or `GAMEBOT_2048_DIR`.

The command opens the game in a visible Chromium window, plays up to 100 moves toward a 128 tile, and leaves the result visible until Ctrl+C. Pass `--steps=200`, `--target=256`, or `--seed=42` to change the run. The default policy is a deterministic slide heuristic. Add `--ai` and set `GAMEBOT_REFLEX_MODEL` or `GAMEBOT_MODEL` to an AI Gateway model ID to let a model choose among legal directions; this uses paid model calls when configured.

On a machine without a graphical desktop, use `--headless` for a smoke run; it saves a final board screenshot under `.gamebot/screenshots/`. `GAMEBOT_CHROME=/path/to/chrome` can point Playwright at an existing Chrome binary. To watch a run on a remote server, provide a remote desktop or browser stream; headed Chromium appears on the machine that launches it.

This bridge is tailored to the original repository's local `index.html` and `gameState` snapshot. It does not support the redesigned site at play2048.co. Each new browser game should have its own package with its own observation, action, and verification rules.

The runner creates `.gamebot/games/2048/tools/` for game-scoped agent tool drafts. Drafts are inert until the bridge explicitly registers a reviewed implementation; `tools/` in this package is reserved for those implementations.
