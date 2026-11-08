import assert from "node:assert/strict";
import test from "node:test";
import { parseUiResponse } from "../out/contracts/uiContract.js";
import { dispatchUi } from "../out/backend/uiDispatch.js";
import { createPunchCatchupWorker } from "../out/application/punchCatchup.js";
import { STARTUP_WAIT_CAP_MS, createStartupGate } from "../out/application/organizationStartup.js";
import { ok, punch, workerRig } from "./organizationHarness.mjs";

const NO_PROFILE = { current: () => ({ generation: null, receivedAt: null, agents: 0, projects: 0, teams: 0, incomplete: false, corrupt: false, omitted: { agents: 0, projects: 0, teams: 0 } }) };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (condition, ms = 5_000) => { const end = Date.now() + ms; while (Date.now() < end && !condition()) await pause(10); assert.ok(condition(), "condition not reached"); };
const wrap = (organization) => ({ ok: true, version: "1.4.8", cairnCommit: "a".repeat(40), storage: { status: "ready" }, profile: { generation: null, receivedAt: null, agents: 0, projects: 0, sink: null }, lastWriteAt: null, uptimeSec: 1, organization });

function dailyRig(t, patch = {}) {
  const events = [];
  const h = workerRig(t, { capture: async (job) => { h.calls.push(job.punchId); return ok(); } });
  h.state.frequency = "daily";
  let reads = 0;
  const readPage = h.store.readPage.bind(h.store);
  h.store.readPage = async (...args) => { reads += 1; return readPage(...args); };
  const worker = h.create({ onStartup: (event) => events.push(event), ...patch });
  return { h, worker, events, reads: () => reads, resetReads: () => { reads = 0; } };
}

test("the gate: the cap is a fixed constant, a release is recorded once with its reason, and the check releases at the cap", () => {
  assert.equal(STARTUP_WAIT_CAP_MS, 300_000);
  let at = 1_000;
  const events = [];
  const gate = createStartupGate({ now: () => at, onChange: (event) => events.push(event) });
  assert.equal(gate.check(), true, "a gate nobody deferred is open");
  gate.defer();
  assert.deepEqual([gate.waiting(), gate.check()], [true, false]);
  at += STARTUP_WAIT_CAP_MS - 1;
  assert.deepEqual([gate.waiting(), gate.check()], [true, false], "one millisecond before the cap it still waits");
  at += 1;
  assert.equal(gate.waiting(), false, "a status read already sees the cap");
  assert.equal(events.length, 1, "reading does not record the release");
  assert.equal(gate.check(), true);
  assert.deepEqual(events.at(-1), { state: "ready", reason: "cap", waitedMs: STARTUP_WAIT_CAP_MS });
  assert.equal(gate.release("round_ended"), false, "already released");
  assert.equal(events.length, 2);
});

test("while the first catch-up is under way: status says syncing, a pass returns before it reads the job file, and run now sends nothing", async (t) => {
  const rig = dailyRig(t);
  await rig.worker.enqueue(punch({ id: "g1", agentId: "sw/a", projectId: "p1" }), "raw-g1");
  rig.worker.start({ deferInitialRun: true });
  await rig.worker.idle();
  rig.resetReads();
  for (let i = 0; i < 5; i += 1) { rig.worker.wake(); await rig.worker.idle(); }
  assert.equal(rig.reads(), 0, "the 19 MB file is not parsed on every pass while the gate is shut");
  const status = rig.worker.status();
  assert.equal(status.syncing, true);
  assert.equal(status.state, "idle", "not the disabled state of a worker that has not run yet");
  assert.equal(parseUiResponse("ui.status", wrap(status)), true);

  const answer = await rig.worker.agentOrganization({ action: "run", agentId: "sw/a" });
  assert.equal(answer.blocked, null);
  rig.worker.wake();
  await rig.worker.idle();
  assert.deepEqual(rig.h.calls, [], "nothing was sent while syncing");
  const served = await dispatchUi("ui.agentOrganization", { action: "status", agentId: "sw/a" }, { storageStatus: () => "ready", services: () => undefined, profile: NO_PROFILE, agentOrganization: rig.worker.agentOrganization, organizationStatus: () => rig.worker.status() });
  assert.equal(served.syncing, true);
  assert.equal(parseUiResponse("ui.agentOrganization", served), true);
  assert.equal(served.run.state, "running", "the run exists and is only waiting for the sync");
  assert.deepEqual(rig.events, [{ state: "waiting" }]);
});

