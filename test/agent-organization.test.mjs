import assert from "node:assert/strict";
import test from "node:test";
import { UI_METHOD_NAMES, parseUiParams, parseUiResponse } from "../out/contracts/uiContract.js";
import { dispatchUi } from "../out/backend/uiDispatch.js";
import { NO_PROFILE } from "../out/application/ui/profilePort.js";
import { failed, ok, punch, tick, workerRig } from "./organizationHarness.mjs";

const RUN = (agentId) => ({ action: "run", agentId });
const STATUS = (agentId) => ({ action: "status", agentId });
const gateOf = () => { let open; const gate = new Promise((resolve) => { open = resolve; }); return { gate, open }; };

async function enqueueAll(worker, specs) {
  for (const spec of specs) await worker.enqueue(punch(spec), "raw-" + spec.id);
}
async function settle(worker) { for (let i = 0; i < 6; i += 1) { await tick(); await worker.idle(); } }

async function makeLegacy(h, id) {
  const row = (await h.store.readPage(null, 100)).records.find((entry) => entry.key === id);
  await h.store.writeBatch([{ key: id, value: { ...row.value, resumeDisposition: "legacy_unlinked" }, expectedRevision: row.revision }]);
}

test("the contract: ten ui methods, the agentOrganization request shapes, and a response that carries the run", () => {
  assert.equal(UI_METHOD_NAMES.length, 10);
  assert.equal(UI_METHOD_NAMES.at(-1), "ui.agentOrganization");
  assert.equal(parseUiParams("ui.agentOrganization", RUN("sw/a")).ok, true);
  assert.equal(parseUiParams("ui.agentOrganization", { action: "stop" }).ok, true);
  assert.equal(parseUiParams("ui.agentOrganization", STATUS("sw/a")).ok, true);
  for (const bad of [{}, { action: "run" }, { action: "stop", agentId: "sw/a" }, { action: "get", agentId: "sw/a" }, { action: "run", agentId: "" }, { action: "run", agentId: "sw/a", extra: 1 }]) {
    assert.equal(parseUiParams("ui.agentOrganization", bad).ok, false, JSON.stringify(bad));
  }
  const answer = { ok: true, action: "status", agentId: "sw/a", pending: 3, blocked: null, run: { agentId: "sw/a", state: "running", total: 3, done: 1, failed: 0, untried: 2, startedAt: 1, endedAt: null, lastError: null } };
  assert.equal(parseUiResponse("ui.agentOrganization", answer), true);
  assert.equal(parseUiResponse("ui.agentOrganization", { ...answer, blocked: "elsewhere" }), false);
  assert.equal(parseUiResponse("ui.agentOrganization", { ...answer, extra: 1 }), false);
  assert.equal(parseUiResponse("ui.agentOrganization", { ok: false, code: "STORAGE_BUSY", retryable: true }), true);
});

test("dispatch: the method is served from the organization worker, and a missing or throwing worker is an expected failure, not a thrown error", async () => {
  const deps = (agentOrganization) => ({ storageStatus: () => "ready", services: () => undefined, profile: NO_PROFILE, ...(agentOrganization === undefined ? {} : { agentOrganization }) });
  const served = await dispatchUi("ui.agentOrganization", RUN("sw/a"), deps(async () => ({ action: "run", agentId: "sw/a", pending: 2, blocked: null, run: null })));
  assert.equal(served.ok, true);
  assert.equal(parseUiResponse("ui.agentOrganization", served), true);
  assert.deepEqual(await dispatchUi("ui.agentOrganization", RUN("sw/a"), deps()), { ok: false, code: "STORAGE_UNSUPPORTED", retryable: false });
  assert.equal((await dispatchUi("ui.agentOrganization", RUN("sw/a"), deps(async () => { throw new Error("EPERM"); }))).code, "STORAGE_BUSY");
  assert.equal((await dispatchUi("ui.agentOrganization", { action: "run" }, deps(async () => ({})))).code, "INVALID_PARAMS");
});

