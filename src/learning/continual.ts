import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SessionRuntime, type GameAdapter, type StepResult, type TraceSink, type Signals } from "../core/index.js";
import { HierarchicalPlayer, initializePlayer } from "./player.js";
import { ModelBudgetExceeded, ModelProviderError, PlayerModelRunner, type LearningReporter, type LearningEvent } from "./models.js";
import { playerPolicySchema, policyId, type LearningGame, type PlayerPolicy } from "./policy.js";
import { preflightPolicy } from "./preflight.js";
import { proposeRevision, type Revision } from "./revision.js";

type Outcome = { done: boolean; won: boolean; score: number };
interface Window<State> {
  before: State; after: State; steps: number; elapsedMs: number; samples: unknown[];
  usageStart: PlayerModelRunner["usage"]; lastProgressStep: number; lastScore: number;
}
interface Feedback<State> {
  policyId: string; reason: string; before: State; after: State; steps: number; elapsedMs: number;
  start: Outcome; end: Outcome; progress: number; comparisonKey?: string; error?: string;
  usage: PlayerModelRunner["usage"]; trajectory: unknown[];
  failedDecision?: { state: State; judgments: unknown };
}
interface LearningCheckpoint<State> {
  policy?: PlayerPolicy; steps: number; episodes: number; reviews: number; nextReviewIn: number;
  window?: Window<State>; pending?: { feedback: Feedback<State>; proposal?: Revision };
  trial?: { previous: PlayerPolicy; reference: Feedback<State>; hypothesis: string };
  history: unknown[]; tried: string[]; usage: PlayerModelRunner["usage"];
  terminal: boolean;
}
export interface ContinualOptions<State, Action> {
  game: LearningGame<State, Action>; models: PlayerModelRunner; signal: AbortSignal;
  adapter?: GameAdapter<State, Action>; policy?: PlayerPolicy; seed?: number;
  learnEvery?: number; learnMs?: number; coldStart?: boolean; fresh?: boolean;
  limits?: { maxSteps?: number; maxReviews?: number; maxGames?: number };
  resume?: string; setupEvents?: LearningEvent[]; report?: LearningReporter; trace?: TraceSink;
}

/** One world and one learning cycle. Reviews run between actions and never reset the world. */
export class ContinualLearningSession<State, Action> {
  readonly directory: string;
  private checkpoint: LearningCheckpoint<State>;
  private runtime!: SessionRuntime<State, Action>;
  private player!: HierarchicalPlayer<State, Action>;
  private adapter!: GameAdapter<State, Action>;
  private queue: Promise<void> = Promise.resolve();
  private readonly controller = new AbortController();
  private readonly originalReporter: LearningReporter | undefined;
  private phase = "gameplay";
  private decisionError?: unknown;
  private signals: Signals = {};
  private judgments: Record<string, unknown> = {};
  private boundaryAt = performance.now();
  private readonly onAbort = () => this.stop();
  private closed = false;
  private learnMs: number;
  private seed: number;

  private constructor(private readonly options: ContinualOptions<State, Action>) {
    this.directory = options.resume ? resolve(options.resume) : resolve(".gamebot", "research", options.game.id, randomUUID());
    this.seed = options.seed ?? 1;
    this.learnMs = options.learnMs ?? 300000;
    this.originalReporter = options.models.report;
    this.checkpoint = { steps: 0, episodes: 0, reviews: 0, nextReviewIn: options.learnEvery ?? 64,
      history: [], tried: [], usage: options.models.usage, terminal: false };
  }

  static async open<State, Action>(options: ContinualOptions<State, Action>): Promise<ContinualLearningSession<State, Action>> {
    const session = new ContinualLearningSession(options);
    try { await session.open(); return session; }
    catch (error) { await session.finish(); throw error; }
  }

