# snake-game

Standalone, seeded, real-time Snake. This package contains the rules, clock, and browser window. It has no GameBot dependency.

From the repository root:

```sh
npm run play -w snake-game
```

The command prints a local browser URL. Open it and use the arrow keys; the first input starts the clock. The game continues at its own pace after that. Ctrl+C or **Close game** ends it. Optional arguments after `--` are tick interval in milliseconds, headless flag, and seed, for example `npm run play -w snake-game -- 200 false 7`.

The game exposes its authoritative observation at `GET /state` and accepts directions at `POST /input`. The optional `@gamebot/snake` bridge launches this package in a separate process and communicates with it through the game's process interface.
