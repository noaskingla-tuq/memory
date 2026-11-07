import { createHash } from "node:crypto";
import { isRefusal, refuse } from "./errors.js";
import { liveItems, newItemId, type LinkStore } from "./linkStore.js";
import type { CallResult, GroupModule, HandlerContext } from "./provider.js";
import { StoreError, isValidPartitionKey, partitionKeyOf, payloadBytes, type LinkItem } from "./storeFile.js";

export const MEMORY_FEATURES = Object.freeze(["inspect", "diagnose", "tags", "ttl", "upsert-by-key", "text-query"]);
export const MEMORY_GROUP_LIMITS = Object.freeze({ maxPayloadChars: 12288, maxRecallLimit: 50, maxForgetIds: 100 });
export const MEMORY_SIDE_EFFECTS = Object.freeze(["remember", "forget"]);

const MAX_PAYLOAD_CHARS = 12288;
const MAX_RESPONSE_CHARS = 60000;
const MAX_TTL_SEC = 31_536_000;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const CURSOR_FORMAT = /^c(\d{1,9})\.([0-9a-f]{16})$/u;
const ALL_METHODS = Object.freeze(["remember", "recall", "forget", "inspect", "diagnose"]);

type Body = Record<string, unknown>;
type Handler = (args: unknown[], ctx: HandlerContext) => CallResult | Promise<CallResult>;

export interface MemoryControl {
  received(name: string): void;
}

export interface MemoryGroupOptions {
  readonly store: LinkStore;
  readonly features?: readonly string[];
  readonly maxPayloadChars?: number;
  readonly methods?: readonly string[];
  readonly control?: MemoryControl;
  readonly idFactory?: () => string;
}

const isRecord = (value: unknown): value is Body => typeof value === "object" && value !== null && !Array.isArray(value);
const invalid = (): Error => refuse("capability_request_invalid");
const validText = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !CONTROL.test(value);
const validTags = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 8 && value.every((tag) => validText(tag, 32)) && new Set(value).size === value.length;
const onlyKeys = (value: Body, keys: readonly string[]): boolean => Object.keys(value).every((key) => keys.includes(key));

function request(args: unknown[], allowed: readonly string[]): Body {
  const [body] = args;
  if (args.length !== 1 || !isRecord(body) || !onlyKeys(body, allowed)) throw invalid();
  return body;
}

function strings(value: unknown, min: number, max: number, itemMax: number): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max || new Set(value).size !== value.length) throw invalid();
  if (!value.every((item) => validText(item, itemMax))) throw invalid();
  return value as string[];
}

function translate(error: unknown): unknown {
  if (error instanceof StoreError) {
    if (error.code === "quota_exceeded" || error.code === "provider_not_ready" || error.code === "provider_error") return refuse(error.code);
    return refuse(error.code === "disposed" ? "provider_not_ready" : "provider_error");
  }
  // why: anything that is not a deliberate refusal (EACCES from stat, a bug) must not reach Core with its own message, which can carry a local path
  return isRefusal(error) ? error : refuse("provider_error");
}

function schemaAccepts(method: string, args: unknown): boolean {
  if (!Array.isArray(args)) return false;
  if (method === "diagnose") return args.length === 0;
  if (method === "inspect" && args.length === 0) return true;
  if (!["remember", "recall", "forget", "inspect"].includes(method) || args.length !== 1) return false;
  const req = args[0];
  if (!isRecord(req)) return false;
  if (method === "remember") {
    return onlyKeys(req, ["payload", "key", "tags", "ttlSec"]) && req.payload !== undefined && req.payload !== null
      && (JSON.stringify(req.payload)?.length ?? Infinity) <= MAX_PAYLOAD_CHARS
      && (req.key === undefined || validText(req.key, 128))
      && (req.tags === undefined || validTags(req.tags))
      && (req.ttlSec === undefined || (Number.isInteger(req.ttlSec) && (req.ttlSec as number) >= 1 && (req.ttlSec as number) <= MAX_TTL_SEC));
  }
  if (method === "recall") {
    return onlyKeys(req, ["limit", "query", "tags", "ids", "cursor"]) && Number.isInteger(req.limit) && (req.limit as number) >= 1 && (req.limit as number) <= 50
      && (req.ids === undefined || (Array.isArray(req.ids) && req.ids.length <= 50 && req.ids.every((id) => validText(id, 128))))
      && (req.tags === undefined || validTags(req.tags))
      && (req.query === undefined || (JSON.stringify(req.query)?.length ?? Infinity) <= 16_384);
  }
  if (method === "forget") {
    return onlyKeys(req, ["ids", "tags", "all"]) && Object.keys(req).length === 1
      && ((Array.isArray(req.ids) && req.ids.length >= 1 && req.ids.length <= 100) || (validTags(req.tags) && req.tags.length >= 1) || req.all === true);
  }
  const limit = req.limit ?? 20;
  return onlyKeys(req, ["limit", "cursor"]) && Number.isInteger(limit) && (limit as number) >= 1 && (limit as number) <= 50 && (req.cursor === undefined || validText(req.cursor, 128));
}

