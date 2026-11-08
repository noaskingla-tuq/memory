import assert from "node:assert/strict";
import test from "node:test";
import { addReply, ok, punch, tick, timeout, workerRig } from "./organizationHarness.mjs";

const AGENTS = ["sw/a", "sw/b", "sw/c"];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function probe(h, behave = async () => ok()) {
  const seen = { inflight: 0, max: 0, order: [] };
  const capture = async (job) => {
    seen.inflight += 1;
    seen.max = Math.max(seen.max, seen.inflight);
    seen.order.push(job.punchId);
    h.calls.push(job.punchId);
    try { await pause(2); return await behave(job, seen); }
    finally { seen.inflight -= 1; }
  };
  return { seen, capture };
}

async function fill(worker, count) {
  for (let i = 0; i < count; i += 1) await worker.enqueue(punch({ id: "p" + i, agentId: AGENTS[i % AGENTS.length], projectId: i % 2 === 0 ? "project" : null }), "raw-" + i);
}

test("the whole organization is one queue: one capture at a time across agents and pairs, in queue order, however often the worker is woken", async (t) => {
  const h = workerRig(t);
  const { seen, capture } = probe(h);
  const worker = h.create({ capture });
  await fill(worker, 12);
  worker.start();
  for (let i = 0; i < 30; i += 1) { worker.wake(); worker.settingsChanged(); await tick(); }
  await worker.idle();
  assert.equal(seen.max, 1, "never two captures at once");
  assert.deepEqual(seen.order, Array.from({ length: 12 }, (_, i) => "p" + i), "every job once, in queue order");
});

test("a continuing job is finished before the next job starts", async (t) => {
  const h = workerRig(t);
  const rounds = new Map();
  const { seen, capture } = probe(h, async (job) => {
    if (job.punchId !== "p0") return ok();
    const round = (rounds.get(job.punchId) ?? 0) + 1;
    rounds.set(job.punchId, round);
    if (round <= 3) { await addReply(h.store, job, round); return timeout(); }
    return ok();
  });
  const worker = h.create({ capture, awaitPending: async () => { await pause(1); } });
  await fill(worker, 3);
  worker.start();
  await worker.idle();
  assert.deepEqual(seen.order, ["p0", "p0", "p0", "p0", "p1", "p2"], "the three continuations come before p1");
  assert.equal(seen.max, 1);
});

test("a job waiting on a running turn holds the queue: the next job is not sent meanwhile", async (t) => {
  const h = workerRig(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { seen, capture } = probe(h, async (job) => {
    if (job.punchId === "p0" && !gate.settled) { await addReply(h.store, job, 1); gate.settled = true; return timeout(); }
    return ok();
  });
  const worker = h.create({ capture, awaitPending: async () => { await gate; } });
  await fill(worker, 2);
  worker.start();
  for (let i = 0; i < 40; i += 1) await tick();
  assert.deepEqual(seen.order, ["p0"], "p1 waits while p0's turn is still running");
  release();
  await worker.idle();
  assert.deepEqual(seen.order, ["p0", "p0", "p1"]);
});

test("every pass ends before a new one starts: a wake during a run is folded into one more pass, never a parallel one", async (t) => {
  const h = workerRig(t);
  const { seen, capture } = probe(h);
  const worker = h.create({ capture });
  worker.start();
  for (let i = 0; i < 8; i += 1) { await worker.enqueue(punch({ id: "q" + i, agentId: AGENTS[i % 3] }), "raw-" + i); worker.wake(); }
  await worker.idle();
  assert.equal(seen.max, 1);
  assert.equal(new Set(seen.order).size, 8);
  assert.equal(seen.order.length, 8, "no job ran twice");
});
