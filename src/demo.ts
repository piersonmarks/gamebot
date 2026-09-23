import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { FileTraceSink, SessionRuntime, type GameAdapter, type Reasoner } from "./core/index.js";
import { evaluate, type EvaluationConfiguration } from "./eval/harness.js";
import { aiSdkReasoner, aiSdkReflex, type ModelCallReport } from "./models/index.js";
import { SkillCatalog, SkillExecutorRegistry, selectSkillSummaries } from "./skills/index.js";

interface World {
  position: number;
  failedMoves: number;
}

type Action = "advance" | "vault" | "bridge";

/** A tiny deterministic environment for exercising the runtime, not a game benchmark. */
class PathGame implements GameAdapter<World, Action> {
  private position = 0;
  private failedMoves = 0;
  private revision = 0;

  async observe() {
    return {
      state: { position: this.position, failedMoves: this.failedMoves },
      revision: String(this.revision),
    };
  }

  async validateAction(action: Action, observation: { state: World; revision?: string }) {
    return observation.revision === String(this.revision) &&
      (action === "advance" || action === "vault" && this.position === 1 ||
        action === "bridge" && this.position === 3);
  }

  async execute(action: Action, signal: AbortSignal) {
    if (signal.aborted) return;
    if (action === "vault" && this.position === 1 || action === "bridge" && this.position === 3) {
      this.position += 2;
    } else if (action === "advance" && this.position !== 1 && this.position !== 3) {
      this.position++;
    } else {
      this.failedMoves++;
    }
    this.revision++;
  }

  signals(context: { lastVerification?: { status: string } }) {
    return {
      tacticFailed: context.lastVerification?.status === "failure",
      goalBlocked: this.position === 3 && context.lastVerification?.status === "failure",
    };
  }

  outcome() {
    return { complete: this.position >= 5, score: this.position / 5 };
  }
}

const tactician: Reasoner<World, number> = {
  async propose(request) {
    if (request.observation.state.position !== 1) return undefined;
    return {
      directive: { id: "vault-wall", instruction: "vault_wall" },
      assumptions: 1,
    };
  },
};

const strategist: Reasoner<World, number> = {
  async propose(request) {
    if (request.observation.state.position !== 3) return undefined;
    return {
      directive: { id: "bridge-gap", instruction: "bridge_gap" },
      assumptions: 3,
    };
  },
};

function board(position: number): string {
  const cells = ["S", "·", "█", "·", "≈", "G"];
  cells[position] = "●";
  return cells.join(" ");
}

const useAi = process.argv.includes("--ai");

function modelFor(role: "reflex" | "tactician" | "strategist"): string {
  const model = process.env[`GAMEBOT_${role.toUpperCase()}_MODEL`] ?? process.env.GAMEBOT_MODEL;
  if (!model) throw new Error(`Set GAMEBOT_${role.toUpperCase()}_MODEL or GAMEBOT_MODEL to an AI Gateway model ID`);
  return model;
}

