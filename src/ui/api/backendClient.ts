import type { JsonValue } from "@teamuq/plugin-sdk";
import type { UiMethodName } from "../../contracts/uiContract.js";
import { codeFromThrown, describeError, type ErrorDescription } from "./errors.js";

export type BackendParams = { readonly [key: string]: JsonValue | undefined };

export type BackendResult<T = unknown> =
  | { readonly ok: true; readonly value: T }
  | ({ readonly ok: false; readonly superseded: boolean; readonly attempts: number } & ErrorDescription);

export interface BackendClientOptions {
  readonly call: (method: string, params: JsonValue) => Promise<JsonValue>;
  readonly maxInFlight?: number;
  readonly maxRetries?: number;
  readonly retryDelaysMs?: readonly number[];
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface BackendClient {
  call(method: UiMethodName, params: BackendParams, options?: { readonly key?: string }): Promise<BackendResult>;
  stats(): { readonly inFlight: number; readonly queued: number };
}

export const DEFAULT_MAX_IN_FLIGHT = 2;
export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 4000];

// why: a forget that reached the backend before the platform squashed its failure into plugin_backend_unavailable must not run twice, and its outcome must never be dropped as stale
const WRITE_METHODS: ReadonlySet<string> = new Set<UiMethodName>(["ui.forget", "ui.legacyTrial", "ui.upgradeLegacy", "ui.agentOrganization"]);

interface Job {
  readonly method: UiMethodName;
  readonly params: JsonValue;
  readonly key: string;
  readonly epoch: number;
  readonly write: boolean;
  attempts: number;
  readonly settle: (result: BackendResult) => void;
}

function compact(params: BackendParams): JsonValue {
  const out: { [key: string]: JsonValue } = {};
  for (const [name, value] of Object.entries(params)) if (value !== undefined) out[name] = value;
  return out;
}

function failure(code: string, attempts: number, source?: "platform" | "plugin" | "client"): BackendResult {
  return { ok: false, superseded: code === "superseded", attempts, ...describeError(code, source) };
}

function pluginFailure(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "malformed_response";
  const record = value as { ok?: unknown; code?: unknown };
  if (record.ok === true) return null;
  return record.ok === false && typeof record.code === "string" ? record.code : "malformed_response";
}

export function createBackendClient(options: BackendClientOptions): BackendClient {
  const maxInFlight = options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const epochs = new Map<string, number>();
  const queue: Job[] = [];
  let inFlight = 0;

  const stale = (job: Job): boolean => !job.write && epochs.get(job.key) !== job.epoch;

  function retryLater(job: Job): void {
    const delay = delays[Math.min(job.attempts - 1, delays.length - 1)] ?? 0;
    void sleep(delay).then(() => {
      if (stale(job)) job.settle(failure("superseded", job.attempts));
      else {
        queue.unshift(job);
        pump();
      }
    });
  }

  async function attempt(job: Job): Promise<void> {
    job.attempts += 1;
    let outcome: BackendResult;
    try {
      const value = await options.call(job.method, job.params);
      const code = pluginFailure(value);
      outcome = code === null ? { ok: true, value } : failure(code, job.attempts, code === "malformed_response" ? "client" : "plugin");
    } catch (error) {
      outcome = failure(codeFromThrown(error), job.attempts);
    }
    inFlight -= 1;
    if (stale(job)) job.settle(failure("superseded", job.attempts));
    else if (!outcome.ok && outcome.code === "plugin_backend_unavailable" && !job.write && job.attempts <= maxRetries) retryLater(job);
    else job.settle(outcome);
    pump();
  }

  function pump(): void {
    while (inFlight < maxInFlight && queue.length > 0) {
      const job = queue.shift() as Job;
      if (stale(job)) {
        job.settle(failure("superseded", job.attempts));
        continue;
      }
      inFlight += 1;
      void attempt(job);
    }
  }

  return {
    call(method, params, callOptions = {}) {
      const key = callOptions.key ?? method;
      const write = WRITE_METHODS.has(method);
      const epoch = (epochs.get(key) ?? 0) + 1;
      if (!write) epochs.set(key, epoch);
      return new Promise<BackendResult>((settle) => {
        for (let index = queue.length - 1; index >= 0; index -= 1) {
          const older = queue[index] as Job;
          if (!write && !older.write && older.key === key) {
            queue.splice(index, 1);
            older.settle(failure("superseded", older.attempts));
          }
        }
        queue.push({ method, params: compact(params), key, epoch, write, attempts: 0, settle });
        pump();
      });
    },
    stats: () => ({ inFlight, queued: queue.length }),
  };
}

let shared: BackendClient | null = null;

export function backendClient(): BackendClient {
  shared ??= createBackendClient({ call: (method, params) => window.tuqPlugin.backend.call(method, params) });
  return shared;
}
