import assert from "node:assert/strict";
import test from "node:test";
import { START, STOP, fail, legacyJob, ok, rowOf, rowsOf, seed, workerRig } from "./trialHarness.mjs";

const ids = (count, prefix = "j") => Array.from({ length: count }, (_, index) => prefix + String(index + 1));
const seedLegacy = (h, count) => seed(h.store, ids(count).map((id) => legacyJob(id)));
const begin = async (worker, request) => { const answer = await worker.legacyTrial(request); await worker.idle(); return answer; };
const legacyLeft = async (h) => (await rowsOf(h.store)).filter((row) => row.value.resumeDisposition === "legacy_unlinked").length;

test("W1: in daily mode before the due time a trial job is sent at once and the other legacy jobs are not; a completed round does not block it", async (t) => {
  const h = workerRig(t);
  await seedLegacy(h, 5);
  const worker = h.create(); worker.start(); await worker.idle();
  assert.equal(h.calls.length, 0);
  const answer = await begin(worker, START(2));
  assert.equal(answer.blocked, null);
  assert.equal(h.calls.length, 2);
  assert.equal(await legacyLeft(h), 3);

  h.at(1, 3); worker.wake(); await worker.idle();
  assert.equal(h.calls.length, 2, "the round of that day has nothing left to do and sends nothing more");
  assert.equal((await worker.status()).trial.state, "completed");
  const second = await begin(worker, START(1, "req-second-aaaaaa"));
  assert.equal(second.adopted, 1);
  assert.equal(h.calls.length, 3, "the daily round is already completed, and the trial job is still sent");
  assert.equal(h.calls.at(-1).allowModelSend, true, "a completed round would otherwise make this a reply-only call");
  assert.equal(await legacyLeft(h), 2);
});

test("W2: each trial job is sent once, and the same day's daily round does not send it again", async (t) => {
  const h = workerRig(t, { capture: async () => fail("MODEL_TIMEOUT", { phase: "turn_timeout" }) });
  await seedLegacy(h, 4);
  const worker = h.create(); worker.start(); await worker.idle();
  await begin(worker, START(2));
  const sent = [];
  for (const [day, hour] of [[1, 2], [1, 5], [1, 23]]) { h.at(day, hour); worker.wake(); await worker.idle(); worker.settingsChanged(); await worker.idle(); }
  for (const row of await rowsOf(h.store)) if (row.value.adoptedBatchId !== undefined) sent.push(row.value.attempts);
  assert.deepEqual(sent, [1, 1]);
  assert.equal((await worker.status()).trial.failed, 2);
});

test("W3: three failures in a row halt the trial and the rest go back to legacy_unlinked", async (t) => {
  const h = workerRig(t, { capture: async () => fail("MODEL_TIMEOUT", { phase: "turn_timeout" }) });
  await seedLegacy(h, 6);
  const worker = h.create(); worker.start(); await worker.idle();
  await begin(worker, START(5));
  assert.equal(h.calls.length, 3);
  const trial = (await worker.status()).trial;
  assert.equal(trial.state, "halted");
  assert.equal(trial.haltReason.consecutive, 3);
  assert.equal(trial.haltReason.code, "MODEL_TIMEOUT");
  assert.equal(trial.untried, 0);
  assert.equal(trial.failed, 3);
  assert.equal(await legacyLeft(h), 3, "two reverted jobs plus the one never offered");
  h.at(1, 3); worker.wake(); await worker.idle();
  assert.equal(h.calls.length, 3, "a halted trial does not come back by itself");
});

test("W4: a model that is not configured halts the trial on the first job", async (t) => {
  const h = workerRig(t, { capture: async () => fail("MODEL_NOT_CONFIGURED", { retryable: false }) });
  await seedLegacy(h, 4);
  const worker = h.create(); worker.start(); await worker.idle();
  await begin(worker, START(4));
  assert.equal(h.calls.length, 1);
  const trial = (await worker.status()).trial;
  assert.equal(trial.state, "halted");
  assert.equal(trial.haltReason.code, "MODEL_NOT_CONFIGURED");
  assert.equal(await legacyLeft(h), 3);
});

test("W4b: a quota or policy phase halts at once even when the code is an ordinary busy code", async (t) => {
  const h = workerRig(t, { capture: async () => fail("RESOURCE_BUSY", { phase: "quota" }) });
  await seedLegacy(h, 3);
  const worker = h.create(); worker.start(); await worker.idle();
  await begin(worker, START(3));
  assert.equal(h.calls.length, 1);
  assert.equal((await worker.status()).trial.haltReason.phase, "quota");
});

