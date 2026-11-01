import assert from "node:assert/strict";
import fs, { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { FILE, addJournal, legacyJob, readFile, rowOf, rowsOf, seed, storeRig } from "./trialHarness.mjs";

const request = (count, requestId = "req-" + count + "-aaaaaa", batchId = "trial-batch-" + count) => ({ requestId, count, batchId, at: 1_700_000_000_000 });

test("S1: adoption takes only attempts-0 pending legacy jobs, numbers them after the file's sequence and leaves every other row byte for byte", async (t) => {
  const { dir, store } = storeRig(t);
  await seed(store, [legacyJob("l1"), legacyJob("l2"), legacyJob("l3")]);
  await store.enqueueJob("normal", legacyJob("normal"), "work-record", "normal");
  await seed(store, [legacyJob("done", { state: "completed", messages: false })]);
  const before = readFile(dir);
  const sequenceBefore = before.organizationQueueSequence;
  assert.equal(sequenceBefore, 1);

  const result = await store.adoptLegacyJobs(request(2));
  assert.equal(result.blocked, null);
  assert.equal(result.adopted, 2);
  assert.equal(result.candidates, 1, "one candidate is left");
  const after = readFile(dir);
  assert.equal(after.organizationQueueSequence, sequenceBefore + 2);
  const adopted = Object.values(after.records).filter((row) => row.value.adoptedBatchId !== undefined);
  assert.deepEqual(adopted.map((row) => row.key).sort(), ["l1", "l2"]);
  assert.deepEqual(adopted.map((row) => row.value.queueSequence).sort(), [2, 3]);
  for (const row of adopted) {
    assert.equal(row.value.resumeDisposition, "eligible");
    assert.equal(row.value.nextAttemptAt, 0);
    assert.equal(row.value.adoptedBatchId, "trial-batch-2");
    assert.equal(row.value.adoptedAt, 1_700_000_000_000);
    assert.equal(row.revision, before.records[row.key].revision + 1);
    assert.deepEqual(row.value.input, before.records[row.key].value.input, "the message input is not touched");
  }
  for (const key of ["l3", "normal", "done"]) assert.equal(JSON.stringify(after.records[key]), JSON.stringify(before.records[key]), key);
  assert.deepEqual(after.organizationTrial, result.trial);
  assert.equal(after.organizationTrial.state, "running");
  assert.equal(after.organizationTrial.adopted, 2);
});

test("S2: the same requestId returns the same answer without writing, and a second request waits while a trial is running", async (t) => {
  const { dir, store } = storeRig(t);
  await seed(store, [legacyJob("l1"), legacyJob("l2"), legacyJob("l3")]);
  const first = await store.adoptLegacyJobs(request(1, "req-same-aaaaaa", "trial-one"));
  const bytes = readFileSync(join(dir, FILE), "utf8");
  const mtime = statSync(join(dir, FILE)).mtimeMs;
  await new Promise((resolve) => setTimeout(resolve, 20));

  const again = await store.adoptLegacyJobs(request(1, "req-same-aaaaaa", "trial-two"));
  assert.equal(again.replayed, true);
  assert.deepEqual(again.trial, first.trial);
  assert.equal(again.adopted, first.adopted);
  assert.equal(readFileSync(join(dir, FILE), "utf8"), bytes, "the file is byte for byte the same");
  assert.equal(statSync(join(dir, FILE)).mtimeMs, mtime, "nothing was written");

  const other = await store.adoptLegacyJobs(request(1, "req-other-aaaaaa", "trial-three"));
  assert.equal(other.blocked, "trial_running");
  assert.equal(other.adopted, 0);
  assert.equal(readFileSync(join(dir, FILE), "utf8"), bytes);
});

test("S3: attempts, a journal, a non-pending state, a foreign input and empty messages each keep a job out; only the journal counts as ambiguous", async (t) => {
  const { store } = storeRig(t);
  const withJournal = legacyJob("journal");
  await seed(store, [
    legacyJob("good"), withJournal, legacyJob("tried", { attempts: 1, lastError: "MODEL_TIMEOUT" }), legacyJob("retried", { attempts: 2 }), legacyJob("finished", { state: "completed", messages: false }),
    legacyJob("foreign", { operationId: "organize:not-the-punch-hash" }), legacyJob("empty", { messages: false }), legacyJob("errored", { lastError: "MODEL_TIMEOUT" }),
  ]);
  await addJournal(store, withJournal);

  const result = await store.adoptLegacyJobs(request(50));
  assert.equal(result.adopted, 1);
  assert.equal(result.skippedAmbiguous, 1);
  assert.equal((await rowOf(store, "good")).value.adoptedBatchId, "trial-batch-50");
  for (const key of ["journal", "tried", "retried", "finished", "foreign", "empty", "errored"]) assert.equal((await rowOf(store, key)).value.adoptedBatchId, undefined, key);
  assert.equal((await rowOf(store, "journal")).value.resumeDisposition, "legacy_unlinked");
});

test("S4: jobs are taken one agent at a time in a fixed order, so the same data always gives the same choice", async (t) => {
  const jobs = [
    ...["a1", "a2", "a3"].map((id) => legacyJob(id, { agentId: "sw/a" })),
    ...["b1", "b2"].map((id) => legacyJob(id, { agentId: "sw/b" })),
    legacyJob("c1", { agentId: "sw/c" }),
  ];
  const choice = async (order) => {
    const { store } = storeRig(t);
    await seed(store, order);
    await store.adoptLegacyJobs(request(5));
    const rows = (await rowsOf(store)).filter((row) => row.value.adoptedBatchId !== undefined);
    return rows.sort((left, right) => left.value.queueSequence - right.value.queueSequence).map((row) => row.key);
  };
  const first = await choice(jobs);
  assert.deepEqual(first, ["a1", "b1", "c1", "a2", "b2"]);
  assert.deepEqual(await choice([...jobs].reverse()), first);
});

test("S5: a write that fails at the rename leaves the file exactly as it was and no temporary file behind", async (t) => {
  const { dir, store } = storeRig(t);
  await seed(store, [legacyJob("l1"), legacyJob("l2")]);
  const bytes = readFileSync(join(dir, FILE), "utf8");
  const rename = fs.renameSync;
  fs.renameSync = () => { throw new Error("EPERM"); };
  syncBuiltinESMExports();
  try {
    await assert.rejects(store.adoptLegacyJobs(request(2)), /EPERM/u);
  } finally {
    fs.renameSync = rename;
    syncBuiltinESMExports();
  }
  assert.equal(readFileSync(join(dir, FILE), "utf8"), bytes);
  assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".tmp")), []);
  assert.equal((await store.adoptLegacyJobs(request(2))).adopted, 2, "the same call works once the write works");
});

