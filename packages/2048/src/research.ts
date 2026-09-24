#!/usr/bin/env node
import { randomUUID, randomInt, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateText, Output } from "ai";
import { z } from "zod";
import { defaultPolicy, policySchema, type Policy2048 } from "./policy.js";
import { runSimGame, type SimResult } from "./sim.js";

function argument(name: string): string | undefined {
  return process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

const rounds = Number(argument("rounds") ?? 5);
const games = Number(argument("games") ?? 12);
const maxTurns = Number(argument("turns") ?? 5000);
const target = Number(argument("target") ?? 2048);
const firstSeed = Number(argument("seed") ?? randomInt(1, 2 ** 31));
if (![rounds, games, maxTurns, target].every(value => Number.isSafeInteger(value) && value > 0) ||
    !Number.isSafeInteger(firstSeed) || target < 2 || target > 2048 || !Number.isInteger(Math.log2(target))) {
  throw new Error("--rounds, --games and --turns must be positive integers; --target must be a power of two from 2 to 2048; --seed must be an integer");
}
const model = process.env.GAMEBOT_RESEARCH_MODEL;
const watch = process.argv.includes("--watch");
const researchDir = resolve(".gamebot", "research", "2048", `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`);
const activePath = resolve(".gamebot", "games", "2048", "active-policy.json");
await mkdir(researchDir, { recursive: true });
const journal = join(researchDir, "runs.jsonl");
await writeFile(join(researchDir, "experiment.json"), JSON.stringify({
  game: "2048", target, rounds, gamesPerSet: games, maxTurns, firstSeed,
  researchModel: model ?? null,
  promotionOrder: ["target wins", "sum of log2 maximum tile", "total score"],
  trainSeeds: Array.from({ length: games }, (_, index) => firstSeed + index),
  finalTestSeeds: Array.from({ length: games }, (_, index) => firstSeed + (rounds + 1) * games + index),
}, null, 2) + "\n");
const abort = new AbortController();
process.once("SIGINT", () => { abort.abort(); console.log("\nStopping research after the current operation..."); });

function policyId(policy: Policy2048): string {
  return createHash("sha256").update(JSON.stringify(policy)).digest("hex").slice(0, 12);
}

let baseline = defaultPolicy;
let hadActivePolicy = false;
try {
  baseline = policySchema.parse(JSON.parse(await readFile(activePath, "utf8")));
  hadActivePolicy = true;
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

function metrics(results: readonly SimResult[]) {
  return {
    wins: results.filter(result => result.reachedTarget).length,
    maxTileTotal: results.reduce((total, result) => total + Math.log2(result.maxTile), 0),
    scoreTotal: results.reduce((total, result) => total + result.score, 0),
    meanScore: Math.round(results.reduce((total, result) => total + result.score, 0) / results.length),
    bestTile: Math.max(...results.map(result => result.maxTile)),
  };
}

function compare(a: ReturnType<typeof metrics>, b: ReturnType<typeof metrics>): number {
  return a.wins - b.wins || a.maxTileTotal - b.maxTileTotal || a.scoreTotal - b.scoreTotal;
}

const trainSeeds = Array.from({ length: games }, (_, index) => firstSeed + index);
const validationSeeds = (round: number) => Array.from({ length: games }, (_, index) => firstSeed + round * games + index);
const testSeeds = Array.from({ length: games }, (_, index) => firstSeed + (rounds + 1) * games + index);
async function evaluate(policy: Policy2048, seeds: readonly number[], round: number, set: "train" | "validation" | "test") {
  const results: SimResult[] = [];
  for (const seed of seeds) {
    if (abort.signal.aborted) break;
    const result = await runSimGame(seed, policy, maxTurns, target, abort.signal);
    results.push(result);
    await appendFile(journal, JSON.stringify({ type: "game", round, set, policyId: policyId(policy), result }) + "\n");
    console.log(`  ${set} ${policyId(policy)} seed ${seed}: ${result.stopReason}; max ${result.maxTile}; score ${result.score}; ${result.turns} turns; ${result.elapsedMs} ms`);
  }
  return results.length === seeds.length ? { metrics: metrics(results), results } : undefined;
}

const deterministicProposals: Policy2048[] = [
  { ...defaultPolicy, monotone: 5 },
  { ...defaultPolicy, monotone: 15 },
  { ...defaultPolicy, monotone: 20 },
  { ...defaultPolicy, smooth: 2 },
  { ...defaultPolicy, empty: 15 },
  { ...defaultPolicy, corner: 40, smooth: 2 },
  { ...defaultPolicy, merge: 4, empty: 15 },
  { ...defaultPolicy, empty: 25, smooth: 3 },
  { ...defaultPolicy, corner: 60, smooth: 4, lookahead: 1 },
];
const tried = new Set([policyId(baseline)]);
const triedPolicies: Policy2048[] = [baseline];
async function propose(round: number, champion: Policy2048, train: NonNullable<Awaited<ReturnType<typeof evaluate>>>) {
  if (!model) {
    const next = deterministicProposals.find(policy => !tried.has(policyId(policy)));
    return next ? { policy: next, reason: "Predefined policy experiment; set GAMEBOT_RESEARCH_MODEL for model proposals" } : undefined;
  }
  const weakest = [...train.results].sort((a, b) => Number(a.reachedTarget) - Number(b.reachedTarget) || a.maxTile - b.maxTile || a.score - b.score)[0]!;
  const result = await generateText({
    model,
    abortSignal: abort.signal,
    maxOutputTokens: 512,
    output: Output.object({ schema: z.object({ policy: policySchema, reason: z.string().min(1).max(500) }) }),
    system: "You are the 2048 improvement strategist. Propose one policy revision for an experiment. You cannot change game rules or the evaluator. A change is accepted only if it improves matched training and fresh validation games. Avoid repeating a tried policy.",
    prompt: JSON.stringify({
      goal: `Reach a ${target} tile`, round, champion, trainingMetrics: train.metrics,
      weakestTrainingGame: { seed: weakest.seed, stopReason: weakest.stopReason, score: weakest.score, maxTile: weakest.maxTile, finalBoard: weakest.finalBoard, recentMoves: weakest.trajectory.slice(-12) },
      triedPolicies,
      features: {
        merge: "weight for immediate merge points",
        empty: "weight for empty cells after a slide",
        corner: "bonus when the largest tile is top-left",
        smooth: "penalty for adjacent tiles with different log2 values",
        monotone: "penalty when row/column tile ranks rise then fall, making large tiles hard to combine",
        lookahead: "0 or 1; when 1, average the best next move across every possible 2/4 tile spawn",
      },
    }),
  });
  return { ...result.output, usage: result.usage };
}

async function savePolicy(policy: Policy2048, name: string): Promise<string> {
  const path = join(researchDir, `${name}.json`);
  await writeFile(path, JSON.stringify(policy, null, 2) + "\n");
  return path;
}

console.log(`2048 auto-research: ${rounds} rounds, ${games} training + ${games} fresh validation games per comparison, ${maxTurns} turns/game.`);
console.log(`Research proposer: ${model ? `AI SDK model ${model}` : "built-in policy experiments"}. Journal: ${journal}`);
console.log(`Starting policy: ${hadActivePolicy ? activePath : "built-in baseline"}; first seed ${firstSeed}.`);
await appendFile(journal, JSON.stringify({ type: "experiment", baselinePolicyId: policyId(baseline), baseline, firstSeed, target, rounds, games, maxTurns }) + "\n");
let champion = baseline;
let championPath = await savePolicy(champion, "champion");
console.log(`Baseline ${policyId(champion)}: ${JSON.stringify(champion)}`);
const baselineTrain = await evaluate(champion, trainSeeds, 0, "train");
let championTrain = baselineTrain;
if (championTrain) {
  for (let round = 1; round <= rounds && !abort.signal.aborted; round++) {
    let proposal: Awaited<ReturnType<typeof propose>>;
    try {
      proposal = await propose(round, champion, championTrain);
    } catch (error) {
      if (!abort.signal.aborted) throw error;
      break;
    }
    if (!proposal) { console.log("No further policy proposals available."); break; }
    const candidate = policySchema.parse(proposal.policy);
    const id = policyId(candidate);
    if (tried.has(id)) { console.log(`Round ${round}: duplicate policy ${id}; skipped.`); continue; }
    tried.add(id);
    triedPolicies.push(candidate);
    await savePolicy(candidate, `round-${round}-${id}`);
    await appendFile(journal, JSON.stringify({ type: "proposal", round, id, policy: candidate, reason: proposal.reason, model: model ?? null, usage: "usage" in proposal ? proposal.usage : undefined }) + "\n");
    console.log(`Round ${round} proposal ${id}: ${proposal.reason}; ${JSON.stringify(candidate)}`);
    const candidateTrain = await evaluate(candidate, trainSeeds, round, "train");
    if (!candidateTrain || abort.signal.aborted) break;
    if (compare(candidateTrain.metrics, championTrain.metrics) <= 0) {
      console.log(`Round ${round}: rejected on training games (${candidateTrain.metrics.wins}/${games} wins; mean score ${candidateTrain.metrics.meanScore}).`);
      await appendFile(journal, JSON.stringify({ type: "revision", round, id, status: "rejected", reason: "training", train: candidateTrain.metrics }) + "\n");
      continue;
    }
    const seeds = validationSeeds(round);
    const championValidation = await evaluate(champion, seeds, round, "validation");
    const candidateValidation = abort.signal.aborted ? undefined : await evaluate(candidate, seeds, round, "validation");
    if (!candidateValidation || !championValidation || abort.signal.aborted) break;
    if (compare(candidateValidation.metrics, championValidation.metrics) > 0) {
      champion = candidate;
      championTrain = candidateTrain;
      championPath = await savePolicy(champion, "champion");
      console.log(`Round ${round}: promoted ${id} (${candidateValidation.metrics.wins}/${games} validation wins; mean score ${candidateValidation.metrics.meanScore}).`);
      await appendFile(journal, JSON.stringify({ type: "revision", round, id, status: "promoted", train: candidateTrain.metrics, validation: candidateValidation.metrics }) + "\n");
    } else {
      console.log(`Round ${round}: rejected on validation games (${candidateValidation.metrics.wins}/${games} wins; mean score ${candidateValidation.metrics.meanScore}).`);
      await appendFile(journal, JSON.stringify({ type: "revision", round, id, status: "rejected", reason: "validation", train: candidateTrain.metrics, validation: candidateValidation.metrics }) + "\n");
    }
  }
}
const baselineTest = abort.signal.aborted ? undefined : await evaluate(baseline, testSeeds, rounds + 1, "test");
const championTest = abort.signal.aborted ? undefined : policyId(champion) === policyId(baseline)
  ? baselineTest : await evaluate(champion, testSeeds, rounds + 1, "test");
const activated = !!baselineTest && !!championTest && compare(championTest.metrics, baselineTest.metrics) > 0;
if (activated) {
  await mkdir(dirname(activePath), { recursive: true });
  const temporary = `${activePath}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(champion, null, 2) + "\n");
  await rename(temporary, activePath);
  console.log(`Activated policy ${policyId(champion)} for future 2048 games: ${activePath}`);
  await appendFile(journal, JSON.stringify({ type: "activation", policyId: policyId(champion), finalTest: championTest.metrics, baselineTest: baselineTest.metrics }) + "\n");
} else if (!abort.signal.aborted) {
  champion = baseline;
  championTrain = baselineTrain;
  championPath = await savePolicy(champion, "champion");
  console.log("Final audit did not improve the active policy; keeping the previous policy.");
}
console.log(JSON.stringify({ champion: policyId(champion), policyPath: championPath, activePolicyPath: activated || hadActivePolicy ? activePath : undefined, activated, train: championTrain?.metrics, finalTest: championTest?.metrics, baselineTest: baselineTest?.metrics, journal, interrupted: abort.signal.aborted }, null, 2));
if (watch && !abort.signal.aborted) {
  const cli = resolve(dirname(fileURLToPath(import.meta.url)), "cli.js");
  console.log("Opening a visible browser game with the selected policy...");
  const child = spawn(process.execPath, [cli, `--policy=${championPath}`, `--seed=${firstSeed + (rounds + 2) * games}`], { stdio: "inherit" });
  const onAbort = () => child.kill("SIGINT");
  abort.signal.addEventListener("abort", onAbort, { once: true });
  await new Promise<void>((resolveChild, reject) => {
    child.once("error", reject);
    child.once("exit", code => {
      if (code && !abort.signal.aborted) reject(new Error(`Visible game exited with status ${code}`));
      else resolveChild();
    });
  });
  abort.signal.removeEventListener("abort", onAbort);
}
