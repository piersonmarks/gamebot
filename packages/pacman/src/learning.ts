import type { LearningGame } from "@gamebot/core";
import type { Direction, PacmanState } from "./game.js";
import type { PacmanSession } from "./session.js";

const directions: Direction[] = ["up", "right", "down", "left"];

export function learningPacman(session: PacmanSession): LearningGame<PacmanState, Direction> {
  const outcome = (state: PacmanState) => ({ done: state.over, won: state.won, score: state.score });
  return {
    id: "pacman", version: "jspacman-v1", realtime: true,
    goal: { id: "clear-maze", description: "Clear the first Pac-Man maze before running out of lives" },
    goalOptions: { win: { objective: "achievement", description: "Clear the first maze before running out of lives", outcome } },
    rules: `This is the independently hosted arcade-style Pac-Man game. Its browser owns the 60 Hz clock, ghosts, maze, scoring, and lives. GameBot can only observe state and press arrow keys; it cannot pause the game.
The state has terrain (rows top-to-bottom, columns left-to-right; # wall, . pellet, o energizer, space cleared floor), player {x,y}, ghosts [{x,y,name,frightened}], direction, lives, score, pelletsRemaining, level, tick, running, won, over. Coordinates are maze tiles, x right, y down. The maze has tunnels at its horizontal edges.
Choose up/right/down/left to hold that arrow key for ${session.holdMs} ms. Pac-Man keeps moving after a key is released and while models think. Turns can be queued shortly before an intersection; a blocked turn may leave him moving in his previous direction. Ghosts move continuously and choose future turns autonomously. Energizers let Pac-Man eat frightened ghosts temporarily. Clearing all pellets on level 1 wins; losing all lives ends the attempt. The browser game is reseeded for each new attempt, but future ghost choices are hidden. Reasoning latency matters because the game keeps moving.`,
    create: seed => session.create(seed),
    candidates: { generate: ({ observation }) => observation.state.over ? [] : directions.map(direction =>
      ({ id: direction, action: direction, description: `Hold ${direction}` })) },
    verifier: { verify: ({ before, after, executionError }) =>
      executionError ? { status: "failure", reason: String(executionError) } :
        after.state.lives < before.state.lives ? { status: "failure", reason: "life lost" } :
          after.state.tick > before.state.tick ? { status: "success" } :
            { status: "unknown", reason: "browser clock has not advanced" } },
    outcome,
  };
}
