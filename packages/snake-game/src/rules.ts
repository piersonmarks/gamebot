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
