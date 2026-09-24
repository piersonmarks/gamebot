import type { LearningGame } from "@gamebot/core";
import { previewMove, type Direction, type Game2048State } from "./index.js";
import { directions } from "./policy.js";

export function learning2048(create: LearningGame<Game2048State, Direction>["create"], target = 2048, goalText = "win"): LearningGame<Game2048State, Direction> {
  const name = goalText.trim().toLowerCase().replace(/\s+/g, " ");
  const maximizeScore = ["maximize score", "maximise score", "max score"].includes(name);
  if (name !== "win" && !maximizeScore) throw new Error('Unsupported 2048 goal. Use --goal="win" or --goal="maximize score".');
  if (!Number.isInteger(target) || target < 2 || target > 2048 || !Number.isInteger(Math.log2(target))) {
    throw new Error("--target must be a power of two from 2 to 2048");
  }
  return {
    id: "2048", version: "classic-v1",
    goal: maximizeScore
      ? { id: "maximize-score", description: "Maximize the score in 2048; continue past 2048 until game over or the run limit" }
      : { id: "reach-tile", description: `Reach a ${target} tile in 2048` },
    rules: `The state has board (4 rows top-to-bottom, columns left-to-right; 0 means empty), score, over and won.
Choose up/right/down/left. All tiles slide in that direction; adjacent equal tiles merge into one double-valued tile.
Each tile merges at most once per move. The score increases by the value of each resulting merged tile.
After a move that changes the board, one empty cell chosen uniformly gets a 2 (90%) or 4 (10%).
Only board-changing moves are offered. The initial board has two spawned tiles. Lose when no moves remain.
Future random spawns are hidden. ${maximizeScore
      ? "Maximize the final score. The won flag means a 2048 tile was reached, not that this objective is finished. Play continues past that tile. Game over is the normal endpoint; higher score is better."
      : "Reach the user's target tile to win."}`,
    create,
    candidates: { generate: ({ observation }) => directions.filter(direction => previewMove(observation.state.board, direction).changed)
      .map(direction => ({ id: direction, action: direction, description: `Slide ${direction}` })) },
    verifier: { verify: ({ before, after, executionError }) => executionError || JSON.stringify(before.state.board) === JSON.stringify(after.state.board)
      ? { status: "failure", reason: executionError ? String(executionError) : "Board did not change" } : { status: "success" } },
    outcome(state) {
      if (maximizeScore) return { done: state.over, won: false, score: state.score };
      const maxTile = Math.max(...state.board.flat());
      return { done: state.over || state.won || maxTile >= target, won: maxTile >= target,
        score: Math.log2(maxTile) + state.score / 1000000 };
    },
  };
}
