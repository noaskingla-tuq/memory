import type { TraceSink } from "../storage/organizationTrace.js";

export type SettleHow = "seq" | "grace" | "backstop" | "cancel" | "failed" | "interrupted" | "error";

const MAX_ROWS = 40;

// why: one line per turn records when each kind of event arrived and how the turn was settled, and never what the turn said
export function startTurnTrace(sink: TraceSink | undefined, now: () => number = Date.now) {
  if (sink === undefined) return { sent() {}, event() {}, settle() {}, end() {} };
  let turnId: string | null = null;
  let sentAt = 0;
  let resumed = false;
  let deltas = 0;
  let settle: SettleHow | null = null;
  let settledAt = 0;
  let written = false;
  const rows: Array<[string, number]> = [];
  const offset = (): number => Math.max(0, now() - sentAt);
  return {
    sent(id: string, at: number, wasResumed: boolean): void { turnId = id; sentAt = at; resumed = wasResumed; },
    event(kind: string): void {
      if (turnId === null || written) return;
      if (kind === "textDelta") {
        deltas += 1;
        if (deltas === 1) rows.push([kind, offset()]);
        return;
      }
      if (rows.length < MAX_ROWS) rows.push([kind, offset()]);
    },
    settle(how: SettleHow): void {
      if (turnId === null || settle !== null) return;
      settle = how;
      settledAt = offset();
    },
    end(): void {
      if (turnId === null || written) return;
      written = true;
      sink.write({ kind: "turn", turnId, sentAt, resumed, events: rows, deltas, settle: settle ?? "none", settledAt: settle === null ? null : settledAt, endedAt: offset() });
    },
  };
}
