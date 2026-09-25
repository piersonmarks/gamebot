import { LocalGameSession } from "@gamebot/core";
import { PacmanGame } from "./game.js";

/** Optional GameBot bridge to the independent Pac-Man maze application. */
export class PacmanSession extends LocalGameSession {
  constructor(tickIntervalMs = 140) {
    super(tickIntervalMs, import.meta.resolve("pacman-game/process"), "Pac-Man");
  }

  async create(seed: number): Promise<PacmanGame> {
    return new PacmanGame(this, await this.createGame(seed));
  }
}
