import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { parseUiResponse } from "../out/contracts/uiContract.js";
import { DAY_START, daysAgo, databasePath, punchContent, seed, startStore } from "./uiHarness.mjs";

const REQUEST = { tzOffsetMin: 480, dayStartIso: DAY_START };

async function build(t) {
  const store = startStore(t);
  const at = (hour) => daysAgo(0, hour);
  const made = await seed(store, [
    { agentId: "sw/dev", projectId: null, sessionId: "S1", content: punchContent({ startMs: Date.parse(at(1)), title: "Alpha job", body: "alpha result" }), updatedAt: at(5) },
    { agentId: "sw/dev", projectId: null, sessionId: "S1", content: "plain note B of the same session", updatedAt: at(6) },
    { agentId: "sw/dev", projectId: null, sessionId: "S2", content: "plain note C of another session", updatedAt: at(7) },
    { agentId: "sw/dev", projectId: "p1", sessionId: "S1", content: "project note D of the same session", updatedAt: at(8) },
    { agentId: "ops/x", projectId: null, sessionId: "S1", content: "other agent note E in a session with the same name", updatedAt: at(9) },
  ]);
  const byPrefix = (prefix) => made.find((row) => row.content.startsWith(prefix));
  return { store, made, a: byPrefix("[工作紀錄"), b: byPrefix("plain note B"), c: byPrefix("plain note C"), d: byPrefix("project note D"), e: byPrefix("other agent") };
}

const refOf = (row) => ({ agentId: row.agentId, scope: row.scope, projectId: row.projectId, memoryId: row.id });
const conforms = (method, response) => assert.equal(parseUiResponse(method, response), true, `${method} ${JSON.stringify(response).slice(0, 300)}`);

test("ui.get returns the whole memory, its receipts, its work info and only same-agent same-session neighbours", async (t) => {
  const { store, a, b, c, d } = await build(t);
  const again = await store.backend.call("memory.remember@1", {
    actor: { agentId: "sw/dev", projectId: null, sessionId: "S9", providerId: "codex" },
    ops: [{ scope: "personal", content: a.content, kind: "context", operationId: "again-1" }],
  });
  assert.equal(again.results[0].value.deduplicated, true);
  const got = await store.backend.call("ui.get", refOf(a));
  conforms("ui.get", got);
  assert.equal(got.ok, true);
  assert.deepEqual(got.memory.ref, refOf(a));
  assert.equal(got.memory.content, a.content.normalize("NFKC"));
  assert.equal(got.memory.updatedAt >= daysAgo(0, 5), true);
  assert.equal(got.memory.revision, 2, "a duplicate write raises the revision");
  assert.equal(got.work.title, "Alpha job");
  assert.equal(got.work.cli, "claude");
  assert.deepEqual(got.receipts.map((receipt) => [receipt.client, receipt.sessionId, receipt.role]).sort(), [["claude", "S1", "user"], ["codex", "S9", "user"]]);
  assert.deepEqual(got.sameSession.map((item) => item.ref.memoryId), [d.id, b.id], "same agent and session only, newest first");
  assert.deepEqual(got.sameSession.map((item) => item.ref.scope), ["project", "personal"]);
  assert.equal(got.sameSession.some((item) => item.ref.memoryId === c.id), false);
  const plain = await store.backend.call("ui.get", refOf(b));
  assert.equal("work" in plain, false);
  assert.deepEqual(plain.sameSession.map((item) => item.ref.memoryId).sort(), [a.id, d.id].sort());
});

test("scanning the receipt table in tiny rowid ranges finds the same neighbours as one big scan", async (t) => {
  const { store, a, b, d } = await build(t);
  const tiny = store.open({ uiReceiptChunk: 1 });
  const chunked = await tiny.call("ui.get", refOf(a));
  const whole = await store.backend.call("ui.get", refOf(a));
  assert.deepEqual(chunked.sameSession.map((item) => item.ref.memoryId), [d.id, b.id]);
  assert.deepEqual(chunked, whole);
});

