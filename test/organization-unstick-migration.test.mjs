import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { unstickLocalDeadline } from "../out/application/organizationUnstick.js";
import { backupStateOnce } from "../out/adapters/storage/stateBackup.js";
import { failedModelAttemptInRound, phaseOf } from "../out/application/organizationJobState.js";
import { createBackend } from "../out/backend/service.js";
import { PIN_PATH } from "./backendHarness.mjs";
import { actorOf, callRecord, seed, sessionRecord, tempStore } from "./recoverHarness.mjs";

const STATE_FILE = "punch-organization.json";
const BACKUP_FILE = "punch-organization.pre-unstick.json";
const EXPIRED = 23;
const ACTIVE = 22;
const DAY = 86_400_000;
const NOW = new Date(2026, 10, 9, 1, 0, 0).getTime();

// why: the shape of the 45 stuck calls in the real state copy: one call per operation, 25 to 34 seconds long, turn id set, no sequence number
async function stuckFixture(store) {
  const sessions = [];
  const calls = [];
  const jobs = [];
  for (let index = 0; index < EXPIRED + ACTIVE; index += 1) {
    const expired = index < EXPIRED;
    const actor = actorOf(`agent-${index}/worker`, index % 3 === 0 ? null : `project-${index}`);
    const createdAt = (expired ? new Date(2026, 10, 2, 9, index) : new Date(2026, 10, 7, 9, index)).getTime();
    const operationId = `organize:punch:${index}`;
    const record = await callRecord(actor, operationId, {
      hostSessionId: `host-${index}`, turnId: `turn-${index}`, sequenceNo: null, phase: "sent", retryable: true,
      partialDelivered: expired, hostErrorCode: "local_deadline", createdAt, updatedAt: createdAt + 25_000 + index * 200,
    });
    calls.push(record);
    sessions.push(sessionRecord(actor, `host-${index}`, expired ? "expired" : "active"));
    jobs.push({ actor, input: { operationId }, localErrorCode: null });
  }
  const bystanders = [];
  const shapes = [
    ["prepared", { phase: "prepared", turnId: null, hostSessionId: "host-b0", hostErrorCode: null }],
    ["send_unknown", { phase: "send_unknown", turnId: null, hostSessionId: "host-b1", hostErrorCode: "send_rejected", retryable: true, partialDelivered: true }],
    ["sent without local_deadline", { phase: "sent", hostSessionId: "host-b2", hostErrorCode: "turn_pending" }],
    ["sent with a sequence number", { phase: "sent", hostSessionId: "host-b3", hostErrorCode: "local_deadline", sequenceNo: 4 }],
    ["failed", { phase: "failed", hostSessionId: "host-b4", hostErrorCode: "provider_error", retryable: false, partialDelivered: true }],
  ];
  for (const [index, [label, fields]] of shapes.entries()) {
    const actor = actorOf(`bystander-${index}/worker`);
    const record = await callRecord(actor, `organize:bystander:${index}`, { updatedAt: NOW - 3 * DAY, ...fields });
    calls.push(record);
    sessions.push(sessionRecord(actor, fields.hostSessionId, "active"));
    bystanders.push({ label, call: record.call, actor });
  }
  await seed(store, { sessions, calls });
  return { jobs, bystanders };
}

const callsOfState = (state) => Object.values(state.operations).flatMap((operation) => Object.values(operation.calls));
const isStuck = (call) => call.phase === "sent" && call.hostErrorCode === "local_deadline" && call.replyJson === null && call.sequenceNo === null && call.turnId !== null;
const backupOf = (dir) => () => { backupStateOnce(dir, STATE_FILE, BACKUP_FILE); };

