// why: the design allows 25 ms between yields, and a slice can overshoot by the one query that was already running, so the slice is 15 ms to keep slice plus overshoot well under the 50 ms pause limit
export const SLICE_MS = 15;
export const CALL_BUDGET_MS = 4_000;

export interface Clock {
  sliceExpired(): boolean;
  timeUp(): boolean;
  yieldNow(): Promise<void>;
  yieldIfDue(): Promise<void>;
}

export interface ClockOptions {
  readonly sliceMs?: number;
  readonly budgetMs?: number;
  readonly now?: () => number;
  readonly cancelled?: () => boolean;
}

const waiting: (() => void)[] = [];
let scheduled = false;

function releaseOne(): void {
  scheduled = false;
  waiting.shift()?.();
  if (waiting.length > 0) scheduleRelease();
}

function scheduleRelease(): void {
  if (scheduled) return;
  scheduled = true;
  setImmediate(releaseOne);
}

// why: every setImmediate queued during one loop turn runs in the next turn together, so concurrent calls that each yield would run their slices back to back and stack their pauses; releasing one waiter per turn keeps the pause of the whole backend at one slice
export function nextTurn(): Promise<void> {
  return new Promise<void>((resolve) => {
    waiting.push(resolve);
    scheduleRelease();
  });
}

// why: the backend shares one thread with the plugin heartbeat and the Core sink, so a scan hands the event loop back every slice and a call stops itself well before the platform's 30 s fence
export function createClock(options: ClockOptions = {}): Clock {
  const sliceMs = options.sliceMs ?? SLICE_MS;
  const budgetMs = options.budgetMs ?? CALL_BUDGET_MS;
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  let sliceStartedAt = startedAt;
  const clock: Clock = {
    sliceExpired: () => now() - sliceStartedAt >= sliceMs,
    timeUp: () => options.cancelled?.() === true || now() - startedAt >= budgetMs,
    async yieldNow() {
      await nextTurn();
      sliceStartedAt = now();
    },
    async yieldIfDue() {
      if (clock.sliceExpired()) await clock.yieldNow();
    },
  };
  return clock;
}