test("W5: failures and successes in turn never reach three in a row, so the trial runs to the end", async (t) => {
  let count = 0;
  const h = workerRig(t, { capture: async () => (++count % 2 === 1 ? fail("MODEL_TIMEOUT", { phase: "turn_timeout" }) : ok()) });
  await seedLegacy(h, 6);
  const worker = h.create(); worker.start(); await worker.idle();
  await begin(worker, START(6));
  assert.equal(h.calls.length, 6);
  const trial = (await worker.status()).trial;
  assert.equal(trial.state, "completed");
  assert.equal(trial.failed, 3);
  assert.equal(trial.committed, 3);
});

test("W6: stopping during a job lets that job finish, sends no other, reverts the rest and raises no revision conflict", async (t) => {
  let release;
  let entered;
  const inside = new Promise((resolve) => { entered = resolve; });
  const h = workerRig(t, { capture: async () => { entered(); await new Promise((resolve) => { release = resolve; }); return ok(); } });
  await seedLegacy(h, 4);
  const worker = h.create(); worker.start(); await worker.idle();
  await worker.legacyTrial(START(4));
  await inside;
  const stopping = await worker.legacyTrial(STOP);
  assert.equal(stopping.blocked, null);
  assert.equal(stopping.trial.state, "running", "the stop waits for the job in progress");
  release();
  await worker.idle();
  assert.equal(h.calls.length, 1);
  const status = await worker.status();
  assert.equal(status.trial.state, "stopped");
  assert.equal(status.trial.committed, 1);
  assert.equal(status.lastError, null, "no state_revision_conflict was turned into STORAGE_BUSY");
  assert.equal(await legacyLeft(h), 3);
  assert.equal((await rowOf(h.store, "j1")).value.state, "completed");
});

test("W6b: stopping an idle trial reverts at once, and stopping with nothing running says so", async (t) => {
  const h = workerRig(t);
  await seedLegacy(h, 3);
  h.setEnabled(false);
  const worker = h.create(); worker.start(); await worker.idle();
  assert.equal((await worker.legacyTrial(STOP)).blocked, "not_running");
  await h.store.adoptLegacyJobs({ requestId: "req-direct-aaaaaa", count: 3, batchId: "trial-direct", at: 1 });
  const stopped = await worker.legacyTrial(STOP);
  assert.equal(stopped.blocked, null);
  assert.equal(stopped.trial.state, "stopped");
  assert.equal(stopped.trial.untried, 0);
  assert.equal(await legacyLeft(h), 3);
  assert.equal(h.calls.length, 0);
});

test("W7: after a restart the trial continues with the jobs not yet sent, and the total number of calls is N", async (t) => {
  const h = workerRig(t);
  await seedLegacy(h, 4);
  const first = h.create({ capture: async () => { if (h.calls.length === 2) h.setEnabled(false); return ok(); } });
  first.start(); await first.idle();
  await begin(first, START(4));
  assert.equal(h.calls.length, 2);
  assert.equal((await first.status()).trial.state, "running");
  await first.stop();

  h.setEnabled(true);
  const second = h.create(); second.start(); await second.idle();
  assert.equal(h.calls.length, 4);
  assert.deepEqual(h.calls.map((call) => call.memoryId).sort(), ["raw-j1", "raw-j2", "raw-j3", "raw-j4"]);
  assert.equal((await second.status()).trial.state, "completed");
});

test("W8: with AI organization off, a start answers disabled and changes nothing", async (t) => {
  const h = workerRig(t);
  await seedLegacy(h, 2);
  h.setEnabled(false);
  const worker = h.create(); worker.start(); await worker.idle();
  const answer = await worker.legacyTrial(START(2));
  assert.equal(answer.blocked, "disabled");
  assert.equal(answer.adopted, 0);
  assert.equal(await legacyLeft(h), 2);
  assert.equal(await h.store.readTrial(), null);
});

