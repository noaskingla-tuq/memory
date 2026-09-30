import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MEMORY_PROFILE_LIMITS, memoryProfileSyncResponseSchema } from "../vendor/teamuq-contract/contract.mjs";
import { createProfileIo } from "../out/adapters/ui/profileStore.js";
import { SAMPLE, SYNC, agentEntry, generationOf, partsOf, profileFileExists, profileFilePath, pushAll, readProfileFile, snapshotOf } from "./profileHarness.mjs";
import { startStore } from "./uiHarness.mjs";

const OVERVIEW = { tzOffsetMin: 0, dayStartIso: "2026-09-30T00:00:00.000Z" };
const status = async (backend) => (await backend.call("ui.status", {})).profile;
const rejectsWith = (promise, code) =>
  assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    return true;
  });
const memoryUiFiles = (base) => readdirSync(join(base, "memory-ui"));

test("parts are staged and the table only becomes effective once every part has arrived", async (t) => {
  const { backend, base } = startStore(t);
  const parts = partsOf(SAMPLE, 3);
  const first = await backend.call(SYNC, parts[0]);
  assert.equal(memoryProfileSyncResponseSchema.safeParse(first).success, true);
  assert.deepEqual(first, { accepted: true, generation: parts[0].generation, complete: false, changed: false, received: 1, agents: 0, teams: 0, projects: 0 });
  const second = await backend.call(SYNC, parts[1]);
  assert.deepEqual([second.complete, second.changed, second.received, second.agents], [false, false, 2, 0]);
  const midway = await status(backend);
  assert.deepEqual([midway.generation, midway.agents, midway.teams, midway.projects], [null, 0, 0, 0], "nothing is visible while parts are missing");
  assert.equal(profileFileExists(base), false, "nothing is written before the last part");
  const last = await backend.call(SYNC, parts[2]);
  assert.deepEqual(last, { accepted: true, generation: parts[0].generation, complete: true, changed: true, received: 3, agents: 4, teams: 2, projects: 2 });
  const done = await status(backend);
  assert.deepEqual([done.generation, done.agents, done.teams, done.projects, done.incomplete, done.corrupt], [parts[0].generation, 4, 2, 2, false, false]);
  assert.match(done.receivedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
  const stored = readProfileFile(base);
  assert.equal(stored.version, 1);
  assert.equal(stored.generation, parts[0].generation);
  assert.deepEqual(stored.agents, snapshotOf(SAMPLE).agents);
  assert.deepEqual(stored.teams, snapshotOf(SAMPLE).teams);
  assert.deepEqual(stored.projects, snapshotOf(SAMPLE).projects);
  assert.deepEqual(memoryUiFiles(base), ["profile.json"], "no temp file is left behind");
});

test("parts in any order, and a part sent twice, still make one table with the generation Core sent", async (t) => {
  const { backend } = startStore(t);
  const parts = partsOf({ ...SAMPLE, agents: [...SAMPLE.agents, agentEntry("ops/y", "維運二號", "ops")] }, 4);
  const order = [parts[2], parts[0], parts[0], parts[3], parts[1]];
  const answers = [];
  for (const part of order) answers.push(await backend.call(SYNC, part));
  assert.deepEqual(answers.map((answer) => [answer.complete, answer.received]), [[false, 1], [false, 2], [false, 2], [false, 3], [true, 4]]);
  assert.equal(answers[4].agents, 5);
  assert.equal((await status(backend)).generation, parts[0].generation);
});

test("a missing part never makes the table effective, and the old table stays", async (t) => {
  const { backend, base } = startStore(t);
  await pushAll(backend, partsOf(SAMPLE, 1));
  const before = await status(backend);
  const next = partsOf({ ...SAMPLE, agents: [...SAMPLE.agents, agentEntry("ops/y", "維運二號", "ops")] }, 3);
  await backend.call(SYNC, next[0]);
  const gap = await backend.call(SYNC, next[2]);
  assert.deepEqual([gap.complete, gap.changed, gap.received, gap.agents], [false, false, 2, 4], "the effective table's counts are reported while parts are missing");
  const after = await status(backend);
  assert.equal(after.generation, before.generation);
  assert.equal(readProfileFile(base).generation, before.generation);
});

test("a generation that does not match the assembled parts is rejected with invalid_params, and the old table stays", async (t) => {
  const { backend, base } = startStore(t);
  await pushAll(backend, partsOf(SAMPLE, 1));
  const good = (await status(backend)).generation;
  const forged = partsOf({ ...SAMPLE, agents: [...SAMPLE.agents, agentEntry("ops/y", "維運二號", "ops")] }, 2);
  forged[1].teams = forged[1].teams.map((entry) => ({ ...entry, name: `${entry.name}被改過` }));
  assert.ok(forged[1].teams.length > 0, "the tampered part really holds entries");
  await backend.call(SYNC, forged[0]);
  await rejectsWith(backend.call(SYNC, forged[1]), "invalid_params");
  assert.equal((await status(backend)).generation, good);
  assert.equal(readProfileFile(base).generation, good);
  const wrongHash = partsOf({ ...SAMPLE, projects: [] }, 1)[0];
  await rejectsWith(backend.call(SYNC, { ...wrongHash, generation: "0".repeat(64) }), "invalid_params");
  assert.equal((await status(backend)).generation, good);
  const changedOmitted = partsOf({ ...SAMPLE, projects: [] }, 1)[0];
  await rejectsWith(backend.call(SYNC, { ...changedOmitted, omitted: { agents: 1, teams: 0, projects: 0 } }), "invalid_params");
  assert.deepEqual(memoryUiFiles(base), ["profile.json"]);
});

test("a part that duplicates an id across parts fails the generation check", async (t) => {
  const { backend } = startStore(t);
  const parts = partsOf(SAMPLE, 2);
  const merged = [...parts[0].agents.slice(0, 1), ...parts[1].agents].sort((left, right) => (left.id < right.id ? -1 : 1));
  await backend.call(SYNC, parts[0]);
  await rejectsWith(backend.call(SYNC, { ...parts[1], agents: merged }), "invalid_params");
  assert.equal((await status(backend)).generation, null);
});

test("the same generation already in effect answers complete:true, changed:false from the first part alone", async (t) => {
  const { backend, base } = startStore(t);
  const parts = partsOf(SAMPLE, 3, { sink: { pending: 4, lastWrittenAtMs: 1_700_000_000_000 } });
  await pushAll(backend, parts);
  const stamped = await status(backend);
  for (const index of [0, 2]) {
    const again = await backend.call(SYNC, parts[index]);
    assert.deepEqual(again, { accepted: true, generation: parts[0].generation, complete: true, changed: false, received: 1, agents: 4, teams: 2, projects: 2 });
  }
  const after = await status(backend);
  assert.equal(after.generation, stamped.generation);
  assert.equal(after.receivedAt, stamped.receivedAt, "the table was not replaced");
  assert.equal(readProfileFile(base).generation, stamped.generation);
});

test("another generation arriving discards the staged parts, and so does a different part count", async (t) => {
  const { backend } = startStore(t);
  const one = partsOf(SAMPLE, 2);
  const two = partsOf({ ...SAMPLE, agents: SAMPLE.agents.slice(0, 2) }, 2);
  await backend.call(SYNC, one[0]);
  await backend.call(SYNC, two[0]);
  const late = await backend.call(SYNC, one[1]);
  assert.deepEqual([late.complete, late.received], [false, 1], "the first table's staged part was dropped when the second generation arrived");
  await backend.call(SYNC, two[0]);
  const done = await backend.call(SYNC, two[1]);
  assert.equal(done.complete, true);
  assert.equal((await status(backend)).generation, two[0].generation);

  const fresh = startStore(t);
  const split = partsOf(SAMPLE, 2);
  const respliced = partsOf(SAMPLE, 3);
  await fresh.backend.call(SYNC, split[0]);
  const restarted = await fresh.backend.call(SYNC, respliced[0]);
  assert.deepEqual([restarted.complete, restarted.received], [false, 1], "the same generation cut into a different number of parts starts over");
});

test("a same-generation push refreshes the sink without replacing the table, and null is stored as unknown", async (t) => {
  const { backend, base, open } = startStore(t);
  await pushAll(backend, partsOf(SAMPLE, 1, { sink: { pending: 3, lastWrittenAtMs: 1_700_000_000_000 } }));
  const first = await status(backend);
  assert.deepEqual(first.sink, { pending: 3, lastWrittenAtMs: 1_700_000_000_000 });
  assert.match(first.sinkReceivedAt, /^\d{4}-/u);
  const refreshed = await backend.call(SYNC, partsOf(SAMPLE, 1, { sink: { pending: 0, lastWrittenAtMs: 1_700_000_500_000 } })[0]);
  assert.equal(refreshed.changed, false);
  const second = await status(backend);
  assert.deepEqual(second.sink, { pending: 0, lastWrittenAtMs: 1_700_000_500_000 });
  assert.equal(second.receivedAt, first.receivedAt);
  assert.deepEqual(readProfileFile(base).sink, { pending: 0, lastWrittenAtMs: 1_700_000_500_000 });
  const restarted = await status(open());
  assert.deepEqual(restarted.sink, { pending: 0, lastWrittenAtMs: 1_700_000_500_000 }, "the sink survives a restart");
  await backend.call(SYNC, partsOf(SAMPLE, 1, { sink: null })[0]);
  const unknown = await status(backend);
  assert.deepEqual([unknown.sink, unknown.sinkReceivedAt], [null, null]);
  await backend.call(SYNC, partsOf(SAMPLE, 1, { sink: { pending: 2, lastWrittenAtMs: null } })[0]);
  assert.deepEqual((await status(backend)).sink, { pending: 2, lastWrittenAtMs: null });
});

test("the effective table survives a restart, and Core's first part after it answers changed:false", async (t) => {
  const { backend, open } = startStore(t);
  const parts = partsOf(SAMPLE, 2);
  await pushAll(backend, parts);
  const restarted = open();
  const reloaded = await status(restarted);
  assert.deepEqual([reloaded.generation, reloaded.agents, reloaded.teams, reloaded.projects, reloaded.corrupt], [parts[0].generation, 4, 2, 2, false]);
  const again = await restarted.call(SYNC, parts[0]);
  assert.deepEqual([again.complete, again.changed], [true, false]);
});

test("omitted greater than zero is reported as an incomplete name table by ui.status and ui.overview", async (t) => {
  const { backend, base } = startStore(t);
  const omitted = { agents: 3, teams: 0, projects: 1 };
  await pushAll(backend, partsOf({ ...SAMPLE, omitted }, 2));
  const reported = await status(backend);
  assert.equal(reported.incomplete, true);
  assert.deepEqual(reported.omitted, omitted);
  assert.deepEqual(readProfileFile(base).omitted, omitted);
  const overview = await backend.call("ui.overview", OVERVIEW);
  assert.equal(overview.profile.incomplete, true);
  assert.deepEqual(overview.profile.omitted, omitted);
  await pushAll(backend, partsOf(SAMPLE, 1));
  assert.equal((await status(backend)).incomplete, false);
  const complete = await backend.call("ui.overview", OVERVIEW);
  assert.deepEqual([complete.profile.incomplete, complete.profile.omitted], [false, { agents: 0, teams: 0, projects: 0 }]);
});

test("parts of one generation that disagree on omitted are rejected and drop the staged parts", async (t) => {
  const { backend } = startStore(t);
  const parts = partsOf({ ...SAMPLE, omitted: { agents: 1, teams: 0, projects: 0 } }, 2);
  await backend.call(SYNC, parts[0]);
  await rejectsWith(backend.call(SYNC, { ...parts[1], omitted: { agents: 0, teams: 0, projects: 0 } }), "invalid_params");
  const retry = await backend.call(SYNC, parts[1]);
  assert.deepEqual([retry.complete, retry.received], [false, 1], "the staged first part was dropped with the rejection");
});

test("a request that breaks the contract schema is invalid_params and leaves staging alone", async (t) => {
  const { backend } = startStore(t);
  const parts = partsOf(SAMPLE, 2);
  await backend.call(SYNC, parts[0]);
  const { sink: _dropped, ...withoutSink } = parts[1];
  const broken = [
    { ...parts[1], part: 3 },
    { ...parts[1], extra: true },
    { ...parts[0], agents: [...parts[0].agents].reverse() },
    { ...parts[1], generation: "xyz" },
    withoutSink,
    "text",
    null,
  ];
  for (const params of broken) await rejectsWith(backend.call(SYNC, params), "invalid_params");
  const done = await backend.call(SYNC, parts[1]);
  assert.deepEqual([done.complete, done.received], [true, 2]);
});

test("a damaged profile.json is an empty table marked corrupt, and the next complete push repairs it", async (t) => {
  const damages = {
    "not json": () => "{ this is not json",
    empty: () => "",
    "wrong schema": () => JSON.stringify({ version: 1, generation: "abc" }),
    "wrong version": (good) => JSON.stringify({ ...good, version: 2 }),
    "content edited after the generation was computed": (good) => JSON.stringify({ ...good, agents: good.agents.map((entry) => ({ ...entry, name: `${entry.name}!` })) }),
    truncated: (good) => JSON.stringify(good).slice(0, 40),
    "an unknown extra field": (good) => JSON.stringify({ ...good, surprise: 1 }),
  };
  for (const [label, damage] of Object.entries(damages)) {
    const { backend, base, open } = startStore(t);
    await pushAll(backend, partsOf(SAMPLE, 1));
    const good = readProfileFile(base);
    await backend.dispose();
    writeFileSync(profileFilePath(base), damage(good));
    const revived = open();
    const reported = await status(revived);
    assert.deepEqual([reported.corrupt, reported.generation, reported.agents, reported.teams, reported.projects], [true, null, 0, 0, 0], label);
    const overview = await revived.call("ui.overview", OVERVIEW);
    assert.equal(overview.profile.corrupt, true, label);
    const repaired = await pushAll(revived, partsOf(SAMPLE, 2));
    assert.equal(repaired.changed, true, label);
    const after = await status(revived);
    assert.deepEqual([after.corrupt, after.agents], [false, 4], label);
    assert.equal(readProfileFile(base).generation, good.generation, label);
  }
});

test("a missing profile.json is an empty table that is not marked corrupt", async (t) => {
  const { backend } = startStore(t);
  const reported = await status(backend);
  assert.deepEqual([reported.corrupt, reported.incomplete, reported.generation, reported.receivedAt], [false, false, null, null]);
});

test("a temp file left by an interrupted write does not affect reading, and the next write removes it", async (t) => {
  const { backend, base, open } = startStore(t);
  const parts = partsOf(SAMPLE, 1);
  await pushAll(backend, parts);
  await backend.dispose();
  writeFileSync(join(base, "memory-ui", "profile.json.0123456789abcdef.tmp"), '{"version":1,"generation":"half written');
  const revived = open();
  const reloaded = await status(revived);
  assert.deepEqual([reloaded.generation, reloaded.corrupt], [parts[0].generation, false]);
  const next = partsOf({ ...SAMPLE, projects: [] }, 1);
  await pushAll(revived, next);
  assert.deepEqual(memoryUiFiles(base), ["profile.json"]);
  assert.equal(readProfileFile(base).generation, next[0].generation);
});

test("a write that fails before the rename leaves the old file and the old table, and answers internal", async (t) => {
  const failures = {
    "the rename fails": { rename: () => { throw new Error("EPERM"); } },
    "the temp write fails after a partial write": { writeTemp: (path) => { writeFileSync(path, "{ half"); throw new Error("ENOSPC"); } },
  };
  for (const [label, override] of Object.entries(failures)) {
    let broken = false;
    const io = {
      writeTemp: (path, text) => (broken && override.writeTemp !== undefined ? override.writeTemp(path, text) : writeFileSync(path, text, { flag: "wx" })),
      rename: (from, to) => (broken && override.rename !== undefined ? override.rename(from, to) : renameSync(from, to)),
    };
    const { backend, base } = startStore(t, { profileIo: io });
    const before = partsOf(SAMPLE, 1);
    await pushAll(backend, before);
    broken = true;
    const next = partsOf({ ...SAMPLE, projects: [] }, 2);
    await backend.call(SYNC, next[0]);
    await rejectsWith(backend.call(SYNC, next[1]), "internal");
    assert.equal((await status(backend)).generation, before[0].generation, label);
    assert.equal(readProfileFile(base).generation, before[0].generation, label);
    assert.deepEqual(memoryUiFiles(base), ["profile.json"], `${label}: the failed write cleans up its temp file`);
    broken = false;
    await pushAll(backend, next);
    assert.equal((await status(backend)).generation, next[0].generation, `${label}: Core's resend succeeds`);
  }
});

test("a disabled fsync (Node permission model, ERR_ACCESS_DENIED) does not fail the write, any other fsync error does", async (t) => {
  const denied = createProfileIo(() => { throw Object.assign(new Error("fsync API is disabled when Permission Model is enabled."), { code: "ERR_ACCESS_DENIED" }); });
  const first = startStore(t, { profileIo: denied });
  const parts = partsOf(SAMPLE, 1);
  await pushAll(first.backend, parts);
  assert.equal(readProfileFile(first.base).generation, parts[0].generation);
  assert.deepEqual(memoryUiFiles(first.base), ["profile.json"]);
  const failing = createProfileIo(() => { throw Object.assign(new Error("disk"), { code: "EIO" }); });
  const second = startStore(t, { profileIo: failing });
  await rejectsWith(pushAll(second.backend, parts), "internal");
  assert.equal(profileFileExists(second.base), false);
  assert.deepEqual(memoryUiFiles(second.base), []);
});

test("a memory-ui directory that is a link is refused: the table reads as corrupt and nothing is written through it", async (t) => {
  const { base, open } = startStore(t);
  const target = mkdtempSync(join(tmpdir(), "teamuq-profile-link-"));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  mkdirSync(base, { recursive: true });
  symlinkSync(target, join(base, "memory-ui"), "junction");
  const backend = open();
  assert.equal((await status(backend)).corrupt, true);
  await rejectsWith(pushAll(backend, partsOf(SAMPLE, 1)), "internal");
  assert.deepEqual(readdirSync(target), [], "nothing was written through the link");
});

test("the name table is stored and served even while Cairn storage is unavailable", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "teamuq-profile-nostorage-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  writeFileSync(join(base, "memory-cairn-v1"), "this is a file where the data directory should be");
  const { createBackend } = await import("../out/backend/service.js");
  const { PIN_PATH } = await import("./backendHarness.mjs");
  const backend = createBackend({ dataRoot: join(base, "memory-cairn-v1"), pinPath: PIN_PATH });
  t.after(() => backend.dispose());
  const before = await backend.call("ui.status", {});
  assert.notEqual(before.storage.status, "ready");
  await pushAll(backend, partsOf(SAMPLE, 2));
  const after = await backend.call("ui.status", {});
  assert.deepEqual([after.profile.agents, after.profile.teams, after.profile.projects], [4, 2, 2]);
});

