import type { LearningGame } from "@gamebot/core";
import { SnakeGame, legalDirections, type Direction, type SnakeState } from "./game.js";

export function learningSnake(target = 5, tickIntervalMs = 120,
  onState?: (state: SnakeState) => void): LearningGame<SnakeState, Direction> {
  if (!Number.isInteger(target) || target < 1 || target > 61) throw new Error("Snake --target must be from 1 to 61");
  if (!Number.isSafeInteger(tickIntervalMs) || tickIntervalMs < 1) throw new Error("Snake --pace must be a positive tick interval in milliseconds");
  return {
    id: "snake", version: "realtime-v1", realtime: true,
    goal: { id: "eat-food", description: `Eat ${target} pieces of food without colliding` },
    rules: `Snake moves on a width by height grid. Coordinates start at the top-left; x increases right, y increases down.
State includes body (head first), direction, food {x,y}, alive, foodEaten, tick and a text board.
The first direction input starts the game. After that, Snake advances one cell every ${tickIntervalMs} milliseconds of real time,
including while any model thinks, while learning runs, and in headless mode. There is no pause action.
Inputs up/right/down/left set the next direction; without new input the snake continues straight. Reversing is forbidden.
State includes tickIntervalMs, nextTickInMs and running. Observations age during inference; late advice can miss a turn or arrive after collision.
Weigh reasoning latency against the next movement deadline. Code can avoid inference delay; requesting intelligence does not stop the clock.
Moving outside the grid or into the body loses. The tail vacates its cell on non-eating moves, so entering that cell is allowed.
Eating food grows the body by one and spawns new food in a random empty cell. Future food locations are hidden.
Reach the user's food target without a collision to win.`,
    create: seed => new SnakeGame(seed, target, tickIntervalMs, onState),
    candidates: { generate: ({ observation }) => !observation.state.alive || observation.state.foodEaten >= target ? [] : legalDirections(observation.state)
      .map(direction => ({ id: direction, action: direction, description: `Move ${direction}` })) },
    verifier: { verify: ({ after, executionError }) => executionError ? { status: "failure", reason: String(executionError) }
      : !after.state.alive ? { status: "failure", reason: "collision" } : { status: "success" } },
    outcome: state => ({ done: !state.alive || state.foodEaten >= target, won: state.alive && state.foodEaten >= target, score: state.foodEaten }),
  };
}
