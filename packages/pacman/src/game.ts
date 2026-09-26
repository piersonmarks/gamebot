import { createHash } from "node:crypto";
import { BrowserGameBridge } from "@gamebot/browser";
import type { GameAdapter, Observation } from "@gamebot/core";
import type { Page } from "playwright";

export type Direction = "up" | "right" | "down" | "left";
export interface Point { x: number; y: number }
export interface PacmanState {
  terrain: string[];
  player: Point;
  ghosts: (Point & { name: string; frightened: boolean })[];
  direction: Direction;
  lives: number;
  score: number;
  pelletsRemaining: number;
  level: number;
  tick: number;
  running: boolean;
  won: boolean;
  over: boolean;
}

const directions: Direction[] = ["up", "right", "down", "left"];
const keys: Record<Direction, string> = { up: "ArrowUp", right: "ArrowRight", down: "ArrowDown", left: "ArrowLeft" };

/** Read the hosted game's own objects; the bridge does not implement its physics. */
async function readGame(page: Page): Promise<PacmanState> {
  return page.evaluate(() => {
    type Point = { x: number; y: number };
    type Actor = { tile: Point; direction: Point; score: number; lives: number };
    type Ghost = Actor & { constructor: { name: string }; isFrightened: boolean };
    type Scene = { constructor: { name: string }; pacman: Actor; ghosts: Ghost[]; mazeClass: { wallMap: string[] };
      pellets: { position: Point }[]; energizers: { position: Point }[]; pelletsLeft: number;
      level: number; levelStarting: boolean; levelComplete: boolean };
    // The game's classic scripts expose SceneManager and Game as global lexical bindings.
    const sceneManager = eval("SceneManager") as { currentScene(): Scene };
    const game = eval("Game") as { LAST_SCORES: number[][] };
    const clock = (window as unknown as { GAME: { lastFrameTimeMs: number; pauseGame: boolean } }).GAME;
    if (!sceneManager?.currentScene || !clock) throw new Error("The hosted Pac-Man state API is unavailable");
    const scene = sceneManager.currentScene();
    const active = scene?.constructor.name === "GameScene";
    if (!active) return {
      terrain: [], player: { x: 0, y: 0 }, ghosts: [], direction: "left" as const,
      lives: -1, score: game.LAST_SCORES[0]?.[0] ?? 0, pelletsRemaining: 0,
      level: 0, tick: Math.floor(clock.lastFrameTimeMs / 16.667), running: false, won: false, over: true,
    };
    const terrain: string[][] = scene.mazeClass.wallMap.map(row => [...row].map(tile => tile === "." || tile === "6" ? "#" : " "));
    for (const pellet of scene.pellets) terrain[pellet.position.y / 8]![pellet.position.x / 8] = ".";
    for (const energizer of scene.energizers) terrain[energizer.position.y / 8]![energizer.position.x / 8] = "o";
    const vector = scene.pacman.direction;
    const direction = vector.y < 0 ? "up" : vector.y > 0 ? "down" : vector.x > 0 ? "right" : "left";
    const won = scene.levelComplete || scene.level > 1;
    return {
      terrain: terrain.map(row => row.join("")), player: scene.pacman.tile,
      ghosts: scene.ghosts.map(ghost => ({ ...ghost.tile, name: ghost.constructor.name, frightened: ghost.isFrightened })),
      direction, lives: scene.pacman.lives, score: scene.pacman.score,
      pelletsRemaining: scene.pelletsLeft, level: scene.level,
      tick: Math.floor(clock.lastFrameTimeMs / 16.667),
      running: !scene.levelStarting && !scene.levelComplete && !clock.pauseGame,
      won, over: won || scene.pacman.lives < 0,
    };
  });
}

export class PacmanGame implements GameAdapter<PacmanState, Direction> {
  private readonly browser: BrowserGameBridge<PacmanState>;
  private detached = false;
  constructor(private readonly page: Page, private readonly holdMs = 220) {
    this.browser = new BrowserGameBridge(page, { extractState: () => readGame(page) });
  }

  async observe(): Promise<Observation<PacmanState>> {
    const observed = await this.browser.observe();
    const state = observed.state.game!;
    return { state, revision: createHash("sha256").update(JSON.stringify(state)).digest("hex"), time: observed.time };
  }

  validateAction(action: Direction, observation: Observation<PacmanState>): boolean {
    return !this.detached && !observation.state.over && directions.includes(action) &&
      this.browser.validateAction({ type: "key", key: keys[action], holdMs: this.holdMs }, {
        state: { url: this.page.url(), viewport: this.page.viewportSize() }, time: observation.time,
      });
  }

  async execute(action: Direction, signal: AbortSignal): Promise<void> {
    if (this.detached) throw new Error("Pac-Man controls are detached");
    await this.browser.execute({ type: "key", key: keys[action], holdMs: this.holdMs }, signal);
  }

  dispose(): void { this.detached = true; }
}

/** Deliberately simple baseline for play without model credentials. */
export function builtinDirection(state: PacmanState, candidates: readonly Direction[]): Direction {
  const offsets: Record<Direction, Point> = { up: { x: 0, y: -1 }, right: { x: 1, y: 0 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 } };
  const pellets: Point[] = [];
  state.terrain.forEach((row, y) => [...row].forEach((tile, x) => { if (tile === "." || tile === "o") pellets.push({ x, y }); }));
  const distance = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  return [...candidates].sort((a, b) => {
    const rate = (direction: Direction) => {
      const offset = offsets[direction];
      const next = { x: state.player.x + offset.x, y: state.player.y + offset.y };
      if (state.terrain[next.y]?.[next.x] === "#") return Infinity;
      const food = Math.min(...pellets.map(pellet => distance(next, pellet)));
      const danger = Math.min(...state.ghosts.filter(ghost => !ghost.frightened).map(ghost => distance(next, ghost)));
      return food + (danger <= 2 ? 100 : 0);
    };
    return rate(a) - rate(b);
  })[0]!;
}
