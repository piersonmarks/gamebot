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
  tickIntervalMs: number;
  nextTickInMs: number;
  running: boolean;
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

/** Seeded real-time Snake; direction inputs never control the passage of game time. */
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
  private clock?: ReturnType<typeof setInterval>;
  private nextTick = 0;
  private started = false;
  private disposed = false;
  private pendingDirection?: Direction;
  private readonly waiting = new Set<() => void>();

  constructor(seed: number, readonly targetFood = 5, readonly tickIntervalMs = 120,
    private readonly onState?: (state: SnakeState) => void) {
    if (!Number.isSafeInteger(tickIntervalMs) || tickIntervalMs < 1) throw new Error("Snake tick interval must be a positive integer");
    this.randomState = seed >>> 0;
    this.food = this.spawnFood();
  }

  async observe() {
    this.advanceClock();
    return {
      state: this.snapshot(),
      revision: String(this.tick),
      time: { turn: this.tick, gameMs: this.tick * this.tickIntervalMs },
      events: this.lastEvent ? [this.lastEvent] : [],
    };
  }

  private snapshot(): SnakeState {
    return {
      width: this.width, height: this.height,
      body: this.body.map(part => ({ ...part })),
      food: this.food && { ...this.food },
      direction: this.direction, alive: this.alive,
      foodEaten: this.eaten, tick: this.tick, board: this.board(),
      tickIntervalMs: this.tickIntervalMs, running: !!this.clock,
      nextTickInMs: this.clock ? Math.max(0, this.nextTick - performance.now()) : 0,
    };
  }

  validateAction(action: Direction, observation: { revision?: string; state: SnakeState }) {
    this.advanceClock();
    return !this.disposed && observation.revision === String(this.tick) && !this.outcome().complete &&
      legalDirections(observation.state).includes(action);
  }

  async execute(action: Direction, signal: AbortSignal) {
    signal.throwIfAborted();
    this.advanceClock();
    if (this.disposed || this.outcome().complete) throw new Error("Snake is no longer running");
    if (!legalDirections(this.snapshot()).includes(action)) throw new Error("Snake cannot reverse direction");
    this.pendingDirection = action;
    if (!this.started) {
      this.started = true;
      this.nextTick = performance.now() + this.tickIntervalMs;
      this.clock = setInterval(() => this.advanceClock(), this.tickIntervalMs);
    }
    // Inputs change the next direction; they never advance or reset the game clock.
    await new Promise<void>(resolve => {
      const done = () => { this.waiting.delete(done); signal.removeEventListener("abort", done); resolve(); };
      this.waiting.add(done);
      signal.addEventListener("abort", done, { once: true });
      if (signal.aborted) done();
    });
  }

  dispose(): void {
    this.advanceClock();
    this.disposed = true;
    if (this.clock) clearInterval(this.clock);
    this.clock = undefined;
    for (const done of this.waiting) done();
    this.onState?.(this.snapshot());
  }

  private advanceClock() {
    // Catch up elapsed ticks even if synchronous agent computation delayed the event loop.
    while (this.clock && performance.now() >= this.nextTick && !this.outcome().complete) {
      this.nextTick += this.tickIntervalMs;
      const action = this.pendingDirection ?? this.direction;
      this.pendingDirection = undefined;
      this.move(action);
      if (this.outcome().complete) { clearInterval(this.clock); this.clock = undefined; }
      this.onState?.(this.snapshot());
      for (const done of this.waiting) done();
    }
  }

  private move(action: Direction) {
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