test("run puts the agent's pending jobs in front of the queue", async (t) => {
  const h = workerRig(t);
  const worker = h.create();
  await enqueueAll(worker, [{ id: "a1", agentId: "sw/a" }, { id: "b1", agentId: "sw/b" }, { id: "a2", agentId: "sw/a" }, { id: "b2", agentId: "sw/b" }, { id: "a3", agentId: "sw/a" }]);
  const answer = await worker.agentOrganization(RUN("sw/b"));
  assert.equal(answer.blocked, null);
  assert.equal(answer.pending, 2);
  assert.equal(answer.run.total, 2);
  worker.start();
  await settle(worker);
  assert.deepEqual(h.calls, ["b1", "b2", "a1", "a2", "a3"], "the agent's jobs go first, the rest follow in queue order");
});

test("run preempts a pass that is already under way, after the job in flight", async (t) => {
  const h = workerRig(t);
  const first = gateOf();
  const worker = h.create({ capture: async (job) => { h.calls.push(job.punchId); if (job.punchId === "a1") await first.gate; return ok(); } });
  await enqueueAll(worker, [{ id: "a1", agentId: "sw/a" }, { id: "a2", agentId: "sw/a" }, { id: "b1", agentId: "sw/b" }]);
  worker.start();
  for (let i = 0; i < 20; i += 1) await tick();
  assert.deepEqual(h.calls, ["a1"]);
  await worker.agentOrganization(RUN("sw/b"));
  first.open();
  await settle(worker);
  assert.deepEqual(h.calls, ["a1", "b1", "a2"], "the running job finishes, then the agent run, then the rest");
});

test("run skips the once-a-day limit and the retry delay, and changes nothing else", async (t) => {
  let outcome = failed("RESOURCE_BUSY");
  const h = workerRig(t, { capture: async (job) => { h.calls.push(job.punchId); return outcome; } });
  h.state.frequency = "daily";
  const worker = h.create();
  await enqueueAll(worker, [{ id: "a1", agentId: "sw/a" }]);
  worker.start();
  await settle(worker);
  assert.deepEqual(h.calls, ["a1"], "the daily pass tried it once and it failed");
  outcome = ok({ memories: [] });
  worker.wake();
  await settle(worker);
  assert.deepEqual(h.calls, ["a1"], "the same day the daily pass will not send again");
  assert.equal((await h.rows()).a1.attempts, 1);

  const answer = await worker.agentOrganization(RUN("sw/a"));
  assert.equal(answer.blocked, null);
  await settle(worker);
  assert.deepEqual(h.calls, ["a1", "a1"], "run sent it again on the same day");
  const row = (await h.rows()).a1;
  assert.equal(row.state, "completed", "the ordinary completion path ran");
  assert.equal(row.attempts, 2);
  assert.equal(row.lastAttemptDate, "2026-01-01");
  assert.equal(worker.status().state, "idle");
});

test("only one agent runs at a time, and the same agent cannot start twice", async (t) => {
  const h = workerRig(t);
  const hold = gateOf();
  const worker = h.create({ capture: async (job) => { h.calls.push(job.punchId); await hold.gate; return ok(); } });
  await enqueueAll(worker, [{ id: "a1", agentId: "sw/a" }, { id: "a2", agentId: "sw/a" }, { id: "b1", agentId: "sw/b" }]);
  assert.equal((await worker.agentOrganization(RUN("sw/a"))).blocked, null);
  assert.equal((await worker.agentOrganization(RUN("sw/b"))).blocked, "other_running");
  assert.equal((await worker.agentOrganization(RUN("sw/a"))).blocked, "running");
  assert.equal((await worker.agentOrganization(STATUS("sw/b"))).blocked, "other_running");
  assert.equal((await worker.agentOrganization(STATUS("sw/a"))).run.state, "running");
  worker.start();
  for (let i = 0; i < 20; i += 1) await tick();
  hold.open();
  await settle(worker);
  const done = await worker.agentOrganization(STATUS("sw/a"));
  assert.equal(done.run.state, "completed");
  assert.deepEqual([done.run.total, done.run.done, done.run.failed, done.run.untried], [2, 2, 0, 0]);
  assert.equal((await worker.agentOrganization(STATUS("sw/b"))).blocked, null, "after the first run ends another agent is no longer held back");
});

