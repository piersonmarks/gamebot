#!/usr/bin/env node
import { learningArgument, runResearchCli } from "@gamebot/core";
import { learning2048 } from "./learning.js";
import { Browser2048Session } from "./browser.js";

if (learningArgument("observe") !== undefined && learningArgument("observe") !== "dom") {
  throw new Error("2048 research currently uses --observe=dom; vision observation is available with ordinary play.");
}
const browser = new Browser2048Session(learningArgument("game-dir"));
await runResearchCli(learning2048(seed => browser.create(seed), Number(learningArgument("target") ?? 2048)), {
  async open({ headless, signal, onClose }) {
    await browser.open(headless, signal, onClose);
    return browser;
  },
});
