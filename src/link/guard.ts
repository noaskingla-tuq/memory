import { refuse } from "./errors.js";
import type { LinkWho } from "./provider.js";

const DEDUPE_MS = 60_000;
const CALL_RATE_PER_SECOND = 10;
const CALL_BURST = 20;

export interface GuardOptions {
  readonly maxSessions: number;
  readonly now?: () => number;
  readonly perSecond?: number;
  readonly burst?: number;
}

export interface Guard {
  begin(): () => void;
  rate(who: LinkWho, groupId: string): void;
  once<T>(linkId: string, id: string, args: unknown, run: () => T | Promise<T>): Promise<T>;
  forget(linkId: string): void;
}

export function createGuard({ maxSessions, now = Date.now, perSecond = CALL_RATE_PER_SECOND, burst = CALL_BURST }: GuardOptions): Guard {
  let active = 0;
  const buckets = new Map<string, { tokens: number; at: number }>();
  const seen = new Map<string, { readonly fingerprint: string; readonly at: number; readonly outcome: Promise<unknown> }>();

  function prune(at: number): void {
    for (const [key, entry] of seen) if (at - entry.at >= DEDUPE_MS) seen.delete(key);
  }

  return {
    begin() {
      if (active >= maxSessions) throw refuse("capability_busy", { retryAfterMs: 1000 });
      active += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active -= 1;
      };
    },
    rate(who, groupId) {
      const key = `${who.source.pluginId ?? "core"}|${groupId}`;
      const at = now();
      const bucket = buckets.get(key) ?? { tokens: burst, at };
      bucket.tokens = Math.min(burst, bucket.tokens + ((at - bucket.at) / 1000) * perSecond);
      bucket.at = at;
      buckets.set(key, bucket);
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return;
      }
      throw refuse("rate_limited", { retryAfterMs: Math.max(1, Math.ceil(((1 - bucket.tokens) / perSecond) * 1000)) });
    },
    async once<T>(linkId: string, id: string, args: unknown, run: () => T | Promise<T>): Promise<T> {
      const at = now();
      prune(at);
      const key = `${linkId}|${id}`;
      const fingerprint = JSON.stringify(args);
      const earlier = seen.get(key);
      if (earlier !== undefined) {
        if (earlier.fingerprint !== fingerprint) throw refuse("capability_request_invalid");
        return earlier.outcome as Promise<T>;
      }
      const outcome = Promise.resolve().then(run);
      seen.set(key, { fingerprint, at, outcome });
      outcome.catch(() => seen.delete(key));
      return outcome;
    },
    forget(linkId) {
      for (const key of seen.keys()) if (key.startsWith(`${linkId}|`)) seen.delete(key);
    },
  };
}