test("stop only raises a flag: the job in flight finishes and the rest stay in the queue", async (t) => {
  const h = workerRig(t);
  const hold = gateOf();
  const worker = h.create({ capture: async (job) => { h.calls.push(job.punchId); if (job.punchId === "a1") await hold.gate; return ok(); } });
  await enqueueAll(worker, [{ id: "a1", agentId: "sw/a" }, { id: "a2", agentId: "sw/a" }, { id: "a3", agentId: "sw/a" }]);
  await worker.agentOrganization(RUN("sw/a"));
  worker.start();
  for (let i = 0; i < 20; i += 1) await tick();
  assert.deepEqual(h.calls, ["a1"]);
  const stopping = await worker.agentOrganization({ action: "stop" });
  assert.equal(stopping.blocked, null);
  assert.equal(stopping.run.state, "stopping", "the answer comes back at once, before the job in flight ends");
  assert.deepEqual(h.calls, ["a1"]);
  hold.open();
  await settle(worker);
  assert.deepEqual(h.calls, ["a1"], "a2 and a3 were never sent");
  const run = (await worker.agentOrganization(STATUS("sw/a"))).run;
  assert.deepEqual([run.state, run.total, run.done, run.failed, run.untried], ["stopped", 3, 1, 0, 2]);
  assert.equal((await h.rows()).a2.state, "pending");
  assert.equal((await worker.agentOrganization({ action: "stop" })).blocked, "not_running");
});

test("legacy_unlinked jobs, other agents' jobs and finished jobs are never picked", async (t) => {
  const h = workerRig(t);
  const worker = h.create();
  await enqueueAll(worker, [{ id: "a-old", agentId: "sw/a" }, { id: "a-new", agentId: "sw/a" }, { id: "b1", agentId: "sw/b" }]);
  await makeLegacy(h, "a-old");
  const answer = await worker.agentOrganization(RUN("sw/a"));
  assert.equal(answer.pending, 1);
  assert.equal(answer.run.total, 1);
  worker.start();
  await settle(worker);
  assert.deepEqual(h.calls.filter((id) => id === "a-old"), [], "the legacy job was not sent");
  assert.ok(h.calls.includes("a-new"));
  const again = await worker.agentOrganization(RUN("sw/a"));
  assert.equal(again.blocked, "no_candidates", "nothing left for this agent");
  assert.equal((await h.rows())["a-old"].resumeDisposition, "legacy_unlinked");
});

test("failed jobs count as failed and can be sent again by the next run; nothing is written twice", async (t) => {
  let fail = true;
  const h = workerRig(t, { capture: async (job) => { h.calls.push(job.punchId); return fail && job.punchId === "a2" ? failed("MODEL_NOT_CONFIGURED") : ok(); } });
  const worker = h.create();
  await enqueueAll(worker, [{ id: "a1", agentId: "sw/a" }, { id: "a2", agentId: "sw/a" }]);
  await worker.agentOrganization(RUN("sw/a"));
  worker.start();
  await settle(worker);
  const first = (await worker.agentOrganization(STATUS("sw/a")));
  assert.deepEqual([first.run.state, first.run.total, first.run.done, first.run.failed, first.run.untried, first.run.lastError], ["completed", 2, 1, 1, 0, "MODEL_NOT_CONFIGURED"]);
  assert.equal(first.pending, 1);
  fail = false;
  await worker.agentOrganization(RUN("sw/a"));
  await settle(worker);
  assert.deepEqual(h.calls, ["a1", "a2", "a2"], "only the failed job is sent again; the finished one is not");
  const second = await worker.agentOrganization(STATUS("sw/a"));
  assert.deepEqual([second.run.total, second.run.done, second.run.failed], [1, 1, 0]);
});

