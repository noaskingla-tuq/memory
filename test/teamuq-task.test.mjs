import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHostMemoryModelPort } from "../out/adapters/model/hostMemoryModelPort.js";
import { createTeamuqTaskStore, TEAMUQ_TASK_FILE } from "../out/adapters/storage/teamuqTaskStore.js";
import { createTeamuqTaskBinding, TEAMUQ_PROJECT_NAME, teamuqTaskNameFor } from "../out/application/teamuqTaskBinding.js";
import { NO_PROFILE } from "../out/application/ui/profilePort.js";
import { readOrganizationSettings } from "../out/backend/organizationSettings.js";
import { createTestHost } from "../vendor/teamuq-devkit-testing/tuq-plugin-test-host.mjs";

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

const KIT_DIR = new URL("../vendor/teamuq-devkit-testing/", import.meta.url);
const KIT_SHA256 = {
  "tuq-plugin-test-host.mjs": "01ba78a1a51b98a9248d8d67e1784f7a8a24ebb4b3b1595896ed6a22f1aed850",
  "tuq-plugin-test-host.d.mts": "2dcb56574c0ea7b9a9cc61f9aef81de7c055529e1c814b125e6946943fd5e36c",
  "tuq-plugin-test-host.version.json": "dc7e756f33eacac25ecaee28a6b900b8239fee64a9225753ffd3646c0070a36f",
};
const sha256Of = (file) => createHash("sha256").update(readFileSync(new URL(file, KIT_DIR))).digest("hex");

test("the vendored devkit test host matches its pinned sha256 and the kit's version.json", () => {
  for (const [file, sha256] of Object.entries(KIT_SHA256)) assert.equal(sha256Of(file), sha256, file);
  assert.deepEqual(JSON.parse(readFileSync(new URL("tuq-plugin-test-host.version.json", KIT_DIR), "utf8")), { coreVersion: "1.8.0", file: "tuq-plugin-test-host.mjs", sha256: KIT_SHA256["tuq-plugin-test-host.mjs"] });
});

// why: the production manifest declares no read permission; the devkit copy adds the two reads only so the scenarios can read Tasks back, and every write permission is the template's own
const READ_BACK_PERMISSIONS = ["program:data:projects:read", "program:data:tasks:read"];
const memoryVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const devkitManifest = () => {
  const template = JSON.parse(readFileSync(new URL("../plugin/manifest.template.json", import.meta.url), "utf8").replace("@VERSION@", memoryVersion));
  return { ...template, permissions: [...template.permissions, ...READ_BACK_PERMISSIONS] };
};
const JSON_REPLY = { events: [{ textDelta: '{"items":[]}' }, "completed"] };
const devkitHost = (t) => {
  const host = createTestHost({ manifest: devkitManifest() });
  t.after(() => host.close());
  return host;
};
const devkitPort = (host, profile) => createHostMemoryModelPort(host.backend.host.ai, enabled, undefined, createTeamuqTaskBinding({ program: host.backend.host.program, store: null, profile, now: () => host.clock.now() }));
const scripted = (host, port, agentId) => {
  host.ai.next(JSON_REPLY);
  return invoke(port, agentId);
};
const devkitProfile = () => profileWith({ "sw/developer": { name: "開發工程師", teamKey: "sw" }, "sw/tester": { name: "測試工程師", teamKey: "sw" }, "sw/qa": { name: "品保工程師", teamKey: "sw" } });
const replyOf = (record) => record.reply.value;
const createdTasks = (host) => host.calls("program.call:data.tasks.create");
const openedTaskIds = (host) => host.calls("backend:ai.openSession").map((record) => record.args.taskId);
const okResult = (reply) => {
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return reply.result;
};

test("devkit host: each agent gets its own Task under one Project, and the Tasks read back through program.call", async (t) => {
  const host = devkitHost(t);
  const port = devkitPort(host, devkitProfile());
  await scripted(host, port, "sw/developer");
  await scripted(host, port, "sw/tester");
  await scripted(host, port, "sw/developer");
  await port.cancel();
  const projects = host.calls("program.call:data.projects.create");
  assert.equal(projects.length, 1);
  assert.equal(projects[0].args.input.name, TEAMUQ_PROJECT_NAME);
  const projectId = replyOf(projects[0]).result.id;
  const tasks = createdTasks(host);
  assert.deepEqual(tasks.map((record) => record.args.input.name), [teamuqTaskNameFor("開發工程師"), teamuqTaskNameFor("測試工程師")]);
  assert.deepEqual(tasks.map((record) => record.args.input.projectId), [projectId, projectId]);
  const [developerTask, testerTask] = tasks.map((record) => replyOf(record).result.id);
  assert.deepEqual(openedTaskIds(host), [developerTask, testerTask, developerTask]);
  for (const [taskId, name] of [[developerTask, teamuqTaskNameFor("開發工程師")], [testerTask, teamuqTaskNameFor("測試工程師")]]) {
    const read = okResult(await host.backend.host.program.call("data.tasks.get", { taskId }));
    assert.equal(read.name, name);
    assert.equal(read.projectId, projectId);
  }
});

test("devkit host: a deleted Task fails its open with task_not_found, and only that agent's Task is rebuilt", async (t) => {
  const host = devkitHost(t);
  const program = host.backend.host.program;
  const port = devkitPort(host, devkitProfile());
  await scripted(host, port, "sw/developer");
  await scripted(host, port, "sw/tester");
  const [developerTask, testerTask] = createdTasks(host).map((record) => replyOf(record).result.id);
  const { authoredRevision } = okResult(await program.call("data.tasks.get", { taskId: testerTask }));
  okResult(await program.call("data.tasks.delete", { taskId: testerTask, expectedAuthoredRevision: authoredRevision }));
  const error = await host.backend.host.ai.openSession({ system: "x", taskId: testerTask }).then(() => null, (caught) => caught);
  assert.equal(error.code, "task_not_found");
  assert.equal(error.message, "host request failed: task_not_found");

  await scripted(host, port, "sw/tester");
  await scripted(host, port, "sw/developer");
  await port.cancel();
  assert.equal(host.calls("program.call:data.projects.create").length, 1);
  const tasks = createdTasks(host);
  assert.deepEqual(tasks.map((record) => record.args.input.name), [teamuqTaskNameFor("開發工程師"), teamuqTaskNameFor("測試工程師"), teamuqTaskNameFor("測試工程師")]);
  const rebuiltTester = replyOf(tasks[2]).result.id;
  assert.notEqual(rebuiltTester, testerTask);
  assert.deepEqual(openedTaskIds(host), [developerTask, testerTask, testerTask, testerTask, rebuiltTester, developerTask]);
});

test("devkit host: with tasks:write revoked, an agent without a Task opens with no taskId and the denial comes back as an envelope", async (t) => {
  const host = devkitHost(t);
  const port = devkitPort(host, devkitProfile());
  await scripted(host, port, "sw/developer");
  const [developerTask] = createdTasks(host).map((record) => replyOf(record).result.id);
  await host.revoke("program:data:tasks:write");
  assert.deepEqual(await scripted(host, port, "sw/qa"), { items: [] });
  await port.cancel();
  const denial = replyOf(createdTasks(host).at(-1));
  assert.equal(denial.ok, false);
  assert.equal(denial.error.code, "forbidden");
  const opens = host.calls("backend:ai.openSession");
  assert.equal(Object.hasOwn(opens.at(-1).args, "taskId"), false);
  assert.deepEqual(openedTaskIds(host), [developerTask, undefined]);
});
