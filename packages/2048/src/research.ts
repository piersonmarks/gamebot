#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { learningArgument, runResearchCli } from "@gamebot/core";
import { learning2048 } from "./learning.js";

await runResearchCli(learning2048(Number(learningArgument("target") ?? 2048)), fileURLToPath(new URL("./cli.js", import.meta.url)));
