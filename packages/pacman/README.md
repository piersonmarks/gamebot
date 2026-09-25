# @gamebot/pacman

An optional bridge from GameBot to the independent [pacman-game](../pacman-game). GameBot observes the native maze and sends directions; the game owns its clock, ghosts, scoring, and browser window. Agent inference cannot pause it. The bridge can add strategy and tactic text to the window, but cannot replace its game state.

After `npm install`, run:

```sh
npm run game -- --game=pacman
npm run autoplay -- --game=pacman --cold-start
```

The game window opens by default. Use `--headless` to skip opening it, `--pace=200` for a 200 ms native tick, `--turns=100` to limit submitted decisions, and `--seed=7` to vary ghost behavior. Ctrl+C stops the run. The window also accepts arrow keys and has a **Close game** control. **New game** is available in standalone play or after the controller disconnects; autoplay resets through the bridge.

Ordinary play starts with the strategist, tactician, and reflex/JEV player. A model key is needed for that path; `--policy=builtin` selects a deliberately simple pellet-seeking baseline without model calls. Ordinary play never loads a saved player implicitly. `--policy=latest` explicitly replays one; autoplay uses the shared continual-learning loop and can be isolated with `--cold-start`.

This is a compact, original maze chase game inspired by Pac-Man, not an emulator of the commercial game. Its fixed goal is to clear all pellets before losing three lives; score is the evaluation signal. The maze is connected, and ghost movement is seeded.
