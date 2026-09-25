import { LocalGameSession } from "@gamebot/core";
import { SnakeGame } from "./game.js";

/** Optional bridge to the independent Snake application. */
export class SnakeSession extends LocalGameSession {
  constructor(tickIntervalMs = 120) {
    super(tickIntervalMs, import.meta.resolve("snake-game/process"), "Snake");
  }

  async create(seed: number): Promise<SnakeGame> {
    return new SnakeGame(this, await this.createGame(seed));
  }
}
