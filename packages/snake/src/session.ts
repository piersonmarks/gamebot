import { fork, type ChildProcess } from "node:child_process";
import type { LearningEvent } from "@gamebot/core";
import { SnakeGame } from "./game.js";

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

  constructor(readonly tickIntervalMs = 120) {
    if (!Number.isSafeInteger(tickIntervalMs) || tickIntervalMs < 1) throw new Error("Snake --pace must be a positive tick interval in milliseconds");
  }

  open(headless = true): Promise<void> {
    if (this.closing) return Promise.reject(new Error("Snake window is closed"));
    return this.opening ??= new Promise<void>((resolve, reject) => {
      let ready = false;
      const child = this.child = fork(new URL("./process.js", import.meta.url), [String(this.tickIntervalMs), String(headless)],
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

  /** Send presentation metadata only; never send a board from an agent receipt. */
  report(event: LearningEvent): void {
    if (!this.child?.connected) return;
    if (!/^(model\.(started|completed|failed)|episode\.(started|resumed|step|completed)|player\.initialized|strategy\.updated|tactic\.updated|supervision\.applied|learning\.(window|proposal|policy-activated|trial-reviewed|reviewed|saved)|research\.(setup|proposal|revision|completed|error))$/.test(event.type)) return;
    const envelope = event.detail as Record<string, any>;
    const source = envelope.event ?? envelope;
    const detail = Object.fromEntries(["role", "episode", "strategy", "instruction", "step", "steps", "action", "stopReason", "error", "reason", "progress", "retained", "round", "accepted", "message"]
      .filter(key => source[key] !== undefined).map(key => [key, source[key]]));
    if (source.policy) detail.policy = { strategy: source.policy.strategy };
    this.child.send({ type: "report", event: { type: event.type, detail } }, () => {});
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
