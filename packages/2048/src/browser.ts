import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, join, delimiter } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { chromium, type Browser, type Page, type Dialog } from "playwright";
import { Game2048 } from "./index.js";

const run = promisify(execFile);

async function launchBrowser(headless: boolean): Promise<Browser> {
  const browserOptions = {
    headless,
    handleSIGINT: false,
    ...(process.env.GAMEBOT_CHROME ? { executablePath: process.env.GAMEBOT_CHROME } : {}),
  };
  const browserMissing = (error: unknown) =>
    String(error).includes("Executable doesn't exist") || String(error).includes("is not found at");
  let browser;
  try {
    browser = await chromium.launch(browserOptions);
  } catch (error) {
    if (process.env.GAMEBOT_CHROME || !browserMissing(error)) throw error;
    for (const channel of ["chrome", "msedge"] as const) {
      try {
        browser = await chromium.launch({ ...browserOptions, channel });
        console.log(`Using installed ${channel === "chrome" ? "Google Chrome" : "Microsoft Edge"}.`);
        break;
      } catch (channelError) {
        if (!browserMissing(channelError)) throw channelError;
      }
    }
    if (!browser) {
      const candidates = process.platform === "darwin"
        ? ["/Applications/Chromium.app/Contents/MacOS/Chromium", join(homedir(), "Applications/Chromium.app/Contents/MacOS/Chromium")]
        : (process.env.PATH ?? "").split(delimiter).filter(Boolean).flatMap(dir => ["chromium", "chromium-browser"].map(name => join(dir, name)));
      for (const candidate of candidates) {
        if (!await access(candidate, constants.X_OK).then(() => true, () => false)) continue;
        browser = await chromium.launch({ ...browserOptions, executablePath: candidate });
        console.log(`Using installed Chromium at ${candidate}.`);
        break;
      }
    }
    if (!browser) {
      console.log("Installing Playwright Chromium because no installed Chrome or Chromium was found...");
      await run(process.platform === "win32" ? "npx.cmd" : "npx", ["playwright", "install", "chromium"], {
        shell: process.platform === "win32",
      });
      browser = await chromium.launch(browserOptions);
    }
  }
  return browser;
}

/** One real game window, reset between episodes. The original game owns all transitions. */
export class Browser2048Session {
  private browser?: Browser;
  private gamePage?: Page;
  private closing = false;
  private removeAbort?: () => void;
  private readonly gameUrl: string;

  constructor(gameDir = process.env.GAMEBOT_2048_DIR) {
    this.gameUrl = gameDir ? pathToFileURL(join(resolve(gameDir), "index.html")).href : "https://classic.play2048.co/";
  }

  get page(): Page {
    if (!this.gamePage) throw new Error("Open the 2048 browser before creating a game");
    return this.gamePage;
  }

  async open(headless = false, signal?: AbortSignal, onClose?: () => void): Promise<void> {
    const abort = () => { void this.close(); };
    signal?.throwIfAborted();
    signal?.addEventListener("abort", abort, { once: true });
    this.removeAbort = () => signal?.removeEventListener("abort", abort);
    try {
      this.browser = await launchBrowser(headless);
      signal?.throwIfAborted();
      if (this.closing) throw new Error("2048 browser was closed during startup");
      this.browser.on("disconnected", () => { if (!this.closing) onClose?.(); });
      this.gamePage = await this.browser.newPage({ viewport: { width: 760, height: 850 } });
      this.gamePage.on("close", () => { if (!this.closing) onClose?.(); });
      await this.gamePage.addInitScript(() => localStorage.removeItem("gameState"));
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async create(seed: number, continueAfterWin = false): Promise<Game2048> {
    if (!Number.isSafeInteger(seed)) throw new Error("2048 seed must be an integer");
    await this.page.goto(this.gameUrl);
    await this.page.locator(".tile-container .tile").first().waitFor();
    await this.page.evaluate(initialSeed => {
      const manager = (window as unknown as { GameManager?: { prototype: { addRandomTile(): void } } }).GameManager;
      if (!manager?.prototype.addRandomTile) throw new Error("2048 game does not expose its tile-spawn method for seeded resets");
      const spawn = manager.prototype.addRandomTile;
      let randomState = initialSeed >>> 0;
      // Only the original game's synchronous spawn calls consume this stream. Ads and analytics must not advance it.
      manager.prototype.addRandomTile = function () {
        const random = Math.random;
        Math.random = () => ((randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0) / 0x100000000);
        try { return spawn.call(this); }
        finally { Math.random = random; }
      };
    }, seed);
    // Restart through the actual controls so the initial tiles use the same seeded stream as subsequent moves.
    const acceptRestart = (dialog: Dialog) => dialog.accept();
    this.page.on("dialog", acceptRestart);
    try { await this.page.keyboard.press("r"); }
    finally { this.page.off("dialog", acceptRestart); }
    await this.page.waitForFunction(() => JSON.parse(localStorage.getItem("gameState") ?? "null")?.score === 0);
    return new Game2048(this.page, undefined, continueAfterWin);
  }

  async close(): Promise<void> {
    this.closing = true;
    this.removeAbort?.();
    await this.browser?.close();
  }
}
