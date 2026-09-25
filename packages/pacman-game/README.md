# pacman-game

A standalone, small Pac-Man-style maze game. This package owns the rules, ghosts, real-time clock, and browser window. It has no GameBot dependency and uses its own graphics rather than assets from another game.

From the repository root:

```sh
npm run play -w pacman-game
```

Open the printed local URL and use the arrow keys. The first input starts the clock. Collect every pellet to win; touching a ghost costs a life unless a power pellet is active. Three lost lives end the game. **New game** resets the maze; **Close game** or Ctrl+C stops the process.

The default tick is 140 ms. To set the tick and seed, run `npm run play -w pacman-game -- 200 false 7`. `GET /state` provides the authoritative state, while `POST /input` accepts directions. The optional GameBot bridge launches this process and never advances or pauses its clock.
