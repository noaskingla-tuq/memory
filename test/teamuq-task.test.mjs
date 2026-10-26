import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHostMemoryModelPort } from "../out/adapters/model/hostMemoryModelPort.js";
import { createTeamuqTaskStore, TEAMUQ_TASK_FILE } from "../out/adapters/storage/teamuqTaskStore.js";
import { createTeamuqTaskBinding, TEAMUQ_PROJECT_NAME, TEAMUQ_TASK_NAME } from "../out/application/teamuqTaskBinding.js";
import { readOrganizationSettings } from "../out/backend/organizationSettings.js";

const enabled = () => readOrganizationSettings();
const invoke = (port) => port.invoke({ agentId: "a", policy: port.resolvePolicy("a"), operation: "extract", system: "JSON please", input: {}, maxOutputTokens: 1024, signal: new AbortController().signal });
const fail = (code) => ({ apiVersion: 1, requestId: null, operation: null, ok: false, error: { code, message: code } });

function program(handler = null) {
  const calls = [];
  let seq = 100;
  return {
    calls,
    async call(operation, input) {
      calls.push({ operation, input });
      const custom = handler?.(operation, input, calls.length);
      if (custom !== undefined) return custom;
      seq += 1;
      return { apiVersion: 1, requestId: `r${seq}`, operation, ok: true, result: { id: String(seq) } };
    },
  };
}

function fakeAi(openFailure = () => null) {
  const opens = [];
  const ai = {
    async getOptions() {
      return { providers: [{ id: "mock", state: "ready", models: [{ id: "allowed", isDefault: true }] }], defaultProviderId: "mock", quota: { state: "ok" }, limits: { systemChars: 10000, inputChars: 20000 } };
    },
    async openSession(input) {
      opens.push(input);
      const failure = openFailure(input, opens.length);
      if (failure !== null) throw failure;
      let listener;
      return {
        sessionId: `s${opens.length}`,
        effective: { providerId: "mock", modelId: "allowed", effort: null },
        turn: null,
        onEvent(next) { listener = next; return () => { listener = undefined; }; },
        async send() {
          listener({ turnId: "t", kind: "textDelta", text: '{"items":[]}' });
          listener({ turnId: "t", kind: "completed" });
          return { turnId: "t" };
        },
        async close() {},
        async interrupt() {},
      };
    },
  };
  return { ai, opens };
}

const tempDir = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "memory-task-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("first AI turn carries a taskId, creates the Project and Task once, and a restart reuses the same id", async (t) => {
  const dir = tempDir(t);
  const prog = program();
  const { ai, opens } = fakeAi();
  const port = createHostMemoryModelPort(ai, enabled, undefined, createTeamuqTaskBinding({ program: prog, store: createTeamuqTaskStore(dir), now: () => 0 }));
  await invoke(port);
  await invoke(port);
  await port.cancel();
  assert.deepEqual(prog.calls.map((call) => call.operation), ["data.projects.create", "data.tasks.create"]);
  assert.equal(prog.calls[0].input.name, TEAMUQ_PROJECT_NAME);
  assert.equal(prog.calls[1].input.name, TEAMUQ_TASK_NAME);
  assert.equal(prog.calls[1].input.projectId, "101");
  assert.deepEqual(opens.map((open) => open.taskId), ["102", "102"]);
  assert.equal(JSON.parse(readFileSync(join(dir, TEAMUQ_TASK_FILE), "utf8")).taskId, "102");

  const restartedProgram = program();
  const restarted = fakeAi();
  const next = createHostMemoryModelPort(restarted.ai, enabled, undefined, createTeamuqTaskBinding({ program: restartedProgram, store: createTeamuqTaskStore(dir), now: () => 0 }));
  await invoke(next);
  await next.cancel();
  assert.equal(restartedProgram.calls.length, 0);
  assert.deepEqual(restarted.opens.map((open) => open.taskId), ["102"]);
});

test("task_not_found on open rebuilds the Task once and retries the open with the new id", async (t) => {
  const prog = program();
  const { ai, opens } = fakeAi((input) => (input.taskId === "102" ? Object.assign(new Error("gone"), { code: "task_not_found" }) : null));
  const port = createHostMemoryModelPort(ai, enabled, undefined, createTeamuqTaskBinding({ program: prog, store: null, now: () => 0 }));
  assert.deepEqual(await invoke(port), { items: [] });
  await port.cancel();
  assert.deepEqual(prog.calls.map((call) => call.operation), ["data.projects.create", "data.tasks.create", "data.tasks.create"]);
  assert.equal(prog.calls[2].input.projectId, "101");
  assert.deepEqual(opens.map((open) => open.taskId), ["102", "103"]);
});

