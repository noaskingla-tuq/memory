import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NO_PROFILE } from "../out/application/ui/profilePort.js";
import { createBackend } from "../out/backend/service.js";
import { dispatchUi } from "../out/backend/uiDispatch.js";
import { createLinkAdmin } from "../out/link/linkAdmin.js";
import { createLinkStore } from "../out/link/linkStore.js";
import { createMemoryStoreGroup } from "../out/link/memoryStoreGroup.js";
import { createProvider } from "../out/link/provider.js";
import { PIN_PATH } from "./backendHarness.mjs";

export const agentHashOf = (agentId) => createHash("sha256").update(agentId).digest("hex");

export function startStore(t, overrides = {}) {
  const base = mkdtempSync(join(tmpdir(), "teamuq-memory-ui-"));
  const dataRoot = join(base, "memory-cairn-v1");
  const backends = [];
  const open = (extra = {}) => {
    const backend = createBackend({ dataRoot, pinPath: PIN_PATH, ...overrides, ...extra });
    backends.push(backend);
    return backend;
  };
  t.after(async () => {
    for (const backend of backends) await backend.dispose();
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return { base, dataRoot, open, backend: open() };
}

export const databasePath = (dataRoot, agentId) => join(dataRoot, "agents", agentHashOf(agentId), "memory.sqlite");

export function setTimes(dataRoot, agentId, times) {
  const db = new DatabaseSync(databasePath(dataRoot, agentId));
  try {
    const update = db.prepare("UPDATE memories SET updated_at = ?, created_at = ? WHERE id = ?");
    db.exec("BEGIN");
    for (const [id, at] of times) update.run(at, at, id);
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

const isoMinute = (ms) => `${new Date(ms).toISOString().slice(0, 16)}Z`;

export function punchContent({ startMs, minutes = 30, cli = "claude", model = "opus-4", title, body }) {
  return `[工作紀錄 ${isoMinute(startMs)}～${isoMinute(startMs + minutes * 60_000)} ${cli}/${model}] 請求：${title}。成果：${body}`;
}

// why: a spec row is one memory, and updatedAt is forced through SQL after the write because Cairn stamps its own clock and the tests need exact, tied and spread times
export async function seed(store, rows, { sessionId = "seed", batch = 16 } = {}) {
  const made = [];
  const byAgent = new Map();
  for (const row of rows) {
    const key = `${row.agentId}|${row.projectId ?? ""}|${row.sessionId ?? sessionId}|${row.provider ?? ""}`;
    if (!byAgent.has(key)) byAgent.set(key, []);
    byAgent.get(key).push(row);
  }
  let serial = 0;
  for (const group of byAgent.values()) {
    for (let start = 0; start < group.length; start += batch) {
      const slice = group.slice(start, start + batch);
      const first = slice[0];
      const response = await store.backend.call("memory.remember@1", {
        actor: { agentId: first.agentId, projectId: first.projectId ?? null, sessionId: first.sessionId ?? sessionId, providerId: first.provider ?? "claude" },
        ops: slice.map((row) => ({ scope: row.projectId === undefined || row.projectId === null ? "personal" : "project", content: row.content, kind: row.kind ?? "context", operationId: `seed-${serial++}` })),
      });
      slice.forEach((row, index) => {
        const result = response.results[index];
        if (!result.ok) throw new Error(`seed failed: ${JSON.stringify(result.error)}`);
        made.push({ ...row, id: result.value.memory.id, projectId: row.projectId ?? null, scope: row.projectId === undefined || row.projectId === null ? "personal" : "project" });
      });
    }
  }
  const perAgent = new Map();
  for (const item of made) {
    if (item.updatedAt === undefined) continue;
    if (!perAgent.has(item.agentId)) perAgent.set(item.agentId, []);
    perAgent.get(item.agentId).push([item.id, item.updatedAt]);
  }
  for (const [agentId, times] of perAgent) setTimes(store.dataRoot, agentId, times);
  return made;
}

export const newestFirst = (left, right) =>
  left.updatedAt < right.updatedAt ? 1 : left.updatedAt > right.updatedAt ? -1 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0;

export const bytesOf = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");

export function expectOk(response, label = "") {
  if (response.ok !== true) throw new Error(`${label} expected ok, got ${JSON.stringify(response)}`);
  return response;
}

export async function pageAll(call, first, { max = 500 } = {}) {
  const pages = [];
  let cursor;
  for (let index = 0; index < max; index += 1) {
    const response = expectOk(await call(cursor === undefined ? first : { ...first, cursor }), `page ${index}`);
    pages.push(response);
    if (response.nextCursor === null) return pages;
    cursor = response.nextCursor;
  }
  throw new Error("paging did not finish");
}

export const DAY_START = "2026-09-29T16:00:00.000Z";
export const DAY_MS = 86_400_000;
export const daysAgo = (days, hour = 3) => new Date(Date.parse(DAY_START) + hour * 3_600_000 - days * DAY_MS).toISOString();

export const CORE_RESPONSE_LIMIT_BYTES = 65_536;

export function assertWithinCoreLimit(result) {
  const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
  if (bytes > CORE_RESPONSE_LIMIT_BYTES - 1_024) throw new Error(`a ui answer is ${bytes} bytes, above the Core limit minus its 1 KiB margin`);
  return bytes;
}

const linkChannel = { closed: false, emit: async () => undefined };
let linkSequence = 0;

export function startLink(t, options = {}) {
  const base = options.base ?? mkdtempSync(join(tmpdir(), "teamuq-link-admin-"));
  const clock = { now: options.start ?? 1_000_000 };
  const now = () => clock.now;
  const store = createLinkStore({ dataDir: base, now, ...(options.io === undefined ? {} : { io: options.io }), ...(options.limits === undefined ? {} : { limits: options.limits }) });
  const admin = createLinkAdmin(store);
  const group = createMemoryStoreGroup({ store });
  const provider = createProvider({ category: "teamuq.memory@1", dataClass: "local", maxSessions: 64, modules: [group], now, callRatePerSecond: 100_000, callBurst: 100_000 });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    provider.dispose();
    await store.dispose();
  };
  t.after(async () => {
    await close();
    if (options.base === undefined) rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  async function connect(pluginId) {
    linkSequence += 1;
    const linkId = `ulink-${linkSequence}`;
    const who = { source: pluginId === undefined ? { kind: "core" } : { kind: "plugin", pluginId }, category: "teamuq.memory@1" };
    await provider.open({ linkId, who, group: { id: "memory-store" }, mode: "call", channel: linkChannel });
    let sequence = 0;
    const call = (method, ...args) => provider.call({ id: `u${linkSequence}-${(sequence += 1)}`, method, args, who, group: { id: "memory-store" }, linkId });
    call.withId = (id, method, ...args) => provider.call({ id, method, args, who, group: { id: "memory-store" }, linkId });
    return call;
  }
  const ui = (method, params, extra = {}) => dispatchUi(method, params, { storageStatus: () => "ready", services: () => undefined, profile: NO_PROFILE, link: admin, ...extra });
  return { base, clock, store, admin, provider, connect, ui, close };
}