test("a run is not saved: a new worker over the same store has no run, and its status reads the saved jobs", async (t) => {
  const h = workerRig(t);
  const worker = h.create();
  await enqueueAll(worker, [{ id: "a1", agentId: "sw/a" }, { id: "a2", agentId: "sw/a" }]);
  await worker.agentOrganization(RUN("sw/a"));
  await worker.stop();
  const restarted = h.create();
  const status = await restarted.agentOrganization(STATUS("sw/a"));
  assert.equal(status.run, null);
  assert.equal(status.pending, 2);
  restarted.start();
  await settle(restarted);
  assert.deepEqual(h.calls, ["a1", "a2"], "the ordinary queue handles them; the run did not resume by itself");
});

test("when AI organization is off the run is refused", async (t) => {
  const h = workerRig(t);
  h.state.enabled = false;
  const worker = h.create();
  await enqueueAll(worker, [{ id: "a1", agentId: "sw/a" }]);
  assert.equal((await worker.agentOrganization(RUN("sw/a"))).blocked, "disabled");
  assert.equal((await worker.agentOrganization(STATUS("sw/a"))).blocked, "disabled");
  assert.equal((await worker.agentOrganization(RUN("sw/zzz"))).blocked, "disabled");
});

test("a run with a pair_blocked job leaves it pending and counts it as untried", async (t) => {
  const h = workerRig(t, { capture: async (job) => { h.calls.push(job.punchId); return job.punchId === "a1" ? failed("RESOURCE_BUSY", "pair_blocked") : ok(); } });
  const worker = h.create();
  await enqueueAll(worker, [{ id: "a1", agentId: "sw/a" }, { id: "a2", agentId: "sw/a", projectId: "p2" }]);
  await worker.agentOrganization(RUN("sw/a"));
  worker.start();
  await settle(worker);
  const run = (await worker.agentOrganization(STATUS("sw/a"))).run;
  assert.deepEqual([run.state, run.total, run.done, run.failed, run.untried], ["completed", 2, 1, 0, 1]);
  assert.equal((await h.rows()).a1.attempts, 0);
  assert.deepEqual(h.calls, ["a1", "a2"]);
});

test("a member that is forgotten before it is reached does not hold the run open or loop the queue", async (t) => {
  const h = workerRig(t);
  const worker = h.create();
  await enqueueAll(worker, [{ id: "a1", agentId: "sw/a" }, { id: "b1", agentId: "sw/b" }]);
  await worker.agentOrganization(RUN("sw/a"));
  await worker.forgetSource("sw/a", "raw-a1");
  worker.start();
  await settle(worker);
  assert.deepEqual(h.calls, ["b1"], "the forgotten member was not sent and the rest ran once");
  const run = (await worker.agentOrganization(STATUS("sw/a"))).run;
  assert.deepEqual([run.state, run.total, run.done, run.failed, run.untried], ["completed", 1, 0, 0, 1]);
  assert.equal((await worker.agentOrganization(RUN("sw/b"))).blocked, "no_candidates", "another agent is no longer held back (b1 already ran)");
});

test("dispatch: the agent page answer carries the stall facts from the organization status, and omits them when there are none", async () => {
  const answer = async () => ({ action: "status", agentId: "sw/a", pending: 2, blocked: null, run: null });
  const deps = (status) => ({ storageStatus: () => "ready", services: () => undefined, profile: NO_PROFILE, agentOrganization: answer, organizationStatus: () => status });
  const stalled = await dispatchUi("ui.agentOrganization", STATUS("sw/a"), deps({ waiting: null, pauseReason: "stall", stall: { count: 3, limit: 3 } }));
  assert.equal(parseUiResponse("ui.agentOrganization", stalled), true);
  assert.deepEqual([stalled.pauseReason, stalled.stall], ["stall", { count: 3, limit: 3 }]);
  const calm = await dispatchUi("ui.agentOrganization", STATUS("sw/a"), deps({ waiting: null }));
  assert.equal("pauseReason" in calm, false);
  assert.equal(calm.waiting, null);
});