test("not_found on Task creation rebuilds the Project together with the Task", async () => {
  const prog = program((operation, _input, call) => (operation === "data.tasks.create" && call === 2 ? fail("not_found") : undefined));
  const { ai, opens } = fakeAi();
  const port = createHostMemoryModelPort(ai, enabled, undefined, createTeamuqTaskBinding({ program: prog, store: null, now: () => 0 }));
  await invoke(port);
  await port.cancel();
  assert.deepEqual(prog.calls.map((call) => call.operation), ["data.projects.create", "data.tasks.create", "data.projects.create", "data.tasks.create"]);
  assert.equal(prog.calls[3].input.projectId, "102");
  assert.deepEqual(opens.map((open) => open.taskId), ["103"]);
});

test("without host.program the turn goes out with no taskId and no Program call", async () => {
  const { ai, opens } = fakeAi();
  const port = createHostMemoryModelPort(ai, enabled);
  assert.deepEqual(await invoke(port), { items: [] });
  await port.cancel();
  assert.equal(Object.hasOwn(opens[0], "taskId"), false);
  const unbound = createTeamuqTaskBinding({ program: undefined, store: null });
  assert.equal(await unbound.resolve(), null);
});

test("denied, unavailable, timed-out Program calls fall back without a taskId and back off before the next try", async () => {
  let clock = 0;
  const prog = program(() => fail("forbidden"));
  const { ai, opens } = fakeAi();
  const port = createHostMemoryModelPort(ai, enabled, undefined, createTeamuqTaskBinding({ program: prog, store: null, now: () => clock, retryMs: 60_000 }));
  await invoke(port);
  clock = 1_000;
  await invoke(port);
  assert.equal(prog.calls.length, 1);
  clock = 60_000;
  await invoke(port);
  await port.cancel();
  assert.equal(prog.calls.length, 2);
  assert.deepEqual(opens.map((open) => Object.hasOwn(open, "taskId")), [false, false, false]);

  const throwing = program(() => { throw Object.assign(new Error("core offline"), { code: "unavailable" }); });
  const thrownAi = fakeAi();
  const thrownPort = createHostMemoryModelPort(thrownAi.ai, enabled, undefined, createTeamuqTaskBinding({ program: throwing, store: null, now: () => 0 }));
  await invoke(thrownPort);
  await invoke(thrownPort);
  await thrownPort.cancel();
  assert.equal(throwing.calls.length, 1);
  assert.deepEqual(thrownAi.opens.map((open) => Object.hasOwn(open, "taskId")), [false, false]);

  const hanging = { calls: 0, call() { hanging.calls += 1; return new Promise(() => {}); } };
  const hangingAi = fakeAi();
  const hangingPort = createHostMemoryModelPort(hangingAi.ai, enabled, undefined, createTeamuqTaskBinding({ program: hanging, store: null, now: () => 0, guardMs: 20 }));
  assert.deepEqual(await invoke(hangingPort), { items: [] });
  assert.deepEqual(await invoke(hangingPort), { items: [] });
  await hangingPort.cancel();
  assert.equal(hanging.calls, 1);
  assert.deepEqual(hangingAi.opens.map((open) => Object.hasOwn(open, "taskId")), [false, false]);
});

test("an unreadable state file is treated as absent and rewritten on the next create", async (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, TEAMUQ_TASK_FILE), "{not json");
  const prog = program();
  const { ai, opens } = fakeAi();
  const port = createHostMemoryModelPort(ai, enabled, undefined, createTeamuqTaskBinding({ program: prog, store: createTeamuqTaskStore(dir), now: () => 0 }));
  await invoke(port);
  await port.cancel();
  assert.equal(prog.calls.length, 2);
  assert.deepEqual(opens.map((open) => open.taskId), ["102"]);
  assert.equal(JSON.parse(readFileSync(join(dir, TEAMUQ_TASK_FILE), "utf8")).taskId, "102");
});
