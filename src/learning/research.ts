import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { SessionRuntime } from "../core/index.js";
import { HierarchicalPlayer, initializePlayer } from "./player.js";
import { ModelBudgetExceeded, ModelProviderError, PlayerModelRunner, type LearningReporter, type LearningEvent } from "./models.js";
import { latestPlayerPath, loadPlayer, playerPolicySchema, policyId, type LearningGame, type PlayerPolicy } from "./policy.js";
import type { GoalEvaluation } from "./goal.js";
import { preflightPolicy } from "./preflight.js";
import { proposeRevision, type Revision } from "./revision.js";

export interface EpisodeResult {
  seed: number;
  won: boolean;
  score: number;
  steps: number;
  stopReason: "won" | "game-over" | "turn-limit" | "error";
  error?: string;
  errorKind?: "provider" | "execution";
  usage: PlayerModelRunner["usage"];
  finalState: unknown;
  trajectory: unknown[];
  failedDecision?: { state: unknown; judgments: unknown };
  elapsedMs: number;
}

export async function playEpisode<State, Action>(game: LearningGame<State, Action>, policy: PlayerPolicy,
  models: PlayerModelRunner, options: { seed: number; maxSteps: number; signal: AbortSignal; report?: LearningReporter }): Promise<EpisodeResult> {
  const adapter = await game.create(options.seed);
  const started = performance.now();
  const usageBefore = structuredClone(models.usage);
  let judgments: Record<string, unknown> = {};
  const reportPlayer: LearningReporter = async event => {
    if (event.type.startsWith("reflex.")) judgments[event.type.slice("reflex.".length)] = event.detail;
    await options.report?.(event);
  };
  const runtime = new SessionRuntime({
    adapter, candidates: game.candidates, verifier: game.verifier,
    reflex: new HierarchicalPlayer({ game, policy, models, report: reportPlayer }),
    trace: { record: event => options.report?.({ type: `runtime.${event.type}`, detail: event }) },
  }, game.goal);
  const stop = () => runtime.stop();
  options.signal.addEventListener("abort", stop, { once: true });
  let state!: State;
  let steps = 0;
  let error: string | undefined;
  let errorKind: EpisodeResult["errorKind"];
  const trajectory: unknown[] = [];
  try {
    state = (await adapter.observe()).state;
    await reportPlayer({ type: "episode.started", detail: { state, strategy: policy.strategy } });
    while (steps < options.maxSteps && !game.outcome(state).done) {
      options.signal.throwIfAborted();
      judgments = {};
      const result = await runtime.step();
      options.signal.throwIfAborted();
      state = (result.after ?? await adapter.observe()).state;
      if (!result.candidate) {
        if (game.outcome(state).done) break;
        if (game.realtime) { await setImmediate(); continue; }
        throw new Error("No action was selected before the episode ended");
      }
      steps++;
      const transition = { step: steps, before: result.before.state, action: result.candidate.action, after: state, verification: result.verification,
        ...(Object.keys(judgments).length ? { judgments } : {}) };
      trajectory.push(transition);
      await options.report?.({ type: "episode.step", detail: transition });
      if (result.verification?.status === "unknown") throw new Error(result.verification.reason ?? "Unverified game transition");
      if (result.verification?.status === "failure" && !game.outcome(state).done) throw new Error(result.verification.reason ?? "Action verification failed");
      // Yield so SIGINT can interrupt a fast generated policy too.
      await setImmediate();
    }
  } catch (cause) {
    if (options.signal.aborted || cause instanceof ModelBudgetExceeded) throw cause;
    if (state === undefined) throw cause;
    error = String(cause);
    errorKind = cause instanceof ModelProviderError ? "provider" : "execution";
  } finally {
    options.signal.removeEventListener("abort", stop);
    await runtime.finish();
    if (game.realtime) state = (await adapter.observe()).state;
  }
  const outcome = game.outcome(state);
  const sample = trajectory.filter((_, index) => index % Math.max(1, Math.ceil(trajectory.length / 12)) === 0 || index >= trajectory.length - 12);
  const usage = structuredClone(models.usage);
  for (const key of ["calls", "inputTokens", "outputTokens", "latencyMs", "failures"] as const) {
    usage[key] -= usageBefore[key];
    for (const role of ["strategist", "tactician", "reflex"] as const) usage.roles[role][key] -= usageBefore.roles[role][key];
  }
  return {
    seed: options.seed, won: !error && outcome.won, score: outcome.score, steps, error, errorKind, usage,
    stopReason: error ? "error" : outcome.won ? "won" : outcome.done ? "game-over" : "turn-limit",
    finalState: state, trajectory: sample, elapsedMs: Math.round(performance.now() - started),
    ...(error ? { failedDecision: { state, judgments } } : {}),
  };
}

