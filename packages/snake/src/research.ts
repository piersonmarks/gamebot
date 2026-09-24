#!/usr/bin/env node
import { learningArgument, runResearchCli } from "@gamebot/core";
import { learningSnake } from "./learning.js";
import { researchViewSnake } from "./viewer.js";

await runResearchCli(learningSnake(Number(learningArgument("target") ?? 5)), researchViewSnake);
