import type { GameAdapter, Observation, Verifier } from "@gamebot/core";

/** The subset of rs-sdk state needed for a first walking task. */
export interface RuneState {
  tick: number;
  revision?: number;
  inGame: boolean;
  player: { x: number; z: number; isDead: boolean } | null;
}

export interface WalkAction { x: number; z: number; tolerance?: number }

/** Accepts the sdk and bot supplied by rs-sdk's runScript callback. */
export class RuneBenchBridge implements GameAdapter<RuneState, WalkAction> {
  constructor(private readonly sdk: { getState(): RuneState | null },
    private readonly bot: { walkTo(x: number, z: number, tolerance?: number): Promise<{ success: boolean; message: string }> }) {}

  async observe(): Promise<Observation<RuneState>> {
    const state = this.sdk.getState();
    if (!state?.inGame || !state.player) throw new Error("rs-sdk has no ready in-game state");
    return { state, revision: String(state.revision ?? state.tick), time: { turn: state.tick } };
  }

  validateAction(action: WalkAction, observation: Observation<RuneState>): boolean {
    const current = this.sdk.getState();
    return !!current?.inGame && !!current.player && !current.player.isDead &&
      Number.isInteger(action.x) && Number.isInteger(action.z) &&
      observation.revision === String(current.revision ?? current.tick);
  }

  async execute(action: WalkAction, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const result = await this.bot.walkTo(action.x, action.z, action.tolerance);
    if (!result.success) throw new Error(result.message);
  }
}

/** Verify position from game state, rather than treating SDK dispatch as success. */
export const walkVerifier: Verifier<RuneState, WalkAction> = {
  verify({ after, candidate, executionError }) {
    if (executionError) return { status: "failure", reason: String(executionError) };
    const player = after.state.player;
    if (!player || player.isDead) return { status: "failure", reason: "player unavailable or dead" };
    const { x, z, tolerance = 3 } = candidate.action;
    return Math.max(Math.abs(player.x - x), Math.abs(player.z - z)) <= tolerance
      ? { status: "success" } : { status: "pending", reason: "destination not yet observed" };
  },
};
