import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { MINUTE, NOW, det, getResponse, iso, refOf, siblingItem, workContent } from "./detailFixtures.mjs";
import { UI_ROOT } from "./uiViewHarness.mjs";

test("parseDetail keeps everything the drawer shows: memory, work, names, receipts and same-session items", () => {
  const response = getResponse({ sameSession: [siblingItem("m2")], revision: 4 });
  const parsed = det.parseDetail(response);
  assert.deepEqual(parsed.ref, refOf("m1"));
  assert.equal(parsed.revision, 4);
  assert.equal(parsed.kind, "context");
  assert.equal(parsed.content, response.memory.content);
  assert.equal(parsed.work.title, "整理週報");
  assert.equal(parsed.agentName, "開發小幫手");
  assert.equal(parsed.projectName, undefined);
  assert.equal(parsed.receipts.length, 1);
  assert.equal(parsed.sameSession[0].ref.memoryId, "m2");
  const noWork = det.parseDetail(getResponse({ work: null }));
  assert.equal(noWork.work, undefined);
});

test("a response that does not have the contract's shape is rejected, never shown as an empty memory", () => {
  const good = getResponse();
  const clone = () => JSON.parse(JSON.stringify(good));
  const cases = {
    "not an object": null,
    "array": [],
    "not ok": { ok: false },
    "no memory": { ...clone(), memory: undefined },
    "revision zero": (() => Object.assign(clone(), { memory: { ...clone().memory, revision: 0 } }))(),
    "revision a string": (() => Object.assign(clone(), { memory: { ...clone().memory, revision: "1" } }))(),
    "content a number": (() => Object.assign(clone(), { memory: { ...clone().memory, content: 7 } }))(),
    "bad scope": (() => Object.assign(clone(), { memory: { ...clone().memory, ref: { ...good.memory.ref, scope: "team" } } }))(),
    "receipts not a list": { ...clone(), receipts: {} },
    "bad receipt role": { ...clone(), receipts: [{ ...good.receipts[0], role: "system" }] },
    "receipt missing a field": { ...clone(), receipts: [{ client: "claude" }] },
    "bad sibling": { ...clone(), sameSession: [{ nope: true }] },
    "bad work": { ...clone(), work: { startIso: 1 } },
  };
  for (const [label, value] of Object.entries(cases)) assert.equal(det.parseDetail(value), null, label);
});

test("the agent and project names come from the name table, and a blank name counts as missing", () => {
  const named = det.parseDetail(getResponse({ names: { agent: { displayName: "小幫手", teamKey: "sw" }, project: { displayName: "官網" } } }));
  assert.equal(named.agentName, "小幫手");
  assert.equal(named.projectName, "官網");
  const blank = det.parseDetail(getResponse({ names: { agent: { displayName: "  ", teamKey: "sw" }, project: { displayName: "" } } }));
  assert.equal(blank.agentName, null);
  assert.equal(blank.projectName, undefined);
});

test("the request and the result of a work record come from the one parser that owns the prefix; anything else is shown whole", () => {
  const work = det.detailText(det.parseDetail(getResponse()));
  assert.deepEqual(work, { request: "整理週報", result: "已整理完成", isWork: true });
  const unnamed = det.detailText(det.parseDetail(getResponse({ content: workContent({ title: "(未命名)" }), work: { startIso: iso(NOW), endIso: iso(NOW), cli: null, model: null, title: null } })));
  assert.equal(unnamed.request, null);
  assert.equal(unnamed.result, "已整理完成");
  const noText = det.detailText(det.parseDetail(getResponse({ content: workContent({ body: "(無文字)" }) })));
  assert.equal(noText.result, "");
  const plain = det.detailText(det.parseDetail(getResponse({ content: "手動筆記\n第二行", work: null })));
  assert.deepEqual(plain, { request: null, result: "手動筆記\n第二行", isWork: false });
});

