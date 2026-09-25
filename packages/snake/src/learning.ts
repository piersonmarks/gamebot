import type { LearningGame } from "@gamebot/core";
import { legalDirections, type Direction, type SnakeState } from "./game.js";

import type { SnakeSession } from "./session.js";

export function learningSnake(session: SnakeSession): LearningGame<SnakeState, Direction> {
  const { tickIntervalMs } = session;
  return {
    id: "snake", version: "independent-v1", realtime: true,
    goal: { id: "fill-board", description: "Grow as long as possible without colliding; fill the board to win" },
    rules: `Snake moves on a width by height grid. Coordinates start at the top-left; x increases right, y increases down.
State includes body (head first), direction, food {x,y}, alive, foodEaten, tick and a text board.
The first direction input starts the game. After that, Snake advances one cell every ${tickIntervalMs} milliseconds of real time,
including while any model thinks, while learning runs, and in headless mode. There is no pause action.
Inputs up/right/down/left set the next direction; without new input the snake continues straight. Reversing is forbidden.
State includes tickIntervalMs, nextTickInMs and running. Observations age during inference; late advice can miss a turn or arrive after collision.
Weigh reasoning latency against the next movement deadline. Code can avoid inference delay; requesting intelligence does not stop the clock.
Moving outside the grid or into the body loses. The tail vacates its cell on non-eating moves, so entering that cell is allowed.
Eating food grows the body by one and spawns new food in a random empty cell. Future food locations are hidden.
The game ends only on collision or when the board is full. Filling the board wins; otherwise maximize food eaten before collision.`,
    create: seed => session.create(seed),
    candidates: { generate: ({ observation }) => !observation.state.alive || observation.state.body.length === observation.state.width * observation.state.height ? [] : legalDirections(observation.state)
      .map(direction => ({ id: direction, action: direction, description: `Move ${direction}` })) },
    verifier: { verify: ({ after, executionError }) => executionError ? { status: "failure", reason: String(executionError) }
      : !after.state.alive ? { status: "failure", reason: "collision" } : { status: "success" } },
    outcome: state => {
      const won = state.alive && state.body.length === state.width * state.height;
      return { done: !state.alive || won, won, score: state.foodEaten };
    },
  };
}
