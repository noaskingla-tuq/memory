#!/usr/bin/env node
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBackend } from "../out/backend/service.js";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dataIndex = process.argv.indexOf("--data");
const outIndex = process.argv.indexOf("--out");
if (dataIndex === -1) {
  console.error("usage: node tools/perf-ui.mjs --data <dir holding memory-cairn-v1> [--out result.json]");
  process.exit(2);
}
const dataRoot = resolve(process.argv[dataIndex + 1] ?? "");
const pinPath = join(repoRoot, "cairn-pin.json");
// why: the first call after activation still has to open every agent database once (about 4 ms each), so a cold list page gets its own, looser limit and the strict 500 ms applies from the moment the index exists
const LIMITS = { overviewMs: 1000, listMs: 500, coldListMs: 1000, searchMs: 1500, stallMs: 50 };
const runtime = process.versions.electron === undefined ? `node ${process.versions.node}` : `electron ${process.versions.electron} (node ${process.versions.node}, run-as-node)`;
const localMidnight = (tzOffsetMin) => {
  const local = Date.now() + tzOffsetMin * 60_000;
  return new Date(local - (local % 86_400_000) - tzOffsetMin * 60_000).toISOString();
};
const TZ = 480;
const OVERVIEW = { tzOffsetMin: TZ, dayStartIso: localMidnight(TZ) };
const results = { runtime, dataRoot, limits: LIMITS, cases: [], failures: [] };

// why: a setImmediate chain runs once per loop turn, so the largest gap between two runs is the longest stretch during which nothing else on the thread could run
function watchLoop() {
  let last = performance.now();
  let max = 0;
  let running = true;
  const turn = () => {
    const now = performance.now();
    max = Math.max(max, now - last);
    last = now;
    if (running) setImmediate(turn);
  };
  setImmediate(turn);
  return () => {
    running = false;
    return Math.max(max, performance.now() - last);
  };
}

async function measure(label, limitMs, work) {
  const stop = watchLoop();
  const started = performance.now();
  const value = await work();
  const ms = performance.now() - started;
  const stallMs = stop();
  const record = { label, ms: +ms.toFixed(1), stallMs: +stallMs.toFixed(1), ok: value?.ok === true, items: value?.items?.length ?? value?.agents?.length ?? null };
  results.cases.push(record);
  if (value?.ok !== true) results.failures.push(`${label} answered ${JSON.stringify(value).slice(0, 160)}`);
  if (limitMs !== null && ms > limitMs) results.failures.push(`${label} took ${ms.toFixed(0)} ms, limit ${limitMs}`);
  if (stallMs > LIMITS.stallMs) results.failures.push(`${label} blocked the event loop for ${stallMs.toFixed(1)} ms, limit ${LIMITS.stallMs}`);
  return value;
}

// why: the real entry point initialises storage at activation, so the first ui call must not be charged for that
const open = (root) => {
  const backend = createBackend({ dataRoot: join(root, "memory-cairn-v1"), pinPath });
  backend.warmUp();
  return backend;
};
const median = (values) => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];