function scoreFor(item: LinkItem, query: string): number {
  const text = JSON.stringify(item.payload).toLowerCase();
  const needle = query.toLowerCase();
  if (needle.length === 0) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(needle, offset)) !== -1) { count += 1; offset += needle.length; }
  return count / Math.max(1, text.length);
}

function publicItem(item: LinkItem, score: number | undefined): Record<string, unknown> {
  return { id: item.id, payload: item.payload, ...(score === undefined ? {} : { score }), ...(item.tags === undefined ? {} : { tags: item.tags }), updatedAtMs: item.updatedAtMs };
}

interface Filter {
  readonly ids?: readonly string[];
  readonly tags?: readonly string[];
  readonly query?: string;
}

function matches(item: LinkItem, filter: Filter): boolean {
  if (filter.ids !== undefined && !filter.ids.includes(item.id)) return false;
  if (filter.tags !== undefined && !filter.tags.every((tag) => item.tags?.includes(tag) === true)) return false;
  return filter.query === undefined || JSON.stringify(item.payload).toLowerCase().includes(filter.query.toLowerCase());
}

const fingerprintOf = (filter: Filter): string => createHash("sha256").update(JSON.stringify([filter.query ?? null, filter.tags ?? null, filter.ids ?? null])).digest("hex").slice(0, 16);

