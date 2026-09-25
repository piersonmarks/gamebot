# @gamebot/snake

Seeded real-time Snake bridge for `@gamebot/core`. A separate Node process owns the native rules, clock, and browser window; the GameBot adapter only reads state and submits direction inputs. The default evaluation objective is five pieces of food without colliding; `--target` changes it. Reaching that objective ends the evaluation attempt, but does not freeze the native game or remove its food. The native game ends on collision or a full board. Use `--target=61` to evaluate filling the entire 8×8 board.

After [configuring the three models](../../docs/learning.md):

```sh
npm run game -- --game=snake --verbose
npm run autoplay -- --game=snake --fresh --rounds=5 --games=3
npm run game -- --game=snake --policy=latest
```

Autoplay also opens a live browser view by default, following the actual research attempts and strategy/tactic updates; `--headless` opts out.

The first direction input starts the game. Once running, the snake advances every 120 ms, continuing in its last direction whenever no fresh direction arrives. Models cannot pause it. Even suspending or blocking the agent process leaves game physics and browser updates running. The viewer uses native game state, so delayed agent receipts cannot rewind the board. Headless play uses the same clock. `--pace=200` sets a 200 ms game tick; it must be positive and does not add a delay after each decision.

Observations include `tickIntervalMs`, `nextTickInMs`, and `running`, so the player can weigh inference latency against the next movement deadline. Direction inputs are checked against the latest state before dispatch. Slow reasoning can miss turns and cause a collision; fast code can avoid that inference delay. Jev or the active generated code continues choosing directions while tactical, strategic, and learning reviews run in the background. Completed updates are applied between decisions; stale one-move advice is discarded. No automatic fallback controller is inserted. Planning before the first input happens on the ready board.

Ordinary play starts AI-first with strategic setup, tactical reviews, and reflex/JEV action selection. It never loads a learned policy implicitly. `--policy=latest` or an artifact path explicitly selects a saved player; `--policy=builtin` runs the older safe-distance heuristic without model calls. `--ai` is an alias for the default behavior.

Research uses the same shared runner as 2048, including AI/code/hybrid revisions, isolated generated code, matched comparisons, and versioned evidence. See the [learning guide](../../docs/learning.md) for configuration and budgets. Snake's fixed evaluation score is food eaten. A collision before the target is a loss; reaching the target records success. A later collision during review does not undo that achievement. Autoplay can reset the game for the next attempt after requested reviews settle.

Snake opens the installed default browser and also prints its local URL. Arrow keys send native direction inputs. Use `--headless` to skip opening the browser. `--watch` also prints a terminal board. `--seed`, `--turns`, `--pace`, `--max-calls`, and `--verbose` configure play. `--turns` limits submitted decisions, not autonomous game ticks. Finishing or disposing the agent session detaches control; it does not stop the clock. Ctrl+C or the window’s **Close game** button explicitly closes the application. If the agent dies unexpectedly, a visible game stays open and playable; a headless game closes automatically. The window stays open after an ordinary evaluation attempt until explicitly closed.

Player artifacts are separate from inert `tools/` drafts; arbitrary files in that directory are not automatically executed.
