# @gamebot/snake

Seeded grid Snake bridge for `@gamebot/core`. It owns its rules and game adapter. The default objective is five pieces of food without colliding; `--target` changes it.

After [configuring the three models](../../docs/learning.md):

```sh
npm run game -- --game=snake --verbose
npm run autoplay -- --game=snake --fresh --rounds=5 --games=3
npm run game -- --game=snake --policy=latest
```

Ordinary play starts AI-first with strategic setup, tactical reviews, and reflex/JEV action selection. It never loads a learned policy implicitly. `--policy=latest` or an artifact path explicitly selects a saved player; `--policy=builtin` runs the older safe-distance heuristic without model calls. `--ai` is an alias for the default behavior.

Research uses the same shared runner as 2048, including AI/code/hybrid revisions, isolated generated code, matched comparisons, and versioned evidence. See the [learning guide](../../docs/learning.md) for configuration and budgets. Snake's fixed evaluation score is food eaten; collisions end an episode as a loss.

The unified game command enables `--window` and prints a local browser URL for a read-only live board. `--watch` also prints a terminal board. `--seed`, `--turns`, `--pace`, `--max-calls`, and `--verbose` configure play. Ctrl+C interrupts decisions and closes the viewer. The final board stays visible after the episode until interrupted.

Player artifacts are separate from inert `tools/` drafts; arbitrary files in that directory are not automatically executed.
