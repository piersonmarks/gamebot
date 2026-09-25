#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { SnakeEngine } from "./engine.js";
import type { SnakeState, Direction } from "./rules.js";
import { startSnakeViewer, type SnakePresentation } from "./viewer.js";

const interval = Number(process.argv[2] ?? 120);
const headless = process.argv[3] === "true";
const initialSeed = process.argv[4] === undefined ? undefined : Number(process.argv[4]);
if (!Number.isSafeInteger(interval) || interval < 1 || initialSeed !== undefined && !Number.isSafeInteger(initialSeed)) {
  throw new Error("Usage: snake-game [tick interval in ms] [headless] [seed]");
}

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
let viewer: Awaited<ReturnType<typeof startSnakeViewer>>;
const close = async () => {
  if (closing) return;
  closing = true; inputSignal.abort(); game?.dispose();
  if (process.connected) process.disconnect();
  await viewer?.close();
};
const newGame = async (seed: number) => {
  if (!Number.isSafeInteger(seed)) throw new Error("Invalid Snake seed");
  game?.dispose();
  gameId = randomUUID();
  game = new SnakeEngine(seed, interval, next => { state = next; viewer.publish(next); });
  state = (await game.observe()).state;
  viewer.publish(state);
  return gameId;
};

try {
  viewer = await startSnakeViewer({ observe, input, close });
  if (initialSeed !== undefined || !process.connected) await newGame(initialSeed ?? 1);
  process.once("SIGINT", () => { void close(); });
  process.on("disconnect", () => {
    if (closing) return;
    if (headless) void close();
    else viewer.present({ phase: "Controller disconnected. Snake continues; use arrow keys or Close game." });
  });
  process.on("message", async (message: any) => {
    try {
      if (message.type === "close") { send({ id: message.id, result: null }); await close(); return; }
      if (closing) throw new Error("Snake window is closed");
      if (message.type === "present") { viewer.present(message.presentation as SnakePresentation); return; }
      if (message.type === "new-game") { send({ id: message.id, result: await newGame(message.seed) }); return; }
      if (message.gameId !== gameId) throw new Error("This Snake game has been replaced");
      if (message.type === "observe") send({ id: message.id, result: await observe() });
      else if (message.type === "input") { await input(message.action); send({ id: message.id, result: null }); }
      else throw new Error("Unknown Snake request");
    } catch (error) { send({ id: message.id, error: String(error) }); }
  });
  if (process.connected) send({ type: "ready", url: viewer.url });
  else console.log(`Snake is running at ${viewer.url}. Use arrow keys in the browser; Ctrl+C closes it.`);
} catch (error) {
  if (process.connected) { send({ type: "startup-error", error: String(error) }); process.disconnect(); }
  else console.error(error);
  process.exitCode = 1;
}