  get steps() { return this.checkpoint.steps; }
  get episodes() { return this.checkpoint.episodes; }
  get reviews() { return this.checkpoint.reviews; }
  get state(): State { return this.checkpoint.window!.after; }
  get done() { return this.checkpoint.terminal; }
  get policyStatus() { return this.checkpoint.trial ? "trial" : this.reviews ? "observational" : "initial"; }
  get policyPath() { return join(this.directory, `${policyId(this.checkpoint.policy!)}.json`); }
  getAuthority() { return this.runtime.getAuthority(); }

  private async open() {
    const { game, models, signal } = this.options;
    signal.throwIfAborted();
    if (this.options.resume && (this.options.policy || this.options.adapter)) throw new Error("Resume must reconnect through the game definition");
    if (this.options.coldStart && this.options.policy) throw new Error("Cold start cannot load a supplied policy");
    if (game.requestedGoal && game.evaluation?.request !== game.requestedGoal) throw new Error("Resolve the requested goal before learning");
    if (!Number.isInteger(this.checkpoint.nextReviewIn) || this.checkpoint.nextReviewIn < 1 || this.checkpoint.nextReviewIn > 2048 ||
      !Number.isSafeInteger(this.learnMs) || this.learnMs < 1 || !Number.isSafeInteger(this.seed)) throw new Error("Invalid learning interval, deadline or seed");
    await mkdir(this.directory, { recursive: true });
    const identity = { game: game.id, gameVersion: game.version, goal: game.goal, evaluation: game.evaluation, rules: game.rules,
      continuity: game.continuity ?? "episodic", models: Object.fromEntries(Object.entries(models.models)
        .map(([role, model]) => [role, typeof model === "string" ? model : model.modelId])) };
    const manifestPath = join(this.directory, "experiment.json");
    if (this.options.resume) {
      const saved = JSON.parse(await readFile(manifestPath, "utf8"));
      if (saved.mode !== "continual-v1" || JSON.stringify(saved.identity) !== JSON.stringify(identity)) throw new Error("Resume game, goal, rules or models differ from this learning session");
      this.checkpoint = JSON.parse(await readFile(join(this.directory, "checkpoint.json"), "utf8"));
      this.seed = saved.seed;
      this.learnMs = saved.learnMs;
      Object.assign(models.usage, this.checkpoint.usage);
      this.checkpoint.usage = models.usage;
      if (models.maxCalls < models.usage.calls) throw new Error("--max-calls cannot be below calls already spent");
      await this.writeJson(manifestPath, { ...saved, maxCalls: models.maxCalls, limits: this.options.limits ?? saved.limits });
    } else {
      await this.writeJson(manifestPath, { mode: "continual-v1", identity, seed: this.seed,
        learnEvery: this.checkpoint.nextReviewIn, learnMs: this.learnMs, coldStart: this.options.coldStart ?? false,
        fresh: this.options.fresh ?? false, limits: this.options.limits, maxCalls: models.maxCalls });
    }
    await this.emit("learning.created", { directory: this.directory, resumed: !!this.options.resume });
    models.report = async event => {
      await this.persist();
      await this.emit(event.type, { phase: this.phase, policyId: this.checkpoint.policy && policyId(this.checkpoint.policy), event: event.detail });
    };
    for (const event of this.options.setupEvents ?? []) await this.emit(event.type, event.detail);
    signal.addEventListener("abort", this.onAbort, { once: true });
    if (signal.aborted) this.stop();
    this.controller.signal.throwIfAborted();
    if (this.options.resume && game.continuity === "persistent") {
      if (!game.reconnect) throw new Error("Persistent worlds require reconnect() to resume without resetting the world");
      this.adapter = await game.reconnect();
    } else {
      this.adapter = this.options.adapter ?? await game.create(this.seed + this.checkpoint.episodes);
    }
    const observation = await this.adapter.observe();
    if (this.options.resume) {
      await this.emit("learning.reconnected", { previous: this.checkpoint.window?.after, current: observation.state,
        discardedPartialSteps: this.checkpoint.window?.steps ?? 0, persistent: game.continuity === "persistent" });
    }
    // Offline changes or a recreated episode must not be attributed to the previous policy's window.
    this.startWindow(observation.state);
    this.checkpoint.terminal = game.outcome(observation.state).done;
    if (!this.checkpoint.policy) {
      this.phase = "learning";
      try { this.checkpoint.policy = this.options.policy ?? await initializePlayer(game, observation, models, this.controller.signal,
        event => this.emit(event.type, event.detail)); }
      finally { this.phase = "gameplay"; }
    }
    playerPolicySchema.parse(this.checkpoint.policy);
    if (!this.checkpoint.tried.length) this.checkpoint.tried.push(policyId(this.checkpoint.policy));
    await this.savePolicy();
    this.buildRuntime();
    await this.persist();
    await this.emit("episode.started", { state: this.state, episode: this.episodes + 1, policyId: policyId(this.checkpoint.policy) });
    await this.emit(this.options.resume ? "learning.resumed" : "learning.started", {
      directory: this.directory, goal: game.goal, policyId: policyId(this.checkpoint.policy),
      nextReviewIn: this.checkpoint.nextReviewIn, learnMs: this.learnMs,
    });
  }

