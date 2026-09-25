import type { GameAdapter, Observation } from "@gamebot/core";
import { legalDirections, step, type Direction, type PacmanState, type Point } from "pacman-game";
import type { PacmanSession } from "./session.js";

export { legalDirections } from "pacman-game";
export type { Direction, PacmanState, Point } from "pacman-game";

/** Read/input adapter; all rules and physics live in pacman-game. */
export class PacmanGame implements GameAdapter<PacmanState, Direction> {
  private detached = false;
  constructor(private readonly session: PacmanSession, private readonly gameId: string) {}

  observe(): Promise<Observation<PacmanState>> {
    return this.session.request({ type: "observe", gameId: this.gameId });
  }

  validateAction(action: Direction, observation: Observation<PacmanState>): boolean {
    return !this.detached && observation.revision?.startsWith(`${this.gameId}:`) === true &&
      !observation.state.over && legalDirections(observation.state).includes(action);
  }

  async execute(action: Direction, signal: AbortSignal): Promise<void> {
    if (this.detached) throw new Error("Pac-Man controls are detached");
    await this.session.request({ type: "input", gameId: this.gameId, action }, signal);
  }

  dispose(): void { this.detached = true; }
}

/** Deliberately simple baseline for local play without model credentials. */
export function builtinDirection(state: PacmanState, candidates: readonly Direction[]): Direction {
  const distance = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  const pellets: Point[] = [];
  for (let y = 0; y < state.height; y++) for (let x = 0; x < state.width; x++) {
    if (state.terrain[y]![x] === "." || state.terrain[y]![x] === "o") pellets.push({ x, y });
  }
  return [...candidates].sort((a, b) => {
    const rate = (direction: Direction) => {
      const next = step(state.player, direction);
      const pelletDistance = Math.min(...pellets.map(pellet => distance(next, pellet)));
      const ghostDistance = Math.min(...state.ghosts.map(ghost => distance(next, ghost)));
      return pelletDistance + (state.powerTicks === 0 && state.invulnerableTicks === 0 && ghostDistance <= 2 ? 100 : 0);
    };
    return rate(a) - rate(b);
  })[0]!;
}
