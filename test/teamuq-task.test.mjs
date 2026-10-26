import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHostMemoryModelPort } from "../out/adapters/model/hostMemoryModelPort.js";
import { createTeamuqTaskStore, TEAMUQ_TASK_FILE } from "../out/adapters/storage/teamuqTaskStore.js";
import { createTeamuqTaskBinding, TEAMUQ_PROJECT_NAME, teamuqTaskNameFor } from "../out/application/teamuqTaskBinding.js";
import { NO_PROFILE } from "../out/application/ui/profilePort.js";
import { readOrganizationSettings } from "../out/backend/organizationSettings.js";

const enabled = () => readOrganizationSettings();
const invoke = (port, agentId = "a") => port.invoke({ agentId, policy: port.resolvePolicy(agentId), operation: "extract", system: "JSON please", input: {}, maxOutputTokens: 1024, signal: new AbortController().signal });
const fail = (code) => ({ apiVersion: 1, requestId: null, operation: null, ok: false, error: { code, message: code } });
const taskCalls = (prog) => prog.calls.filter((call) => call.operation === "data.tasks.create");
const projectCalls = (prog) => prog.calls.filter((call) => call.operation === "data.projects.create");

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

function profileWith(names) {
  const agents = new Map(Object.entries(names));
  return { ...NO_PROFILE, agent: (agentId) => agents.get(agentId) };
}

const tempDir = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "memory-task-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("each agent gets its own Task named after it, under one Project", async () => {
  const prog = program();
  const { ai, opens } = fakeAi();
  const profile = profileWith({ "sw/developer": { name: "開發工程師", teamKey: "sw" }, "sw/tester": { name: "測試工程師", teamKey: "sw" } });
  const port = createHostMemoryModelPort(ai, enabled, undefined, createTeamuqTaskBinding({ program: prog, store: null, profile, now: () => 0 }));
  await invoke(port, "sw/developer");
  await invoke(port, "sw/tester");
  await invoke(port, "sw/developer");
  await port.cancel();
  assert.equal(projectCalls(prog).length, 1);
  assert.equal(projectCalls(prog)[0].input.name, TEAMUQ_PROJECT_NAME);
  assert.deepEqual(taskCalls(prog).map((call) => call.input.name), [teamuqTaskNameFor("開發工程師"), teamuqTaskNameFor("測試工程師")]);
  assert.equal(teamuqTaskNameFor("開發工程師"), "AI 整理記憶：開發工程師");
  assert.deepEqual(taskCalls(prog).map((call) => call.input.projectId), ["101", "101"]);
  assert.deepEqual(opens.map((open) => open.taskId), ["102", "103", "102"]);
});

test("concurrent requests for one agent create its Task once, and agents share one Project under parallel first use", async () => {
  const prog = program();
  const { ai } = fakeAi();
  const port = createHostMemoryModelPort(ai, enabled, undefined, createTeamuqTaskBinding({ program: prog, store: null, now: () => 0 }));
  await Promise.all([invoke(port, "x/a"), invoke(port, "x/a"), invoke(port, "x/b"), invoke(port, "x/a"), invoke(port, "x/b")]);
  await port.cancel();
  assert.equal(projectCalls(prog).length, 1);
  assert.equal(taskCalls(prog).length, 2);
  assert.deepEqual(taskCalls(prog).map((call) => call.input.name), [teamuqTaskNameFor("a（x）"), teamuqTaskNameFor("b（x）")]);
});

test("a restart reuses each agent's own Task without calling Program", async (t) => {
  const dir = tempDir(t);
  const prog = program();
  const first = fakeAi();
  const port = createHostMemoryModelPort(first.ai, enabled, undefined, createTeamuqTaskBinding({ program: prog, store: createTeamuqTaskStore(dir), now: () => 0 }));
  await invoke(port, "x/a");
  await invoke(port, "x/b");
  await port.cancel();
  assert.equal(taskCalls(prog).length, 2);
  const stored = JSON.parse(readFileSync(join(dir, TEAMUQ_TASK_FILE), "utf8"));
  assert.deepEqual(stored, { version: 2, projectId: "101", tasks: { "x/a": "102", "x/b": "103" } });

  const restartedProgram = program();
  const restarted = fakeAi();
  const next = createHostMemoryModelPort(restarted.ai, enabled, undefined, createTeamuqTaskBinding({ program: restartedProgram, store: createTeamuqTaskStore(dir), now: () => 0 }));
  await invoke(next, "x/b");
  await invoke(next, "x/a");
  await next.cancel();
  assert.equal(restartedProgram.calls.length, 0);
  assert.deepEqual(restarted.opens.map((open) => open.taskId), ["103", "102"]);
});