  private buildRuntime() {
    const { game, models } = this.options;
    this.player = new HierarchicalPlayer({ game, models, policy: this.checkpoint.policy, report: async event => {
      if (event.type.startsWith("reflex.")) this.judgments[event.type.slice(7)] = event.detail;
      await this.emit(event.type, event.detail);
    } });
    this.runtime = new SessionRuntime({ adapter: this.adapter, candidates: game.candidates, verifier: game.verifier,
      reflex: { choose: async (context, candidates, signal) => {
        try { return await this.player.choose(context, candidates, signal); }
        catch (error) { this.decisionError = error; throw error; }
      } }, trace: { record: async event => {
        if (event.type === "observation") this.signals = (event.detail as { signals: Signals }).signals;
        await this.options.trace?.record(event);
        await this.emit(`runtime.${event.type}`, event);
      } } }, game.goal);
  }

  step(): Promise<StepResult<State, Action>> {
    return this.enqueue(async () => {
      const signal = this.controller.signal;
      signal.throwIfAborted();
      await this.reviewPending();
      if (this.done) throw new Error("The current game is terminal");
      this.judgments = {};
      this.decisionError = undefined;
      let result: StepResult<State, Action>;
      try { result = await this.runtime.step(); }
      catch (error) {
        if (signal.aborted || error instanceof ModelBudgetExceeded || error instanceof ModelProviderError || error !== this.decisionError) throw error;
        await this.closeWindow("execution-error", String(error));
        return { before: await this.adapter.observe() };
      }
      signal.throwIfAborted();
      const observation = result.after ?? await this.adapter.observe();
      const window = this.checkpoint.window!;
      window.after = structuredClone(observation.state);
      if (result.candidate) { window.steps++; this.checkpoint.steps++; }
      window.elapsedMs += performance.now() - this.boundaryAt;
      this.boundaryAt = performance.now();
      const outcome = this.options.game.outcome(window.after);
      if (outcome.score > window.lastScore) window.lastProgressStep = window.steps;
      window.lastScore = outcome.score;
      const transition = { step: this.checkpoint.steps, before: result.before.state, action: result.candidate?.action,
        after: observation.state, verification: result.verification, judgments: this.judgments };
      window.samples.push(structuredClone(transition));
      if (window.samples.length > 12) window.samples.splice(4, 1);
      if (outcome.done) { this.checkpoint.episodes++; this.checkpoint.terminal = true; }
      await this.persist();
      await this.emit("episode.step", transition);
      const feedback = this.options.game.learningFeedback?.(window);
      const failed = result.verification?.status === "unknown" || result.verification?.status === "failure" && !outcome.done;
      const reason = failed ? "verification-failure" : outcome.done ? outcome.won ? "won" : "game-over"
        : !result.candidate ? "blocked" : this.signals.goalBlocked || this.signals.tacticFailed ? "setback" : this.signals.novel ? "novel-situation"
          : feedback?.setback ? `setback: ${feedback.setback}` : feedback?.milestone ? `milestone: ${feedback.milestone}`
          : window.elapsedMs >= this.learnMs ? "deadline" : window.steps >= this.checkpoint.nextReviewIn
            ? window.steps - window.lastProgressStep >= this.checkpoint.nextReviewIn && (feedback?.progress ?? 0) <= 0 ? "stalled" : "review-interval" : undefined;
      if (reason) await this.closeWindow(reason, failed ? result.verification?.reason ?? "Unverified action" : undefined);
      return result;
    });
  }