test("after a forget focus goes to the next memory, else the previous one, else nothing but the card that opened the drawer", () => {
  const keys = ["a", "b", "c"];
  assert.deepEqual(det.focusCandidates(keys, "a", "a"), ["b"]);
  assert.deepEqual(det.focusCandidates(keys, "b", "b"), ["c", "a"]);
  assert.deepEqual(det.focusCandidates(keys, "c", "c"), ["b"]);
  assert.deepEqual(det.focusCandidates(["a"], "a", "a"), []);
  assert.deepEqual(det.focusCandidates(keys, "x", "b"), ["b"], "a forgotten memory that is not listed leaves the opener");
  assert.deepEqual(det.focusCandidates(keys, "x", null), []);
  assert.deepEqual(det.focusCandidates([], "x", null), []);
});

test("the receipt limit and the contract shape are tied to the contract, so a drift fails the type check instead of the screen", () => {
  assert.equal(det.RECEIPTS_MAX, 12);
  assert.deepEqual(det.DETAIL_CONTRACT_MATCHES, [true, true, true, true]);
});

test("edgeTab only steps in at the two ends of the drawer and leaves every other Tab to the browser", () => {
  assert.deepEqual(det.edgeTab(1, 4, false), { kind: "natural" });
  assert.deepEqual(det.edgeTab(2, 4, true), { kind: "natural" });
  assert.deepEqual(det.edgeTab(3, 4, false), { kind: "focus", index: 0 });
  assert.deepEqual(det.edgeTab(0, 4, true), { kind: "focus", index: 3 });
  assert.deepEqual(det.edgeTab(-1, 4, true), { kind: "focus", index: 3 }, "focus on the title or container steps back to the last control");
  assert.deepEqual(det.edgeTab(-1, 4, false), { kind: "natural" });
  assert.deepEqual(det.edgeTab(0, 1, false), { kind: "focus", index: 0 });
  assert.deepEqual(det.edgeTab(0, 1, true), { kind: "focus", index: 0 });
  assert.deepEqual(det.edgeTab(0, 0, false), { kind: "focus", index: -1 });
});

test("clicks on the data-dt controls reach the matching action, and the timeline's and home's controls are left alone", () => {
  const log = [];
  let handler = null;
  det.bindDetailEvents({ addEventListener: (_type, listener) => (handler = listener) }, {
    retry: () => log.push("retry"),
    closeReload: () => log.push("closeReload"),
    forget: () => log.push("forget"),
    sibling: (key) => log.push(`sibling:${key}`),
  });
  const hit = (dataset) => ({ closest: () => ({ dataset }) });
  for (const dt of ["retry", "closeReload", "forget", "unknown"]) handler({ target: hit({ dt }) });
  handler({ target: hit({ dt: "sibling", dtKey: '["a","personal",null,"m2"]' }) });
  handler({ target: hit({ dt: "sibling" }) });
  handler({ target: hit({ tl: "open", tlKey: "x" }) });
  handler({ target: hit({ act: "reload" }) });
  handler({ target: { closest: () => null } });
  handler({ target: {} });
  handler({ target: null });
  assert.deepEqual(log, ["retry", "closeReload", "forget", 'sibling:["a","personal",null,"m2"]']);
});

test("the hour-and-minute formatter exists once: localClock is gone and clock.ts serves the space page and the timeline", () => {
  assert.equal(existsSync(join(UI_ROOT, "i18n", "localClock.ts")), false);
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts") && /timeOfDay|localClock/u.test(readFileSync(path, "utf8"))) offenders.push(path);
    }
  };
  walk(UI_ROOT);
  assert.deepEqual(offenders, []);
  const at = new Date(2026, 8, 30, 9, 5).getTime();
  assert.equal(det.clockTime(at), "09:05");
  assert.equal(det.monthDay("2026-09-30"), "9/30");
  assert.equal(det.monthDay("broken"), "broken");
  assert.equal(det.dateTime(at + MINUTE), "2026-09-30 09:06");
});

test("the timeline title can take focus, because it is where focus lands after the last card is forgotten", () => {
  assert.equal(det.TIMELINE_IDS.title, "tl-title");
  assert.match(det.timelineShell().value, /<h2 id="tl-title" class="tl-h" tabindex="-1">/u);
});