function metrics(results: EpisodeResult[]) {
  const completed = results.filter(result => !result.error);
  const mean = (items: EpisodeResult[], value: (item: EpisodeResult) => number) =>
    items.length ? items.reduce((sum, item) => sum + value(item), 0) / items.length : 0;
  return {
    games: results.length, completed: completed.length,
    wins: completed.filter(result => result.won).length,
    errors: results.filter(result => result.error).length,
    providerErrors: results.filter(result => result.errorKind === "provider").length,
    executionErrors: results.filter(result => result.errorKind === "execution").length,
    meanScore: mean(completed, result => result.score),
    meanSteps: mean(completed, result => result.steps),
    meanCalls: mean(completed, result => result.usage.calls),
    meanTokens: mean(completed, result => result.usage.inputTokens + result.usage.outputTokens),
    meanMs: mean(completed, result => result.elapsedMs),
  };
}
function better(candidate: ReturnType<typeof metrics>, incumbent: ReturnType<typeof metrics>, evaluation?: GoalEvaluation) {
  // Outages provide no evidence that one player is better. Execution errors are policy evidence.
  if (candidate.errors || incumbent.providerErrors) return false;
  if (incumbent.executionErrors) return true;
  if (candidate.wins !== incumbent.wins) return candidate.wins > incumbent.wins;
  const allWon = candidate.wins === candidate.games && incumbent.wins === incumbent.games;
  if ((evaluation?.objective === "score" || !allWon) && candidate.meanScore !== incumbent.meanScore) return candidate.meanScore > incumbent.meanScore;
  // Preserve goal performance first. Then reduce decisions, model calls, and tokens, in that order.
  if (evaluation?.efficiency === "model-calls" && candidate.meanCalls !== incumbent.meanCalls) return candidate.meanCalls < incumbent.meanCalls;
  if (candidate.meanSteps !== incumbent.meanSteps) return candidate.meanSteps < incumbent.meanSteps;
  if (candidate.meanCalls !== incumbent.meanCalls) return candidate.meanCalls < incumbent.meanCalls;
  return candidate.meanTokens < incumbent.meanTokens;
}