  /** Autoplay may start another terminal episodic game; learning checkpoints never call this. */
  restart(): Promise<void> {
    return this.enqueue(async () => {
      this.controller.signal.throwIfAborted();
      await this.reviewPending();
      if (!this.done || this.options.game.continuity === "persistent") throw new Error("Only terminal episodic games can restart");
      await this.runtime.finish();
      this.adapter = await this.options.game.create(this.seed + this.checkpoint.episodes);
      this.startWindow((await this.adapter.observe()).state);
      this.checkpoint.terminal = this.options.game.outcome(this.state).done;
      this.buildRuntime();
      await this.persist();
      await this.emit("episode.started", { state: this.state, episode: this.episodes + 1, policyId: policyId(this.checkpoint.policy!) });
    });
  }

  /** Use the same review path for a run budget boundary as for a milestone or game ending. */
  review(): Promise<void> {
    return this.enqueue(async () => {
      await this.reviewPending();
      if (this.checkpoint.window?.steps) await this.closeWindow("run-limit");
    });
  }

  stop(): void { this.controller.abort(); this.runtime?.stop(); }
  async finish(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stop();
    await this.queue;
    await this.runtime?.finish();
    this.options.signal.removeEventListener("abort", this.onAbort);
    try {
      if (this.checkpoint.policy) {
        if (this.checkpoint.window?.steps && !this.checkpoint.pending) {
          this.checkpoint.pending = { feedback: this.describeWindow("interrupted") };
        }
        await this.persist();
        await this.emit("learning.saved", { directory: this.directory, policyPath: this.policyPath, steps: this.steps,
          reviews: this.reviews, policyStatus: this.policyStatus, terminal: this.done, pendingReview: !!this.checkpoint.pending });
      }
    } finally { this.options.models.report = this.originalReporter; }
  }

  private startWindow(state: State) {
    this.checkpoint.window = { before: structuredClone(state), after: structuredClone(state), steps: 0, elapsedMs: 0, samples: [],
      usageStart: structuredClone(this.options.models.usage), lastProgressStep: 0, lastScore: this.options.game.outcome(state).score };
    this.boundaryAt = performance.now();
  }

  private describeWindow(reason: string, error?: string): Feedback<State> {
    const window = this.checkpoint.window!;
    const { game, models } = this.options;
    const start = game.outcome(window.before), end = game.outcome(window.after);
    const assessment = game.learningFeedback?.(window);
    const usage = structuredClone(models.usage);
    for (const key of ["calls", "failures", "inputTokens", "outputTokens", "latencyMs"] as const) {
      usage[key] -= window.usageStart[key];
      for (const role of ["strategist", "tactician", "reflex"] as const) usage.roles[role][key] -= window.usageStart.roles[role][key];
    }
    const feedback: Feedback<State> = { policyId: policyId(this.checkpoint.policy!), reason,
      before: window.before, after: window.after, steps: window.steps, elapsedMs: window.elapsedMs,
      start, end, progress: assessment?.progress ?? end.score - start.score, comparisonKey: assessment?.comparisonKey,
      error, usage, trajectory: window.samples,
      ...(error ? { failedDecision: { state: window.after, judgments: this.judgments } } : {}) };
    if (!Number.isFinite(feedback.progress)) throw new Error("Learning feedback progress must be finite");
    return feedback;
  }

