import assert from "node:assert/strict";
import test from "node:test";
import { REPLY, actorOf, callRecord, callsOf, invokeScoped, portOf, recoverAi, seed, tempStore } from "./recoverHarness.mjs";

const OP = "organize:detach";
const ticks = async (count = 30) => { for (let i = 0; i < count; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

function liveHost(t) {
  const { store } = tempStore(t);
  const host = recoverAi();
  const turns = [];
  const sessions = [];
  const state = { sent: 0, closed: 0 };
  host.ai.openSession = async (input) => {
    if ("resume" in input) {
      const found = sessions.find((entry) => entry.sessionId === input.resume);
      if (found === undefined) throw Object.assign(new Error("session not found"), { code: "session_not_found" });
      return found;
    }
    const session = host.make("live-" + (sessions.length + 1), null);
    session.send = async () => {
      state.sent += 1;
      const turnId = session.sessionId + "-turn-" + state.sent;
      turns.push({ session, turnId });
      return { turnId };
    };
    session.close = async () => { state.closed += 1; };
    sessions.push(session);
    return session;
  };
  const port = portOf(host.ai, store);
  t.after(() => port.cancel());
  const finish = (index, reply = REPLY) => {
    const { session, turnId } = turns[index];
    const text = JSON.stringify(reply);
    session.turn = { turnId, text, terminal: { kind: "completed" } };
    session.emit({ turnId, kind: "textDelta", text });
    session.emit({ turnId, kind: "contentSaved", sequenceNo: index + 1 });
    session.emit({ turnId, kind: "completed" });
  };
  const fail = (index, code = "provider_error") => turns[index].session.emit({ turnId: turns[index].turnId, kind: "failed", code, retryable: true, partialDelivered: false });
  return { store, host, port, turns, state, finish, fail, actor: actorOf("sw/a") };
}

async function startDetached(rig, operationId = OP) {
  const controller = new AbortController();
  const call = invokeScoped(rig.port, rig.actor, operationId, { value: 1 }, controller.signal);
  const outcome = call.then(() => null, (error) => error);
  await ticks();
  assert.equal(rig.state.sent, 1, "the turn is on the host");
  controller.abort();
  return { error: await outcome };
}

test("a soft stop after the send detaches the caller: MODEL_TIMEOUT comes back, the host turn is not interrupted, and the finished turn is cached as reply_ready", async (t) => {
  const rig = liveHost(t);
  const { error } = await startDetached(rig);
  assert.equal(error.code, "MODEL_TIMEOUT");
  assert.equal(error.localCode, "detached_running");
  assert.equal(rig.host.counters.interrupted, 0, "a soft stop never reaches session.interrupt");
  const [running] = await callsOf(rig.store, OP, rig.actor);
  assert.deepEqual([running.phase, running.turnId, running.replyJson], ["sent", "live-1-turn-1", null], "the call is still sent, not failed");
  assert.ok(rig.port.waiting() !== null && rig.port.waiting().sinceMs >= 0, "the wait shows while the turn runs");

  rig.finish(0);
  await ticks();
  const [ready] = await callsOf(rig.store, OP, rig.actor);
  assert.equal(ready.phase, "reply_ready");
  assert.deepEqual(JSON.parse(ready.replyJson), REPLY);
  assert.equal(rig.port.waiting(), null);

  assert.deepEqual(await invokeScoped(rig.port, rig.actor, OP, { value: 1 }), REPLY, "the next call is answered from the cache");
  assert.equal(rig.state.sent, 1, "no second send");
  const calls = await callsOf(rig.store, OP, rig.actor);
  assert.equal(calls.length, 1, "the next call used the same callKey");
  assert.equal(rig.host.counters.interrupted, 0);
});

test("a detached turn keeps the pair lock and the host slot: another pair waits and releasePair returns only after the turn ends", async (t) => {
  const rig = liveHost(t);
  await startDetached(rig);
  let released = false;
  const release = rig.port.releasePair(rig.actor.agentId, rig.actor.projectId).then(() => { released = true; });
  const otherActor = actorOf("sw/b");
  let otherDone = false;
  const other = invokeScoped(rig.port, otherActor, "organize:other", { value: 2 }).then((value) => { otherDone = true; return value; });
  await ticks(60);
  assert.equal(released, false, "releasePair waits for the running turn");
  assert.equal(rig.state.sent, 1, "the other pair has not sent: the host slot is still held");
  assert.equal(otherDone, false);
  assert.equal(rig.state.closed, 0, "the running session is not closed under the turn");

  rig.finish(0);
  await ticks(60);
  assert.equal(rig.state.sent, 2, "the other pair sends once the first turn has ended");
  rig.finish(1);
  assert.deepEqual(await other, REPLY);
  await release;
  assert.equal(released, true);
});

test("a hard stop while detached interrupts the turn and closes the call as failed cancelled_local", async (t) => {
  const rig = liveHost(t);
  await startDetached(rig);
  rig.port.interrupt();
  await ticks();
  assert.equal(rig.host.counters.interrupted, 1);
  const [call] = await callsOf(rig.store, OP, rig.actor);
  assert.deepEqual([call.phase, call.hostErrorCode, call.retryable, call.partialDelivered], ["failed", "cancelled_local", true, false]);
  assert.equal(rig.port.waiting(), null);
  await rig.port.awaitPair(rig.actor.agentId, rig.actor.projectId);
});

test("cancel() hard-stops detached turns and waits for their terminal record", async (t) => {
  const rig = liveHost(t);
  await startDetached(rig);
  await rig.port.cancel();
  const [call] = await callsOf(rig.store, OP, rig.actor);
  assert.deepEqual([call.phase, call.hostErrorCode], ["failed", "cancelled_local"], "the record is final before cancel returns");
  assert.equal(rig.host.counters.interrupted, 1);
});

test("a detached turn that the host fails leaves the failure in the journal", async (t) => {
  const rig = liveHost(t);
  await startDetached(rig);
  rig.fail(0, "stalled");
  await ticks();
  const [call] = await callsOf(rig.store, OP, rig.actor);
  assert.deepEqual([call.phase, call.hostErrorCode, call.retryable, call.partialDelivered], ["failed", "stalled", true, false]);
  assert.equal(rig.port.waiting(), null);
  await rig.port.awaitPair(rig.actor.agentId, rig.actor.projectId);
  const retry = invokeScoped(rig.port, rig.actor, OP, { value: 1 });
  await ticks();
  assert.equal(rig.state.sent, 2, "a retryable failure is sent again as the next occurrence");
  rig.finish(1);
  assert.deepEqual(await retry, REPLY);
});

test("with no saved reply and a turn that never finishes, awaitPair stays pending until the turn ends", async (t) => {
  const rig = liveHost(t);
  await startDetached(rig);
  let settled = false;
  const waiting = rig.port.awaitPair(rig.actor.agentId, rig.actor.projectId).then(() => { settled = true; });
  await ticks(40);
  assert.equal(settled, false);
  rig.finish(0);
  await waiting;
  assert.equal(settled, true);
});

test("a second operation of a pair that has an unresolved call is refused with the pair_blocked local code", async (t) => {
  const rig = liveHost(t);
  const blocker = await callRecord(rig.actor, "organize:blocker", { phase: "prepared", turnId: null, hostSessionId: null });
  await seed(rig.store, { calls: [blocker] });
  await assert.rejects(invokeScoped(rig.port, rig.actor, "organize:next"), (error) => error.code === "RESOURCE_BUSY" && error.phase === "session_resume" && error.localCode === "pair_blocked");
  assert.equal(rig.state.sent, 0);
});
