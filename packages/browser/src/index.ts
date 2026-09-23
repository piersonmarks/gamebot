import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { GameAdapter, Observation } from "@gamebot/core";

/** The Playwright Page operations the bridge uses; the host owns the browser lifecycle. */
export interface BrowserPage {
  url(): string;
  viewportSize(): { width: number; height: number } | null;
  screenshot(options: { type: "png" }): Promise<Buffer>;
  keyboard: {
    press(key: string): Promise<void>;
    down(key: string): Promise<void>;
    up(key: string): Promise<void>;
  };
  mouse: { click(x: number, y: number): Promise<void> };
  locator(selector: string): { click(): Promise<void>; focus(): Promise<void>; innerText(): Promise<string> };
}

export interface BrowserState<GameState = unknown> {
  url: string;
  screenshot?: Buffer;
  viewport: { width: number; height: number } | null;
  text?: string;
  game?: GameState;
}

export type BrowserAction =
  | { type: "key"; key: string; holdMs?: number }
  | { type: "click"; x: number; y: number }
  | { type: "click"; selector: string };

export interface BrowserBridgeOptions<GameState = unknown> {
  /** Capture pixels only when a game-specific observation needs them. */
  captureScreenshot?: boolean;
  /** A DOM region for text-based games; canvas games can rely on screenshots. */
  textSelector?: string;
  /** Focus a canvas or other element before keyboard actions. */
  focusSelector?: string;
  /** A game-specific structured observation, when the page exposes one. */
  extractState?: () => Promise<GameState>;
}

/** Generic visible-browser control; game-specific candidates and verification stay outside. */
export class BrowserGameBridge<GameState = unknown> implements GameAdapter<BrowserState<GameState>, BrowserAction> {
  private readonly origin: string;
  constructor(private readonly page: BrowserPage, private readonly options: BrowserBridgeOptions<GameState> = {}) {
    if (!options.captureScreenshot && !options.textSelector && !options.extractState) {
      throw new Error("Configure a browser game observation source");
    }
    this.origin = new URL(page.url()).origin;
  }

  async observe(): Promise<Observation<BrowserState<GameState>>> {
    const screenshot = this.options.captureScreenshot ? await this.page.screenshot({ type: "png" }) : undefined;
    const state: BrowserState<GameState> = {
      url: this.page.url(), viewport: this.page.viewportSize(),
      ...(screenshot ? { screenshot } : {}),
      ...(this.options.textSelector ? { text: await this.page.locator(this.options.textSelector).innerText() } : {}),
      ...(this.options.extractState ? { game: await this.options.extractState() } : {}),
    };
    return {
      state,
      ...(screenshot ? { revision: createHash("sha256").update(screenshot).digest("hex") } : {}),
      time: { wallMs: Date.now() },
    };
  }

  validateAction(action: BrowserAction, observation: Observation<BrowserState<GameState>>): boolean {
    if (new URL(observation.state.url).origin !== this.origin) return false;
    if (action.type === "key") return !!action.key &&
      (action.holdMs === undefined || Number.isInteger(action.holdMs) && action.holdMs >= 0 && action.holdMs <= 2000);
    if ("selector" in action) return !!action.selector.trim();
    const viewport = observation.state.viewport;
    return !!viewport && Number.isFinite(action.x) && Number.isFinite(action.y) &&
      action.x >= 0 && action.x < viewport.width && action.y >= 0 && action.y < viewport.height;
  }

  async execute(action: BrowserAction, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    if (action.type === "key") {
      if (this.options.focusSelector) await this.page.locator(this.options.focusSelector).focus();
      if (!action.holdMs) return this.page.keyboard.press(action.key);
      await this.page.keyboard.down(action.key);
      try { await delay(action.holdMs, undefined, { signal }); }
      finally { await this.page.keyboard.up(action.key); }
    } else if ("selector" in action) {
      await this.page.locator(action.selector).click();
    } else {
      await this.page.mouse.click(action.x, action.y);
    }
  }
}
