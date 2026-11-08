import { appendFileSync, lstatSync, realpathSync, renameSync } from "node:fs";
import { join } from "node:path";

export const TRACE_FILE = "organization-trace.log";
export const TRACE_MAX_BYTES = 1_048_576;

export type TraceValue = string | number | boolean | null;
export interface TraceEntry {
  readonly kind: "turn" | "catchup" | "startup";
  readonly [field: string]: TraceValue | ReadonlyArray<ReadonlyArray<TraceValue>> | undefined;
}

export interface TraceSink {
  write(entry: TraceEntry): void;
}

export interface TraceOptions {
  readonly dir: string;
  readonly maxBytes?: number;
  readonly now?: () => number;
}

const TOKEN = /^[A-Za-z0-9_.:-]{1,80}$/u;
const FIELDS: Readonly<Record<TraceEntry["kind"], ReadonlySet<string>>> = {
  turn: new Set(["turnId", "sentAt", "resumed", "events", "deltas", "settle", "settledAt", "endedAt"]),
  catchup: new Set(["phase", "complete", "stoppedCode", "examined", "written", "pending", "code"]),
  startup: new Set(["state", "reason", "waitedMs"]),
};

function cleanValue(value: unknown): TraceValue | undefined {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : null;
  // why: a free string could carry a prompt, a reply or a path, so only a short identifier-like token is ever written
  if (typeof value === "string") return TOKEN.test(value) ? value : "invalid";
  return undefined;
}

// why: the log is for diagnosis only, so an entry keeps a fixed set of metadata fields and nothing else; there is no way to put content in it
export function sanitizeTraceEntry(entry: TraceEntry): Record<string, unknown> {
  const allowed = FIELDS[entry.kind];
  const clean: Record<string, unknown> = { kind: entry.kind };
  for (const [name, value] of Object.entries(entry)) {
    if (name === "kind" || !allowed.has(name) || value === undefined) continue;
    if (Array.isArray(value)) {
      clean[name] = value.slice(0, 64).map((row) => (Array.isArray(row) ? row.slice(0, 4).map((cell) => cleanValue(cell) ?? null) : []));
      continue;
    }
    const cleaned = cleanValue(value);
    if (cleaned !== undefined) clean[name] = cleaned;
  }
  return clean;
}

// why: the same checks as the state stores: a symlink or junction at the log path could send the write outside the data directory
function safePath(root: string, name: string): string {
  const file = join(root, name);
  if (lstatSync(root).isSymbolicLink()) throw new Error("trace_path_unsafe");
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (stat !== undefined && (stat.isSymbolicLink() || !stat.isFile() || realpathSync(file) !== join(realpathSync(root), name))) throw new Error("trace_path_unsafe");
  return file;
}

// why: nothing reads this file back; it only exists for a person looking at what a turn did, so a failed write is dropped and never reaches the caller
export function createOrganizationTrace(options: TraceOptions): TraceSink {
  const maxBytes = options.maxBytes ?? TRACE_MAX_BYTES;
  const now = options.now ?? Date.now;
  return {
    write(entry) {
      try {
        const line = JSON.stringify({ t: new Date(now()).toISOString(), ...sanitizeTraceEntry(entry) }) + "\n";
        const size = Buffer.byteLength(line, "utf8");
        if (size > maxBytes) return;
        const file = safePath(options.dir, TRACE_FILE);
        const rotated = safePath(options.dir, TRACE_FILE + ".1");
        const current = lstatSync(file, { throwIfNoEntry: false })?.size ?? 0;
        if (current + size > maxBytes) renameSync(file, rotated);
        appendFileSync(file, line, { mode: 0o600 });
      } catch {}
    },
  };
}
