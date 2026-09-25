import { randomUUID } from "node:crypto";
import { startResearchViewer } from "@gamebot/core";
import { SnakeEngine } from "./engine.js";
import type { SnakeState, Direction } from "./game.js";
import { researchViewSnake } from "./viewer.js";

const interval = Number(process.argv[2]), headless = process.argv[3] === "true";
let game: SnakeEngine | undefined, gameId: string | undefined, state: SnakeState | undefined;
let closing = false;
const inputSignal = new AbortController();
const send = (message: unknown) => { if (process.connected) process.send?.(message as any, () => {}); };
const observe = async () => {
  if (!game) throw new Error("Snake has no active game");
  const observation = await game.observe();
  return { ...observation, revision: `${gameId}:${observation.revision}` };
};
const input = async (action: unknown) => {
  if (!["up", "right", "down", "left"].includes(String(action))) throw new Error("Invalid Snake direction");
  if (!game) throw new Error("Snake has no active game");
  await game.execute(action as Direction, inputSignal.signal);
};
try {
  const viewer = await startResearchViewer({ ...researchViewSnake, currentState: () => state,
    async handleRequest(request, response) {
      if (request.url === "/state" && request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(await observe()));
        return;
      }
      if (request.method !== "POST" || request.headers["content-type"] !== "application/json" ||
          request.headers.origin && request.headers.origin !== viewer.url.slice(0, -1)) {
        response.writeHead(403).end(); return;
      }
      if (request.url === "/close") {
        response.writeHead(200).end(); await close(); return;
      }
      if (request.url === "/input") {
        let body = "";
        for await (const chunk of request) { body += chunk; if (body.length > 1024) throw new Error("Input is too large"); }
        await input(JSON.parse(body).action);
        response.writeHead(200).end(); return;
      }
      response.writeHead(404).end();
    },
  });
  const close = async () => {
    if (closing) return;
    closing = true; inputSignal.abort(); game?.dispose();
    if (process.connected) process.disconnect();
    await viewer.close();
  };
  process.on("disconnect", () => {
    if (closing) return;
    if (headless) void close();
    else viewer.report({ type: "research.error", detail: { message: "GameBot disconnected. Snake continues; use arrow keys or Close game." } });
  });
  process.on("message", async (message: any) => {
    try {
      if (message.type === "close") {
        // Acknowledge before disconnecting the control channel.
        send({ id: message.id, result: null }); await close(); return;
      }
      if (closing) throw new Error("Snake window is closed");
      if (message.type === "report") { viewer.report(message.event); return; }
      if (message.type === "new-game") {
        if (!Number.isSafeInteger(message.seed)) throw new Error("Invalid Snake seed");
        game?.dispose();
        gameId = randomUUID();
        game = new SnakeEngine(message.seed, interval, next => {
          state = next; viewer.report({ type: "game.state", detail: { state } });
        });
        state = (await game.observe()).state;
        viewer.report({ type: "game.state", detail: { state } });
        send({ id: message.id, result: gameId }); return;
      }
      if (message.gameId !== gameId) throw new Error("This Snake game has been replaced");
      if (message.type === "observe") send({ id: message.id, result: await observe() });
      else if (message.type === "input") { await input(message.action); send({ id: message.id, result: null }); }
      else throw new Error("Unknown Snake request");
    } catch (error) { send({ id: message.id, error: String(error) }); }
  });
  send({ type: "ready", url: viewer.url });
} catch (error) { send({ type: "startup-error", error: String(error) }); process.exitCode = 1; process.disconnect?.(); }
