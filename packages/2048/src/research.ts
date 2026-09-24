#!/usr/bin/env node
import { learningArgument, runResearchCli } from "@gamebot/core";
import { learning2048 } from "./learning.js";
import { Browser2048Session } from "./browser.js";

if (learningArgument("observe") !== undefined && learningArgument("observe") !== "dom") {
  throw new Error("2048 research currently uses --observe=dom; vision observation is available with ordinary play.");
}
const browser = new Browser2048Session(learningArgument("game-dir"));
const definition = learning2048(seed => browser.create(seed, definition.goal.id === "maximize-score"),
  Number(learningArgument("target") ?? 2048), learningArgument("goal"));
if (definition.goal.id === "maximize-score" && learningArgument("target") !== undefined) {
  throw new Error('--target only applies to --goal="win"');
}
await runResearchCli(definition, {
  async open({ headless, signal, onClose }) {
    if (definition.evaluation?.objective === "score" && learningArgument("target") !== undefined) throw new Error('--target only applies to achievement goals');
    await browser.open(headless, signal, onClose);
    return browser;
  },
});
