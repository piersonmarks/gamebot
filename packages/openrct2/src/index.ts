import { createConnection } from "node:net";
import { createHash } from "node:crypto";
import type { GameAdapter, Observation } from "@gamebot/core";

type Response = { success: boolean; payload?: unknown; error?: string };
export type OpenRct2Action = { endpoint: string; params?: Record<string, unknown> };
export type OpenRct2State = { status: unknown; cash: unknown };

/** Connects to the separate openrct2-bridge plugin's newline-delimited JSON port. */
export class OpenRct2Bridge implements GameAdapter<OpenRct2State, OpenRct2Action> {
  private lastRevision?: string;
  constructor(private readonly port = 20020, private readonly host = "127.0.0.1") {}

  request(endpoint: string, params?: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ host: this.host, port: this.port });
      let buffer = "";
      socket.setTimeout(5000, () => socket.destroy(new Error("OpenRCT2 bridge timed out")));
      socket.on("error", reject);
      socket.on("connect", () => socket.write(JSON.stringify({ endpoint, ...(params ? { params } : {}) }) + "\n"));
      socket.on("data", chunk => {
        buffer += chunk.toString();
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        try {
          const response = JSON.parse(buffer.slice(0, newline)) as Response;
          if (!response.success) reject(new Error(response.error ?? `OpenRCT2 rejected ${endpoint}`));
          else resolve(response.payload);
        } catch (error) { reject(error); }
        socket.end();
      });
      socket.on("close", () => reject(new Error("OpenRCT2 bridge closed without a response")));
    });
  }

  async observe(): Promise<Observation<OpenRct2State>> {
    const status = await this.request("get_status");
    const cash = await this.request("park.cash");
    const state = { status, cash };
    this.lastRevision = createHash("sha256").update(JSON.stringify(state)).digest("hex");
    return { state, revision: this.lastRevision, time: { wallMs: Date.now() } };
  }

  validateAction(action: OpenRct2Action, observation: Observation<OpenRct2State>): boolean {
    return !!action.endpoint && observation.revision === this.lastRevision;
  }

  async execute(action: OpenRct2Action, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    await this.request(action.endpoint, action.params);
  }
}