function bulk(agentCount, teamCount, projectCount, label) {
  const teams = Array.from({ length: teamCount }, (_, index) => ({ key: `team-${String(index).padStart(4, "0")}`, name: label(`部門${index}`) }));
  const agents = Array.from({ length: agentCount }, (_, index) => {
    const team = teams[index % teamCount].key;
    return agentEntry(`${team}/agent-${String(index).padStart(5, "0")}-${"長".repeat(10)}`, label(`代理人${index}`), team, label(`職稱${index}`));
  });
  const projects = Array.from({ length: projectCount }, (_, index) => ({ id: `project-${String(index).padStart(5, "0")}-${"x".repeat(8)}`, name: label(`專案${index}`), archived: index % 7 === 0 }));
  return { agents, teams, projects };
}

test("a table of real dev scale (113 agents, 21 teams, 10 projects) is one part and becomes effective", async (t) => {
  const { backend } = startStore(t);
  const input = bulk(113, 21, 10, (text) => text);
  const parts = partsOf(input, 1, { sink: { pending: 0, lastWrittenAtMs: 1_700_000_000_000 } });
  assert.ok(Buffer.byteLength(JSON.stringify(parts[0])) < MEMORY_PROFILE_LIMITS.partBudgetBytes);
  const answer = await backend.call(SYNC, parts[0]);
  assert.deepEqual([answer.complete, answer.changed, answer.received, answer.agents, answer.teams, answer.projects], [true, true, 1, 113, 21, 10]);
  assert.equal((await status(backend)).generation, generationOf(snapshotOf(input)));
});

test("an oversized table cut into 5 parts within the params limit becomes effective only with all five", async (t) => {
  const { backend, base } = startStore(t);
  const { maxAgents, maxTeams, maxProjects } = MEMORY_PROFILE_LIMITS;
  const parts = partsOf(bulk(maxAgents, maxTeams, maxProjects, (text) => text), 5);
  for (const part of parts) assert.ok(Buffer.byteLength(JSON.stringify(part)) <= 256 * 1024, "a part fits the 256 KiB params limit");
  for (const part of parts.slice(0, 4)) assert.equal((await backend.call(SYNC, part)).complete, false);
  assert.equal(profileFileExists(base), false);
  const done = await backend.call(SYNC, parts[4]);
  assert.deepEqual([done.complete, done.changed, done.received, done.agents, done.teams, done.projects], [true, true, 5, maxAgents, maxTeams, maxProjects]);
  assert.equal((await status(backend)).generation, parts[0].generation);
  const again = await backend.call(SYNC, parts[3]);
  assert.deepEqual([again.complete, again.changed], [true, false]);
});