test("a catch-up round that ends without a stop code releases the gate, and the agent run starts by itself", async (t) => {
  const rig = dailyRig(t);
  await rig.worker.enqueue(punch({ id: "r1", agentId: "sw/a", projectId: "p1" }), "raw-r1");
  rig.worker.start({ deferInitialRun: true });
  await rig.worker.agentOrganization({ action: "run", agentId: "sw/a" });
  rig.worker.resumeStartup("round_ended");
  await until(() => rig.h.calls.length === 1);
  assert.equal(rig.worker.status().syncing, undefined);
  assert.deepEqual(rig.events.map((event) => event.reason ?? event.state), ["waiting", "round_ended"]);
  rig.worker.resumeStartup("catchup_complete");
  assert.equal(rig.events.length, 2, "a second release is not a change");
});

test("the first-round cap: when no round ends, the wait is released after the cap and the agent run starts without anyone doing anything", async (t) => {
  const rig = dailyRig(t, { startupCapMs: 60_000, pollMs: 20 });
  await rig.worker.enqueue(punch({ id: "c1", agentId: "sw/a", projectId: "p1" }), "raw-c1");
  rig.worker.start({ deferInitialRun: true });
  await rig.worker.agentOrganization({ action: "run", agentId: "sw/a" });
  await pause(120);
  assert.deepEqual(rig.h.calls, [], "before the cap nothing starts, however often the poll wakes it");
  assert.equal(rig.worker.status().syncing, true);
  rig.h.state.now += 60_000;
  assert.equal(rig.worker.status().syncing, undefined, "a status read after the cap no longer says syncing");
  await until(() => rig.h.calls.length === 1);
  assert.deepEqual(rig.events.map((event) => event.reason ?? event.state), ["waiting", "cap"]);
  assert.equal(rig.events[1].waitedMs, 60_000);
  const status = await rig.worker.agentOrganization({ action: "status", agentId: "sw/a" });
  assert.equal(status.run.done, 1);
});

test("immediate frequency never waits for the catch-up, and a disabled organization does not claim to be syncing", async (t) => {
  const immediate = dailyRig(t);
  immediate.h.state.frequency = "immediate";
  await immediate.worker.enqueue(punch({ id: "i1", agentId: "sw/a", projectId: "p1" }), "raw-i1");
  immediate.worker.start({ deferInitialRun: true });
  await until(() => immediate.h.calls.length === 1);
  assert.equal(immediate.worker.status().syncing, undefined);
  const off = dailyRig(t);
  off.h.state.enabled = false;
  off.worker.start({ deferInitialRun: true });
  await off.worker.idle();
  assert.equal(off.worker.status().syncing, undefined);
  assert.equal(off.worker.status().state, "disabled");
});

test("the catch-up reports a start and an end for every round, and the end carries the stop code the gate looks at", async () => {
  const events = [];
  const records = [{ id: "p1", agentId: "sw/a", projectId: null, sessionId: "s", providerId: "mock", punchType: "main", startedAtMs: 1, endedAtMs: 2, model: "m", name: "n", description: JSON.stringify({ root: { type: "root", children: [] } }) }];
  const state = new Map();
  const worker = createPunchCatchupWorker({
    feed: {
      async openSettledSnapshot() { return { snapshotId: "s1", generation: "g", highWatermark: "p1" }; },
      async readSettledPage() { return { snapshot: { snapshotId: "s1", generation: "g", highWatermark: "p1" }, records, nextCursor: null }; },
      subscribeSettledChanges() { return () => {}; },
    },
    receipts: {
      async readPage() { return { records: [...state].map(([key, value]) => ({ key, value })), nextCursor: null }; },
      async writeBatch(rows) { for (const row of rows) state.set(row.key, row.value); },
    },
    writer: { async rememberMany(input) { return input.map(() => ({ ok: true, memoryId: "m", deduplicated: false })); } },
    now: () => Date.UTC(2026, 9, 2), minAgeMs: 0, batchPauseMs: 0, onProgress: (event) => events.push(event),
  });
  worker.start();
  await worker.idle();
  await worker.stop();
  assert.deepEqual(events.map((event) => event.event).slice(0, 2), ["punch_catchup_start", "punch_catchup"]);
  assert.equal(events[1].stoppedCode, null);
  assert.equal(events[1].complete, true);
});
