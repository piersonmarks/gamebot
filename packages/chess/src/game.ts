import { Chess } from "chess.js";
import type { GameAdapter } from "@gamebot/core";

export interface ChessState {
  fen: string;
  board: string;
  recentMoves: readonly string[];
  legalMoves: readonly { id: string; san: string }[];
}

/** Gamebot plays White; a seeded legal-move opponent plays Black. */
export class ChessGame implements GameAdapter<ChessState, string> {
  private readonly engine = new Chess();
  private randomState: number;
  private revision = 0;
  lastTurn = "";

  constructor(seed: number) {
    this.randomState = seed >>> 0;
  }

  async observe() {
    return {
      state: {
        fen: this.engine.fen(),
        board: this.engine.ascii(),
        recentMoves: this.engine.history().slice(-8),
        legalMoves: this.engine.turn() === "w"
          ? this.engine.moves({ verbose: true }).map(move => ({ id: move.lan, san: move.san }))
          : [],
      },
      revision: String(this.revision),
      time: { turn: Math.floor(this.engine.history().length / 2) },
    };
  }

  validateAction(action: string, observation: { revision?: string; state: ChessState }) {
    return observation.revision === String(this.revision) &&
      this.engine.turn() === "w" && observation.state.legalMoves.some(move => move.id === action);
  }

  async execute(action: string, signal: AbortSignal) {
    if (signal.aborted) return;
    const white = this.engine.move(action);
    this.revision++;
    let blackMove = "";
    if (!this.engine.isGameOver()) {
      const replies = this.engine.moves();
      this.randomState = (Math.imul(this.randomState, 1664525) + 1013904223) >>> 0;
      blackMove = this.engine.move(replies[Math.floor(this.randomState / 0x100000000 * replies.length)]!).san;
      this.revision++;
    }
    this.lastTurn = `${white.san}${blackMove ? ` / ${blackMove}` : ""}`;
  }

  outcome() {
    if (!this.engine.isGameOver()) return { complete: false, score: 0.5 };
    if (this.engine.isCheckmate()) return { complete: true, score: this.engine.turn() === "b" ? 1 : 0 };
    return { complete: true, score: 0.5 };
  }

  status() {
    if (this.engine.isCheckmate()) return this.engine.turn() === "b" ? "White wins" : "Black wins";
    if (this.engine.isDraw()) return "Draw";
    return "Step limit reached";
  }
}
