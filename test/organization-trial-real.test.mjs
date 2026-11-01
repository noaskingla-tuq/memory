import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { parseUiResponse } from "../out/contracts/uiContract.js";
import { startBackend } from "./backendHarness.mjs";

const JOBS = 6;
const snapshot = { snapshotId: "s", generation: "g", highWatermark: "p" };

function feed() {
  const counters = { sent: 0, opened: 0 };
  const records = Array.from({ length: JOBS }, (_, index) => ({
    id: "row" + index, punchId: "p" + index, agentId: index % 2 === 0 ? "sw/a" : "sw/b", projectId: null, sessionId: "s" + index, providerId: "mock", model: "allowed", punchType: "main",
    startedAtMs: Date.now() - 500000, endedAtMs: Date.now() - 200000, name: "Request " + index, description: "Outcome " + index,
  }));
  const options = { providers: [{ id: "mock", state: "ready", models: [{ id: "allowed", isDefault: true }] }], defaultProviderId: "mock", capabilities: { closedSessionResume: true }, quota: { state: "ok" }, limits: { systemChars: 10_000, inputChars: 20_000, transcriptLines: 80 } };
  // why: the mock answers every turn with an empty extraction, so the real Cairn chain runs and each job costs a countable number of turns
  const ai = {
    async getOptions() { return options; },
    async openSession(openOptions) {
      counters.opened += 1;
      let listener;
      const session = {
        sessionId: openOptions?.resume ?? "session-" + counters.opened, effective: { providerId: "mock", modelId: "allowed", effort: null }, turn: null,
        onEvent(next) { listener = next; return () => { listener = undefined; }; },
        async send() {
          counters.sent += 1;
          const turnId = "turn-" + counters.sent;
          const reply = '{"items":[]}';
          session.turn = { turnId, text: reply, terminal: { kind: "completed" } };
          listener?.({ turnId, kind: "textDelta", text: reply });
          listener?.({ turnId, kind: "contentSaved", sequenceNo: counters.sent });
          listener?.({ turnId, kind: "completed" });
          return { turnId };
        },
        async close() {},
        async interrupt() {},
      };
      return session;
    },
  };
  const host = {
    workRecords: { async readPage() { return { snapshot, nextCursor: null, records }; }, subscribeSettledChanges() { return () => {}; } },
    pluginState: { async readPage() { throw Object.assign(new Error("retired"), { code: "plugin_state_retired" }); } },
    agentDirectory: { async readPage() { return { snapshot, entries: [], nextCursor: null }; } },
    projectDirectory: { async readPage() { return { snapshot, entries: [], nextCursor: null }; } },
    ai,
  };
  return { host, counters };
}

test("I1: with the real Cairn chain and a mock host.ai, start 3 spends at most 3 jobs' worth of turns, finishes exactly three jobs and leaves the other legacy jobs untouched", async (t) => {
  const { host, counters } = feed();
  let values = { organizationEnabled: false };
  let onChange;
  const settings = { all: () => values, onChange(listener) { onChange = listener; return () => {}; } };
  const { backend, dataRoot } = startBackend(t, { host, settings, organizationNow: () => new Date(2026, 0, 1, 1, 59).getTime() });
  backend.startWorkers();
  await backend.idleWorkers();
  const path = join(dirname(dataRoot), "punch-organization.json");
  const saved = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(Object.keys(saved.records).length, JOBS, "every punch became an organization job while AI organization was off");
  for (const record of Object.values(saved.records)) { delete record.value.resumeDisposition; delete record.value.queueSequence; }
  writeFileSync(path, JSON.stringify(saved));
  values = { organizationEnabled: true };
  onChange(values);
  await backend.idleWorkers();
  assert.equal(counters.sent, 0, "turning AI organization on sends no legacy job by itself");
  let status = await backend.call("ui.status", {});
  assert.equal(parseUiResponse("ui.status", status), true);
  assert.equal(status.organization.legacyUnlinked, JOBS);
  assert.equal(status.organization.legacyTrialCandidates, JOBS);

  const request = { action: "start", requestId: "req-real-aaaaaa", count: 3 };
  const answer = await backend.call("ui.legacyTrial", request);
  assert.equal(parseUiResponse("ui.legacyTrial", answer), true, JSON.stringify(answer));
  assert.equal(answer.blocked, null);
  assert.equal(answer.adopted, 3);
  await backend.idleWorkers();
  const perJob = counters.sent / 3;
  t.diagnostic("turns per job: " + perJob + " (" + counters.sent + " in total)");
  assert.ok(counters.sent >= 3 && counters.sent <= 3 * 4, "turns " + counters.sent);

  status = await backend.call("ui.status", {});
  assert.equal(parseUiResponse("ui.status", status), true);
  assert.equal(status.organization.trial.state, "completed");
  assert.deepEqual([status.organization.trial.adopted, status.organization.trial.attempted, status.organization.trial.failed, status.organization.trial.untried], [3, 3, 0, 0]);
  assert.equal(status.organization.trial.committed + status.organization.trial.emptySuccess, 3);
  assert.equal(status.organization.legacyUnlinked, JOBS - 3);
  const rows = Object.values(JSON.parse(readFileSync(path, "utf8")).records);
  assert.equal(rows.filter((row) => row.value.state === "completed").length, 3);
  assert.equal(rows.filter((row) => row.value.resumeDisposition === "legacy_unlinked" && row.value.attempts === 0).length, JOBS - 3);
  assert.deepEqual([...new Set(rows.filter((row) => row.value.adoptedBatchId !== undefined).map((row) => row.value.actor.agentId))].sort(), ["sw/a", "sw/b"], "the trial reached both agents");

  const sentBefore = counters.sent;
  const again = await backend.call("ui.legacyTrial", request);
  await backend.idleWorkers();
  assert.equal(again.adopted, 3);
  assert.equal(counters.sent, sentBefore, "the same requestId does not send anything again");
});