test("W9: the trial counts, the failure groups, legacyUnlinked and legacyTrialCandidates all follow the job rows", async (t) => {
  const outcomes = {
    "raw-j1": () => ok(), "raw-j2": () => ok({ emptySuccess: true }), "raw-j3": () => fail("MODEL_TIMEOUT", { phase: "turn_timeout", localCode: undefined }),
    "raw-j4": () => ok(), "raw-j5": () => fail("RESOURCE_BUSY", { phase: "session_resume" }), "raw-j6": () => fail("MEMORY_SUPPRESSED", { retryable: false }),
  };
  const h = workerRig(t, { capture: async (job) => outcomes[job.memoryId]() });
  await seedLegacy(h, 8);
  const worker = h.create(); worker.start(); await worker.idle();
  assert.equal((await worker.status()).legacyTrialCandidates, 8);
  await begin(worker, START(6));
  const status = await worker.status();
  assert.equal(status.legacyUnlinked, 2);
  assert.equal(status.legacyTrialCandidates, 2);
  const { trial } = status;
  assert.deepEqual({ ...trial, batchId: undefined, startedAt: undefined, endedAt: undefined, failures: undefined }, {
    batchId: undefined, state: "completed", requested: 6, adopted: 6, attempted: 6, committed: 2, emptySuccess: 1, skipped: 1, failed: 2, untried: 0,
    startedAt: undefined, endedAt: undefined, haltReason: null, failures: undefined,
  });
  assert.equal(trial.committed + trial.emptySuccess + trial.skipped + trial.failed, trial.attempted);
  assert.deepEqual(trial.failures.map((group) => [group.code, group.phase, group.count]).sort(), [["MODEL_TIMEOUT", "turn_timeout", 1], ["RESOURCE_BUSY", "session_resume", 1]]);
});

test("W10: a trial job that failed is sent once by the next day's daily round and not twice", async (t) => {
  let first = true;
  const h = workerRig(t, { capture: async () => { const wasFirst = first; first = false; return wasFirst ? fail("MODEL_TIMEOUT", { phase: "turn_timeout" }) : ok(); } });
  await seedLegacy(h, 1);
  const worker = h.create(); worker.start(); await worker.idle();
  await begin(worker, START(1));
  assert.equal(h.calls.length, 1);
  h.at(2, 3); worker.wake(); await worker.idle();
  assert.equal(h.calls.length, 2);
  worker.wake(); await worker.idle(); worker.settingsChanged(); await worker.idle();
  assert.equal(h.calls.length, 2);
  assert.equal((await rowOf(h.store, "j1")).value.state, "completed");
});

test("W11: in immediate mode each trial job is also sent once and a failed one waits for its backoff", async (t) => {
  const h = workerRig(t, { capture: async () => fail("MODEL_TIMEOUT", { phase: "turn_timeout" }) });
  h.setFrequency("immediate");
  await seedLegacy(h, 4);
  const worker = h.create(); worker.start(); await worker.idle();
  await begin(worker, START(2));
  assert.equal(h.calls.length, 2);
  worker.wake(); await worker.idle();
  assert.equal(h.calls.length, 2, "the failed jobs wait for nextAttemptAt");
  assert.equal(await legacyLeft(h), 2);
});

test("W12: the per-pair release fault map shows on a clean trial status and gives way to a trial job's own error", async (t) => {
  let failing = false;
  const h = workerRig(t, { capture: async () => (failing ? fail("MODEL_TIMEOUT", { phase: "turn_timeout" }) : ok()) });
  await seedLegacy(h, 4);
  const worker = h.create(); worker.start(); await worker.idle();
  worker.noteReleaseFault("pair-a", { code: "RESOURCE_BUSY", phase: "session_close", localCode: "close_timeout", retryable: true, at: 5 });
  worker.noteReleaseFault("pair-b", null);
  await begin(worker, START(1));
  let status = await worker.status();
  assert.equal(status.errorPhase, "session_close", "pair b's clean release did not erase pair a's record");
  assert.equal(status.trial.committed, 1);
  failing = true;
  await begin(worker, START(1, "req-failing-aaaaaa"));
  status = await worker.status();
  assert.equal(status.lastError, "MODEL_TIMEOUT", "the job's own error is more specific than the release fault");
  assert.equal(status.errorPhase, "turn_timeout");
});