async function readPhase() {
  const warmup = open(dataRoot);
  await warmup.call("ui.status", {});
  await warmup.call("ui.overview", OVERVIEW);
  await warmup.dispose();

  const background = open(dataRoot);
  await measure("index warm-up in the background (from activation)", null, async () => {
    await background.warmIndex();
    return { ok: true };
  });
  await measure("list page 1 after the warm-up", LIMITS.listMs, () => background.call("ui.list", { limit: 12 }));
  await measure("overview after the warm-up", LIMITS.overviewMs, () => background.call("ui.overview", OVERVIEW));
  await background.dispose();

  const cold = open(dataRoot);
  const overview = await measure("overview cold (empty index)", LIMITS.overviewMs, () => cold.call("ui.overview", OVERVIEW));
  results.overview = { tiles: overview.tiles, cards: overview.agents.length, nextCursor: overview.nextCursor !== null };
  for (let round = 1; round <= 3; round += 1) await measure(`overview warm #${round}`, LIMITS.overviewMs, () => cold.call("ui.overview", OVERVIEW));
  await measure("overview page 2", LIMITS.overviewMs, () => cold.call("ui.overview", { ...OVERVIEW, cursor: overview.nextCursor }));
  await cold.dispose();

  const listBackend = open(dataRoot);
  const first = await measure("list page 1 cold", LIMITS.coldListMs, () => listBackend.call("ui.list", { limit: 12 }));
  const second = await measure("list page 2", LIMITS.listMs, () => listBackend.call("ui.list", { limit: 12, cursor: first.nextCursor }));
  await measure("list page 3", LIMITS.listMs, () => listBackend.call("ui.list", { limit: 24, cursor: second.nextCursor }));
  await measure("list page 1 warm", LIMITS.listMs, () => listBackend.call("ui.list", { limit: 12 }));
  const someone = first.items[0].ref;
  await measure("list one agent", LIMITS.listMs, () => listBackend.call("ui.list", { limit: 24, agentId: someone.agentId }));
  await measure("list cli filter", LIMITS.listMs, () => listBackend.call("ui.list", { limit: 12, cli: "codex" }));
  await measure("list time window", LIMITS.listMs, () => listBackend.call("ui.list", { limit: 12, sinceIso: new Date(Date.now() - 10 * 86_400_000).toISOString(), untilIso: new Date(Date.now() - 5 * 86_400_000).toISOString() }));
  let deep = first;
  for (let step = 0; step < 40 && deep.nextCursor !== null; step += 1) deep = await listBackend.call("ui.list", { limit: 24, cursor: deep.nextCursor });
  await measure("list deep page (cursor 40 pages in)", LIMITS.listMs, () => listBackend.call("ui.list", { limit: 12, cursor: deep.nextCursor }));
  let deeper = deep;
  for (let step = 0; step < 100 && deeper.nextCursor !== null; step += 1) deeper = await listBackend.call("ui.list", { limit: 24, cursor: deeper.nextCursor });
  await measure("list deeper page (cursor 140 pages in)", LIMITS.listMs, () => listBackend.call("ui.list", { limit: 12, cursor: deeper.nextCursor }));
  await listBackend.dispose();

  const searchBackend = open(dataRoot);
  const queries = [
    ["search common CJK 2 chars", "測試"],
    ["search common ASCII", "sqlite"],
    ["search 3 terms AND", "測試 登入 sqlite"],
    ["search rare phrase", "登入頁面 sqlite"],
    ["search no hit (worst case)", "NOMATCHZZ"],
  ];
  let firstSearch = true;
  for (const [label, q] of queries) {
    const page = await measure(`${label}${firstSearch ? " cold" : ""}`, LIMITS.searchMs, () => searchBackend.call("ui.search", { q, limit: 12 }));
    firstSearch = false;
    if (page.nextCursor !== null) await measure(`${label} page 2`, LIMITS.searchMs, () => searchBackend.call("ui.search", { q, limit: 12, cursor: page.nextCursor }));
    await measure(`${label} warm`, LIMITS.searchMs, () => searchBackend.call("ui.search", { q, limit: 12 }));
  }
  await measure("search no hit, one agent", LIMITS.searchMs, () => searchBackend.call("ui.search", { q: "NOMATCHZZ", agentId: someone.agentId }));
  let deepSearch = await searchBackend.call("ui.search", { q: "登入頁面 修正", limit: 24 });
  for (let step = 0; step < 20 && deepSearch.nextCursor !== null; step += 1) deepSearch = await searchBackend.call("ui.search", { q: "登入頁面 修正", limit: 24, cursor: deepSearch.nextCursor });
  await measure("search rare phrase, page 21", LIMITS.searchMs, () => searchBackend.call("ui.search", { q: "登入頁面 修正", limit: 24, cursor: deepSearch.nextCursor }));

  await measure("get", LIMITS.listMs, () => searchBackend.call("ui.get", { agentId: someone.agentId, scope: someone.scope, projectId: someone.projectId, memoryId: someone.memoryId }));
  await measure("agentStats cold", LIMITS.listMs, () => searchBackend.call("ui.agentStats", { agentId: someone.agentId, tzOffsetMin: TZ }));
  await measure("agentStats warm", LIMITS.listMs, () => searchBackend.call("ui.agentStats", { agentId: someone.agentId, tzOffsetMin: TZ }));
  await measure("status (warm index)", LIMITS.listMs, () => searchBackend.call("ui.status", {}));
  const statusBackend = open(dataRoot);
  await measure("status cold", LIMITS.overviewMs, () => statusBackend.call("ui.status", {}));
  await statusBackend.dispose();
  await searchBackend.dispose();
  return median(results.cases.filter((entry) => entry.label.startsWith("overview warm")).map((entry) => entry.ms));
}

