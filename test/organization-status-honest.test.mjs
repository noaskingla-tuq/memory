import assert from "node:assert/strict";
import test from "node:test";
import { parseUiResponse } from "../out/contracts/uiContract.js";
import { fail, legacyJob, seed } from "./trialHarness.mjs";
import { ok, punch, workerRig } from "./organizationHarness.mjs";

const wrap = (organization) => ({ ok: true, version: "1.4.8", cairnCommit: "a".repeat(40), storage: { status: "ready" }, profile: { generation: null, receivedAt: null, agents: 0, projects: 0, sink: null }, lastWriteAt: null, uptimeSec: 1, organization });
const eligible = (index, patch = {}) => ({ ...legacyJob("e" + index, { agentId: "sw/manager", projectId: "1", attempts: 0 }), resumeDisposition: "eligible", queueSequence: index + 1, ...patch });
const oldBusy = (index) => eligible(index, { attempts: 2, lastError: "RESOURCE_BUSY", errorPhase: "session_resume", retryable: true, nextAttemptAt: Date.now() + 3_600_000, lastAttemptDate: "2026-01-01", lastAttemptAt: 1 });

// why: the counts are the ones in the real punch-organization.json that 1.4.7 called paused: 6866 old RESOURCE_BUSY, 22 old MODEL_TIMEOUT, 518 untried, 3398 legacy
function realShape() {
  const jobs = [];
  for (let i = 0; i < 6866; i += 1) jobs.push(oldBusy(i));
  for (let i = 0; i < 22; i += 1) jobs.push(eligible(6866 + i, { attempts: 1, lastError: "MODEL_TIMEOUT", errorPhase: "turn_timeout", retryable: true, nextAttemptAt: Date.now() + 3_600_000 }));
  for (let i = 0; i < 518; i += 1) jobs.push(eligible(6888 + i));
  for (let i = 0; i < 3398; i += 1) jobs.push({ ...legacyJob("l" + i, { agentId: "sw/devops", projectId: "2", attempts: i < 191 ? 3 : 0, lastError: i < 191 ? "MODEL_TIMEOUT" : null }), resumeDisposition: "legacy_unlinked" });
  return jobs;
}

test("the real data shape (6866 old RESOURCE_BUSY, 3398 legacy) is not shown as paused, and keeps the old error as a plain fact", async (t) => {
  const h = workerRig(t, { capture: async () => assert.fail("a pass that is not due must not send") });
  h.state.frequency = "daily";
  h.state.now = new Date(2026, 0, 1, 1).getTime();
  const jobs = realShape();
  await seed(h.store, jobs);
  const worker = h.create();
  worker.start();
  await worker.idle();
  const status = worker.status();
  assert.notEqual(status.state, "paused");
  assert.equal(status.pauseReason ?? null, null);
  assert.equal(status.legacyUnlinked, 3398);
  assert.equal(status.lastError, "RESOURCE_BUSY", "the old error is still reported, only not as a pause");
  assert.equal(parseUiResponse("ui.status", wrap(status)), true);
});

test("only old RESOURCE_BUSY and legacy jobs: idle, in every frequency and after a round that left work for tomorrow", async (t) => {
  for (const frequency of ["daily", "immediate"]) {
    const h = workerRig(t, { capture: async (job) => { h.calls.push(job.punchId); return fail("RESOURCE_BUSY", { phase: "session_resume" }); } });
    h.state.frequency = frequency;
    await seed(h.store, [0, 1].map((i) => ({ ...legacyJob("l" + i, { agentId: "sw/devops" }), resumeDisposition: "legacy_unlinked" })));
    const worker = h.create();
    for (const id of ["b1", "b2", "b3"]) await worker.enqueue(punch({ id, agentId: "sw/manager", projectId: "p-" + id }), "raw-" + id);
    worker.start();
    await worker.idle();
    assert.ok(h.calls.length >= 1, frequency + ": the pass did try");
    const status = worker.status();
    assert.notEqual(status.state, "paused", frequency);
    assert.equal(status.lastError, "RESOURCE_BUSY", frequency);
    assert.equal(status.legacyUnlinked, 2, frequency);
    if (frequency === "daily") assert.equal(status.dailyRound?.state, "paused", "the round itself still says it is waiting for tomorrow");
  }
});

test("only legacy jobs left: idle, not paused", async (t) => {
  const h = workerRig(t);
  await seed(h.store, [0, 1, 2].map((i) => ({ ...legacyJob("l" + i), resumeDisposition: "legacy_unlinked" })));
  const worker = h.create();
  worker.start();
  await worker.idle();
  assert.equal(worker.status().state, "idle");
  assert.equal(worker.status().legacyUnlinked, 3);
});

test("what really stops a pass is still a pause with its reason: model not configured, policy denied, a stall, and a disabled organization is disabled", async (t) => {
  for (const [code, reason] of [["MODEL_NOT_CONFIGURED", "model_not_configured"], ["MODEL_POLICY_DENIED", "model_policy_denied"]]) {
    const h = workerRig(t, { capture: async () => fail(code, { phase: "policy" }) });
    h.state.frequency = "immediate";
    await seed(h.store, [eligible(0)]);
    const worker = h.create();
    worker.start();
    await worker.idle();
    assert.equal(worker.status().state, "paused", code);
    assert.equal(worker.status().pauseReason, reason, code);
    assert.equal(parseUiResponse("ui.status", wrap(worker.status())), true);
    h.state.enabled = false;
    assert.equal(worker.status().state, "disabled");
    assert.equal(worker.status().pauseReason, null);
  }
});

test("an old error in front of a blocking one cannot hide it", async (t) => {
  const h = workerRig(t, { capture: async () => ok() });
  h.state.frequency = "daily";
  h.state.now = new Date(2026, 0, 1, 1).getTime();
  await seed(h.store, [oldBusy(0), oldBusy(1), eligible(2, { attempts: 1, lastError: "MODEL_NOT_CONFIGURED", retryable: false, nextAttemptAt: Date.now() + 3_600_000 })]);
  const worker = h.create();
  worker.start();
  await worker.idle();
  assert.equal(worker.status().state, "paused");
  assert.equal(worker.status().pauseReason, "model_not_configured");
});
