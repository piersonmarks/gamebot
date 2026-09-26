import type { LearningGame } from "@gamebot/core";
import { previewMove, type Direction, type Game2048State } from "./index.js";
import { directions } from "./policy.js";

export function learning2048(create: LearningGame<Game2048State, Direction>["create"], target = 2048, goalText = "win"): LearningGame<Game2048State, Direction> {
  const name = goalText.trim().toLowerCase().replace(/\s+/g, " ");
  const maximizeScore = ["maximize score", "maximise score", "max score"].includes(name);
  const requestedGoal = name !== "win" && !maximizeScore ? goalText.trim() : undefined;
  if (requestedGoal === "") throw new Error("--goal must not be empty");
  if (!Number.isInteger(target) || target < 2 || target > 2048 || !Number.isInteger(Math.log2(target))) {
    throw new Error("--target must be a power of two from 2 to 2048");
  }
  const goals = {
    "reach-tile": { objective: "achievement" as const, aliases: ["win"], description: `Reach a ${target} tile; success first, then partial progress by largest tile and score`,
      outcome(state: Game2048State) {
        const maxTile = Math.max(...state.board.flat());
        return { done: state.over || maxTile >= target, won: maxTile >= target, score: Math.log2(maxTile) + state.score / 1000000 };
      } },
    "maximize-score": { objective: "score" as const, aliases: ["maximize score", "maximise score", "max score"], description: "Maximize final score; continue beyond 2048 until game over or the turn limit",
      outcome: (state: Game2048State) => ({ done: state.over, won: false, score: state.score }) },
  };
  const option = maximizeScore ? "maximize-score" : "reach-tile";
  return {
    requestedGoal, goalOptions: goals,
    evaluation: { option, objective: goals[option].objective, description: goals[option].description, request: maximizeScore ? "maximize score" : "win", efficiency: "steps" },
    id: "2048", version: "classic-v1",
    goal: maximizeScore
      ? { id: "maximize-score", description: "Maximize the score in 2048; continue past 2048 until game over or the run limit" }
      : { id: "reach-tile", description: `Reach a ${target} tile in 2048` },
    rules: `The state has board (4 rows top-to-bottom, columns left-to-right; 0 means empty), score, over and won.
Choose up/right/down/left. All tiles slide in that direction; adjacent equal tiles merge into one double-valued tile.
Each tile merges at most once per move. The score increases by the value of each resulting merged tile.
After a move that changes the board, one empty cell chosen uniformly gets a 2 (90%) or 4 (10%).
Only board-changing moves are offered. The initial board has two spawned tiles. Lose when no moves remain.
Future random spawns are hidden. The won flag marks reaching 2048. Play can continue beyond it if the goal requires it. The separate evaluation contract defines the endpoint.`,
    create,
    candidates: { generate: ({ observation }) => directions.filter(direction => previewMove(observation.state.board, direction).changed)
      .map(direction => ({ id: direction, action: direction, description: `Slide ${direction}` })) },
    verifier: { verify: ({ before, after, executionError }) => executionError || JSON.stringify(before.state.board) === JSON.stringify(after.state.board)
      ? { status: "failure", reason: executionError ? String(executionError) : "Board did not change" } : { status: "success" } },
    outcome: goals[option].outcome,
  };
}
