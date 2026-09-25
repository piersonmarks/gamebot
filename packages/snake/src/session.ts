import { fork, type ChildProcess } from "node:child_process";
import type { LearningEvent } from "@gamebot/core";
import { SnakeGame } from "./game.js";
const gameProcess = import.meta.resolve("snake-game/process");

/** Owns the native game application, separately from any agent/controller session. */
export class SnakeSession {
  private child?: ChildProcess;
  private opening?: Promise<void>;
  private closing?: Promise<void>;
  private sequence = 0;
  private readonly pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  url?: string;
  onClose?: () => void;
  private notified = false;
  private readonly activeModels = new Map<string, number>();

  constructor(readonly tickIntervalMs = 120) {
    if (!Number.isSafeInteger(tickIntervalMs) || tickIntervalMs < 1) throw new Error("Snake --pace must be a positive tick interval in milliseconds");
  }

  open(headless = true): Promise<void> {
    if (this.closing) return Promise.reject(new Error("Snake window is closed"));
    return this.opening ??= new Promise<void>((resolve, reject) => {
      let ready = false;
      const child = this.child = fork(new URL(gameProcess), [String(this.tickIntervalMs), String(headless)],
        { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"], execArgv: [] });
      const failed = (error: Error) => {
        reject(error);
        for (const item of this.pending.values()) item.reject(error);
        this.pending.clear();
        if (ready && !this.closing && !this.notified) { this.notified = true; this.onClose?.(); }
      };
      child.on("error", failed);
      child.on("exit", code => failed(new Error(`Snake game process exited (${code})`)));
      child.on("disconnect", () => failed(new Error("Snake game connection closed")));
      child.on("message", (message: any) => {
        if (message.type === "ready") {
          ready = true;
          this.url = message.url;
          child.unref();
          resolve();
        } else if (message.type === "startup-error") failed(new Error(message.error));
        else {
          const item = this.pending.get(message.id);
          if (!item) return;
          this.pending.delete(message.id);
          if (message.error) item.reject(new Error(message.error)); else item.resolve(message.result);
        }
      });
    });
  }

  async create(seed: number): Promise<SnakeGame> {
    await this.open();
    const gameId = await this.request<string>({ type: "new-game", seed });
    return new SnakeGame(this, gameId);
  }

  async request<T>(message: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (!this.child?.connected) throw new Error("Snake game is not connected");
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const finish = () => {
        this.pending.delete(id); signal?.removeEventListener("abort", abort);
      };
      const abort = () => { finish(); reject(signal!.reason); };
      this.pending.set(id, {
        resolve: value => { finish(); resolve(value); },
        reject: error => { finish(); reject(error); },
      });
      signal?.addEventListener("abort", abort, { once: true });
      this.child!.send({ ...message, id }, error => { if (error) this.pending.get(id)?.reject(error); });
    });
  }

  /** Translate GameBot events into optional labels understood by the independent game. */
  report(event: LearningEvent): void {
    if (!this.child?.connected) return;
    const envelope = event.detail as Record<string, any>;
    const source = envelope.event ?? envelope;
    const presentation: Record<string, string> = {};
    switch (event.type) {
      case "model.started":
      case "model.completed":
      case "model.failed": {
        const role = String(source.role ?? "model");
        this.activeModels.set(role, Math.max(0, (this.activeModels.get(role) ?? 0) + (event.type === "model.started" ? 1 : -1)));
        const thinking = [...this.activeModels].filter(([, count]) => count > 0).map(([name]) => name + " thinking");
        presentation.phase = thinking.length ? thinking.join(" · ") : "Playing";
        break;
      }
      case "player.initialized": presentation.strategy = String(source.policy?.strategy ?? ""); break;
      case "strategy.updated": presentation.strategy = String(source.strategy ?? ""); break;
      case "tactic.updated": presentation.tactic = String(source.instruction ?? ""); break;
      case "supervision.applied":
        presentation.strategy = String(source.strategy ?? "");
        presentation.tactic = String(source.instruction ?? "");
        break;
      case "episode.started":
      case "episode.resumed": presentation.phase = "Playing"; presentation.action = ""; break;
      case "episode.step": presentation.action = `Move ${source.step}: ${JSON.stringify(source.action)}`; break;
      case "episode.completed": presentation.phase = source.error ? `Attempt failed: ${source.error}` : `Attempt finished: ${source.stopReason}`; break;
      case "learning.window": presentation.phase = `Reviewing: ${source.reason}`; break;
      case "learning.proposal": presentation.phase = "Checking a proposed revision"; break;
      case "learning.policy-activated": presentation.phase = "Trying a revised player"; break;
      case "learning.trial-reviewed": presentation.phase = source.retained ? "Retaining the live trial" : "Restoring the previous player"; break;
      case "learning.reviewed": presentation.phase = "Playing"; break;
      case "learning.saved": presentation.phase = "Learning saved"; break;
      case "research.setup": presentation.phase = "Planning the first attempt"; break;
      case "research.proposal": presentation.phase = `Testing revision ${source.round}`; break;
      case "research.revision": presentation.phase = source.accepted ? "Improved policy accepted" : "Keeping the previous policy"; break;
      case "research.completed": presentation.phase = "Research complete"; break;
      case "research.error": presentation.phase = `Research stopped: ${source.message}`; break;
      default: return;
    }
    this.child.send({ type: "present", presentation }, () => {});
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      if (!this.child) return;
      await this.opening?.catch(() => {});
      if (!this.child.connected) return;
      await this.request({ type: "close" });
    })();
  }
}
