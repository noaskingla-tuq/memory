import assert from "node:assert/strict";
import test from "node:test";
import { COMPLETED_GRACE_MS, TURN_BACKSTOP_MS } from "../out/adapters/model/turnLimits.js";
import { REPLY, actorOf, callsOf, invokeScoped, portOf, recoverAi, tempStore } from "./recoverHarness.mjs";

const OP = "organize:settle";
const LIMITS = { graceMs: 40, backstopMs: 120 };
const ticks = async (count = 30) => { for (let i = 0; i < count; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// why: the real Core sends started, textDelta and completed and never contentSaved, so this host sends it only when a test asks
function realCoreHost(t, limits = LIMITS) {
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
  const port = portOf(host.ai, store, limits);
  t.after(() => port.cancel());
  const complete = (index, { saved = false, reply = REPLY } = {}) => {
    const { session, turnId } = turns[index];
    const text = JSON.stringify(reply);
    session.turn = { turnId, text, terminal: { kind: "completed" } };
    session.emit({ turnId, kind: "textDelta", text });
    if (saved) session.emit({ turnId, kind: "contentSaved", sequenceNo: index + 1 });
    session.emit({ turnId, kind: "completed" });
  };
  return { store, host, port, turns, sessions, state, complete, actor: actorOf("sw/a") };
}

async function detach(rig, operationId = OP) {
  const controller = new AbortController();
  const outcome = invokeScoped(rig.port, rig.actor, operationId, { value: 1 }, controller.signal).then(() => null, (error) => error);
  await ticks();
  controller.abort();
  return outcome;
}

test("limits: the grace is 5 seconds and the backstop is above the Core's 300 seconds", () => {
  assert.equal(COMPLETED_GRACE_MS, 5_000);
  assert.ok(TURN_BACKSTOP_MS > 300_000);
  assert.equal(TURN_BACKSTOP_MS, 330_000);
});

test("completed with its output and no contentSaved settles after the grace as reply_ready with a null sequenceNo, and the next call is answered from it", async (t) => {
  const rig = realCoreHost(t);
  const error = await detach(rig);
  assert.equal(error.localCode, "detached_running");
  rig.complete(0);
  await ticks();
  assert.equal((await callsOf(rig.store, OP, rig.actor))[0].phase, "sent", "the grace is still running");
  await pause(LIMITS.graceMs + 60);
  const [ready] = await callsOf(rig.store, OP, rig.actor);
  assert.deepEqual([ready.phase, ready.sequenceNo], ["reply_ready", null]);
  assert.deepEqual(JSON.parse(ready.replyJson), REPLY);
  assert.equal(rig.port.waiting(), null);
  assert.deepEqual(await invokeScoped(rig.port, rig.actor, OP), REPLY);
  assert.equal(rig.state.sent, 1, "no second send");
});

test("a contentSaved that arrives inside the grace is used and settles at once", async (t) => {
  const rig = realCoreHost(t, { graceMs: 5_000, backstopMs: 60_000 });
  await detach(rig);
  const { session, turnId } = rig.turns[0];
  const text = JSON.stringify(REPLY);
  session.turn = { turnId, text, terminal: { kind: "completed" } };
  session.emit({ turnId, kind: "textDelta", text });
  session.emit({ turnId, kind: "completed" });
  await ticks();
  assert.equal((await callsOf(rig.store, OP, rig.actor))[0].phase, "sent");
  session.emit({ turnId, kind: "contentSaved", sequenceNo: 9 });
  await ticks();
  const [ready] = await callsOf(rig.store, OP, rig.actor);
  assert.deepEqual([ready.phase, ready.sequenceNo], ["reply_ready", 9]);
});

test("a reply that is not valid JSON still fails as json_parse after the grace", async (t) => {
  const rig = realCoreHost(t);
  await detach(rig);
  const { session, turnId } = rig.turns[0];
  session.turn = { turnId, text: "not json", terminal: { kind: "completed" } };
  session.emit({ turnId, kind: "textDelta", text: "not json" });
  session.emit({ turnId, kind: "completed" });
  await pause(LIMITS.graceMs + 60);
  const [call] = await callsOf(rig.store, OP, rig.actor);
  assert.deepEqual([call.phase, call.hostErrorCode, call.retryable], ["failed", "json_parse", false]);
});

test("the cache check no longer asks for a sequenceNo but still checks the hash and the byte length", async (t) => {
  const rig = realCoreHost(t);
  await detach(rig);
  rig.complete(0);
  await pause(LIMITS.graceMs + 60);
  const state = await rig.store.readResumeState();
  const [operation] = Object.values(state.operations);
  const [call] = Object.values(operation.calls);
  const tamper = (fields) => rig.store.transactResumeState((resume) => ({ ...resume, operations: { ...resume.operations, [operation.operationKey]: { ...operation, calls: { [call.callKey]: { ...call, ...fields } } } } }));
  await tamper({ replySha256: "0".repeat(64) });
  await assert.rejects(invokeScoped(rig.port, rig.actor, OP), { code: "STORAGE_BUSY" });
  await tamper({ replySha256: call.replySha256, responseBytes: call.responseBytes + 1 });
  await assert.rejects(invokeScoped(rig.port, rig.actor, OP), { code: "STORAGE_BUSY" });
  await tamper({ responseBytes: call.responseBytes });
  assert.deepEqual(await invokeScoped(rig.port, rig.actor, OP), REPLY);
});

test("backstop: a Core that never ends the turn is interrupted, the call is failed turn_backstop, the lock is released, and the next call goes through on a fresh session", async (t) => {
  const rig = realCoreHost(t);
  const error = await detach(rig);
  assert.equal(error.localCode, "detached_running");
  assert.ok(rig.port.waiting() !== null);
  let released = false;
  const wait = rig.port.awaitPair(rig.actor.agentId, rig.actor.projectId).then(() => { released = true; });
  await pause(40);
  assert.equal(released, false, "the turn still holds the lock before the backstop");
  await wait;
  assert.equal(rig.host.counters.interrupted, 1);
  const [call] = await callsOf(rig.store, OP, rig.actor);
  assert.deepEqual([call.phase, call.hostErrorCode, call.retryable, call.partialDelivered], ["failed", "turn_backstop", true, false]);
  assert.equal(rig.port.waiting(), null);
  const next = invokeScoped(rig.port, rig.actor, OP);
  await ticks(60);
  assert.equal(rig.state.sent, 2, "the retryable failure is sent again as the next occurrence");
  assert.equal(rig.sessions.length, 2, "the session the stuck turn may have wedged is not reused");
  rig.complete(1, { saved: true });
  assert.deepEqual(await next, REPLY);
  assert.deepEqual((await callsOf(rig.store, OP, rig.actor)).map((entry) => entry.phase), ["failed", "reply_ready"]);
});

test("a turn that ends before the backstop is not touched by it", async (t) => {
  const rig = realCoreHost(t, { graceMs: 20, backstopMs: 150 });
  await detach(rig);
  rig.complete(0, { saved: true });
  await pause(220);
  assert.equal(rig.host.counters.interrupted, 0);
  assert.equal((await callsOf(rig.store, OP, rig.actor))[0].phase, "reply_ready");
});

test("awaitPair with a signal returns when the signal aborts, leaves the turn running, and the lock order is not broken", async (t) => {
  const rig = realCoreHost(t, { graceMs: 20, backstopMs: 60_000 });
  await detach(rig);
  const controller = new AbortController();
  const waiting = rig.port.awaitPair(rig.actor.agentId, rig.actor.projectId, controller.signal).then(() => "returned", (error) => error.code);
  await ticks();
  controller.abort();
  assert.equal(await waiting, "RESOURCE_BUSY");
  assert.equal(rig.state.sent, 1, "nothing was sent again");
  assert.equal(rig.host.counters.interrupted, 0, "the turn was not stopped");
  const next = invokeScoped(rig.port, rig.actor, OP, { value: 1 });
  let answered = false;
  void next.then(() => { answered = true; }, () => { answered = true; });
  await ticks(40);
  assert.equal(answered, false, "the next call still waits behind the running turn");
  rig.complete(0, { saved: true });
  assert.deepEqual(await next, REPLY);
  assert.equal(rig.state.sent, 1, "it was answered from the finished turn, never sent twice");
});