test("ui.get keeps at most 12 receipts and the full 4000-character content", async (t) => {
  const { store, a } = await build(t);
  for (let round = 0; round < 15; round += 1) {
    const written = await store.backend.call("memory.remember@1", {
      actor: { agentId: "sw/dev", projectId: null, sessionId: `many-${round}`, providerId: "claude" },
      ops: [{ scope: "personal", content: a.content, kind: "context", operationId: `many-${round}` }],
    });
    assert.equal(written.results[0].ok, true);
  }
  const got = await store.backend.call("ui.get", refOf(a));
  assert.equal(got.receipts.length, 12);
  const long = "長".repeat(3990);
  const stored = await store.backend.call("memory.remember@1", { actor: { agentId: "sw/dev", projectId: null, sessionId: "long", providerId: "claude" }, ops: [{ scope: "personal", content: long, kind: "fact", operationId: "long-1" }] });
  const detail = await store.backend.call("ui.get", { agentId: "sw/dev", scope: "personal", projectId: null, memoryId: stored.results[0].value.memory.id });
  assert.equal(detail.memory.content, long);
});

test("ui.get says NOT_FOUND for a wrong id, scope, project or agent and never creates anything", async (t) => {
  const { store, a, d } = await build(t);
  const notFound = { ok: false, code: "NOT_FOUND", retryable: false };
  const agentsBefore = readdirSync(join(store.dataRoot, "agents")).sort();
  assert.deepEqual(await store.backend.call("ui.get", { ...refOf(a), memoryId: "nope" }), notFound);
  assert.deepEqual(await store.backend.call("ui.get", { ...refOf(a), scope: "project", projectId: "p1" }), notFound);
  assert.deepEqual(await store.backend.call("ui.get", { ...refOf(d), projectId: "p2" }), notFound);
  assert.deepEqual(await store.backend.call("ui.get", { ...refOf(a), agentId: "ops/x" }), notFound);
  assert.deepEqual(await store.backend.call("ui.get", { ...refOf(a), agentId: "nobody/here" }), notFound);
  assert.deepEqual(readdirSync(join(store.dataRoot, "agents")).sort(), agentsBefore);
});

test("ui.forget: a stale revision conflicts, the right one forgets, a second forget answers forgotten:false", async (t) => {
  const { store, a, b } = await build(t);
  const stale = await store.backend.call("ui.forget", { ...refOf(a), expectedRevision: 99 });
  conforms("ui.forget", stale);
  assert.deepEqual(stale, { ok: false, code: "REVISION_CONFLICT", retryable: false });
  assert.equal((await store.backend.call("ui.get", refOf(a))).ok, true, "a conflict changes nothing");
  const first = await store.backend.call("ui.forget", { ...refOf(a), expectedRevision: 1 });
  conforms("ui.forget", first);
  assert.deepEqual(first, { ok: true, forgotten: true });
  assert.deepEqual(await store.backend.call("ui.forget", { ...refOf(a), expectedRevision: 1 }), { ok: true, forgotten: false });
  assert.deepEqual(await store.backend.call("ui.forget", { ...refOf(a), expectedRevision: 99 }), { ok: true, forgotten: false }, "an already forgotten memory is not a conflict");
  assert.deepEqual(await store.backend.call("ui.get", refOf(a)), { ok: false, code: "NOT_FOUND", retryable: false });
  assert.equal((await store.backend.call("ui.get", refOf(b))).ok, true, "other memories are untouched");
  const raw = new DatabaseSync(databasePath(store.dataRoot, "sw/dev"));
  try {
    const row = raw.prepare("SELECT deleted, content, revision FROM memories WHERE id = ?").get(a.id);
    assert.deepEqual({ ...row }, { deleted: 1, content: null, revision: 2 });
    assert.equal(raw.prepare("SELECT count(*) AS n FROM receipts WHERE memory_id = ?").get(a.id).n, 0, "the receipts go with the memory");
    assert.equal(raw.prepare("SELECT count(*) AS n FROM suppressed").get().n, 1);
  } finally {
    raw.close();
  }
});

