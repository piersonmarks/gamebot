# @gamebot/pacman

An optional GameBot bridge for [JS Pac-Man](https://jrhollis.github.io/jspacman/), a separately hosted arcade-style Pac-Man game. The browser game owns its maze, ghosts, scoring, and 60 Hz clock. GameBot reads its live structured state and sends arrow-key input; model inference does not pause play.

After `npm install`, run:

```sh
npm run game -- --game=pacman
npm run autoplay -- --game=pacman --cold-start --goal=win
```

The game window opens by default. Use `--headless` to hide it, `--hold-ms=300` to hold each direction for 300 ms, `--turns=100` to limit decisions, and `--seed=7` to seed the game's random choices. Ctrl+C stops the run. The browser also accepts arrow keys; closing it stops GameBot. Autoplay starts a fresh browser game for each episode.

Ordinary play starts with the strategist, tactician, and reflex/JEV player. A model key is needed for that path; `--policy=builtin` selects a simple pellet-seeking baseline without model calls. Ordinary play never loads a saved player implicitly. `--policy=latest` explicitly replays one; autoplay uses the shared continual-learning loop and can be isolated with `--cold-start`.

The default goal and `--goal=win` both mean clearing the first maze before losing all lives. The hosted game and its page structure are external dependencies; if they change, this bridge may need updating.
