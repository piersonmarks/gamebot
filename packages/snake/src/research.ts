#!/usr/bin/env node
import { learningArgument, runResearchCli, startResearchViewer, openGameWindow } from "@gamebot/core";
import { learningSnake } from "./learning.js";
import { researchViewSnake } from "./viewer.js";

let viewer: Awaited<ReturnType<typeof startResearchViewer>> | undefined;
const game = learningSnake(Number(learningArgument("target") ?? 5), Number(learningArgument("pace") ?? 120),
  state => viewer?.report({ type: "game.state", detail: { state } }));
await runResearchCli(game, {
  async open({ headless }) {
    if (!headless) {
      viewer = await startResearchViewer(researchViewSnake);
      console.log(`Watch GameBot live at ${viewer.url}`);
      openGameWindow(viewer.url);
    }
    return { report: event => viewer?.report(event), close: async () => { await viewer?.close(); } };
  },
});