test("after a forget the same content is refused with MEMORY_SUPPRESSED, other content is still accepted", async (t) => {
  const { store, a } = await build(t);
  assert.deepEqual(await store.backend.call("ui.forget", { ...refOf(a), expectedRevision: 1 }), { ok: true, forgotten: true });
  const actor = { agentId: "sw/dev", projectId: null, sessionId: "again", providerId: "claude" };
  for (const operationId of ["rewrite-same-op", "rewrite-other-op"]) {
    const response = await store.backend.call("memory.remember@1", { actor, ops: [{ scope: "personal", content: a.content, kind: "context", operationId }] });
    assert.equal(response.results[0].ok, false, operationId);
    assert.equal(response.results[0].error.code, "MEMORY_SUPPRESSED");
  }
  const other = await store.backend.call("memory.remember@1", { actor, ops: [{ scope: "personal", content: "Something else entirely.", kind: "fact", operationId: "fresh" }] });
  assert.equal(other.results[0].ok, true);
});

test("ui.forget on something that is not there: unknown memory forgets nothing, unknown agent is NOT_FOUND and creates nothing", async (t) => {
  const { store, a, d } = await build(t);
  const agentsBefore = readdirSync(join(store.dataRoot, "agents")).sort();
  assert.deepEqual(await store.backend.call("ui.forget", { ...refOf(a), memoryId: "ghost", expectedRevision: 1 }), { ok: true, forgotten: false });
  assert.deepEqual(await store.backend.call("ui.forget", { ...refOf(d), projectId: "p2", expectedRevision: 1 }), { ok: true, forgotten: false });
  assert.deepEqual(await store.backend.call("ui.forget", { ...refOf(a), scope: "project", projectId: "p1", expectedRevision: 1 }), { ok: true, forgotten: false });
  assert.deepEqual(await store.backend.call("ui.forget", { ...refOf(a), agentId: "nobody/here", expectedRevision: 1 }), { ok: false, code: "NOT_FOUND", retryable: false });
  assert.deepEqual(readdirSync(join(store.dataRoot, "agents")).sort(), agentsBefore);
  assert.equal((await store.backend.call("ui.get", refOf(a))).ok, true);
});

test("a forget of a project memory and two simultaneous forgets of one memory produce exactly one forgotten:true", async (t) => {
  const { store, d, b } = await build(t);
  assert.deepEqual(await store.backend.call("ui.forget", { ...refOf(d), expectedRevision: 1 }), { ok: true, forgotten: true });
  const both = await Promise.all([1, 2, 3].map(() => store.backend.call("ui.forget", { ...refOf(b), expectedRevision: 1 })));
  assert.deepEqual(both.map((response) => response.ok), [true, true, true]);
  assert.equal(both.filter((response) => response.forgotten).length, 1);
});

test("caches drop a forgotten memory at once: overview counts, list, search, stats and detail all follow", async (t) => {
  const { store, a, b } = await build(t);
  const first = { list: await store.backend.call("ui.list", { limit: 24 }), overview: await store.backend.call("ui.overview", REQUEST), search: await store.backend.call("ui.search", { q: "alpha" }), stats: await store.backend.call("ui.agentStats", { agentId: "sw/dev", tzOffsetMin: 480 }) };
  assert.ok(first.list.items.some((item) => item.ref.memoryId === a.id));
  assert.equal(first.search.items.length, 1);
  assert.equal(await store.backend.call("ui.forget", { ...refOf(a), expectedRevision: 1 }).then((response) => response.forgotten), true);
  const list = await store.backend.call("ui.list", { limit: 24 });
  assert.equal(list.items.some((item) => item.ref.memoryId === a.id), false);
  assert.equal(list.items.length, first.list.items.length - 1);
  const overview = await store.backend.call("ui.overview", REQUEST);
  assert.equal(overview.tiles.totalMemories, first.overview.tiles.totalMemories - 1);
  assert.equal(overview.agents.find((card) => card.id === "sw/dev").counts.total, first.overview.agents.find((card) => card.id === "sw/dev").counts.total - 1);
  assert.equal((await store.backend.call("ui.search", { q: "alpha" })).items.length, 0);
  const stats = await store.backend.call("ui.agentStats", { agentId: "sw/dev", tzOffsetMin: 480 });
  assert.equal(stats.namespaces.reduce((sum, row) => sum + row.count, 0), first.stats.namespaces.reduce((sum, row) => sum + row.count, 0) - 1);
  assert.equal(stats.tools.reduce((sum, row) => sum + row.n, 0), first.stats.tools.reduce((sum, row) => sum + row.n, 0) - 1);
  assert.equal((await store.backend.call("ui.get", refOf(b))).sameSession.some((item) => item.ref.memoryId === a.id), false);
});
