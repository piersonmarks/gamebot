import { z } from "zod";
import type { Candidate, DecisionContext, Reflex } from "@gamebot/core";
import { previewMove, type Direction, type Game2048State } from "./index.js";

export const policySchema = z.object({
  merge: z.number().min(0).max(20),
  empty: z.number().min(0).max(50),
  corner: z.number().min(0).max(100),
  smooth: z.number().min(0).max(20),
  lookahead: z.union([z.literal(0), z.literal(1)]),
}).strict();
export type Policy2048 = z.infer<typeof policySchema>;
export const defaultPolicy: Policy2048 = { merge: 2, empty: 10, corner: 20, smooth: 0, lookahead: 0 };
export const directions = ["up", "right", "down", "left"] as const;

export function candidates2048(context: DecisionContext<Game2048State>): Candidate<Direction>[] {
  return directions.flatMap(direction => {
    const preview = previewMove(context.observation.state.board, direction);
    return preview.changed ? [{
      id: direction, action: direction,
      description: `${direction}; immediate merge points ${preview.points}; empty cells ${preview.board.flat().filter(value => value === 0).length}`,
    }] : [];
  });
}

function boardScore(board: number[][], mergePoints: number, policy: Policy2048) {
  const cells = board.flat();
  const empty = cells.filter(value => value === 0).length;
  const corner = board[0]![0] === Math.max(...cells) ? 1 : 0;
  let roughness = 0;
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
    const value = board[y]![x]!;
    if (!value) continue;
    if (x < 3 && board[y]![x + 1]) roughness += Math.abs(Math.log2(value) - Math.log2(board[y]![x + 1]!));
    if (y < 3 && board[y + 1]![x]) roughness += Math.abs(Math.log2(value) - Math.log2(board[y + 1]![x]!));
  }
  return { score: mergePoints * policy.merge + empty * policy.empty + corner * policy.corner - roughness * policy.smooth, empty, corner, roughness };
}

function bestNextScore(board: number[][], policy: Policy2048): number {
  const scores = directions.flatMap(direction => {
    const next = previewMove(board, direction);
    return next.changed ? [boardScore(next.board, next.points, policy).score] : [];
  });
  return scores.length ? Math.max(...scores) : -1000;
}

export function rankMoves(board: number[][], candidates: readonly Candidate<Direction>[], policy: Policy2048) {
  return candidates.map(candidate => {
    const preview = previewMove(board, candidate.action);
    const features = boardScore(preview.board, preview.points, policy);
    let lookaheadBonus = 0;
    if (policy.lookahead) {
      const empty: [number, number][] = [];
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) if (!preview.board[y]![x]) empty.push([y, x]);
      if (empty.length) {
        let expected = 0;
        for (const [y, x] of empty) for (const [value, probability] of [[2, 0.9], [4, 0.1]]) {
          const spawned = preview.board.map(row => [...row]);
          spawned[y]![x] = value;
          expected += probability * bestNextScore(spawned, policy) / empty.length;
        }
        lookaheadBonus = expected * 0.5;
      }
    }
    return { id: candidate.id, ...features, score: features.score + lookaheadBonus, mergePoints: preview.points, lookaheadBonus };
  }).sort((a, b) => b.score - a.score);
}

export function policyReflex(policy: Policy2048, onRanking?: (ranking: ReturnType<typeof rankMoves>) => void): Reflex<Game2048State, Direction> {
  return { choose(context, candidates) {
    const ranking = rankMoves(context.observation.state.board, candidates, policy);
    onRanking?.(ranking);
    return ranking[0]!.id;
  } };
}
