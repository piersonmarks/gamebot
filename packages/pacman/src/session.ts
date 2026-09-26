import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { chromium, type Browser, type Page } from "playwright";
import { PacmanGame } from "./game.js";

const GAME_URL = "https://jrhollis.github.io/jspacman/";

/** A visible browser runs the independently hosted arcade game at its own 60 Hz clock. */
export class PacmanSession {
  private browser?: Browser;
  private gamePage?: Page;
  private closing = false;
  onClose?: () => void;

  constructor(readonly holdMs = 220) {}

  get url(): string { return this.gamePage?.url() ?? GAME_URL; }

  async open(headless = false): Promise<void> {
    const options = { headless, handleSIGINT: false,
      ...(process.env.GAMEBOT_CHROME ? { executablePath: process.env.GAMEBOT_CHROME } : {}) };
    try {
      this.browser = await chromium.launch(options);
    } catch (error) {
      const missing = String(error).includes("Executable doesn't exist") || String(error).includes("is not found at");
      if (!missing || process.env.GAMEBOT_CHROME) throw error;
      for (const channel of ["chrome", "msedge"] as const) {
        try { this.browser = await chromium.launch({ ...options, channel }); break; }
        catch (channelError) {
          if (!String(channelError).includes("Executable doesn't exist") && !String(channelError).includes("is not found at")) throw channelError;
        }
      }
      if (!this.browser) {
        const candidates = process.platform === "darwin"
          ? ["/Applications/Chromium.app/Contents/MacOS/Chromium", join(homedir(), "Applications/Chromium.app/Contents/MacOS/Chromium")]
          : (process.env.PATH ?? "").split(delimiter).filter(Boolean).flatMap(dir =>
              ["chromium", "chromium-browser"].map(name => join(dir, name)));
        for (const candidate of candidates) {
          if (!await access(candidate, constants.X_OK).then(() => true, () => false)) continue;
          this.browser = await chromium.launch({ ...options, executablePath: candidate });
          break;
        }
      }
      if (!this.browser) {
        console.log("Installing Playwright Chromium because no installed Chrome or Chromium was found...");
        await promisify(execFile)(process.platform === "win32" ? "npx.cmd" : "npx", ["playwright", "install", "chromium"]);
        this.browser = await chromium.launch(options);
      }
    }
    this.browser.on("disconnected", () => { if (!this.closing) this.onClose?.(); });
  }

  async create(seed: number): Promise<PacmanGame> {
    if (!Number.isSafeInteger(seed)) throw new Error("Pac-Man seed must be an integer");
    if (!this.browser) throw new Error("Open the Pac-Man browser before creating a game");
    const previousPage = this.gamePage;
    this.gamePage = undefined;
    await previousPage?.close();
    const page = await this.browser.newPage({ viewport: { width: 520, height: 680 } });
    this.gamePage = page;
    page.on("close", () => { if (!this.closing && this.gamePage === page) this.onClose?.(); });
    await page.addInitScript(initialSeed => {
      let state = initialSeed >>> 0;
      Math.random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 0x100000000);
    }, seed);
    await page.goto(GAME_URL, { waitUntil: "load" });
    const holdUntil = async (key: string, scene: string) => {
      await page.keyboard.down(key);
      try {
        await page.waitForFunction(expected => eval("SceneManager").currentScene()?.constructor.name === expected, scene, { timeout: 10000 });
      } finally { await page.keyboard.up(key); }
    };
    await holdUntil("Enter", "PacmanTitleScene");
    await holdUntil("Shift", "PacmanStartScene");
    await holdUntil("Enter", "GameScene");
    return new PacmanGame(page, this.holdMs);
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.browser?.close();
  }
}
