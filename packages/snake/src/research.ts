#!/usr/bin/env node
import { learningArgument, runResearchCli, openGameWindow } from "@gamebot/core";
import { learningSnake } from "./learning.js";
import { SnakeSession } from "./session.js";

const world = new SnakeSession(Number(learningArgument("target") ?? 5), Number(learningArgument("pace") ?? 120));
await runResearchCli(learningSnake(world), {
  async open({ headless, log, onClose }) {
    world.onClose = onClose;
    await world.open(headless);
    if (!headless) {
      log(`Watch Snake at ${world.url}. Arrow keys also control the game.`);
      openGameWindow(world.url!, log);
    }
    return { report: event => world.report(event), close: () => world.close() };
  },
});
