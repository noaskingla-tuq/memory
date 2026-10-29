import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalPunchOrganizationStore, createLocalPunchReceiptStore } from "../out/adapters/storage/punchStateStore.js";
import { createMigratingPunchReceiptStore } from "../out/backend/punchStateMigration.js";
import { createPunchFeed, createProfileDirectory } from "../out/backend/hostDataAdapter.js";
import { legacyModelCallKey, operationKey, pairKey, sha256 } from "../out/application/modelInvocationScope.js";

const scratch = (t) => { const dir = mkdtempSync(join(tmpdir(), "memory-state-")); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const snapshot = { snapshotId: "s", generation: "g", highWatermark: "p" };
const receipt = { state: "written", punchId: "p", agentId: "sw/a", scope: "personal", projectId: null, memoryId: "m", contentSha256: "a".repeat(64), writtenAt: 100 };

test("local state survives reopen, paginates and commits revision batches atomically", async (t) => {
  const dir = scratch(t);
  const store = createLocalPunchReceiptStore(dir);
  await store.writeBatch([{ key: "p", value: receipt, expectedRevision: null }, { key: "checkpoint.v1", value: { sinceMs: 123 }, expectedRevision: null }]);
  const reopened = createLocalPunchReceiptStore(dir);
  const first = await reopened.readPage(null, 1);
  assert.equal(first.records[0].key, "checkpoint.v1");
  assert.equal(first.records[0].revision, 1);
  assert.equal((await reopened.readPage(first.nextCursor, 1)).records[0].key, "p");
  const before = readFileSync(join(dir, "punch-state.json"), "utf8");
  await assert.rejects(reopened.writeBatch([{ key: "new", value: {} }, { key: "p", value: {}, expectedRevision: 9 }]), /state_revision_conflict/);
  assert.equal(readFileSync(join(dir, "punch-state.json"), "utf8"), before);
  await reopened.writeBatch([{ key: "p", value: receipt, expectedRevision: 1 }]);
  assert.equal((await reopened.readPage(null, 100)).records.find((row) => row.key === "p").revision, 2);
  const snapshotPage = await reopened.readPage(null, 1);
  await reopened.writeBatch([{ key: "a-before-checkpoint", value: 1 }]);
  assert.equal((await reopened.readPage(snapshotPage.nextCursor, 1)).records[0].key, "p");
  await assert.rejects(reopened.readPage(snapshotPage.nextCursor, 1), /state_cursor_invalid/);
});
test("organization date claims survive legacy queue reads and ordinary job writes", async (t) => {
  const dir = scratch(t);
  const path = join(dir, "punch-organization.json");
  writeFileSync(path, JSON.stringify({ version: 1, records: { "legacy-punch": { key: "legacy-punch", value: { version: 1, state: "pending" }, revision: 4 } } }));
  const store = createLocalPunchOrganizationStore(dir);
  const legacy = (await store.readPage(null, 100)).records[0];
  assert.equal(legacy.key, "legacy-punch");
  assert.equal(legacy.revision, 4);
  assert.equal(legacy.value.resumeDisposition, "legacy_unlinked");
  assert.equal(await store.claimDailyRound("2026-10-27"), true);
  assert.equal(await store.claimDailyRound("2026-10-27"), false);
  await assert.rejects(store.claimDailyRound("2026-02-30"), /organization_claim_date_invalid/);

  await store.writeBatch([
    { key: legacy.key, value: { state: "completed" }, expectedRevision: legacy.revision },
    { key: "new-punch", value: { state: "pending" }, expectedRevision: null },
  ]);
  const persisted = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(persisted.organizationClaims, { version: 1, dates: ["2026-10-27"], throughDate: "2026-10-27" });
  assert.equal(persisted.records["legacy-punch"].value.resumeDisposition, "legacy_unlinked");
  const reopened = createLocalPunchOrganizationStore(dir);
  assert.equal(await reopened.claimDailyRound("2026-10-27"), false);
  assert.equal(await reopened.claimDailyRound("2026-10-28"), true);
  const rows = await reopened.readPage(null, 100);
  assert.equal(rows.records.find((row) => row.key === "legacy-punch").value.state, "completed");
  assert.equal(rows.records.find((row) => row.key === "new-punch").value.state, "pending");
});
test("daily history stays bounded while preserving the latest open round, queued reply, and rollback watermark", async (t) => {
  const dir = scratch(t);
  const store = createLocalPunchOrganizationStore(dir);
  const jobKey = "open-job";
  const operationId = "organize:open-job";
  await store.enqueueJob(jobKey, {
    version: 1, punchId: jobKey, memoryId: "raw-memory",
    actor: { agentId: "sw/a", projectId: "project", sessionId: "session", providerId: "mock" },
    input: { scope: "project", operationId, messages: [{ id: "source", role: "user", content: "synthetic" }] },
    state: "pending", attempts: 1, nextAttemptAt: 0, lastError: "STORAGE_BUSY", resumeDisposition: "eligible", lastAttemptDate: "2026-01-01",
  }, "work-record", jobKey);
  const pair = pairKey("sw/a", "project");
  const opKey = operationKey(pair, operationId);
  const requestSha256 = "a".repeat(64);
  const replyJson = '{"items":[]}';
  const legacyCallKey = legacyModelCallKey(opKey, "extract", requestSha256, 0);
  await store.transactResumeState((state) => ({
    ...state,
    operations: {
      ...state.operations,
      [opKey]: {
        operationKey: opKey, pairKey: pair, operationId, agentId: "sw/a", projectId: "project", updatedAt: Date.UTC(2026, 0, 1),
        calls: {
          [legacyCallKey]: {
            callKey: legacyCallKey, operationKey: opKey, pairKey: pair, modelOperation: "extract", operationSystemSha256: "b".repeat(64),
            requestSha256, occurrence: 0, hostSessionId: "saved-session", turnId: "saved-turn", sequenceNo: 1,
            phase: "reply_ready", retryable: false, partialDelivered: false, hostErrorCode: null,
            replyJson, replySha256: sha256(replyJson), responseBytes: Buffer.byteLength(replyJson),
            createdAt: Date.UTC(2026, 0, 1), updatedAt: Date.UTC(2026, 0, 1),
          },
        },
      },
    },
  }));
  const firstDate = "2026-01-01";
  let latestDate = firstDate;
  for (let offset = 0; offset < 100; offset++) {
    const date = new Date(Date.UTC(2026, 0, 1 + offset)).toISOString().slice(0, 10);
    const at = Date.UTC(2026, 0, 1 + offset, 3);
    const begun = await store.beginOrResumeDailyRound(date, { generation: "g", highWatermark: "p" }, at);
    assert.equal(begun.shouldRun, true);
    assert.ok(begun.round);
    const paused = offset === 99;
    await store.updateDailyRound(date, {
      ...begun.round,
      state: paused ? "paused" : "completed",
      updatedAt: at,
      nextResumeAt: paused ? at + 86_400_000 : null,
      completedAt: paused ? null : at,
    });
    latestDate = date;
  }

  const beforeRollback = await store.readResumeState();
  const persisted = JSON.parse(readFileSync(join(dir, "punch-organization.json"), "utf8"));
  assert.ok(Object.keys(beforeRollback.dailyRounds).length <= 32);
  assert.ok(persisted.organizationClaims.dates.length <= 32);
  assert.equal(persisted.organizationClaims.throughDate, latestDate);
  assert.equal(beforeRollback.claimedThroughDate, latestDate);
  assert.equal(beforeRollback.dailyRounds[latestDate].state, "paused");
  assert.equal(beforeRollback.operations[opKey].calls[legacyCallKey].replyJson, replyJson);
  const pending = (await store.readPage(null, 100)).records.find((row) => row.key === jobKey).value;
  assert.equal(pending.state, "pending");
  assert.equal(pending.input.messages[0].content, "synthetic");

  const sameDay = await store.beginOrResumeDailyRound(latestDate, { generation: "g", highWatermark: "p" }, Date.UTC(2026, 3, 10, 4));
  assert.equal(sameDay.shouldRun, true);
  assert.equal(sameDay.round.roundId, beforeRollback.dailyRounds[latestDate].roundId);
  const rolledBack = await store.beginOrResumeDailyRound(firstDate, { generation: "g", highWatermark: "p" }, Date.UTC(2026, 0, 1, 4));
  assert.equal(rolledBack.shouldRun, false);
  assert.equal(rolledBack.replyOnly, true);
  assert.equal(rolledBack.round, null);
  assert.equal(await store.claimDailyRound(firstDate), false);
  const afterRollback = await store.readResumeState();
  assert.equal(afterRollback.claimedThroughDate, latestDate);
  assert.ok(Object.keys(afterRollback.dailyRounds).length <= 32);
  assert.equal(afterRollback.dailyRounds[latestDate].state, "paused");
  assert.equal(afterRollback.operations[opKey].calls[legacyCallKey].replyJson, replyJson);
});
test("corrupt state, duplicate keys and unsafe paths fail without overwriting evidence", async (t) => {
  const dir = scratch(t);
  const store = createLocalPunchReceiptStore(dir);
  await assert.rejects(store.writeBatch([{ key: "p", value: {} }, { key: "p", value: {} }]), /state_key_invalid/);
  writeFileSync(join(dir, "punch-state.json"), "broken");
  await assert.rejects(store.writeBatch([{ key: "p", value: receipt }]));
  assert.equal(readFileSync(join(dir, "punch-state.json"), "utf8"), "broken");
  assert.throws(() => createLocalPunchReceiptStore(dir, "../escape.json"), /state_path_invalid/);
  const target = scratch(t);
  const link = join(dir, "redirect");
  symlinkSync(target, link, "junction");
  await assert.rejects(createLocalPunchReceiptStore(link).readPage(null, 100), /state_path_unsafe/);
});
test("host state migrates receipts and checkpoint once without host writes", async (t) => {
  const local = createLocalPunchReceiptStore(scratch(t));
  let reads = 0;
  const host = { pluginState: { async readPage(namespace) { reads++; return { records: namespace === "punch-write-v1" ? [{ key: "p", value: receipt }, { key: "checkpoint.v1", value: { version: 1, sinceMs: 9 } }] : [{ key: "p", value: { ...receipt } }], nextCursor: null }; } } };
  const migrating = createMigratingPunchReceiptStore(host, local);
  const rows = (await migrating.readPage(null, 100)).records;
  assert.deepEqual(rows.find((row) => row.key === "p").value, receipt);
  assert.equal(rows.find((row) => row.key === "checkpoint.v1").value.sinceMs, 9);
  assert.equal(reads, 2);
  await createMigratingPunchReceiptStore(host, local).readPage(null, 100);
  assert.equal(reads, 2);
});
test("retired host state allows local writes; temporary failures retry and conflicts fail closed", async (t) => {
  const local = createLocalPunchReceiptStore(scratch(t));
  let retired = false;
  const host = { pluginState: { async readPage() { throw Object.assign(new Error("unavailable"), { code: retired ? "plugin_state_retired" : "temporary" }); } } };
  const migrating = createMigratingPunchReceiptStore(host, local);
  await assert.rejects(migrating.readPage(null, 100), { code: "temporary" });
  retired = true;
  await migrating.writeBatch([{ key: "p", value: receipt }]);
  assert.deepEqual((await local.readPage(null, 100)).records.find((row) => row.key === "p").value, receipt);
  const conflictLocal = createLocalPunchReceiptStore(scratch(t));
  await conflictLocal.writeBatch([{ key: "p", value: { ...receipt, memoryId: "different" } }]);
  const conflict = createMigratingPunchReceiptStore({ pluginState: { async readPage() { return { records: [{ key: "p", value: receipt }], nextCursor: null }; } } }, conflictLocal);
  await assert.rejects(conflict.readPage(null, 100), /legacy_receipt_conflict/);
});
test("SDK readPage opens snapshots and preserves the initial work-record page and punch identity", async () => {
  const requests = [];
  const feed = createPunchFeed({ workRecords: {
    async readPage(request) { requests.push(request); return { snapshot, records: [{ id: "host-row", punchId: "punch", agentId: "a", projectId: null }], nextCursor: request.cursor === null ? "next" : null }; },
    subscribeSettledChanges(listener) { listener({}); return () => {}; },
  } });
  assert.deepEqual(await feed.openSettledSnapshot(), snapshot);
  const first = await feed.readSettledPage({ snapshotId: "s", cursor: null, limit: 100 });
  assert.equal(first.records[0].id, "punch");
  assert.equal(requests.length, 1);
  await feed.readSettledPage({ snapshotId: "s", cursor: first.nextCursor, limit: 100 });
  assert.deepEqual(requests[1], { snapshotId: "s", cursor: "next", limit: 100 });
});
test("SDK work-record and directory snapshots reject changes and repeated cursors", async () => {
  const feed = createPunchFeed({ workRecords: { async readPage(request) { return { snapshot: { ...snapshot, snapshotId: request.cursor ? "changed" : "s" }, records: [], nextCursor: "next" }; } } });
  await feed.openSettledSnapshot();
  await assert.rejects(feed.readSettledPage({ snapshotId: "s", cursor: "next", limit: 100 }), /snapshot_changed/);
  for (const mode of ["snapshot", "generation", "cursor"]) {
    let calls = 0;
    const directory = createProfileDirectory({ agentDirectory: { async readPage(request) {
      calls++;
      assert.equal(request.snapshotId, calls === 1 ? undefined : "s");
      return { snapshot: { ...snapshot, ...(calls > 1 && mode === "snapshot" ? { snapshotId: "changed" } : {}), ...(calls > 1 && mode === "generation" ? { generation: "changed" } : {}) }, entries: [], nextCursor: "next" };
    } } });
    await assert.rejects(directory.readAgents(), mode === "cursor" ? /cursor_repeated/ : /snapshot_changed/);
  }
});