export function createMemoryStoreGroup(options: MemoryGroupOptions): GroupModule {
  const { store, control } = options;
  const activeFeatures = [...(options.features ?? MEMORY_FEATURES)];
  const maxPayloadChars = options.maxPayloadChars ?? MEMORY_GROUP_LIMITS.maxPayloadChars;
  const idFactory = options.idFactory ?? newItemId;
  const activeMethods = options.methods ?? ALL_METHODS;
  const has = (feature: string): boolean => activeFeatures.includes(feature);
  const sourceOf = (ctx: HandlerContext): string => {
    const key = partitionKeyOf(ctx.who);
    if (!isValidPartitionKey(key)) throw invalid();
    return key;
  };

  const remember: Handler = async (args, ctx) => {
    const body = request(args, ["payload", "key", "tags", "ttlSec"]);
    const text = body.payload === undefined || body.payload === null ? undefined : JSON.stringify(body.payload);
    if (text === undefined || text.length > MAX_PAYLOAD_CHARS) throw invalid();
    if (text.length > maxPayloadChars) throw refuse("unsupported_options");
    if (body.key !== undefined && !validText(body.key, 128)) throw invalid();
    if (body.tags !== undefined && !validTags(body.tags)) throw invalid();
    if (body.ttlSec !== undefined && !(Number.isInteger(body.ttlSec) && (body.ttlSec as number) >= 1 && (body.ttlSec as number) <= MAX_TTL_SEC)) throw invalid();
    if (body.tags !== undefined && !has("tags")) throw refuse("unsupported_options");
    if (body.ttlSec !== undefined && !has("ttl")) throw refuse("unsupported_options");
    if (body.key !== undefined && !has("upsert-by-key")) throw refuse("unsupported_options");
    const id = (body.key as string | undefined) ?? idFactory();
    const tags = body.tags as string[] | undefined;
    const outcome = await store.commit(sourceOf(ctx), (snap, at) => {
      const existing = snap.items.find((item) => item.id === id);
      const next: LinkItem = {
        id,
        ...(body.key === undefined ? {} : { key: body.key as string }),
        payload: body.payload,
        ...(tags === undefined || tags.length === 0 ? {} : { tags: [...tags] }),
        rev: (existing?.rev ?? 0) + 1,
        updatedAtMs: at,
        ...(body.ttlSec === undefined ? {} : { expiresAtMs: at + (body.ttlSec as number) * 1000 }),
      };
      return { items: [...snap.items.filter((item) => item.id !== id), next], result: existing === undefined };
    });
    return { value: { id, created: outcome.result } };
  };

  const recall: Handler = (args, ctx) => {
    const body = request(args, ["limit", "query", "tags", "ids", "cursor"]);
    const limit = body.limit;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 50) throw invalid();
    const tags = body.tags === undefined ? undefined : strings(body.tags, 0, 8, 32);
    const ids = body.ids === undefined ? undefined : strings(body.ids, 0, 50, 128);
    if (tags !== undefined && !has("tags")) throw refuse("unsupported_options");
    if (body.query !== undefined && (typeof body.query !== "string" || !has("text-query"))) throw refuse("unsupported_options");
    const query = body.query as string | undefined;
    if (body.cursor !== undefined && !(typeof body.cursor === "string" && body.cursor.length >= 1 && Buffer.byteLength(body.cursor) <= 256)) throw invalid();
    const filter: Filter = { ...(query === undefined ? {} : { query }), ...(tags === undefined ? {} : { tags }), ...(ids === undefined ? {} : { ids }) };
    const fingerprint = fingerprintOf(filter);
    let offset = 0;
    if (body.cursor !== undefined) {
      const parsed = CURSOR_FORMAT.exec(body.cursor as string);
      if (parsed === null || parsed[2] !== fingerprint) throw refuse("unsupported_options");
      offset = Number(parsed[1]);
    }
    const snap = store.snapshot(sourceOf(ctx));
    const found = snap.items
      .filter((item) => matches(item, filter))
      .map((item) => ({ item, score: query === undefined ? undefined : scoreFor(item, query) }))
      .sort((a, b) => ((b.score ?? 0) - (a.score ?? 0)) || b.item.updatedAtMs - a.item.updatedAtMs || (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0));
    if (offset > found.length) throw refuse("unsupported_options");
    const items: Record<string, unknown>[] = [];
    let size = 64;
    let next = offset;
    while (next < found.length && items.length < limit) {
      const entry = publicItem(found[next].item, found[next].score);
      const cost = JSON.stringify(entry).length;
      if (items.length > 0 && size + cost > MAX_RESPONSE_CHARS) break;
      items.push(entry);
      size += cost;
      next += 1;
    }
    return { value: { items, ...(next < found.length ? { nextCursor: `c${next}.${fingerprint}` } : {}) } };
  };

  const forget: Handler = async (args, ctx) => {
    const body = request(args, ["ids", "tags", "all"]);
    const keys = Object.keys(body);
    if (keys.length !== 1) throw invalid();
    let doomed: (item: LinkItem) => boolean;
    if (keys[0] === "ids") {
      const ids = strings(body.ids, 1, 100, 128);
      doomed = (item) => ids.includes(item.id);
    } else if (keys[0] === "tags") {
      if (!has("tags")) throw refuse("unsupported_options");
      const tags = strings(body.tags, 1, 8, 32);
      doomed = (item) => matches(item, { tags });
    } else if (body.all === true) {
      doomed = () => true;
    } else {
      throw invalid();
    }
    const outcome = await store.commit(sourceOf(ctx), (snap) => {
      const kept = snap.items.filter((item) => !doomed(item));
      return kept.length === snap.items.length ? { items: snap.items, result: 0 } : { items: kept, result: snap.items.length - kept.length };
    });
    return { value: { forgotten: outcome.result } };
  };

  const inspect: Handler = (args, ctx) => {
    if (args.length > 1) throw invalid();
    const body = args.length === 0 ? {} : request(args, ["cursor", "limit"]);
    if (body.limit !== undefined && !(typeof body.limit === "number" && Number.isInteger(body.limit) && body.limit >= 1 && body.limit <= 50)) throw invalid();
    if (body.cursor !== undefined) throw refuse("unsupported_options");
    const items = liveItems(store.snapshot(sourceOf(ctx)).items, store.now());
    const sizeBytes = items.reduce((sum, item) => sum + payloadBytes(item.payload), 0);
    const updatedAtMs = items.reduce((latest, item) => Math.max(latest, item.updatedAtMs), 0);
    return { value: { summary: { count: items.length, sizeBytes, ...(items.length === 0 ? {} : { updatedAtMs }) }, details: { limits: { items: store.limits.items, bytes: store.limits.bytes } } } };
  };

  const diagnose: Handler = (args, ctx) => {
    if (args.length !== 0) throw invalid();
    const health = store.health(sourceOf(ctx));
    const storeOk = health.state === "ok" || health.state === "empty";
    const storeNote = health.state === "empty" ? "尚無資料" : health.state === "ok" ? "可讀寫" : health.state === "corrupt" ? "資料檔無法讀取，已保留原檔" : "最近一次寫入失敗";
    const quotaOk = health.count < store.limits.items && health.bytes < store.limits.bytes;
    const checks = [
      { name: "store", ok: storeOk, note: storeNote },
      { name: "quota", ok: quotaOk, note: `已用 ${health.count}／${store.limits.items} 筆` },
    ];
    return { value: { ok: checks.every((check) => check.ok), checks } };
  };

  const all: Record<string, Handler> = { remember, recall, forget, inspect, diagnose };
  const methods: Record<string, Handler> = {};
  for (const name of Object.keys(all)) {
    if (!activeMethods.includes(name)) continue;
    const handler = all[name];
    // why: a call that finishes without waiting must hand its answer back at once so it never counts as in progress against maxSessions
    methods[name] = (args, ctx) => {
      control?.received(name);
      try {
        const out = handler(args, ctx);
        return out instanceof Promise ? out.catch((error: unknown) => { throw translate(error); }) : out;
      } catch (error) {
        throw translate(error);
      }
    };
  }

  return Object.freeze({
    group: Object.freeze({ id: "memory-store", version: 1, features: activeFeatures, limits: { ...MEMORY_GROUP_LIMITS, maxPayloadChars } }),
    sideEffects: MEMORY_SIDE_EFFECTS,
    methods: Object.freeze(methods),
    argsSchemaFor: (method: string) => (Object.hasOwn(methods, method) ? { safeParse: (args: unknown) => ({ success: schemaAccepts(method, args) }) } : undefined),
  });
}