  private async closeWindow(reason: string, error?: string) {
    const feedback = this.describeWindow(reason, error);
    this.checkpoint.pending = { feedback };
    await this.persist();
    await this.emit("learning.window", feedback);
    await this.reviewPending();
  }

  private async reviewPending() {
    const pending = this.checkpoint.pending;
    if (!pending) return;
    const { game, models } = this.options;
    const signal = this.controller.signal;
    signal.throwIfAborted();
    this.phase = "learning";
    try {
      const proposal = pending.proposal ?? await proposeRevision(models, {
        mode: "continual", rules: game.rules, goal: game.goal, evaluation: game.evaluation,
        currentPolicy: this.checkpoint.policy, training: { results: [pending.feedback] },
        trial: this.checkpoint.trial, history: this.checkpoint.history.slice(-6), tried: this.checkpoint.tried,
        round: this.reviews + 1, budget: { remainingModelCalls: models.maxCalls - models.usage.calls },
      }, signal);
      pending.proposal = proposal;
      await this.persist();
      await this.emit("learning.proposal", proposal);
      // Stage the revision, then commit it with its receipts. Resume must never assess an old window against a newly activated trial.
      let policy = this.checkpoint.policy!;
      let trial = this.checkpoint.trial;
      const events: { type: string; detail: unknown }[] = [];
      let preflight: Awaited<ReturnType<typeof preflightPolicy>> | undefined;
      let attemptedId: string | undefined;
      if (trial) {
        const comparable = !!pending.feedback.comparisonKey && pending.feedback.comparisonKey === trial.reference.comparisonKey;
        const regression = comparable && pending.feedback.steps > 0 && trial.reference.steps > 0 &&
          pending.feedback.progress / pending.feedback.steps < trial.reference.progress / trial.reference.steps;
        const reject = !!pending.feedback.error || proposal.trialVerdict === "reject" || regression;
        if (reject) policy = trial.previous;
        if (reject || proposal.trialVerdict === "keep") {
          trial = undefined;
          events.push({ type: "learning.trial-reviewed", detail: { retained: !reject, comparable, evidence: "observational",
            reason: pending.feedback.error ?? (regression ? "measured progress regression" : proposal.diagnosis) } });
        }
      }
      if (proposal.policy && !this.checkpoint.tried.includes(policyId(proposal.policy))) {
        const current = (await this.adapter.observe()).state;
        const states = [pending.feedback.before, ...pending.feedback.trajectory.map(item => (item as { before: State }).before), current];
        preflight = await preflightPolicy(game, proposal.policy, states, signal);
        events.push({ type: "learning.preflight", detail: preflight });
        attemptedId = policyId(proposal.policy);
        if (preflight.passed) {
          // Revising an inconclusive trial retains its original rollback policy.
          trial = { previous: trial?.previous ?? policy, reference: trial?.reference ?? pending.feedback, hypothesis: proposal.hypothesis };
          policy = proposal.policy;
          events.push({ type: "learning.policy-activated", detail: { policyId: policyId(policy), evidence: "trial" } });
        }
      }
      const observed = (await this.adapter.observe()).state;
      signal.throwIfAborted();
      const changed = policyId(policy) !== policyId(this.checkpoint.policy!);
      this.checkpoint.policy = policy;
      this.checkpoint.trial = trial;
      if (attemptedId) this.checkpoint.tried.push(attemptedId);
      if (changed) this.player.replacePolicy(policy);
      this.checkpoint.nextReviewIn = proposal.nextReviewIn;
      this.checkpoint.history.push({ ...pending.feedback, trajectory: pending.feedback.trajectory.slice(-3),
        diagnosis: proposal.diagnosis, hypothesis: proposal.hypothesis, verdict: proposal.trialVerdict,
        proposedPolicy: proposal.policy, preflight, appliedPolicyId: policyId(policy), trialActive: !!trial });
      this.checkpoint.history = this.checkpoint.history.slice(-20);
      this.checkpoint.reviews++;
      this.checkpoint.pending = undefined;
      this.startWindow(observed);
      if (!this.checkpoint.terminal && game.outcome(observed).done) this.checkpoint.episodes++;
      this.checkpoint.terminal = game.outcome(observed).done;
      await this.savePolicy();
      await this.persist();
      for (const event of events) await this.emit(event.type, event.detail);
      await this.emit("learning.reviewed", { reviews: this.reviews, nextReviewIn: this.checkpoint.nextReviewIn,
        diagnosis: proposal.diagnosis, policyPath: this.policyPath });
    } finally { this.phase = "gameplay"; }
  }

