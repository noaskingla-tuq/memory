import type { MemoryResult } from "../domain/errors.js";

export const STALL_LIMIT = 3;
// why: the model port frees a stuck turn at 330 seconds, so the queue only gives up waiting a little after that if the port itself failed to
export const AWAIT_CAP_MS = 360_000;
export const STALL_LOCAL_CODE = "stall_paused";
const DETACHED_LOCAL_CODE = "detached_running";
const BACKSTOP_LOCAL_CODE = "turn_backstop";

export type StallOutcome = "stuck" | "settled" | "other";

// why: a job that ended on a detached turn with no new reply, or on the backstop, is the only shape that spends quota without progress
export function stallOutcome(result: MemoryResult<unknown>): StallOutcome {
  if (result.ok) return "settled";
  return result.error.localCode === DETACHED_LOCAL_CODE || result.error.localCode === BACKSTOP_LOCAL_CODE ? "stuck" : "other";
}

export function createStallGuard(limit = STALL_LIMIT) {
  let count = 0;
  return {
    paused: (): boolean => count >= limit,
    count: (): number => count,
    limit,
    // why: a press on "run now" is the user asking for one probe, so it lets exactly one job through and the next stall pauses again at once
    allowOne(): boolean { if (count < limit) return false; count = limit - 1; return true; },
    reset(): void { count = 0; },
    observe(outcome: StallOutcome): void { count = outcome === "stuck" ? count + 1 : 0; },
  };
}

// why: a stop or a disable must end the wait even while the turn keeps running, and the pair lock is left to the turn alone
export async function awaitUnlessStopped(
  wait: (signal: AbortSignal) => Promise<void>,
  shouldStop: () => boolean,
  capMs = AWAIT_CAP_MS,
  pollMs = 200,
): Promise<void> {
  const controller = new AbortController();
  const started = Date.now();
  const timer = setInterval(() => { if (shouldStop() || Date.now() - started >= capMs) controller.abort(); }, pollMs);
  timer.unref();
  try { await wait(controller.signal); }
  catch (error) { if (!controller.signal.aborted) throw error; }
  finally { clearInterval(timer); }
}
