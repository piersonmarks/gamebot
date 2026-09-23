# @gamebot/snake

Seeded grid Snake bridge for `@gamebot/core`. It has its own game rules, Gamebot adapter, terminal runner, and no chess dependency. The objective is to eat five pieces of food without colliding.

From the Gamebot workspace:

```sh
npm run snake
npm run snake -- --seed=42
npm run snake -- --window
```

Add `--ai` and set `GAMEBOT_REFLEX_MODEL` or `GAMEBOT_MODEL` to use a model instead of the deterministic safe-distance heuristic. The score is food eaten divided by five; an episode ends on collision or reaching the food target. The executable is `gamebot-snake` when this package is installed.

`--window` prints a local browser URL for a read-only live board. The runner stays open after the episode so the result remains visible; press Ctrl+C to close it.

The runner creates a writable `.gamebot/games/snake/tools/` directory in the current working directory for agent-authored drafts. The package's [`tools/`](tools) directory is reserved for reviewed game-specific implementations. A draft may analyze Snake state or propose a direction, but it does not become callable merely by being placed there; the bridge must register it explicitly.
