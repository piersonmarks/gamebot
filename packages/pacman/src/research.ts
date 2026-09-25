#!/usr/bin/env node
import { learningArgument, runResearchCli, openGameWindow } from "@gamebot/core";
import { learningPacman } from "./learning.js";
import { PacmanSession } from "./session.js";

const world = new PacmanSession(Number(learningArgument("pace") ?? 140));
await runResearchCli(learningPacman(world), {
  async open({ headless, log, onClose }) {
    world.onClose = onClose;
    await world.open(headless);
    if (!headless) {
      log(`Watch Pac-Man at ${world.url}. Arrow keys also control the game.`);
      openGameWindow(world.url!, log);
    }
    return { report: event => world.report(event), close: () => world.close() };
  },
});
