import { generateText, Output, type LanguageModel, type LanguageModelUsage, type ModelMessage } from "ai";
import { z } from "zod";
import type {
  Candidate, DecisionContext, DirectiveProposal, Reasoner, ReasoningRequest,
  ReasoningRole, Reflex,
} from "../core/index.js";

const choiceSchema = z.object({ candidateId: z.string() });
const proposalSchema = z.object({
  intervention: z.enum(["none", "directive"]),
  directive: z.object({ id: z.string(), instruction: z.string() }).optional(),
});

export interface ModelCallReport {
  role: "vision" | "reflex" | ReasoningRole;
  usage: LanguageModelUsage;
  latencyMs: number;
}

interface CommonOptions {
  /** An AI Gateway model ID or an AI SDK provider model. */
  model: LanguageModel;
  maxOutputTokens?: number;
  timeoutMs?: number;
  onCall?: (report: ModelCallReport) => void;
}

export interface AiSdkVisionOptions<State> extends CommonOptions {
  /** The game supplies the meaning and shape of the state visible in a screenshot. */
  prompt: string;
  schema: z.ZodType<State>;
}

export function aiSdkVisionExtractor<State>(options: AiSdkVisionOptions<State>) {
  return async (screenshot: Buffer, signal?: AbortSignal): Promise<State> => {
    const started = performance.now();
    const result = await generateText({
      model: options.model,
      messages: [{ role: "user", content: [
        { type: "text", text: options.prompt },
        { type: "file", data: screenshot, mediaType: "image/png" },
      ] }],
      output: Output.object({ schema: options.schema }),
      ...(signal ? { abortSignal: signal } : {}),
      ...(options.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.maxOutputTokens }),
      ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
    });
    options.onCall?.({ role: "vision", usage: result.usage, latencyMs: performance.now() - started });
    return result.output;
  };
}

export interface AiSdkReflexOptions<State, Action> extends CommonOptions {
  /** The game integration decides what state and action details the model sees. */
  render(context: DecisionContext<State>, candidates: readonly Candidate<Action>[]): string | ModelMessage[] | Promise<string | ModelMessage[]>;
}

export function aiSdkReflex<State, Action>(options: AiSdkReflexOptions<State, Action>): Reflex<State, Action> {
  return {
    async choose(context, candidates, signal) {
      const started = performance.now();
      const rendered = await options.render(context, candidates);
      const result = await generateText({
        model: options.model,
        system: "Choose exactly one offered candidate ID. Return only the requested structured output.",
        ...(typeof rendered === "string" ? { prompt: rendered } : { messages: rendered }),
        output: Output.object({ schema: choiceSchema }),
        abortSignal: signal,
        ...(options.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.maxOutputTokens }),
        ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
      });
      options.onCall?.({ role: "reflex", usage: result.usage, latencyMs: performance.now() - started });
      const choice = result.output.candidateId;
      if (!candidates.some(candidate => candidate.id === choice)) {
        throw new Error(`AI SDK reflex selected unoffered candidate: ${choice}`);
      }
      return choice;
    },
  };
}

export interface AiSdkReasonerOptions<State, Assumptions> extends CommonOptions {
  render(request: ReasoningRequest<State>): string | Promise<string>;
  /** Relevant assumptions come from observed facts, not model claims. */
  captureAssumptions(request: ReasoningRequest<State>): Assumptions;
}

export function aiSdkReasoner<State, Assumptions>(
  options: AiSdkReasonerOptions<State, Assumptions>,
): Reasoner<State, Assumptions> {
  return {
    async propose(request, signal): Promise<DirectiveProposal<Assumptions> | undefined> {
      const started = performance.now();
      const result = await generateText({
        model: options.model,
        system: `You are the ${request.role}. Keep the user's goal authoritative. Preserve the current directive unless a change is useful. Return a directive proposal or no intervention.`,
        prompt: await options.render(request),
        output: Output.object({ schema: proposalSchema }),
        abortSignal: signal,
        ...(options.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.maxOutputTokens }),
        ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
      });
      options.onCall?.({ role: request.role, usage: result.usage, latencyMs: performance.now() - started });
      if (result.output.intervention === "none") return undefined;
      if (!result.output.directive) throw new Error("AI SDK reasoner omitted its directive");
      return { directive: result.output.directive, assumptions: options.captureAssumptions(request) };
    },
  };
}
