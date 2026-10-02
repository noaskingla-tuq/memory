import assert from "node:assert/strict";
import test from "node:test";
import { createPunchCatchupWorker, PUNCH_RECEIPT_NAMESPACE } from "../out/application/punchCatchup.js";
import { buildPunchMemoryContent, punchOperationId } from "../out/application/punchContent.js";

const lexical = (text) => JSON.stringify({ root: { type: "root", children: [{ type: "paragraph", children: [{ type: "text", text }] }] } });
const punch = (id, overrides = {}) => ({
  id,
  agentId: "sw/developer",
  projectId: null,
  sessionId: "session-1",
  providerId: "claude",
  punchType: "main",
  startedAtMs: Date.UTC(2026, 8, 29, 3, 15),
  endedAtMs: Date.UTC(2026, 8, 29, 3, 42),
  model: "claude-opus",
  name: "Fix login",
  description: lexical("Added a regression test."),
  ...overrides,
});

function harness(records, options = {}) {
  const state = new Map();
  const calls = [];
  const writes = [];
  const events = [];
  let listener = () => {};
  let cursorReads = 0;
  const feed = {
    async openSettledSnapshot() { return { snapshotId: "snapshot-1", generation: "g1", highWatermark: "p2" }; },
    async readSettledPage(input) {
      assert.equal(input.snapshotId, "snapshot-1");
      cursorReads += 1;
      return { snapshot: { snapshotId: "snapshot-1", generation: "g1", highWatermark: "p2" }, records, nextCursor: null };
    },
    subscribeSettledChanges(next) { listener = next; return () => { listener = () => {}; }; },
  };
  const receipts = {
    async readPage(cursor, limit) {
      assert.equal(limit, 100);
      const all = [...state].map(([key, value]) => ({ key, value }));
      const offset = cursor === null ? 0 : Number(cursor);
      const page = all.slice(offset, offset + limit);
      return { records: page, nextCursor: offset + limit < all.length ? String(offset + limit) : null };
    },
    async writeBatch(rows) {
      if (options.failReceiptWrites) throw new Error("receipt_write_failed");
      events.push("receipt_write");
      writes.push(rows);
      for (const row of rows) state.set(row.key, row.value);
    },
  };
  const writer = options.writer ?? {
    async rememberMany(input) {
      calls.push(input);
      return input.map((item, index) => item.content === "fail"
        ? { ok: false, code: "MEMORY_SUPPRESSED", retryable: false }
        : { ok: true, memoryId: `memory-${calls.length}-${index}`, deduplicated: false });
    },
  };
  const worker = createPunchCatchupWorker({ feed, receipts, writer, now: () => Date.UTC(2026, 9, 2), minAgeMs: 0, batchPauseMs: 0, ...options });
  return { worker, state, calls, writes, events, listener: () => listener(), get cursorReads() { return cursorReads; } };
}

test("punch content preserves the old deterministic work-record template and operation id", () => {
  const built = buildPunchMemoryContent(punch("p1"));
  assert.equal(built.content, "[工作紀錄 2026-09-29T03:15Z～2026-09-29T03:42Z claude/claude-opus] 請求：Fix login。成果：Added a regression test.");
  assert.equal(built.operationId, punchOperationId("p1"));
  assert.match(built.contentSha256, /^[0-9a-f]{64}$/u);
});

test("activation catches up settled records and persists one terminal receipt per record", async () => {
  const h = harness([punch("p1"), punch("p2", { punchType: "subagent" })]);
  h.worker.start();
  await h.worker.idle();
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls.flat().map((call) => call.operationId), [punchOperationId("p1"), punchOperationId("p2")]);
  assert.equal([...h.state.values()].filter((value) => value?.state === "written").length, 2);
  assert.equal([...h.state.values()].filter((value) => value?.version === 1).length, 1);
  await h.worker.stop();
  assert.equal(PUNCH_RECEIPT_NAMESPACE, "punch-write-v1");
});

test("a repeated activation reads durable receipts before writing and remains idempotent", async () => {
  const h = harness([punch("p1")]);
  h.worker.start();
  await h.worker.idle();
  h.worker.wake();
  await h.worker.idle();
  assert.equal(h.calls.length, 1);
  assert.equal(h.cursorReads, 2);
  await h.worker.stop();
});

test("empty content is terminally skipped without calling the memory writer", async () => {
  const h = harness([punch("empty", { name: " ", description: lexical("") })]);
  h.worker.start();
  await h.worker.idle();
  assert.equal(h.calls.length, 0);
  assert.equal(h.state.get("empty")?.reason, "empty_content");
  await h.worker.stop();
});

test("same-actor writes retain the sixteen-operation request ceiling", async () => {
  const h = harness(Array.from({ length: 18 }, (_, index) => punch(`batch-${index}`)));
  h.worker.start();
  await h.worker.idle();
  assert.deepEqual(h.calls.map((call) => call.length), [16, 2]);
  assert.equal([...h.state.values()].filter((value) => value?.state === "written").length, 18);
  await h.worker.stop();
});

test("retryable memory failures leave the punch without a terminal receipt", async () => {
  const writer = { async rememberMany(items) { return items.map(() => ({ ok: false, code: "STORAGE_BUSY", retryable: true })); } };
  const h = harness([punch("retry")], { writer });
  h.worker.start();
  await h.worker.idle();
  assert.equal(h.state.has("retry"), false);
  assert.equal(h.state.get("checkpoint.v1")?.completedAt, undefined);
  await h.worker.stop();
});

test("long memory content is capped without splitting surrogate pairs", () => {
  const built = buildPunchMemoryContent(punch("long", { description: lexical(`${"H".repeat(50)}${"😀".repeat(6000)}${"T".repeat(50)}`) }));
  assert.ok(built.content.length <= 3_600);
  assert.ok(built.content.includes(" …… "));
  assert.ok(built.content.startsWith("[工作紀錄"));
  assert.ok(built.content.endsWith("TTTTT"));
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(built.content), false);
});

test("legacy receipts copy exact terminal identity before deleting their source keys", async () => {
  const legacy = { state: "written", punchId: "p1", agentId: "sw/developer", scope: "project", projectId: "project-1", memoryId: "memory-existing", contentSha256: "a".repeat(64), writtenAt: 1727581320000 };
  const h = harness([punch("p1", { projectId: "project-1" })], {
    legacyReceipts: {
      async readPage(cursor, limit) {
        assert.equal(cursor, null);
        assert.equal(limit, 100);
        return { records: [{ key: "p1", value: legacy }], nextCursor: null };
      },
      async deleteBatch(keys) {
        assert.deepEqual(keys, ["p1"]);
        assert.deepEqual(h.state.get("p1"), legacy);
        h.events.push("legacy_delete");
      },
    },
  });
  h.worker.start();
  await h.worker.idle();
  assert.deepEqual(h.state.get("p1"), legacy);
  assert.equal(h.calls.length, 0);
  assert.ok(h.events.indexOf("receipt_write") < h.events.indexOf("legacy_delete"));
  await h.worker.stop();
});
