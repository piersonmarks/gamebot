#!/usr/bin/env node
import { learningArgument, runResearchCli } from "@gamebot/core";
import { learningPacman } from "./learning.js";
import { PacmanSession } from "./session.js";

const holdMs = Number(learningArgument("hold-ms") ?? 220);
if (!Number.isSafeInteger(holdMs) || holdMs < 1 || holdMs > 2000) throw new Error("Invalid --hold-ms");
const world = new PacmanSession(holdMs);
await runResearchCli(learningPacman(world), {
  async open({ headless, log, onClose }) {
    world.onClose = onClose;
    await world.open(headless);
    if (!headless) log(`Watch Pac-Man at ${world.url}. Arrow keys also control the game.`);
    return { close: () => world.close() };
  },
});