  private async savePolicy() {
    await this.writeJson(this.policyPath, { format: "gamebot-player-v2", gameId: this.options.game.id,
      gameVersion: this.options.game.version, goal: this.options.game.goal, evaluation: this.options.game.evaluation,
      policy: this.checkpoint.policy, policyStatus: this.policyStatus, evidence: "observational; not a matched benchmark promotion" });
  }
  private persist() { return this.writeJson(join(this.directory, "checkpoint.json"), this.checkpoint); }
  private async writeJson(path: string, value: unknown) {
    const temporary = `${path}.tmp`;
    await writeFile(temporary, JSON.stringify(value) + "\n");
    await rename(temporary, path);
  }
  private async emit(type: string, detail: unknown) {
    await appendFile(join(this.directory, "runs.jsonl"), JSON.stringify({ time: new Date().toISOString(), type, detail }) + "\n");
    await this.options.report?.({ type, detail });
  }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

export async function runContinualLearning<State, Action>(options: ContinualOptions<State, Action> & {
  maxSteps?: number; maxReviews?: number; maxGames?: number;
}) {
  if (options.resume) {
    const saved = JSON.parse(await readFile(join(resolve(options.resume), "experiment.json"), "utf8"));
    options = { ...options, maxSteps: options.maxSteps ?? saved.limits?.maxSteps,
      maxReviews: options.maxReviews ?? saved.limits?.maxReviews, maxGames: options.maxGames ?? saved.limits?.maxGames };
  }
  for (const value of [options.maxSteps, options.maxReviews, options.maxGames]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new Error("Learning budgets must be positive integers");
  }
  const session = await ContinualLearningSession.open({ ...options,
    limits: { maxSteps: options.maxSteps, maxReviews: options.maxReviews, maxGames: options.maxGames } });
  let episodeStart = session.steps;
  try {
    while (!options.signal.aborted && (options.maxSteps === undefined || session.steps < options.maxSteps) &&
      (options.maxReviews === undefined || session.reviews < options.maxReviews) &&
      (options.maxGames === undefined || session.episodes < options.maxGames)) {
      if (session.done) {
        if (options.game.continuity === "persistent" || episodeStart === session.steps) break;
        await session.restart();
        episodeStart = session.steps;
      }
      await session.step();
    }
    if (!options.signal.aborted && (options.maxReviews === undefined || session.reviews < options.maxReviews)) await session.review();
    const result = { directory: session.directory, policyPath: session.policyPath, steps: session.steps,
      episodes: session.episodes, reviews: session.reviews, usage: options.models.usage,
      policyStatus: session.policyStatus, evidence: "observational", interrupted: options.signal.aborted };
    await writeFile(join(session.directory, "result.json"), JSON.stringify(result, null, 2) + "\n");
    await options.report?.({ type: "learning.completed", detail: result });
    return result;
  } finally { await session.finish(); }
}
