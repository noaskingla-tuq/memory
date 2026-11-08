import assert from "node:assert/strict";
import test from "node:test";
import { parseUiResponse } from "../out/contracts/uiContract.js";
import { MAX_CONTINUATIONS, captureWithContinuation } from "../out/application/organizationQueue.js";
import { addReply, failed, ok, punch, timeout, workerRig } from "./organizationHarness.mjs";

function script(results, { progressAfter = () => true, stop = () => false } = {}) {
  const log = { captures: 0, waits: 0, progress: 0 };
  const run = () => captureWithContinuation({
    capture: async () => results[Math.min(log.captures++, results.length - 1)],
    readProgress: async () => log.progress,
    awaitPending: async () => { log.waits += 1; if (progressAfter(log.waits)) log.progress += 1; },
    shouldStop: stop,
  });
  return { log, run };
}

test("the same job continues while every round saved something new, and at most six times", async () => {
  const s = script([timeout()]);
  const { result, continuations } = await s.run();
  assert.equal(MAX_CONTINUATIONS, 6);
  assert.equal(continuations, 6);
  assert.equal(s.log.captures, 7, "one first call and six continuations");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "MODEL_TIMEOUT");
});

test("a continuation needs progress: a round that saved no new reply ends the job at once", async () => {
  const none = script([timeout()], { progressAfter: () => false });
  await none.run();
  assert.equal(none.log.captures, 1);
  assert.equal(none.log.waits, 1);

  const twice = script([timeout()], { progressAfter: (wait) => wait <= 2 });
  await twice.run();
  assert.equal(twice.log.captures, 3, "two rounds of progress give two continuations, the third round has none");
});

test("a continuation that succeeds ends the loop with the success", async () => {
  const s = script([timeout(), timeout(), ok({ memories: [] })]);
  const { result, continuations } = await s.run();
  assert.equal(result.ok, true);
  assert.equal(continuations, 2);
  assert.equal(s.log.captures, 3);
});

test("only a timeout failure continues: other failures, successes and a failed classification end at the first call", async () => {
  for (const result of [failed("RESOURCE_BUSY"), failed("STORAGE_BUSY"), failed("MODEL_NOT_CONFIGURED"), ok({ classification: { status: "failed", error: { code: "model_timeout" } } })]) {
    const s = script([result]);
    await s.run();
    assert.equal(s.log.captures, 1, JSON.stringify(result).slice(0, 60));
    assert.equal(s.log.waits, 0);
  }
});

test("a stop request ends the continuation without waiting for the running turn", async () => {
  const s = script([timeout()], { stop: () => true });
  await s.run();
  assert.equal(s.log.captures, 1);
  assert.equal(s.log.waits, 0);
});

test("the worker counts the whole continuation as one attempt on one day", async (t) => {
  const h = workerRig(t);
  let round = 0;
  const waits = [];
  const patched = h.create({
    awaitPending: async (job) => { waits.push(job.actor.agentId); },
    capture: async (job) => {
      h.calls.push(job.punchId);
      round += 1;
      if (round <= 2) { await addReply(h.store, job, round); return timeout(); }
      return ok({ memories: [] });
    },
  });
  await patched.enqueue(punch({ id: "slow" }), "raw");
  patched.start();
  await patched.idle();
  assert.deepEqual(h.calls, ["slow", "slow", "slow"], "the job is called again until it ends");
  assert.equal(waits.length, 2, "each continuation first waits for the running turn");
  const row = (await h.rows()).slow;
  assert.equal(row.state, "completed");
  assert.equal(row.attempts, 1, "one attempt however many continuations");
  assert.equal(row.lastAttemptDate, "2026-01-01");
});

test("a job whose continuation stalls stays pending after one attempt and is not called again that day", async (t) => {
  const h = workerRig(t, { capture: async (job) => { h.calls.push(job.punchId); return timeout(); } });
  h.state.frequency = "daily";
  const worker = h.create();
  await worker.enqueue(punch({ id: "stalled" }), "raw");
  worker.start();
  await worker.idle();
  assert.equal(h.calls.length, 1);
  worker.wake();
  await worker.idle();
  assert.equal(h.calls.length, 1, "the day's one attempt is used");
  const row = (await h.rows()).stalled;
  assert.equal(row.state, "pending");
  assert.equal(row.attempts, 1);
  assert.equal(row.lastError, "MODEL_TIMEOUT");
});

test("a pair_blocked result leaves the job untouched: no attempt, no day used, and the next job still runs", async (t) => {
  let blocked = true;
  const h = workerRig(t, {
    capture: async (job) => {
      h.calls.push(job.punchId);
      return job.punchId === "first" && blocked ? failed("RESOURCE_BUSY", "pair_blocked") : ok();
    },
  });
  h.state.frequency = "daily";
  const worker = h.create();
  await worker.enqueue(punch({ id: "first" }), "raw-1");
  await worker.enqueue(punch({ id: "second", projectId: "other" }), "raw-2");
  worker.start();
  await worker.idle();
  assert.deepEqual(h.calls, ["first", "second"]);
  const afterFirstPass = await h.rows();
  assert.equal(afterFirstPass.first.attempts, 0);
  assert.equal(afterFirstPass.first.lastError, null);
  assert.ok(afterFirstPass.first.lastAttemptDate === null || afterFirstPass.first.lastAttemptDate === undefined, "no day was used");
  assert.equal(afterFirstPass.second.state, "completed");

  blocked = false;
  worker.wake();
  await worker.idle();
  assert.deepEqual(h.calls, ["first", "second", "first"], "the same day it is tried again");
  assert.equal((await h.rows()).first.state, "completed");
});

test("the optional waiting field: present with sinceMs while a turn outlives its caller, absent otherwise, and a status without it stays valid", async (t) => {
  const h = workerRig(t);
  let waiting = null;
  const worker = h.create({ waiting: () => waiting });
  const wrap = (organization) => ({ ok: true, version: "1.4.6", cairnCommit: "a".repeat(40), storage: { status: "ready" }, profile: { generation: null, receivedAt: null, agents: 0, projects: 0, sink: null }, lastWriteAt: null, uptimeSec: 1, organization });
  assert.equal("waiting" in worker.status(), false);
  assert.equal(parseUiResponse("ui.status", wrap(worker.status())), true, "no waiting field is still valid");
  waiting = { sinceMs: 4321 };
  assert.deepEqual(worker.status().waiting, { sinceMs: 4321 });
  assert.equal(parseUiResponse("ui.status", wrap(worker.status())), true);
  assert.equal(parseUiResponse("ui.status", wrap({ ...worker.status(), waiting: { sinceMs: -1 } })), false);
  assert.equal(parseUiResponse("ui.status", wrap({ ...worker.status(), waiting: { sinceMs: 1, extra: 2 } })), false);
});
