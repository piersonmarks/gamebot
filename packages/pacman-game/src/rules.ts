export type Direction = "up" | "right" | "down" | "left";
export interface Point { x: number; y: number }

export const maze = [
  "###############",
  "#............o#",
  "#.###.###.###.#",
  "#...#.....#...#",
  "###.#.#.#.#.###",
  "#...#.#.#.#...#",
  "#.###.#.#.###.#",
  "#.....#.#.....#",
  "#.###.#.#.###.#",
  "#...#.#.#.#...#",
  "###.#.#.#.#.###",
  "#...#.....#...#",
  "#.###.###.###.#",
  "#o...........o#",
  "###############",
] as const;

export const directions: readonly Direction[] = ["up", "right", "down", "left"];
export const offset: Record<Direction, Point> = {
  up: { x: 0, y: -1 }, right: { x: 1, y: 0 },
  down: { x: 0, y: 1 }, left: { x: -1, y: 0 },
};
export const same = (a: Point, b: Point) => a.x === b.x && a.y === b.y;
export const step = (point: Point, direction: Direction): Point =>
  ({ x: point.x + offset[direction].x, y: point.y + offset[direction].y });

export interface PacmanState {
  width: number;
  height: number;
  /** Current floor: # wall, . pellet, o power pellet, space cleared. */
  terrain: readonly string[];
  player: Point;
  ghosts: readonly Point[];
  direction: Direction;
  lives: number;
  score: number;
  pelletsRemaining: number;
  powerTicks: number;
  invulnerableTicks: number;
  tick: number;
  tickIntervalMs: number;
  nextTickInMs: number;
  running: boolean;
  won: boolean;
  over: boolean;
  board: string;
}

export function legalDirections(state: PacmanState): readonly Direction[] {
  return directions.filter(direction => {
    const next = step(state.player, direction);
    return state.terrain[next.y]?.[next.x] !== undefined && state.terrain[next.y]![next.x] !== "#";
  });
}