// why: a remember is a synchronous Cairn write (about 6 ms per memory, and one slow fsync can take 100 ms), so the loop is legitimately blocked for as long as the longest write; the limit is therefore asserted on what the ui calls add on top of that (stall minus the longest write call), in both the 16-op batch run and the single-op run
async function concurrentPhase(name, batchOps, stallLimitMs) {
  const scratch = mkdtempSync(join(tmpdir(), "teamuq-perf-ui-"));
  try {
    cpSync(join(dataRoot, "memory-cairn-v1"), join(scratch, "memory-cairn-v1"), { recursive: true });
    const backend = open(scratch);
    await backend.warmIndex();
    const overview = await backend.call("ui.overview", OVERVIEW);
    const owners = [];
    let cursor;
    for (let guard = 0; guard < 20; guard += 1) {
      const page = await backend.call("ui.overview", { ...OVERVIEW, limit: 200, ...(cursor === undefined ? {} : { cursor }) });
      owners.push(...page.agents.map((card) => card.id));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    const errors = [];
    const writeCalls = [];
    let written = 0;
    let stop = false;
    const stopWatching = watchLoop();
    const started = performance.now();
    const writer = async () => {
      for (let batch = 0; !stop; batch += 1) {
        const agentId = owners[(batch * 7) % owners.length];
        const ops = Array.from({ length: batchOps }, (_, index) => ({ scope: "personal", content: `並行寫入測試 ${batch}-${index} ${"內容".repeat(50)}`, kind: "context", operationId: `perf:${batch}-${index}` }));
        const began = performance.now();
        try {
          const response = await backend.call("memory.remember@1", { actor: { agentId, projectId: null, sessionId: "perf", providerId: "codex" }, ops });
          for (const result of response.results) {
            if (result.ok) written += 1;
            else errors.push(`remember ${result.error.code}`);
          }
        } catch (error) {
          errors.push(`remember threw ${error?.code ?? error?.message}`);
        }
        writeCalls.push(performance.now() - began);
        await new Promise((resolveTurn) => setImmediate(resolveTurn));
      }
    };
    const reads = { overview: 0, list: 0, search: 0, stats: 0, get: 0, status: 0 };
    // why: every real ui call arrives as its own IPC task, so the loops give the event loop a turn per call; without it a fully cached answer resolves in microtasks alone and starves timers and the writer
    const call = async (kind, method, params) => {
      await new Promise((resolveTurn) => setImmediate(resolveTurn));
      try {
        const response = await backend.call(method, params);
        if (response.ok !== true) errors.push(`${method} ${JSON.stringify(response).slice(0, 100)}`);
        reads[kind] += 1;
        return response;
      } catch (error) {
        errors.push(`${method} threw ${error?.code ?? error?.message}`);
        return undefined;
      }
    };
    const reader = async (index) => {
      while (!stop) {
        await call("overview", "ui.overview", OVERVIEW);
        const list = await call("list", "ui.list", { limit: 12 });
        await call("search", "ui.search", { q: index === 0 ? "並行寫入測試" : "測試 sqlite", limit: 12 });
        await call("stats", "ui.agentStats", { agentId: owners[index * 11], tzOffsetMin: TZ });
        const item = list?.items?.[0]?.ref;
        if (item !== undefined) await call("get", "ui.get", item);
        await call("status", "ui.status", {});
      }
    };
    const runners = [writer(), reader(0), reader(1)];
    await new Promise((resolveWait) => setTimeout(resolveWait, 8000));
    stop = true;
    await Promise.all(runners);
    const seconds = (performance.now() - started) / 1000;
    const stallMs = stopWatching();
    const after = await backend.call("ui.overview", OVERVIEW);
    const record = {
      name,
      batchOps,
      seconds: +seconds.toFixed(1),
      written,
      writeCalls: writeCalls.length,
      writeCallMaxMs: +Math.max(...writeCalls).toFixed(1),
      reads,
      errors: [...new Set(errors)],
      errorCount: errors.length,
      stallMs: +stallMs.toFixed(1),
      uiShareMs: +Math.max(0, stallMs - Math.max(...writeCalls)).toFixed(1),
      stallLimitMs,
      agentsAtStart: overview.tiles.agents,
      totalBefore: overview.tiles.totalMemories,
      totalAfter: after.tiles.totalMemories,
      totalExpected: overview.tiles.totalMemories + written,
    };
    results.concurrent.push(record);
    if (errors.length > 0) results.failures.push(`${name}: ${errors.length} errors: ${[...new Set(errors)].slice(0, 5).join("; ")}`);
    if (record.uiShareMs > stallLimitMs) results.failures.push(`${name}: the ui calls added ${record.uiShareMs} ms on top of the longest write (stall ${stallMs.toFixed(1)} ms, longest write ${record.writeCallMaxMs} ms), limit ${stallLimitMs}`);
    if (after.tiles.totalMemories !== record.totalExpected) results.failures.push(`${name}: overview counted ${after.tiles.totalMemories}, expected ${record.totalExpected}`);
    await backend.dispose();
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

results.concurrent = [];
await readPhase();
if (!process.argv.includes("--reads-only")) {
  await concurrentPhase("reads while 16-op remember batches run (as the Core sink writes)", 16, LIMITS.stallMs);
  await concurrentPhase("reads while single remember ops run", 1, LIMITS.stallMs);
}
results.ok = results.failures.length === 0;
const text = JSON.stringify(results, null, 2);
if (outIndex !== -1) writeFileSync(resolve(process.argv[outIndex + 1] ?? "perf.json"), text);
console.log(text);
process.exit(results.ok ? 0 : 1);