function configuration(name: string, useTactician: boolean, useStrategist: boolean, watch = false): EvaluationConfiguration {
  return {
    name,
    create(seed, record) {
      const game = new PathGame();
      const traceSink = new FileTraceSink(resolve(".gamebot", "traces", `${name}-${seed}-${randomUUID()}.jsonl`));
      const models = useAi ? {
        reflex: modelFor("reflex"),
        ...(useTactician ? { tactician: modelFor("tactician") } : {}),
        ...(useStrategist ? { strategist: modelFor("strategist") } : {}),
      } : undefined;
      let traceStarted = false;
      const tokens = { input: 0, output: 0 };
      const onCall = (report: ModelCallReport) => {
        tokens.input += report.usage.inputTokens ?? 0;
        tokens.output += report.usage.outputTokens ?? 0;
      };
      const skills = new SkillExecutorRegistry();
      for (const [name, action] of [["vault-wall", "vault"], ["bridge-gap", "bridge"]] as const) {
        skills.register(name, {
          parseParams() { return {}; },
          async start() {
            let sent = false;
            let cancelled = false;
            return {
              async progress() {
                if (cancelled) return { status: "finished" as const, outcome: { status: "unknown" as const, reason: "cancelled" } };
                if (sent) return { status: "finished" as const, outcome: { status: "succeeded" as const, result: undefined } };
                sent = true;
                return { status: "running" as const, action };
              },
              async cancel() { cancelled = true; },
            };
          },
        });
      }
      const runtime = new SessionRuntime<World, Action, number>({
        adapter: game,
        reflex: useAi ? aiSdkReflex<World, Action>({
          model: models!.reflex,
          maxOutputTokens: 96,
          timeoutMs: 15_000,
          render(context, candidates) {
            return JSON.stringify({
              goal: context.authority.goal,
              directive: context.authority.directive,
              position: context.observation.state.position,
              candidates: candidates.map(({ id, description }) => ({ id, description })),
            });
          },
          onCall,
        }) : undefined,
        candidates: {
          generate({ observation, authority }) {
            const at = observation.state.position;
            const directive = authority.directive?.instruction;
            const action: Action = at === 1 && directive === "vault_wall" ? "vault" :
              at === 3 && directive === "bridge_gap" ? "bridge" : "advance";
            return [{ id: action, description: action, action }];
          },
        },
        verifier: {
          verify({ before, after, executionError }) {
            if (executionError) return { status: "unknown", reason: String(executionError) };
            return { status: after.state.position > before.state.position ? "success" : "failure" };
          },
        },
        executor: {
          async execute(action, signal) {
            if (action === "advance") return game.execute(action, signal);
            const name = action === "vault" ? "vault-wall" : "bridge-gap";
            const run = await skills.start(name, {}, await game.observe());
            for (;;) {
              if (signal.aborted) {
                await run.cancel("interrupted");
                return;
              }
              const progress = await run.progress(await game.observe());
              if (progress.status === "finished") {
                if (progress.outcome.status !== "succeeded") throw new Error(progress.outcome.reason);
                return;
              }
              if (progress.action !== undefined) {
                const current = await game.observe();
                const primitive = progress.action as Action;
                if (!(await game.validateAction(primitive, current))) throw new Error("Skill action is no longer valid");
                await game.execute(primitive, signal);
              }
            }
          },
        },
        tactician: useTactician ? (useAi ? aiSdkReasoner<World, number>({
          model: models!.tactician!,
          maxOutputTokens: 192,
          timeoutMs: 30_000,
          render: renderReasoning,
          captureAssumptions: request => request.observation.state.position,
          onCall,
        }) : tactician) : undefined,
        strategist: useStrategist ? (useAi ? aiSdkReasoner<World, number>({
          model: models!.strategist!,
          maxOutputTokens: 192,
          timeoutMs: 30_000,
          render: renderReasoning,
          captureAssumptions: request => request.observation.state.position,
          onCall,
        }) : strategist) : undefined,
        proposalValidator: {
          validate(proposal, current) {
            return proposal.assumptions === current.state.position;
          },
        },
        trace: {
          async record(event) {
            record(event);
            if (!traceStarted) {
              traceStarted = true;
              await traceSink.record({ ...event, type: "run.config", detail: { seed, models: models ?? "scripted" } });
            }
            if (watch && event.type === "decision") {
              console.log(`Action: ${(event.detail as { candidateId: string }).candidateId}`);
            }
            if (watch && event.type === "proposal.activated") {
              const change = event.detail as { role: string; directive: { instruction: string } };
              console.log(`${change.role} changes directive: ${change.directive.instruction}`);
            }
            if (watch && event.type === "verification") {
              console.log(`Outcome: ${(event.detail as { status: string }).status}`);
            }
            await traceSink.record(event);
          },
        },
      }, { id: "finish-path", description: "Reach position five" });
      if (watch) {
        console.log("Path game: reach G. █ is a wall; ≈ is a gap; ● is the agent.\n");
        console.log(board(0));
      }
      return {
        step: async () => {
          await runtime.step();
          if (watch) {
            console.log(board((await game.observe()).state.position), "\n");
            await new Promise(resolve => setTimeout(resolve, 650));
          }
        },
        outcome: () => game.outcome(),
        tracePath: traceSink.path,
        ...(models === undefined ? {} : { models }),
        ...(useAi ? { tokens: () => ({ ...tokens }) } : {}),
      };
    },
  };
}

function renderReasoning(request: { role: string; observation: { state: World }; authority: { goal: { description: string }; directive?: { instruction: string } }; lastVerification?: { status: string } }): string {
  return JSON.stringify({
    role: request.role,
    goal: request.authority.goal.description,
    currentDirective: request.authority.directive?.instruction,
    position: request.observation.state.position,
    lastOutcome: request.lastVerification?.status,
    gameRules: "Positions are 0 through 5. Ordinary advance is blocked at position 1 by a wall and at position 3 by a gap. The directive instruction vault_wall enables vault at position 1. The directive instruction bridge_gap enables bridge at position 3. Preserve the current directive when it still works.",
  });
}

const catalog = await SkillCatalog.discover(new URL("../examples/skills", import.meta.url).pathname);
const availableSkills = await selectSkillSummaries(catalog, {
  select(_context, available) { return available.map(skill => skill.name); },
}, {});
const watch = process.argv.includes("--watch");
const configurations = watch
  ? [configuration("full-hierarchy", true, true, true)]
  : [
      configuration("reflex", false, false),
      configuration("reflex+tactician", true, false),
      configuration("full-hierarchy", true, true),
    ];
const results = await evaluate(configurations, [1], 12);
console.log(JSON.stringify(watch ? { result: results[0] } : { availableSkills, results }, null, 2));