test("S6: a revert puts untried jobs back to legacy_unlinked without the adoption fields and keeps the attempted one; a second revert changes nothing", async (t) => {
  const { dir, store } = storeRig(t);
  await seed(store, [legacyJob("l1"), legacyJob("l2"), legacyJob("l3")]);
  const adoption = await store.adoptLegacyJobs(request(3));
  const attempted = await rowOf(store, "l1");
  await store.writeBatch([{ key: "l1", value: { ...attempted.value, attempts: 1, lastError: "MODEL_TIMEOUT", lastAttemptAt: 5 }, expectedRevision: attempted.revision }]);
  const kept = await rowOf(store, "l1");
  const revisions = { l2: (await rowOf(store, "l2")).revision, l3: (await rowOf(store, "l3")).revision };

  const haltReason = { code: "MODEL_TIMEOUT", phase: "turn_timeout", hostCode: null, localCode: null, consecutive: 3 };
  const reverted = await store.revertTrialJobs(adoption.trial.batchId, { state: "halted", endedAt: 9, haltReason });
  assert.equal(reverted, 2);
  for (const key of ["l2", "l3"]) {
    const row = await rowOf(store, key);
    assert.equal(row.value.resumeDisposition, "legacy_unlinked");
    for (const field of ["queueSequence", "adoptedBatchId", "adoptedAt"]) assert.equal(field in row.value, false, key + " " + field);
    assert.equal(row.value.attempts, 0);
    assert.equal(row.revision, revisions[key] + 1, key + " got a new revision, so a stale writer is refused");
  }
  assert.equal(JSON.stringify(await rowOf(store, "l1")), JSON.stringify(kept));
  const trial = await store.readTrial();
  assert.equal(trial.state, "halted");
  assert.equal(trial.endedAt, 9);
  assert.deepEqual(trial.haltReason, haltReason);

  const bytes = readFileSync(join(dir, FILE), "utf8");
  assert.equal(await store.revertTrialJobs(adoption.trial.batchId, { state: "stopped", endedAt: 10, haltReason: null }), 0);
  assert.equal(readFileSync(join(dir, FILE), "utf8"), bytes);
  assert.equal((await store.adoptLegacyJobs(request(2, "req-next-aaaaaa", "trial-next"))).adopted, 2, "the reverted jobs can be adopted again");
});

test("a trial can be written back, and a file whose trial record is malformed is refused instead of read", async (t) => {
  const { dir, store } = storeRig(t);
  await seed(store, [legacyJob("l1")]);
  const { trial } = await store.adoptLegacyJobs(request(1));
  await store.writeTrial({ ...trial, state: "completed", endedAt: 12 });
  assert.equal((await store.readTrial()).state, "completed");
  const saved = readFile(dir);
  writeFileSync(join(dir, FILE), JSON.stringify({ ...saved, organizationTrial: { ...saved.organizationTrial, state: "weird" } }));
  await assert.rejects(store.readTrial(), /state_file_invalid/u);
});