test("W14: a real error during the trial is shown as an error and is not covered by the paused state that legacy jobs cause", async (t) => {
  const h = workerRig(t, { capture: async () => fail("MODEL_TIMEOUT", { phase: "turn_timeout" }) });
  await seedLegacy(h, 5);
  const worker = h.create(); worker.start(); await worker.idle();
  assert.equal((await worker.status()).state, "idle", "only legacy jobs: nothing is stopped, so not paused");
  await begin(worker, START(1));
  const status = await worker.status();
  assert.equal(status.legacyUnlinked, 4);
  assert.equal(status.state, "error");
  assert.equal(status.lastError, "MODEL_TIMEOUT");
  assert.equal(status.errorPhase, "turn_timeout");
});

test("W15: the trial counts in the status line rise with each finished job, not when the whole batch ends", async (t) => {
  const seen = [];
  let worker;
  const h = workerRig(t, { capture: async () => { seen.push(worker.status().trial.attempted); return ok(); } });
  await seedLegacy(h, 4);
  worker = h.create(); worker.start(); await worker.idle();
  await begin(worker, START(4));
  assert.deepEqual(seen, [0, 1, 2, 3], "each capture sees the jobs finished before it");
  const done = (await worker.status()).trial;
  assert.equal(done.attempted, 4);
  assert.equal(done.committed, 4);
});

test("W16: a failed trial job shows in the running counts before the next job is sent", async (t) => {
  const seen = [];
  let worker;
  let n = 0;
  const h = workerRig(t, { capture: async () => { const mid = worker.status().trial; seen.push([mid.attempted, mid.failed]); n += 1; return n === 1 ? fail("MODEL_TIMEOUT", { phase: "turn_timeout" }) : ok(); } });
  await seedLegacy(h, 3);
  worker = h.create(); worker.start(); await worker.idle();
  await begin(worker, START(3));
  assert.deepEqual(seen, [[0, 0], [1, 1], [2, 1]]);
});

const seedStuckLegacy = (h, stuck, fresh) => seed(h.store, [
  ...ids(stuck, "t").map((id) => legacyJob(id, { attempts: 3, lastError: "MODEL_TIMEOUT" })),
  ...ids(fresh, "f").map((id) => legacyJob(id)),
]);

for (const mode of ["before-due", "due", "immediate"]) {
  test(`W17 (${mode}): legacy jobs that already failed do not make the organization state an error or fill lastError`, async (t) => {
    const h = workerRig(t);
    if (mode === "due") h.at(5, 10);
    if (mode === "immediate") h.setFrequency("immediate");
    await seedStuckLegacy(h, 3, 4);
    const worker = h.create(); worker.start(); await worker.idle();
    let status = await worker.status();
    assert.equal(status.state, "idle", "only legacy jobs: idle, never paused and never error");
    assert.equal(status.lastError, null);
    assert.equal(status.errorPhase, null);
    assert.equal(status.legacyUnlinked, 7);
    assert.equal(status.legacyTrialCandidates, 4);
    await begin(worker, START(2));
    status = await worker.status();
    assert.equal(status.trial.committed, 2);
    assert.equal(status.state, "idle", "a clean trial leaves the legacy jobs waiting, not paused");
    assert.equal(status.lastError, null);
  });
}

test("W18: a release fault still shows when the only failed jobs are legacy ones", async (t) => {
  const h = workerRig(t);
  await seedStuckLegacy(h, 3, 2);
  const worker = h.create(); worker.start(); await worker.idle();
  worker.noteReleaseFault("pair-a", { code: "RESOURCE_BUSY", phase: "session_close", localCode: "close_timeout", retryable: true, at: 7 });
  const status = await worker.status();
  assert.equal(status.lastError, "RESOURCE_BUSY");
  assert.equal(status.errorPhase, "session_close");
  assert.equal(status.localErrorCode, "close_timeout");
});

test("W19: a real trial error is still an error, and it is the trial job's code and not a legacy job's", async (t) => {
  const h = workerRig(t, { capture: async () => fail("MODEL_TIMEOUT", { phase: "turn_timeout" }) });
  await seed(h.store, [
    ...ids(2, "t").map((id) => legacyJob(id, { attempts: 2, lastError: "INTERNAL" })),
    ...ids(4, "f").map((id) => legacyJob(id)),
  ]);
  const worker = h.create(); worker.start(); await worker.idle();
  assert.equal((await worker.status()).state, "idle");
  await begin(worker, START(1));
  const status = await worker.status();
  assert.equal(status.state, "error");
  assert.equal(status.lastError, "MODEL_TIMEOUT");
  assert.equal(status.errorPhase, "turn_timeout");
});