test("task_not_found rebuilds only the failing agent's Task and retries that agent's open once", async () => {
  const prog = program();
  let gone = null;
  const { ai, opens } = fakeAi((input) => (input.taskId === gone ? Object.assign(new Error("gone"), { code: "task_not_found" }) : null));
  const port = createHostMemoryModelPort(ai, enabled, undefined, createTeamuqTaskBinding({ program: prog, store: null, now: () => 0 }));
  await invoke(port, "x/a");
  await invoke(port, "x/b");
  gone = "102";
  assert.deepEqual(await invoke(port, "x/a"), { items: [] });
  assert.deepEqual(await invoke(port, "x/b"), { items: [] });
  await port.cancel();
  assert.equal(projectCalls(prog).length, 1);
  assert.deepEqual(taskCalls(prog).map((call) => call.input.name), [teamuqTaskNameFor("a（x）"), teamuqTaskNameFor("b（x）"), teamuqTaskNameFor("a（x）")]);
  assert.deepEqual(taskCalls(prog).map((call) => call.input.projectId), ["101", "101", "101"]);
  assert.deepEqual(opens.map((open) => open.taskId), ["102", "103", "102", "104", "103"]);
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

test("agents that hit not_found on the same deleted Project rebuild it once", async () => {
  let gone = false;
  const prog = program((operation, input) => (gone && operation === "data.tasks.create" && input.projectId === "101" ? fail("not_found") : undefined));
  const { ai } = fakeAi();
  const port = createHostMemoryModelPort(ai, enabled, undefined, createTeamuqTaskBinding({ program: prog, store: null, now: () => 0 }));
  await invoke(port, "x/a");
  gone = true;
  await Promise.all([invoke(port, "x/b"), invoke(port, "x/c")]);
  await port.cancel();
  assert.equal(projectCalls(prog).length, 2);
  assert.equal(taskCalls(prog).filter((call) => call.input.projectId === "101").length, 3);
  assert.equal(taskCalls(prog).filter((call) => call.input.projectId === "103").length, 2);
});

test("names fall back to the degraded name when the agent is not in the name table", async () => {
  const prog = program();
  const { ai } = fakeAi();
  const port = createHostMemoryModelPort(ai, enabled, undefined, createTeamuqTaskBinding({ program: prog, store: null, now: () => 0 }));
  await invoke(port, "sw/developer");
  await port.cancel();
  assert.equal(taskCalls(prog)[0].input.name, "AI 整理記憶：developer（sw）");
});

test("a version-1 state file keeps its Project, drops its shared Task, and is rewritten as version 2", async (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, TEAMUQ_TASK_FILE), JSON.stringify({ version: 1, projectId: "55", taskId: "77" }));
  const prog = program();
  const { ai, opens } = fakeAi();
  const port = createHostMemoryModelPort(ai, enabled, undefined, createTeamuqTaskBinding({ program: prog, store: createTeamuqTaskStore(dir), now: () => 0 }));
  await invoke(port, "x/a");
  await port.cancel();
  assert.deepEqual(prog.calls.map((call) => call.operation), ["data.tasks.create"]);
  assert.equal(prog.calls[0].input.projectId, "55");
  assert.deepEqual(opens.map((open) => open.taskId), ["101"]);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, TEAMUQ_TASK_FILE), "utf8")), { version: 2, projectId: "55", tasks: { "x/a": "101" } });
});

test("without host.program the turn goes out with no taskId and no Program call", async () => {
  const { ai, opens } = fakeAi();
  const port = createHostMemoryModelPort(ai, enabled);
  assert.deepEqual(await invoke(port), { items: [] });
  await port.cancel();
  assert.equal(Object.hasOwn(opens[0], "taskId"), false);
  const unbound = createTeamuqTaskBinding({ program: undefined, store: null });
  assert.equal(await unbound.resolve("a"), null);
});

test("denied, unavailable, timed-out Program calls fall back without a taskId and back off per agent", async () => {
  let clock = 0;
  const prog = program(() => fail("forbidden"));
  const { ai, opens } = fakeAi();
  const port = createHostMemoryModelPort(ai, enabled, undefined, createTeamuqTaskBinding({ program: prog, store: null, now: () => clock, retryMs: 60_000 }));
  await invoke(port, "x/a");
  clock = 1_000;
  await invoke(port, "x/a");
  assert.equal(prog.calls.length, 1);
  await invoke(port, "x/b");
  assert.equal(prog.calls.length, 2);
  clock = 60_000;
  await invoke(port, "x/a");
  await port.cancel();
  assert.equal(prog.calls.length, 3);
  assert.deepEqual(opens.map((open) => Object.hasOwn(open, "taskId")), [false, false, false, false]);

  const throwing = program(() => { throw Object.assign(new Error("core offline"), { code: "unavailable" }); });
  const thrownAi = fakeAi();
  const thrownPort = createHostMemoryModelPort(thrownAi.ai, enabled, undefined, createTeamuqTaskBinding({ program: throwing, store: null, now: () => 0 }));
  await invoke(thrownPort, "x/a");
  await invoke(thrownPort, "x/a");
  await thrownPort.cancel();
  assert.equal(throwing.calls.length, 1);
  assert.deepEqual(thrownAi.opens.map((open) => Object.hasOwn(open, "taskId")), [false, false]);

  const hanging = { calls: 0, call() { hanging.calls += 1; return new Promise(() => {}); } };
  const hangingAi = fakeAi();
  const hangingPort = createHostMemoryModelPort(hangingAi.ai, enabled, undefined, createTeamuqTaskBinding({ program: hanging, store: null, now: () => 0, guardMs: 20 }));
  assert.deepEqual(await invoke(hangingPort, "x/a"), { items: [] });
  assert.deepEqual(await invoke(hangingPort, "x/a"), { items: [] });
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
  await invoke(port, "x/a");
  await port.cancel();
  assert.equal(prog.calls.length, 2);
  assert.deepEqual(opens.map((open) => open.taskId), ["102"]);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, TEAMUQ_TASK_FILE), "utf8")), { version: 2, projectId: "101", tasks: { "x/a": "102" } });
});
