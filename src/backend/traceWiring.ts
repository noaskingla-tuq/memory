import type { TraceEntry, TraceSink } from "../adapters/storage/organizationTrace.js";
import type { StartupEvent } from "../application/organizationStartup.js";

const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;

// why: only the counts and the stop code of a catch-up round are copied, so the record never holds a punch, an agent id or a path
export function catchupEntry(event: Readonly<Record<string, unknown>>): TraceEntry | null {
  if (event.event === "punch_catchup_start") return { kind: "catchup", phase: "start" };
  if (event.event === "punch_catchup_failed") return { kind: "catchup", phase: "failed", code: typeof event.code === "string" ? event.code : null };
  if (event.event !== "punch_catchup") return null;
  return {
    kind: "catchup", phase: "end", complete: event.complete === true, stoppedCode: typeof event.stoppedCode === "string" ? event.stoppedCode : null,
    examined: number(event.examined), written: number(event.written), pending: number(event.pending),
  };
}

export function startupEntry(event: StartupEvent): TraceEntry {
  return event.state === "waiting" ? { kind: "startup", state: "waiting" } : { kind: "startup", state: "ready", reason: event.reason, waitedMs: event.waitedMs };
}

// why: an idle round (nothing examined, nothing written, no stop) would push the turn lines out of the size-capped file, so its start is held back and dropped with its end
export function createCatchupTrace(sink: TraceSink | undefined): (event: Readonly<Record<string, unknown>>) => void {
  let held: TraceEntry | null = null;
  return (event) => {
    if (sink === undefined) return;
    const entry = catchupEntry(event);
    if (entry === null) return;
    if (entry.phase === "start") { held = entry; return; }
    const idle = entry.phase === "end" && entry.examined === 0 && entry.written === 0 && entry.stoppedCode === null;
    const start = held;
    held = null;
    if (idle) return;
    if (start !== null) sink.write(start);
    sink.write(entry);
  };
}
