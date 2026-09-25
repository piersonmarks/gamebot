import { directions, maze, same, step, type Direction, type PacmanState, type Point } from "./rules.js";

const start: Point = { x: 1, y: 1 };
const homes: readonly Point[] = [{ x: 13, y: 13 }, { x: 1, y: 13 }];
const key = ({ x, y }: Point) => `${x},${y}`;
const open = (point: Point) => maze[point.y]?.[point.x] !== undefined && maze[point.y]![point.x] !== "#";

/** A self-contained, seeded maze chase game with a clock independent of controllers. */
export class PacmanEngine {
  private player: Point = { ...start };
  private ghosts: Point[] = homes.map(home => ({ ...home }));
  private direction: Direction = "right";
  private pendingDirection?: Direction;
  private readonly pellets = new Set<string>();
  private readonly powerPellets = new Set<string>();
  private lives = 3;
  private score = 0;
  private powerTicks = 0;
  private invulnerableTicks = 0;
  private tick = 0;
  private won = false;
  private randomState: number;
  private lastEvents: string[] = [];
  private clock?: ReturnType<typeof setInterval>;
  private nextTick = 0;
  private started = false;
  private disposed = false;
  private readonly waiting = new Set<() => void>();

  constructor(seed: number, readonly tickIntervalMs = 140,
    private readonly onState?: (state: PacmanState) => void) {
    if (!Number.isSafeInteger(seed) || !Number.isSafeInteger(tickIntervalMs) || tickIntervalMs < 1) {
      throw new Error("Pac-Man seed and tick interval must be valid integers");
    }
    this.randomState = seed >>> 0;
    for (let y = 0; y < maze.length; y++) for (let x = 0; x < maze[y]!.length; x++) {
      const point = { x, y };
      if (same(point, start)) continue;
      if (maze[y]![x] === ".") this.pellets.add(key(point));
      else if (maze[y]![x] === "o") this.powerPellets.add(key(point));
    }
  }

  async observe() {
    return {
      state: this.snapshot(),
      revision: String(this.tick),
      time: { turn: this.tick, gameMs: this.tick * this.tickIntervalMs },
      events: [...this.lastEvents],
    };
  }

  async execute(action: Direction, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.disposed || this.over()) throw new Error("Pac-Man is no longer running");
    if (!directions.includes(action)) throw new Error("Invalid Pac-Man direction");
    this.pendingDirection = action;
    if (!this.started) {
      this.started = true;
      this.nextTick = performance.now() + this.tickIntervalMs;
      this.clock = setInterval(() => this.advanceClock(), this.tickIntervalMs);
    }
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

  private snapshot(): PacmanState {
    const terrain = maze.map((row, y) => [...row].map((cell, x) =>
      cell === "#" ? "#" : this.powerPellets.has(key({ x, y })) ? "o" :
        this.pellets.has(key({ x, y })) ? "." : " ").join(""));
    const board = terrain.map((row, y) => [...row].map((cell, x) =>
      same(this.player, { x, y }) ? "P" : this.ghosts.some(ghost => same(ghost, { x, y })) ? "G" : cell).join("")).join("\n");
    return {
      width: maze[0].length, height: maze.length, terrain,
      player: { ...this.player }, ghosts: this.ghosts.map(ghost => ({ ...ghost })),
      direction: this.direction, lives: this.lives, score: this.score,
      pelletsRemaining: this.pellets.size + this.powerPellets.size,
      powerTicks: this.powerTicks, invulnerableTicks: this.invulnerableTicks,
      tick: this.tick, tickIntervalMs: this.tickIntervalMs,
      nextTickInMs: this.clock ? Math.max(0, this.nextTick - performance.now()) : 0,
      running: !!this.clock, won: this.won, over: this.over(), board,
    };
  }

  private advanceClock(): void {
    while (this.clock && performance.now() >= this.nextTick && !this.over()) {
      this.nextTick += this.tickIntervalMs;
      this.move();
      if (this.over()) { clearInterval(this.clock); this.clock = undefined; }
      this.onState?.(this.snapshot());
      for (const done of this.waiting) done();
    }
  }

  private move(): void {
    this.tick++;
    this.lastEvents = [];
    if (this.pendingDirection && open(step(this.player, this.pendingDirection))) {
      this.direction = this.pendingDirection;
      this.pendingDirection = undefined;
    }
    const next = step(this.player, this.direction);
    if (open(next)) this.player = next;
    const position = key(this.player);
    if (this.pellets.delete(position)) { this.score += 10; this.lastEvents.push("pellet eaten"); }
    if (this.powerPellets.delete(position)) {
      this.score += 50; this.powerTicks = 35; this.lastEvents.push("power pellet eaten");
    }
    if (this.pellets.size + this.powerPellets.size === 0) {
      this.won = true; this.lastEvents.push("maze cleared"); return;
    }
    this.resolveCollisions();
    if (this.lives > 0 && this.tick % 3 === 0) {
      this.ghosts = this.ghosts.map((ghost, index) => this.moveGhost(ghost, index));
      this.resolveCollisions();
    }
    if (this.powerTicks > 0) this.powerTicks--;
    if (this.invulnerableTicks > 0) this.invulnerableTicks--;
  }

  private resolveCollisions(): void {
    for (let index = 0; index < this.ghosts.length; index++) {
      if (!same(this.player, this.ghosts[index]!)) continue;
      if (this.powerTicks > 0) {
        this.score += 200;
        this.ghosts[index] = { ...homes[index]! };
        this.lastEvents.push("ghost eaten");
      } else if (this.invulnerableTicks === 0) {
        this.lives--;
        this.lastEvents.push(this.lives ? "life lost" : "game over");
        if (this.lives) {
          this.player = { ...start };
          this.ghosts = homes.map(home => ({ ...home }));
          this.direction = "right";
          this.pendingDirection = undefined;
          this.invulnerableTicks = 6;
        }
        return;
      }
    }
  }

  private moveGhost(ghost: Point, index: number): Point {
    const choices = directions.map(direction => step(ghost, direction)).filter(open);
    if (!choices.length) return ghost;
    if (index === 1 && this.random() < 0.6) return choices[Math.floor(this.random() * choices.length)]!;
    const target = this.player;
    const scored = choices.map(point => ({ point, distance: this.distance(point, target), tie: this.random() }));
    scored.sort((a, b) => this.powerTicks > 0 ? b.distance - a.distance || a.tie - b.tie :
      a.distance - b.distance || a.tie - b.tie);
    return scored[0]!.point;
  }

  private distance(from: Point, to: Point): number {
    if (same(from, to)) return 0;
    const seen = new Set([key(from)]), queue: { point: Point; distance: number }[] = [{ point: from, distance: 0 }];
    for (let index = 0; index < queue.length; index++) {
      const current = queue[index]!;
      for (const direction of directions) {
        const next = step(current.point, direction), nextKey = key(next);
        if (!open(next) || seen.has(nextKey)) continue;
        if (same(next, to)) return current.distance + 1;
        seen.add(nextKey); queue.push({ point: next, distance: current.distance + 1 });
      }
    }
    return Infinity;
  }

  private random(): number {
    this.randomState = (Math.imul(this.randomState, 1664525) + 1013904223) >>> 0;
    return this.randomState / 0x100000000;
  }

  private over(): boolean { return this.won || this.lives === 0; }
}