export async function runResearch<State, Action>(options: {
  game: LearningGame<State, Action>; models: PlayerModelRunner; rounds: number; games: number;
  maxSteps: number; firstSeed: number; signal: AbortSignal; policy?: PlayerPolicy; fresh?: boolean;
  /** Isolated experiment: no prior policies/findings and no writes to shared learning state. */
  coldStart?: boolean;
  report?: LearningReporter;
  /** Resume completed episodes/proposals; an interrupted episode restarts from its seed. */
  resume?: string;
  setupEvents?: LearningEvent[];
}) {
  const { game, models, signal } = options;
  if (game.continuity === "persistent") throw new Error("Matched benchmarks require resettable episodes; use continual learning for persistent worlds");
  if (game.requestedGoal && game.evaluation?.request !== game.requestedGoal) throw new Error("Resolve the requested goal before starting research");
  if (options.resume && options.policy) throw new Error("Resume cannot replace the saved baseline policy");
  if (options.coldStart && options.policy) throw new Error("Cold-start experiments cannot use a supplied policy");
  const startEmpty = options.fresh || options.coldStart;
  for (const value of [options.rounds, options.games, options.maxSteps]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("Research rounds, games and turn limits must be positive integers");
  }
  const lastSeed = options.firstSeed + (options.rounds + 2) * options.games;
  if (!Number.isSafeInteger(options.firstSeed) || options.firstSeed < 0 || lastSeed > 0xffffffff) throw new Error("Research seeds must fit in distinct unsigned 32-bit values");
  const directory = options.resume ? resolve(options.resume) : resolve(".gamebot", "research", game.id, randomUUID());
  await mkdir(directory, { recursive: true });
  const journal = join(directory, "runs.jsonl");
  const experiment = {
    game: game.id, gameVersion: game.version, rules: game.rules, goal: game.goal, evaluation: game.evaluation,
    coldStart: options.coldStart ?? false, fresh: options.fresh ?? false, rounds: options.rounds, games: options.games,
    maxSteps: options.maxSteps, firstSeed: options.firstSeed, maxCalls: models.maxCalls,
    models: Object.fromEntries(Object.entries(models.models).map(([role, model]) => [role, typeof model === "string" ? model : model.modelId])),
  };
  type Proposal = Revision;
  type Checkpoint = {
    completed?: boolean; baseline?: PlayerPolicy; proposals: Record<string, Proposal>; results: Record<string, EpisodeResult>;
    preflights: Record<string, Awaited<ReturnType<typeof preflightPolicy>>>;
    findings: Record<string, unknown>; history?: unknown[]; usage: PlayerModelRunner["usage"];
    firstWin?: { episode: number; policyId: string; set: string; seed: number; steps: number; modelCalls: number };
  };
  let checkpoint: Checkpoint = { proposals: {}, results: {}, preflights: {}, findings: {}, usage: models.usage };
  if (options.resume) {
    const original = JSON.parse(await readFile(join(directory, "experiment.json"), "utf8"));
    delete original.maxOutputTokens; // Ignore the removed output setting in older checkpoints.
    // Budget can be raised explicitly to continue after exhaustion; evaluation conditions cannot change.
    if (JSON.stringify({ ...original, maxCalls: models.maxCalls }) !== JSON.stringify(experiment)) throw new Error("Resume configuration differs from the saved experiment");
    checkpoint = JSON.parse(await readFile(join(directory, "checkpoint.json"), "utf8"));
    if (checkpoint.completed) throw new Error("This experiment is already complete; replay its result.json policyPath with --policy instead");
    Object.assign(models.usage, checkpoint.usage);
    checkpoint.usage = models.usage;
    if (models.maxCalls < models.usage.calls) throw new Error(`--max-calls must cover the ${models.usage.calls} calls already spent`);
    // Keep subsequent CLI resumes on the last explicitly selected call limit.
    await writeFile(join(directory, "experiment.json"), JSON.stringify(experiment, null, 2) + "\n");
  } else {
    await writeFile(join(directory, "experiment.json"), JSON.stringify(experiment, null, 2) + "\n");
  }
  const persist = async () => {
    const temporary = join(directory, "checkpoint.tmp");
    await writeFile(temporary, JSON.stringify(checkpoint) + "\n");
    await rename(temporary, join(directory, "checkpoint.json"));
  };
  await persist();
  const report: LearningReporter = async event => {
    await appendFile(journal, JSON.stringify({ time: new Date().toISOString(), ...event }) + "\n");
    await options.report?.(event);
  };
  const originalReporter = models.report;
  let modelContext: Record<string, unknown> = { phase: "research" };
  models.report = async event => {
    await persist();
    await report({ ...event, detail: { ...modelContext, event: event.detail } });
  };
  try {
    await report({ type: options.resume ? "research.resumed" : "research.created", detail: { directory, experiment } });
    for (const event of options.setupEvents ?? []) await report(event);
    const artifact = (policy: PlayerPolicy) => ({ format: "gamebot-player-v2", gameId: game.id, gameVersion: game.version, goal: game.goal, evaluation: game.evaluation, policy });
    const save = async (policy: PlayerPolicy) => {
      const path = join(directory, `${policyId(policy)}.json`);
      await writeFile(path, JSON.stringify(artifact(policy), null, 2) + "\n");
      return path;
    };
    const seeds = (set: number) => Array.from({ length: options.games }, (_, index) => options.firstSeed + set * options.games + index);
    let firstWin = checkpoint.firstWin;
    const evaluate = async (policy: PlayerPolicy, set: string, seedSet: number[]) => {
      const results: EpisodeResult[] = [];
      for (const seed of seedSet) {
        signal.throwIfAborted();
        const key = `${policyId(policy)}:${set}:${seed}`;
        let result = checkpoint.results[key];
        if (!result) {
          modelContext = { phase: "gameplay", policyId: policyId(policy), set, seed };
          try {
            result = await playEpisode(game, policy, models, { seed, maxSteps: options.maxSteps, signal,
              report: event => report({ ...event, detail: { policyId: policyId(policy), set, seed, event: event.detail } }),
            });
          } finally { modelContext = { phase: "research" }; }
          if (result.errorKind === "provider") {
            await report({ type: "episode.completed", detail: { policyId: policyId(policy), set, ...result } });
            throw new Error(`Trial is inconclusive after provider failure; resume to retry seed ${seed}. ${result.error}`);
          }
          checkpoint.results[key] = result;
          if (result.won && !firstWin) {
            firstWin = { episode: Object.keys(checkpoint.results).length, policyId: policyId(policy), set, seed, steps: result.steps, modelCalls: models.usage.calls };
            checkpoint.firstWin = firstWin;
            await report({ type: "research.first-win", detail: firstWin });
          }
          await persist();
          await report({ type: "episode.completed", detail: { policyId: policyId(policy), set, ...result } });
        }
        results.push(result);
      }
      return { metrics: metrics(results), results };
    };
    let baseline = checkpoint.baseline ?? options.policy;
    if (!baseline && !startEmpty) {
      try { baseline = await loadPlayer("latest", game); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    if (!baseline) {
      const observation = await (await game.create(options.firstSeed)).observe();
      await report({ type: "research.setup", detail: { state: observation.state } });
      baseline = await initializePlayer(game, observation, models, signal, report);
    }
    checkpoint.baseline = baseline;
    await save(baseline);
    await persist();
    await report({ type: "research.started", detail: { ...experiment, baseline: policyId(baseline), journal } });
    const historyPath = options.coldStart ? join(directory, "research-history.jsonl")
      : resolve(".gamebot", "games", game.id, "research-history.jsonl");
    let history: unknown[] = checkpoint.history ?? [];
    try {
      history = checkpoint.history !== undefined ? checkpoint.history : startEmpty ? [] : (await readFile(historyPath, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line))
        .filter(item => item.gameVersion === game.version && item.goal === game.goal.description).slice(-20);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    checkpoint.history = structuredClone(history);
    await persist();
    let champion = baseline;
    const initialTrain = await evaluate(champion, "train", seeds(0));
    let championTrain = initialTrain;
    const tried = new Set([policyId(champion)]);
    for (let round = 1; round <= options.rounds; round++) {
      signal.throwIfAborted();
      const proposal = checkpoint.proposals[round] ?? await proposeRevision(models, {
        mode: "benchmark", rules: game.rules, goal: game.goal, evaluation: game.evaluation, budget: { gamesPerSet: options.games, rounds: options.rounds, maxSteps: options.maxSteps, remainingModelCalls: models.maxCalls - models.usage.calls }, currentPolicy: champion, training: championTrain,
        // Keep detailed receipts for recent experiments, summaries for older ones.
        history: history.map((item, index) => {
          if (index >= history.length - 3) return item;
          const { policy, evidence, ...summary } = item as Record<string, unknown>;
          return summary;
        }), tried: [...tried], round,
      }, signal);
      if (!proposal.policy) {
        checkpoint.proposals[round] = proposal;
        await persist();
        await report({ type: "research.revision", detail: { round, accepted: false, reason: "no-change", ...proposal } });
        continue;
      }
      playerPolicySchema.parse(proposal.policy);
      checkpoint.proposals[round] = proposal;
      await persist();
      const candidate = proposal.policy;
      const id = policyId(candidate);
      await save(candidate);
      await report({ type: "research.proposal", detail: { round, id, ...proposal } });
      let accepted = false;
      let reason = "duplicate";
      let candidateMetrics: ReturnType<typeof metrics> | undefined;
      let errors: string[] = [];
      let evidence: EpisodeResult[] = [];
      const priorEvidence = history.slice(-3).flatMap(item => {
        const evidence = (item as { evidence?: EpisodeResult[] }).evidence;
        return Array.isArray(evidence) ? evidence : [];
      });
      const states = [...championTrain.results, ...priorEvidence].flatMap(result => [
        ...result.trajectory.map(item => (item as { before: State }).before), result.finalState as State,
      ]);
      const preflight = checkpoint.preflights[id] ?? await preflightPolicy(game, candidate, states, signal);
      checkpoint.preflights[id] = preflight;
      await persist();
      await report({ type: "research.preflight", detail: { id, ...preflight } });
      if (!preflight.passed) { reason = "preflight"; errors = [preflight.error!]; tried.add(id); }
      if (preflight.passed && !tried.has(id)) {
        tried.add(id);
        const train = await evaluate(candidate, "train", seeds(0));
        evidence = train.results;
        candidateMetrics = train.metrics;
        errors = train.results.flatMap(result => result.error ? [result.error] : []);
        reason = "training";
        if (better(train.metrics, championTrain.metrics, game.evaluation)) {
          const previous = await evaluate(champion, "validation", seeds(round));
          const validation = await evaluate(candidate, "validation", seeds(round));
          evidence = [...train.results, ...validation.results];
          candidateMetrics = validation.metrics;
          errors = validation.results.flatMap(result => result.error ? [result.error] : []);
          reason = "validation";
          if (better(validation.metrics, previous.metrics, game.evaluation)) {
            champion = candidate;
            championTrain = train;
            accepted = true;
          }
        }
      }
      const finding = { gameVersion: game.version, goal: game.goal.description, round, id, hypothesis: proposal.hypothesis,
        diagnosis: proposal.diagnosis, accepted, reason, metrics: candidateMetrics, errors, policy: candidate,
        preflight, evidence: evidence.map(result => ({ ...result, trajectory: result.trajectory.slice(-3) })) };
      history.push(finding);
      history = history.slice(-20);
      await mkdir(dirname(historyPath), { recursive: true });
      if (!checkpoint.findings[round]) {
        checkpoint.findings[round] = finding;
        await persist();
        await appendFile(historyPath, JSON.stringify(finding) + "\n");
      }
      await report({ type: "research.revision", detail: finding });
    }
    const baselineTest = await evaluate(baseline, "test", seeds(options.rounds + 1));
    const championTest = policyId(champion) === policyId(baseline) ? baselineTest : await evaluate(champion, "test", seeds(options.rounds + 1));
    const promoted = policyId(champion) !== policyId(baseline) && better(championTest.metrics, baselineTest.metrics, game.evaluation);
    const selected = promoted ? champion : baseline;
    const selectedTest = promoted ? championTest : baselineTest;
    await mkdir(dirname(historyPath), { recursive: true });
    await appendFile(historyPath, JSON.stringify({ gameVersion: game.version, goal: game.goal.description,
      id: policyId(champion), selectedId: policyId(selected), accepted: promoted, reason: "final-audit",
      candidateMetrics: championTest.metrics, baselineMetrics: baselineTest.metrics,
    }) + "\n");
    const path = await save(selected);
    signal.throwIfAborted();
    // Only evaluated, error-free policies may become latest. Ordinary play never loads this implicitly.
    if (!options.coldStart && selectedTest.metrics.errors === 0) {
      const latest = latestPlayerPath(game.id, game.goal);
      await mkdir(dirname(latest), { recursive: true });
      const temporary = `${latest}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(artifact(selected), null, 2) + "\n");
      signal.throwIfAborted();
      await rename(temporary, latest);
    }
    const result = { policyPath: path, policyId: policyId(selected), promoted, coldStart: options.coldStart ?? false,
      episodes: Object.keys(checkpoint.results).length, firstWin: firstWin ?? null, initialTrain: initialTrain.metrics, baselineTest: baselineTest.metrics,
      goalReachedOnTest: selectedTest.metrics.errors === 0 && selectedTest.metrics.wins > 0,
      candidateTest: championTest.metrics, selectedTest: selectedTest.metrics, usage: models.usage, journal };
    await writeFile(join(directory, "result.json"), JSON.stringify(result, null, 2) + "\n");
    checkpoint.completed = true;
    await persist();
    await report({ type: "research.completed", detail: result });
    return result;
  } catch (error) {
    await persist();
    await report({ type: "research.interrupted", detail: { directory, reason: String(error),
      resume: `npm run autoplay -- --game=${game.id} --resume=${directory}` } });
    throw error;
  } finally { models.report = originalReporter; }
}
