import assert from "node:assert/strict";
import test from "node:test";
import { parseUiResponse } from "../out/contracts/uiContract.js";
import { AWAIT_CAP_MS, STALL_LIMIT, STALL_LOCAL_CODE, awaitUnlessStopped, createStallGuard, stallOutcome } from "../out/application/organizationStall.js";
import { failed, ok, punch, tick, timeout, workerRig } from "./organizationHarness.mjs";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (condition, ms = 5_000) => { const end = Date.now() + ms; while (Date.now() < end && !condition()) await pause(10); assert.ok(condition(), "condition not reached"); };
const enqueueAll = async (worker, ids) => { for (const id of ids) await worker.enqueue(punch({ id, agentId: "sw/a", projectId: "p-" + id }), "raw-" + id); };

test("the guard pauses at the third consecutive stuck outcome, and any other outcome clears the count", () => {
  assert.equal(STALL_LIMIT, 3);
  const guard = createStallGuard();
  guard.observe("stuck"); guard.observe("stuck");
  assert.equal(guard.paused(), false);
  guard.observe("settled");
  assert.equal(guard.count(), 0);
  guard.observe("stuck"); guard.observe("stuck"); guard.observe("other");
  assert.equal(guard.count(), 0, "a failure that is not a stall breaks the streak");
  for (let i = 0; i < 3; i += 1) guard.observe("stuck");
  assert.equal(guard.paused(), true);
  guard.reset();
  assert.equal(guard.paused(), false);
});

test("a stall is a detached turn that gave no reply or the backstop; nothing else is", () => {
  assert.equal(stallOutcome(timeout("detached_running")), "stuck");
  assert.equal(stallOutcome(timeout("turn_backstop")), "stuck");
  assert.equal(stallOutcome(failed("MODEL_TIMEOUT")), "other");
  assert.equal(stallOutcome(failed("RESOURCE_BUSY", "pair_blocked")), "other");
  assert.equal(stallOutcome(ok()), "settled");
});

test("awaitUnlessStopped returns when the stop test turns true, at the cap, and when the wait ends; a real error still surfaces", async () => {
  let aborted = 0;
  const never = (signal) => new Promise((_, reject) => signal.addEventListener("abort", () => { aborted += 1; reject(new Error("cancelled")); }, { once: true }));
  let stop = false;
  const stopping = awaitUnlessStopped(never, () => stop, 60_000, 10);
  setTimeout(() => { stop = true; }, 40);
  await stopping;
  assert.equal(aborted, 1);
  const started = Date.now();
  await awaitUnlessStopped(never, () => false, 60, 10);
  assert.ok(Date.now() - started < 1_000, "the cap ended the wait");
  assert.equal(aborted, 2);
  await awaitUnlessStopped(async () => undefined, () => false, 60_000, 10);
  await assert.rejects(awaitUnlessStopped(async () => { throw new Error("storage"); }, () => false, 60_000, 10), { message: "storage" });
  assert.ok(AWAIT_CAP_MS > 330_000);
});

test("stop on the agent run ends the wait for a detached turn at once: no second send, and the run reports stopped", async (t) => {
  const h = workerRig(t, { capture: async (job) => { h.calls.push(job.punchId); return timeout(); } });
  let waits = 0;
  const worker = h.create({
    awaitPending: (_job, signal) => new Promise((_, reject) => { waits += 1; signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }); }),
  });
  await enqueueAll(worker, ["a1", "a2"]);
  await worker.agentOrganization({ action: "run", agentId: "sw/a" });
  worker.start();
  await until(() => waits === 1);
  assert.equal((await worker.agentOrganization({ action: "stop" })).blocked, null);
  await worker.idle();
  const status = await worker.agentOrganization({ action: "status", agentId: "sw/a" });
  assert.equal(status.run.state, "stopped");
  assert.deepEqual(h.calls, ["a1"], "the second job was not started and the first was not sent again");
  assert.equal(waits, 1);
});

test("turning the organization off ends the wait too, and the worker stops without hanging", async (t) => {
  const h = workerRig(t, { capture: async (job) => { h.calls.push(job.punchId); return timeout(); } });
  let waits = 0;
  const worker = h.create({ awaitPending: (_job, signal) => new Promise((_, reject) => { waits += 1; signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }); }) });
  await enqueueAll(worker, ["a1"]);
  worker.start();
  await until(() => waits === 1);
  h.state.enabled = false;
  worker.settingsChanged();
  await worker.idle();
  assert.equal(worker.status().state, "disabled");
  assert.deepEqual(h.calls, ["a1"]);
});

test("three stuck jobs in a row pause the organization with an existing code, later jobs are not sent, and re-enabling clears the pause", async (t) => {
  let answer = timeout();
  const h = workerRig(t, { capture: async (job) => { h.calls.push(job.punchId); return answer; } });
  const worker = h.create();
  await enqueueAll(worker, ["j1", "j2", "j3", "j4"]);
  worker.start();
  await worker.idle();
  assert.deepEqual(h.calls, ["j1", "j2", "j3"], "the fourth job was never sent");
  const paused = worker.status();
  assert.equal(paused.state, "paused");
  assert.equal(paused.lastError, "RESOURCE_BUSY", "an existing failure code, none added");
  assert.equal(paused.hostErrorCode, "turn_backstop");
  assert.equal(paused.localErrorCode, STALL_LOCAL_CODE);
  assert.equal(paused.retryable, true);
  const wrap = (organization) => ({ ok: true, version: "1.4.7", cairnCommit: "a".repeat(40), storage: { status: "ready" }, profile: { generation: null, receivedAt: null, agents: 0, projects: 0, sink: null }, lastWriteAt: null, uptimeSec: 1, organization });
  assert.equal(parseUiResponse("ui.status", wrap(paused)), true);

  const blocked = await worker.agentOrganization({ action: "run", agentId: "sw/a" });
  assert.equal(blocked.blocked, null);
  await worker.idle();
  assert.deepEqual(h.calls, ["j1", "j2", "j3"], "an immediate run does not get past the pause either");
  assert.equal((await worker.agentOrganization({ action: "status", agentId: "sw/a" })).run.state, "completed");

  answer = ok();
  h.state.enabled = false;
  worker.settingsChanged();
  await worker.idle();
  assert.equal(worker.status().state, "disabled");
  h.state.enabled = true;
  worker.settingsChanged();
  await worker.idle();
  assert.equal(h.calls.includes("j4"), true, "after the organization was turned off and on, jobs are sent again");
  assert.notEqual(worker.status().state, "paused");
});

test("a settled job clears the count, so stalls that are not consecutive never pause", async (t) => {
  const results = [timeout(), timeout(), ok(), timeout(), timeout(), ok()];
  let index = 0;
  const h = workerRig(t, { capture: async (job) => { h.calls.push(job.punchId); return results[index++]; } });
  const worker = h.create();
  await enqueueAll(worker, ["k1", "k2", "k3", "k4", "k5", "k6"]);
  worker.start();
  await worker.idle();
  assert.equal(h.calls.length, 6, "every job was tried");
  assert.notEqual(worker.status().state, "paused");
  assert.notEqual(worker.status().localErrorCode, STALL_LOCAL_CODE);
  await tick();
});

test("the queue's wait cap is above the model port's backstop", async () => {
  const { TURN_BACKSTOP_MS } = await import("../out/adapters/model/turnLimits.js");
  assert.ok(AWAIT_CAP_MS > TURN_BACKSTOP_MS);
});
