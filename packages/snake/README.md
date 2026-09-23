# @gamebot/snake

Seeded grid Snake bridge for `@gamebot/core`. It has its own game rules, Gamebot adapter, terminal runner, and no chess dependency. The objective is to eat five pieces of food without colliding.

From the Gamebot workspace:

```sh
npm run snake
npm run snake -- --seed=42
```

Add `--ai` and set `GAMEBOT_REFLEX_MODEL` or `GAMEBOT_MODEL` to use a model instead of the deterministic safe-distance heuristic. The score is food eaten divided by five; an episode ends on collision or reaching the food target. The executable is `gamebot-snake` when this package is installed.
