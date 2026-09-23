# @gamebot/chess

Chess bridge for `@gamebot/core`. Gamebot plays White against a seeded legal-move Black opponent. `chess.js` supplies the rules, legal candidates, and terminal outcome; this package supplies the Gamebot adapter and terminal runner.

From the Gamebot workspace:

```sh
npm run game -- --game=chess
npm run game -- --game=chess --seed=42
```

Add `--ai` and set `GAMEBOT_REFLEX_MODEL` or `GAMEBOT_MODEL` to use a model for White. The default is a deterministic capture/check heuristic. A score of `1` is a White win, `0.5` a draw or unfinished game, and `0` a Black win. The executable is `gamebot-chess` when this package is installed.

The runner creates a writable `.gamebot/games/chess/tools/` directory in the current working directory for agent-authored drafts. The package's [`tools/`](tools) directory is reserved for reviewed game-specific implementations. A draft may analyze chess state or propose a move, but it does not become callable merely by being placed there; the bridge must register it explicitly.
