import type { GameAdapter } from "@gamebot/core";

export type Direction = "up" | "right" | "down" | "left";
export interface Point { x: number; y: number }

export interface SnakeState {
  width: number;
  height: number;
  body: readonly Point[];
  food?: Point;
  direction: Direction;
  alive: boolean;
  foodEaten: number;
  tick: number;
  board: string;
}

const directions: readonly Direction[] = ["up", "right", "down", "left"];
const offset: Record<Direction, Point> = {
  up: { x: 0, y: -1 }, right: { x: 1, y: 0 },
  down: { x: 0, y: 1 }, left: { x: -1, y: 0 },
};

function same(a: Point, b: Point): boolean { return a.x === b.x && a.y === b.y; }

export function legalDirections(state: SnakeState): readonly Direction[] {
  return directions.filter(direction =>
    offset[direction].x !== -offset[state.direction].x ||
    offset[direction].y !== -offset[state.direction].y);
}

export function wouldCollide(state: SnakeState, direction: Direction): boolean {
  const head = state.body[0]!;
  const next = { x: head.x + offset[direction].x, y: head.y + offset[direction].y };
  if (next.x < 0 || next.x >= state.width || next.y < 0 || next.y >= state.height) return true;
  const eating = state.food !== undefined && same(next, state.food);
  return state.body.slice(0, eating ? undefined : -1).some(part => same(part, next));
}

export function foodDistance(state: SnakeState, direction: Direction): number {
  if (!state.food) return 0;
  const head = state.body[0]!;
  return Math.abs(head.x + offset[direction].x - state.food.x) +
    Math.abs(head.y + offset[direction].y - state.food.y);
}

/** Seeded grid Snake; the runtime sees state and candidate directions, not game internals. */
export class SnakeGame implements GameAdapter<SnakeState, Direction> {
  private readonly width = 8;
  private readonly height = 8;
  private body: Point[] = [{ x: 3, y: 4 }, { x: 2, y: 4 }, { x: 1, y: 4 }];
  private direction: Direction = "right";
  private food?: Point;
  private alive = true;
  private eaten = 0;
  private tick = 0;
  private randomState: number;
  private lastEvent?: string;

  constructor(seed: number, readonly targetFood = 5) {
    this.randomState = seed >>> 0;
    this.food = this.spawnFood();
  }

  async observe() {
    return {
      state: {
        width: this.width, height: this.height,
        body: this.body.map(part => ({ ...part })),
        food: this.food && { ...this.food },
        direction: this.direction, alive: this.alive,
        foodEaten: this.eaten, tick: this.tick, board: this.board(),
      },
      revision: String(this.tick),
      time: { turn: this.tick },
      events: this.lastEvent ? [this.lastEvent] : [],
    };
  }

  validateAction(action: Direction, observation: { revision?: string; state: SnakeState }) {
    return observation.revision === String(this.tick) && this.alive &&
      legalDirections(observation.state).includes(action);
  }

  async execute(action: Direction, signal: AbortSignal) {
    if (signal.aborted) return;
    const head = this.body[0]!;
    const next = { x: head.x + offset[action].x, y: head.y + offset[action].y };
    const eating = this.food !== undefined && same(next, this.food);
    const occupied = this.body.slice(0, eating ? undefined : -1).some(part => same(part, next));
    this.direction = action;
    this.tick++;
    if (next.x < 0 || next.x >= this.width || next.y < 0 || next.y >= this.height || occupied) {
      this.alive = false;
      this.lastEvent = "collision";
      return;
    }
    this.body.unshift(next);
    if (eating) {
      this.eaten++;
      this.food = this.eaten >= this.targetFood ? undefined : this.spawnFood();
      this.lastEvent = "food eaten";
    } else {
      this.body.pop();
      this.lastEvent = undefined;
    }
  }

  outcome() {
    return { complete: !this.alive || this.eaten >= this.targetFood,
      score: Math.min(1, this.eaten / this.targetFood) };
  }

  status() {
    if (!this.alive) return "Collision";
    if (this.eaten >= this.targetFood) return "Food target reached";
    return "Step limit reached";
  }

  private spawnFood(): Point | undefined {
    const empty: Point[] = [];
    for (let y = 0; y < this.height; y++) for (let x = 0; x < this.width; x++) {
      const point = { x, y };
      if (!this.body.some(part => same(part, point))) empty.push(point);
    }
    this.randomState = (Math.imul(this.randomState, 1664525) + 1013904223) >>> 0;
    return empty[Math.floor(this.randomState / 0x100000000 * empty.length)];
  }

  private board(): string {
    const rows: string[] = [];
    for (let y = 0; y < this.height; y++) {
      let row = "";
      for (let x = 0; x < this.width; x++) {
        const point = { x, y };
        row += same(this.body[0]!, point) ? "@" :
          this.body.slice(1).some(part => same(part, point)) ? "o" :
          this.food && same(this.food, point) ? "*" : "·";
      }
      rows.push(row);
    }
    return rows.join("\n");
  }
}
