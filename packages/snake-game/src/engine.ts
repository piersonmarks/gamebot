import { legalDirections, type Direction, type Point, type SnakeState } from "./rules.js";
const offset: Record<Direction, Point> = { up: { x: 0, y: -1 }, right: { x: 1, y: 0 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 } };
const same = (a: Point, b: Point) => a.x === b.x && a.y === b.y;

/** Seeded real-time Snake; direction inputs never control the passage of game time. */
export class SnakeEngine {
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

  constructor(seed: number, readonly tickIntervalMs = 120,
    private readonly onState?: (state: SnakeState) => void) {
    if (!Number.isSafeInteger(tickIntervalMs) || tickIntervalMs < 1) throw new Error("Snake tick interval must be a positive integer");
    this.randomState = seed >>> 0;
    this.food = this.spawnFood();
  }

  async observe() {
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

  async execute(action: Direction, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.disposed || this.gameOver()) throw new Error("Snake is no longer running");
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
    this.disposed = true;
    if (this.clock) clearInterval(this.clock);
    this.clock = undefined;
    for (const done of this.waiting) done();
    this.onState?.(this.snapshot());
  }

  private advanceClock() {
    // Keep native time even if rendering or OS scheduling delays this process briefly.
    while (this.clock && performance.now() >= this.nextTick && !this.gameOver()) {
      this.nextTick += this.tickIntervalMs;
      const action = this.pendingDirection ?? this.direction;
      this.pendingDirection = undefined;
      this.move(action);
      if (this.gameOver()) { clearInterval(this.clock); this.clock = undefined; }
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
      this.food = this.spawnFood();
      this.lastEvent = "food eaten";
    } else {
      this.body.pop();
      this.lastEvent = undefined;
    }
  }

  private gameOver(): boolean { return !this.alive || !this.food; }

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
