import type { GameAdapter, Observation } from "@gamebot/core";
import { legalDirections, type SnakeState, type Direction } from "snake-game";
import type { SnakeSession } from "./session.js";
export { legalDirections, wouldCollide, foodDistance } from "snake-game";
export type { Direction, Point, SnakeState } from "snake-game";

/** Read/input bridge. Game physics and rendering live in the separate Snake process. */
export class SnakeGame implements GameAdapter<SnakeState, Direction> {
  private detached = false;
  constructor(private readonly session: SnakeSession, private readonly gameId: string) {}

  observe(): Promise<Observation<SnakeState>> {
    return this.session.request({ type: "observe", gameId: this.gameId });
  }

  validateAction(action: Direction, observation: Observation<SnakeState>): boolean {
    return !this.detached && observation.revision?.startsWith(`${this.gameId}:`) === true &&
      observation.state.alive && observation.state.food !== undefined && legalDirections(observation.state).includes(action);
  }

  async execute(action: Direction, signal: AbortSignal): Promise<void> {
    if (this.detached) throw new Error("Snake controls are detached");
    await this.session.request({ type: "input", gameId: this.gameId, action }, signal);
  }

  /** Detaching the player must not stop the external game's clock. */
  dispose(): void { this.detached = true; }
}