test("the migration turns all 45 stuck calls into failed migrated_unrecoverable and invalidates their sessions", async (t) => {
  const { dir, store } = tempStore(t, "memory-unstick-");
  const { jobs, bystanders } = await stuckFixture(store);
  const before = await store.readResumeState();
  const originalBytes = readFileSync(join(dir, STATE_FILE));
  assert.equal(callsOfState(before).filter(isStuck).length, EXPIRED + ACTIVE);
  assert.equal(Object.values(before.sessions).filter((session) => session.state === "expired").length, EXPIRED);

  const result = await unstickLocalDeadline(store, NOW, backupOf(dir));
  assert.equal(result.migrated, EXPIRED + ACTIVE);
  assert.equal(result.sessionsInvalidated, EXPIRED + ACTIVE);
  const after = await store.readResumeState();
  assert.equal(callsOfState(after).filter(isStuck).length, 0, "no call matches the condition any more");

  for (const [key, operation] of Object.entries(before.operations)) {
    for (const [callKey, call] of Object.entries(operation.calls)) {
      const next = after.operations[key].calls[callKey];
      if (!isStuck(call)) { assert.deepEqual(next, call, "a call that does not match is untouched"); continue; }
      assert.deepEqual(next, { ...call, phase: "failed", retryable: true, partialDelivered: false, hostErrorCode: "migrated_unrecoverable" });
      assert.equal(next.updatedAt, call.updatedAt, "updatedAt is kept");
    }
    assert.equal(after.operations[key].updatedAt, operation.updatedAt);
  }
  for (const [pair, session] of Object.entries(before.sessions)) {
    const stuck = jobs.some((job) => job.actor.agentId === session.agentId);
    assert.deepEqual(after.sessions[pair], stuck ? { ...session, state: "invalidated" } : session);
  }
  assert.deepEqual({ ...after, sessions: before.sessions, operations: before.operations }, before, "nothing outside sessions and operations changed");
  for (const { call } of bystanders) assert.deepEqual(after.operations[call.operationKey].calls[call.callKey], call);
  assert.deepEqual(readFileSync(join(dir, BACKUP_FILE)), originalBytes, "the backup is the exact file from before the migration");
});

test("a second run changes nothing and keeps the first backup", async (t) => {
  const { dir, store } = tempStore(t, "memory-unstick-");
  await stuckFixture(store);
  const backup = backupOf(dir);
  await unstickLocalDeadline(store, NOW, backup);
  const migratedBytes = readFileSync(join(dir, STATE_FILE));
  const backupBytes = readFileSync(join(dir, BACKUP_FILE));
  const again = await unstickLocalDeadline(store, NOW + 1000, backup);
  assert.equal(again.migrated, 0);
  assert.deepEqual(readFileSync(join(dir, STATE_FILE)), migratedBytes);
  assert.deepEqual(readFileSync(join(dir, BACKUP_FILE)), backupBytes);
});

test("an existing backup is never overwritten", async (t) => {
  const { dir, store } = tempStore(t, "memory-unstick-");
  await stuckFixture(store);
  writeFileSync(join(dir, BACKUP_FILE), "earlier backup");
  await unstickLocalDeadline(store, NOW, backupOf(dir));
  assert.equal(readFileSync(join(dir, BACKUP_FILE), "utf8"), "earlier backup");
});

test("prepared, send_unknown and sent calls of other shapes are not touched, and without stuck calls no backup is written", async (t) => {
  const { dir, store } = tempStore(t, "memory-unstick-");
  const { bystanders } = await stuckFixture(store);
  const state = await store.readResumeState();
  const withoutStuck = { ...state, operations: Object.fromEntries(Object.entries(state.operations).filter(([, operation]) => !callsOfState({ operations: { x: operation } }).some(isStuck))) };
  await store.writeResumeState(withoutStuck);
  const bytes = readFileSync(join(dir, STATE_FILE));
  const result = await unstickLocalDeadline(store, NOW, backupOf(dir));
  assert.deepEqual([result.migrated, result.sessionsInvalidated], [0, 0]);
  assert.deepEqual(readFileSync(join(dir, STATE_FILE)), bytes);
  assert.throws(() => readFileSync(join(dir, BACKUP_FILE)), { code: "ENOENT" });
  const after = await store.readResumeState();
  for (const { call } of bystanders) assert.deepEqual(after.operations[call.operationKey].calls[call.callKey], call);
});

