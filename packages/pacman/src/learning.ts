import type { LearningGame } from "@gamebot/core";
import { legalDirections, type Direction, type PacmanState } from "pacman-game";
import type { PacmanSession } from "./session.js";

export function learningPacman(session: PacmanSession): LearningGame<PacmanState, Direction> {
  return {
    id: "pacman", version: "maze-v1", realtime: true,
    goal: { id: "clear-maze", description: "Collect every pellet before losing all three lives" },
    rules: `Pac-Man moves on a 15x15 maze. # is a wall, . a pellet, o a power pellet, and space a cleared floor.
The structured state includes terrain, player {x,y}, ghosts [{x,y}], direction, lives, score, pelletsRemaining, powerTicks, invulnerableTicks, tick, running, won, and over. Coordinates start top-left, x right, y down. The board overlays P and G for display.
Choose up/right/down/left. Only currently open directions are offered. An input queues a turn; after the first input the native game advances one tick every ${session.tickIntervalMs} ms even while models think. If the queued turn is blocked, Pac-Man continues in the previous direction if possible, otherwise waits at the wall.
Every traversed pellet gives 10 points; power pellets give 50 points and let Pac-Man eat ghosts for 200 points during 35 ticks. Ghosts move autonomously every three ticks: one pursues or flees, the other partly wanders. Ghost contact costs a life unless powered or briefly invulnerable after losing a life. Losing the third life ends the game. Clearing all pellets wins.
The game is seeded, but future ghost choices are hidden. State ages during inference, so weigh reasoning latency against the movement deadline. GameBot cannot pause the game.`,
    create: seed => session.create(seed),
    candidates: { generate: ({ observation }) => observation.state.over ? [] : legalDirections(observation.state)
      .map(direction => ({ id: direction, action: direction, description: `Turn ${direction}` })) },
    verifier: { verify: ({ before, after, executionError }) =>
      executionError ? { status: "failure", reason: String(executionError) } :
        after.state.lives < before.state.lives ? { status: "failure", reason: "life lost" } :
          after.state.tick > before.state.tick ? { status: "success" } :
            { status: "unknown", reason: "native clock has not advanced" } },
    outcome: state => ({ done: state.over, won: state.won, score: state.score }),
  };
}
