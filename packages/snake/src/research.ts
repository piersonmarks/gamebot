#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { learningArgument, runResearchCli } from "@gamebot/core";
import { learningSnake } from "./learning.js";

await runResearchCli(learningSnake(Number(learningArgument("target") ?? 5)), fileURLToPath(new URL("./cli.js", import.meta.url)), ["--window"]);
