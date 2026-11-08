// why: the first catch-up admits the work records the daily round snapshot is cut from, so a round that began before it would push everything admitted later to the next day
export const STARTUP_WAIT_CAP_MS = 300_000;

export type StartupRelease = "catchup_complete" | "round_ended" | "cap";
export type StartupEvent =
  | { readonly state: "waiting" }
  | { readonly state: "ready"; readonly reason: StartupRelease; readonly waitedMs: number };

export interface StartupGateOptions {
  readonly now: () => number;
  readonly capMs?: number;
  readonly onChange?: (event: StartupEvent) => void;
}

// why: waiting for the first catch-up must end: a round that finished without a stop code is enough, and so is the time cap when the catch-up never finishes
export function createStartupGate(options: StartupGateOptions) {
  const capMs = options.capMs ?? STARTUP_WAIT_CAP_MS;
  let since: number | null = null;
  const release = (reason: StartupRelease): boolean => {
    if (since === null) return false;
    const waitedMs = Math.max(0, options.now() - since);
    since = null;
    try { options.onChange?.({ state: "ready", reason, waitedMs }); } catch {}
    return true;
  };
  return {
    capMs,
    defer(): void {
      since = options.now();
      try { options.onChange?.({ state: "waiting" }); } catch {}
    },
    release,
    // why: a status read has to look the same as the pass that follows it, but only the pass records the release
    waiting: (): boolean => since !== null && options.now() - since < capMs,
    check(): boolean {
      if (since !== null && options.now() - since >= capMs) release("cap");
      return since === null;
    },
  };
}
