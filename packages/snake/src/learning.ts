import type { LearningGame } from "@gamebot/core";
import { SnakeGame, legalDirections, type Direction, type SnakeState } from "./game.js";

export function learningSnake(target = 5): LearningGame<SnakeState, Direction> {
  if (!Number.isInteger(target) || target < 1 || target > 61) throw new Error("Snake --target must be from 1 to 61");
  return {
    id: "snake", version: "grid-v1",
    goal: { id: "eat-food", description: `Eat ${target} pieces of food without colliding` },
    rules: `Snake moves on a width by height grid. Coordinates start at the top-left; x increases right, y increases down.
State includes body (head first), direction, food {x,y}, alive, foodEaten, tick and a text board.
Each action up/right/down/left advances one cell; reversing the current direction is forbidden.
Moving outside the grid or into the body loses. The tail vacates its cell on non-eating moves, so entering that cell is allowed.
Eating food grows the body by one and spawns new food in a random empty cell. Future food locations are hidden.
Reach the user's food target without a collision to win.`,
    create: seed => new SnakeGame(seed, target),
    candidates: { generate: ({ observation }) => legalDirections(observation.state)
      .map(direction => ({ id: direction, action: direction, description: `Move ${direction}` })) },
    verifier: { verify: ({ after, executionError }) => executionError ? { status: "failure", reason: String(executionError) }
      : !after.state.alive ? { status: "failure", reason: "collision" } : { status: "success" } },
    outcome: state => ({ done: !state.alive || state.foodEaten >= target, won: state.alive && state.foodEaten >= target, score: state.foodEaten }),
  };
}
