#!/usr/bin/env node
import { learningArgument, runResearchCli } from "@gamebot/core";
import { learning2048 } from "./learning.js";
import { researchView2048 } from "./viewer.js";

await runResearchCli(learning2048(Number(learningArgument("target") ?? 2048)), researchView2048);
