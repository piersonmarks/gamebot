import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Page } from "playwright";
import { BrowserGameBridge } from "@gamebot/browser";
import type { GameAdapter, Observation } from "@gamebot/core";

export type Direction = "up" | "right" | "down" | "left";
export interface Game2048State {
  board: number[][];
  score: number;
  over: boolean;
  won: boolean;
}

const keys: Record<Direction, string> = {
  up: "ArrowUp", right: "ArrowRight", down: "ArrowDown", left: "ArrowLeft",
};

function collapse(values: number[]): { values: number[]; points: number } {
  const nonzero = values.filter(Boolean);
  const merged: number[] = [];
  let points = 0;
  for (let i = 0; i < nonzero.length; i++) {
    if (nonzero[i] === nonzero[i + 1]) {
      const value = nonzero[i]! * 2;
      merged.push(value);
      points += value;
      i++;
    } else merged.push(nonzero[i]!);
  }
  return { values: [...merged, ...Array(values.length - merged.length).fill(0)], points };
}

/** Predicts only the deterministic slide, before the game's random tile spawns. */
export function previewMove(board: number[][], direction: Direction): { board: number[][]; points: number; changed: boolean } {
  const result = board.map(row => [...row]);
  let points = 0;
  const vertical = direction === "up" || direction === "down";
  const reverse = direction === "right" || direction === "down";
  for (let lane = 0; lane < 4; lane++) {
    const original = Array.from({ length: 4 }, (_, index) => vertical ? board[index]![lane]! : board[lane]![index]!);
    const { values, points: gained } = collapse(reverse ? [...original].reverse() : original);
    points += gained;
    const placed = reverse ? values.reverse() : values;
    for (let index = 0; index < 4; index++) {
      if (vertical) result[index]![lane] = placed[index]!;
      else result[lane]![index] = placed[index]!;
    }
  }
  return { board: result, points, changed: result.some((row, y) => row.some((value, x) => value !== board[y]![x])) };
}

/** Reads only the visible board, score and terminal flags from the original game. */
async function readGame(page: Page): Promise<Game2048State> {
  return page.evaluate(() => {
    const raw = localStorage.getItem("gameState");
    if (raw) {
      const saved = JSON.parse(raw) as {
        grid: { cells: ({ value: number } | null)[][] };
        score: number; over: boolean; won: boolean;
      };
      const board = Array.from({ length: 4 }, (_, y) =>
        Array.from({ length: 4 }, (_, x) => saved.grid.cells[x]?.[y]?.value ?? 0));
      return { board, score: saved.score, over: saved.over, won: saved.won };
    }
    // The game removes saved state on loss; the rendered board remains visible.
    const board = Array.from({ length: 4 }, () => Array<number>(4).fill(0));
    for (const tile of document.querySelectorAll(".tile-container > .tile")) {
      const position = tile.className.match(/tile-position-(\d)-(\d)/);
      const value = tile.className.match(/(?:^|\s)tile-(\d+)(?:\s|$)/);
      if (position && value) {
        const x = Number(position[1]) - 1, y = Number(position[2]) - 1;
        board[y]![x] = Math.max(board[y]![x]!, Number(value[1]));
      }
    }
    return {
      board,
      score: Number(document.querySelector(".score-container")?.firstChild?.textContent ?? 0),
      over: document.querySelector(".game-message")?.classList.contains("game-over") ?? false,
      won: document.querySelector(".game-message")?.classList.contains("game-won") ?? false,
    };
  });
}

export class Game2048 implements GameAdapter<Game2048State, Direction> {
  private readonly browser: BrowserGameBridge<Game2048State>;
  constructor(private readonly page: Page, private readonly visualState?: () => Promise<Game2048State>, private readonly continueAfterWin = false) {
    this.browser = new BrowserGameBridge(page, { extractState: () => visualState ? visualState() : readGame(page) });
  }

  async observe(): Promise<Observation<Game2048State>> {
    const observation = await this.browser.observe();
    const state = observation.state.game!;
    return {
      state,
      revision: createHash("sha256").update(JSON.stringify(state)).digest("hex"),
      time: observation.time,
    };
  }

  validateAction(action: Direction, observation: Observation<Game2048State>): boolean {
    return !observation.state.over && (this.continueAfterWin || !observation.state.won) && previewMove(observation.state.board, action).changed;
  }

  async execute(action: Direction, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.continueAfterWin && await this.page.evaluate(() => {
      const saved = JSON.parse(localStorage.getItem("gameState") ?? "null");
      return saved?.won && !saved.keepPlaying;
    })) {
      await this.page.locator(".game-message.game-won .keep-playing-button").click();
      signal.throwIfAborted();
    }
    const before = this.visualState ? undefined : await this.page.evaluate(() => localStorage.getItem("gameState"));
    await this.browser.execute({ type: "key", key: keys[action] }, signal);
    if (signal.aborted) return;
    if (this.visualState) {
      await delay(500, undefined, { signal });
      return;
    }
    await this.page.waitForFunction(previous => {
      const current = localStorage.getItem("gameState");
      return current === null
        ? document.querySelector(".game-message")?.classList.contains("game-over")
        : current !== previous;
    }, before, { timeout: 1500 });
  }
}

export { learning2048 } from "./learning.js";
export { Browser2048Session } from "./browser.js";