test("after the migration the retry rules treat the pairs as ordinary failures", async (t) => {
  const { dir, store } = tempStore(t, "memory-unstick-");
  const { jobs } = await stuckFixture(store);
  const dailyTime = "02:00";
  const before = await store.readResumeState();
  const sample = jobs[0];
  const sampleCall = callsOfState({ operations: { x: Object.values(before.operations).find((operation) => operation.operationId === sample.input.operationId) } })[0];
  const at = NOW + 8 * DAY;
  assert.equal(phaseOf(before, sample, at).phase, "operator_reconcile", "before: the 7 day rule marks the pair");
  await unstickLocalDeadline(store, NOW, backupOf(dir));
  const after = await store.readResumeState();
  for (const job of jobs) {
    assert.notEqual(phaseOf(after, job, at).phase, "operator_reconcile");
    const localDay = (stamp) => `${new Date(stamp).getFullYear()}-${String(new Date(stamp).getMonth() + 1).padStart(2, "0")}-${String(new Date(stamp).getDate()).padStart(2, "0")}`;
    assert.equal(failedModelAttemptInRound(after, job, localDay(NOW), dailyTime), false, "the failure is not from today, so today's round may send again");
  }
  assert.ok(sampleCall.updatedAt < NOW);
});

test("start-up runs the migration once before the organization worker and writes the backup next to the state file", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "memory-unstick-start-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const { createLocalPunchOrganizationStore } = await import("../out/adapters/storage/punchStateStore.js");
  const store = createLocalPunchOrganizationStore(base);
  await stuckFixture(store);
  const snapshot = { snapshotId: "s", generation: "g", highWatermark: "p" };
  const host = {
    workRecords: { async readPage() { return { snapshot, nextCursor: null, records: [] }; }, subscribeSettledChanges() { return () => {}; } },
    pluginState: { async readPage() { throw Object.assign(new Error("retired"), { code: "plugin_state_retired" }); } },
    agentDirectory: { async readPage() { return { snapshot, entries: [], nextCursor: null }; } },
    projectDirectory: { async readPage() { return { snapshot, entries: [], nextCursor: null }; } },
    ai: { async getOptions() { throw new Error("no model in this test"); } },
  };
  const backend = createBackend({ dataRoot: join(base, "memory-cairn-v1"), pinPath: PIN_PATH, host, settings: { all: () => ({ organizationEnabled: false }), onChange() { return () => {}; } } });
  t.after(() => backend.dispose());
  backend.startWorkers();
  await backend.idleWorkers();
  const after = await store.readResumeState();
  assert.equal(callsOfState(after).filter(isStuck).length, 0);
  assert.equal(callsOfState(after).filter((call) => call.hostErrorCode === "migrated_unrecoverable").length, EXPIRED + ACTIVE);
  assert.ok(readFileSync(join(base, BACKUP_FILE)).length > 0);
});

test("a migration that cannot write its backup leaves the state alone and does not stop start-up", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "memory-unstick-fail-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const { createLocalPunchOrganizationStore } = await import("../out/adapters/storage/punchStateStore.js");
  const store = createLocalPunchOrganizationStore(base);
  await stuckFixture(store);
  mkdirSync(join(base, BACKUP_FILE));
  const bytes = readFileSync(join(base, STATE_FILE));
  const snapshot = { snapshotId: "s", generation: "g", highWatermark: "p" };
  const host = {
    workRecords: { async readPage() { return { snapshot, nextCursor: null, records: [] }; }, subscribeSettledChanges() { return () => {}; } },
    pluginState: { async readPage() { throw Object.assign(new Error("retired"), { code: "plugin_state_retired" }); } },
    agentDirectory: { async readPage() { return { snapshot, entries: [], nextCursor: null }; } },
    projectDirectory: { async readPage() { return { snapshot, entries: [], nextCursor: null }; } },
    ai: { async getOptions() { throw new Error("no model in this test"); } },
  };
  const backend = createBackend({ dataRoot: join(base, "memory-cairn-v1"), pinPath: PIN_PATH, host, settings: { all: () => ({ organizationEnabled: false }), onChange() { return () => {}; } } });
  t.after(() => backend.dispose());
  backend.startWorkers();
  await backend.idleWorkers();
  const saved = (text) => { const { operations, sessions } = JSON.parse(text).organizationResume; return { operations, sessions }; };
  assert.deepEqual(saved(readFileSync(join(base, STATE_FILE), "utf8")), saved(bytes.toString("utf8")), "without a backup the journal and sessions are not rewritten");
});
