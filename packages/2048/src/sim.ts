import { SessionRuntime, type GameAdapter, type Observation } from "@gamebot/core";
import { candidates2048, directions, policyReflex, type Policy2048 } from "./policy.js";
import { previewMove, type Direction, type Game2048State } from "./index.js";

export interface SimResult {
  seed: number;
  score: number;
  maxTile: number;
  reachedTarget: boolean;
  turns: number;
  stopReason: "target-reached" | "game-over" | "turn-limit" | "interrupted";
  finalBoard: number[][];
  moves: Direction[];
  trajectory: { board: number[][]; action: Direction; score: number }[];
  elapsedMs: number;
}

class Sim2048 implements GameAdapter<Game2048State, Direction> {
  private randomState: number;
  private revision = 0;
  readonly state: Game2048State = { board: Array.from({ length: 4 }, () => [0, 0, 0, 0]), score: 0, over: false, won: false };

  constructor(seed: number) {
    this.randomState = seed >>> 0;
    this.spawn();
    this.spawn();
  }

  private random(): number {
    this.randomState = (Math.imul(this.randomState, 1664525) + 1013904223) >>> 0;
    return this.randomState / 0x100000000;
  }

  private spawn(): void {
    const empty: [number, number][] = [];
    for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) if (!this.state.board[y]![x]) empty.push([y, x]);
    if (!empty.length) return;
    const value = this.random() < 0.9 ? 2 : 4;
    const [y, x] = empty[Math.floor(this.random() * empty.length)]!;
    this.state.board[y]![x] = value;
  }

  observe(): Promise<Observation<Game2048State>> {
    return Promise.resolve({ state: { ...this.state, board: this.state.board.map(row => [...row]) }, revision: String(this.revision) });
  }

  validateAction(action: Direction): boolean {
    return !this.state.over && !this.state.won && previewMove(this.state.board, action).changed;
  }

  execute(action: Direction, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    const next = previewMove(this.state.board, action);
    if (!next.changed) throw new Error(`Illegal 2048 move: ${action}`);
    this.state.board = next.board;
    this.state.score += next.points;
    this.state.won = this.state.board.flat().some(value => value >= 2048);
    this.spawn();
    this.state.over = directions.every(direction => !previewMove(this.state.board, direction).changed);
    this.revision++;
    return Promise.resolve();
  }
}

export async function runSimGame(seed: number, policy: Policy2048, maxTurns: number, target: number, signal?: AbortSignal): Promise<SimResult> {
  const game = new Sim2048(seed);
  const moves: Direction[] = [];
  const trajectory: SimResult["trajectory"] = [];
  const started = performance.now();
  const session = new SessionRuntime<Game2048State, Direction>({
    adapter: game,
    candidates: { generate: candidates2048 },
    reflex: policyReflex(policy),
    verifier: { verify({ before, after, executionError }) {
      return executionError || JSON.stringify(before.state.board) === JSON.stringify(after.state.board)
        ? { status: "failure" } : { status: "success" };
    } },
  }, { id: "reach-tile", description: `Reach a ${target} tile in 2048` });
  const onAbort = () => session.stop();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (moves.length < maxTurns && !signal?.aborted && !game.state.over && !game.state.won && Math.max(...game.state.board.flat()) < target) {
      const result = await session.step();
      if (!result.candidate) break;
      moves.push(result.candidate.action);
      trajectory.push({ board: result.before.state.board, action: result.candidate.action, score: result.after?.state.score ?? game.state.score });
    }
  } catch (error) {
    if (!signal?.aborted) throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await session.finish();
  }
  const maxTile = Math.max(...game.state.board.flat());
  return {
    seed, score: game.state.score, maxTile, reachedTarget: maxTile >= target, turns: moves.length,
    stopReason: signal?.aborted ? "interrupted" : maxTile >= target ? "target-reached" : game.state.over ? "game-over" : "turn-limit",
    finalBoard: game.state.board, moves, trajectory, elapsedMs: Math.round(performance.now() - started),
  };
}
