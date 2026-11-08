import assert from "node:assert/strict";
import test from "node:test";
import { count, makeAgent, tokenize } from "./homeFixtures.mjs";
import {
  AGENT_ID,
  EMPTY_STATS,
  NOW,
  SPACE_ALLOWED_ATTRIBUTES,
  SPACE_ALLOWED_TAGS,
  clone,
  createSpace,
  failure,
  makeItem,
  makeStats,
  opened,
  sectionOf,
  statsClient,
  ui,
} from "./spaceFixtures.mjs";

const { STRINGS, spaceShell, bindSpaceEvents } = ui;

function assertSafe(markup, label) {
  const { tags, rest } = tokenize(markup);
  assert.ok(!/[<>]/u.test(rest), `${label}: a raw angle bracket survived: ${rest.match(/.{0,30}[<>].{0,30}/u)?.[0]}`);
  for (const tag of tags) {
    assert.ok(SPACE_ALLOWED_TAGS.has(tag.name), `${label}: unexpected tag <${tag.name}>`);
    for (const [name, value] of tag.attributes) {
      assert.ok(SPACE_ALLOWED_ATTRIBUTES.has(name), `${label}: unexpected attribute ${name} on <${tag.name}>`);
      assert.ok(value === null || !/[<>"]/u.test(value), `${label}: attribute ${name} carries a raw bracket or quote`);
    }
  }
}

test("the four representative memories show the request, when it ran, the tool, where it was kept and the result", async () => {
  const { targets } = await opened();
  const reps = sectionOf(targets.body.innerHTML, "space-h-rep");
  const cards = reps.split("<article").slice(1);
  assert.equal(cards.length, 4);
  assert.ok(cards[0].includes("請求標題 1") && cards[0].includes("第 1 筆的成果說明"));
  assert.ok(/\d{4}-\d{2}-\d{2} 14:05～14:35/u.test(cards[0]), "the work's own start and end are shown in local time");
  assert.ok(cards[0].includes("claude / opus-4"));
  assert.ok(cards[0].includes("官網改版") && cards[0].includes('data-scope="project"') && cards[0].includes('data-project-id="proj-alpha"'));
  assert.ok(cards[1].includes(`・${STRINGS["space.rep.personal"]}`) && cards[1].includes('data-project-id=""'));
  assert.ok(cards[0].includes('data-memory-id="mem-1"'));
});

test("a representative memory without work details or text still gets a readable card", async () => {
  const stats = makeStats({
    representative: [
      makeItem(1, { work: undefined, snippet: "  " }),
      makeItem(2, { work: { startIso: "not a time", endIso: "also not", cli: null, model: "gpt-5", title: " " } }),
      makeItem(3, { ref: { agentId: AGENT_ID, scope: "project", projectId: "0123456789abcdef", memoryId: "m3" }, names: undefined }),
    ],
  });
  const { targets } = await opened(stats);
  const reps = sectionOf(targets.body.innerHTML, "space-h-rep");
  assert.equal(count(reps, /<article class="rep"/gu), 3);
  assert.ok(reps.includes(STRINGS["space.rep.noTitle"]) && reps.includes(STRINGS["space.rep.noSnippet"]));
  assert.ok(reps.includes("寫入 "), "no usable work time falls back to the write time");
  assert.ok(reps.includes("專案 01234567"), "a project the table does not name is shown by the project word and its id prefix");
  assert.ok(!/undefined|NaN|null/u.test(reps));
});

test("the sampled note appears only when the statistics cover the newest part", async () => {
  assert.ok(!(await opened(makeStats({ sampled: false }))).targets.body.innerHTML.includes(STRINGS["space.sampled"]));
  assert.ok((await opened(makeStats({ sampled: true }))).targets.body.innerHTML.includes(STRINGS["space.sampled"]));
});

test("NOT_FOUND and a zero total are the empty state: an explanation, no charts, and still a header", async () => {
  const hint = makeAgent(3, { id: AGENT_ID, name: "開發工程師" });
  const zero = makeStats({ namespaces: [{ scope: "personal", projectId: null, count: 0, firstAt: null, lastAt: null, project: null }] });
  for (const answer of [failure("NOT_FOUND"), zero]) {
    const { targets, space } = createSpace({ client: statsClient(() => clone(answer)) });
    await space.open(AGENT_ID, hint, targets);
    assert.equal(space.view().phase, "empty");
    const body = targets.body.innerHTML;
    assert.ok(body.includes(STRINGS["space.empty.title"]) && body.includes(STRINGS["space.empty.body"]));
    assert.ok(!body.includes("<section") && !body.includes("<i "), "no chart and no section");
    assert.ok(!body.includes('role="alert"'), "an empty space is not an error");
    assert.ok(!body.includes(STRINGS["error.NOT_FOUND.message"]), "the memory-shaped not-found sentence is never shown for an agent");
    assert.equal(targets.title.textContent, "開發工程師");
    assert.equal(targets.id.textContent, AGENT_ID);
  }
});

test("a failed read shows the plain message, the suggested action and a retry button only when retrying can help", async () => {
  const answers = [failure("STORAGE_BUSY"), makeStats()];
  const client = statsClient(() => answers.shift());
  const { targets, space, open } = createSpace({ client });
  await open();
  assert.equal(space.view().phase, "error");
  const body = targets.body.innerHTML;
  assert.ok(body.includes(STRINGS["error.STORAGE_BUSY.message"]) && body.includes(STRINGS["error.STORAGE_BUSY.action"]));
  assert.ok(body.includes('data-code="STORAGE_BUSY"') && body.includes('role="alert"'));
  assert.ok(body.includes('<button type="button" class="btn" data-act="retrySpace">'));
  assert.ok(!body.includes("<section"), "no half-drawn page next to the error");
  assert.equal(targets.title.textContent, "developer", "without stats or a card the title is the id tail");
  await space.retry();
  assert.equal(space.view().phase, "ready");
  assert.equal(client.calls.length, 2);
  assert.ok(targets.body.innerHTML.includes("space-h-spaces"));
  assert.ok(!targets.body.innerHTML.includes('role="alert"'));

  for (const code of ["plugin_disabled", "plugin_permission_denied", "backend_method_not_allowed", "STORAGE_UNSUPPORTED", "INVALID_PARAMS"]) {
    const refused = createSpace({ client: statsClient(() => failure(code)) });
    await refused.open();
    assert.equal(refused.space.view().phase, "error", code);
    assert.ok(!refused.targets.body.innerHTML.includes("data-act"), `${code} offers no retry`);
    assert.ok(refused.targets.body.innerHTML.includes(STRINGS[`error.${code}.message`]), code);
  }
});

test("an answer the page cannot read, or one for another agent, is an error and never an empty space", async () => {
  for (const [label, answer] of [
    ["garbage", { ok: true, hello: "world" }],
    ["short hours", { ...makeStats(), byHour: [1, 2, 3] }],
    ["another agent", makeStats({ agentId: "ops/someone-else" })],
  ]) {
    const { targets, space, open } = createSpace({ client: statsClient(() => clone(answer)) });
    await open();
    assert.equal(space.view().phase, "error", label);
    assert.ok(targets.body.innerHTML.includes(STRINGS["error.malformed_response.message"]), label);
    assert.ok(targets.body.innerHTML.includes('data-act="retrySpace"'), label);
  }
});

test("a late answer for an agent the reader already left is dropped, and so is one that arrives after the page was closed", async () => {
  const gates = [];
  const client = statsClient(() => new Promise((resolve) => gates.push(resolve)));
  const { targets, space } = createSpace({ client });
  const first = space.open("sw/first", undefined, targets);
  const second = space.open("sw/second", undefined, targets);
  await new Promise((resolve) => setImmediate(resolve));
  gates[1](makeStats({ agentId: "sw/second", agent: { displayName: "第二位", teamKey: "sw" } }));
  await second;
  gates[0](makeStats({ agentId: "sw/first", agent: { displayName: "第一位", teamKey: "sw" } }));
  await first;
  assert.equal(targets.title.textContent, "第二位", "the first agent's answer arrived later and was ignored");
  assert.equal(space.view().agentId, "sw/second");

  const third = space.open("sw/third", undefined, targets);
  await new Promise((resolve) => setImmediate(resolve));
  space.close();
  const before = targets.title.textContent;
  gates[2](makeStats({ agentId: "sw/third", agent: { displayName: "第三位", teamKey: "sw" } }));
  await third;
  assert.equal(targets.title.textContent, before, "a closed page is never written to");
});

test("a superseded request does not touch the page", async () => {
  const { targets, space, open } = createSpace({ client: statsClient(() => ({ ...failure("superseded"), superseded: true })) });
  await open();
  assert.equal(space.view().phase, "loading");
  assert.ok(targets.body.innerHTML.includes(STRINGS["space.loading"]));
});

test("while loading, the page shows a busy skeleton with a status line and the summary the card wall already knew", async () => {
  const hint = makeAgent(3, { id: AGENT_ID, name: "開發工程師" });
  const { targets, space } = createSpace({ client: statsClient(() => new Promise(() => undefined)) });
  void space.open(AGENT_ID, hint, targets);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(space.view().phase, "loading");
  assert.ok(targets.body.innerHTML.includes('role="status"') && targets.body.innerHTML.includes(STRINGS["space.loading"]));
  assert.ok(targets.body.innerHTML.includes('aria-hidden="true"') && targets.body.innerHTML.includes("skeleton"));
  assert.equal(targets.title.textContent, "開發工程師");
  assert.ok(targets.meta.textContent.startsWith(`累積 ${hint.counts.total} 筆`), targets.meta.textContent);
});

test("the title falls back from the stats name to the card wall's name to the id, and is never empty", async () => {
  const hint = makeAgent(3, { id: "hw/layout", name: "版圖員" });
  const withStats = createSpace({ client: statsClient(() => makeStats({ agentId: "hw/layout", agent: { displayName: "", name: "", teamKey: "hw" } })), agentId: "hw/layout", hint });
  await withStats.open();
  assert.equal(withStats.targets.title.textContent, "版圖員", "a blank stats name defers to the card's name");
  const plain = createSpace({ client: statsClient(() => makeStats({ agentId: "hw/layout", agent: undefined })), agentId: "hw/layout" });
  await plain.open();
  assert.equal(plain.targets.title.textContent, "layout", "no name anywhere: the last segment of the id, with the whole id under it");
  assert.equal(plain.targets.id.textContent, "hw/layout");
  assert.ok(plain.targets.meta.textContent.includes("累積 22 筆"));
  const named = createSpace({ client: statsClient(() => makeStats({ agentId: "hw/layout", agent: { displayName: "layout（hw）", teamKey: "hw" } })), agentId: "hw/layout" });
  await named.open();
  assert.equal(named.targets.title.textContent, "layout（hw）", "the backend's own degraded display name is used as sent");
  assert.ok(!named.targets.meta.textContent.includes("部門"), "the header carries no department");
  const noTeam = createSpace({ client: statsClient(() => makeStats({ agent: { displayName: "獨行俠", teamKey: "" } })) });
  await noTeam.open();
  assert.ok(!noTeam.targets.meta.textContent.includes("部門"), "the header carries no department");
});

test("hostile ids, names and texts are escaped everywhere on the page", async () => {
  const payload = `"><script>alert(1)</script><img src=x onerror=alert(2)>`;
  const hostile = makeStats({
    agent: { displayName: payload, name: payload, title: payload, teamKey: payload, teamName: payload },
    namespaces: [
      { scope: "personal", projectId: null, count: 2, firstAt: null, lastAt: null, project: null },
      { scope: "project", projectId: payload, count: 3, firstAt: null, lastAt: null, project: { displayName: payload, name: payload } },
    ],
    tools: [{ cli: payload, model: payload, n: 3 }],
    repeatedRequests: [{ title: payload, count: 4 }],
    representative: [
      makeItem(1, {
        snippet: payload,
        ref: { agentId: AGENT_ID, scope: "project", projectId: payload, memoryId: payload },
        work: { startIso: "2026-09-30T06:00:00.000Z", endIso: "2026-09-30T06:30:00.000Z", cli: payload, model: payload, title: payload },
        names: { agent: { displayName: payload, teamKey: payload }, project: { displayName: payload } },
      }),
    ],
  });
  const { targets } = await opened(hostile);
  assertSafe(targets.body.innerHTML, "body");
  assert.ok(!targets.body.innerHTML.includes("<script") && !targets.body.innerHTML.includes("<img"));
  assert.ok(targets.body.innerHTML.includes("&lt;script&gt;"), "the text is shown, escaped");
  assertSafe(targets.avatar.innerHTML, "avatar");
  const failed = createSpace({ client: statsClient(() => failure("STORAGE_BUSY")), agentId: `t/${payload}` });
  await failed.open();
  assertSafe(failed.targets.body.innerHTML, "error body");
  assertSafe(failed.targets.avatar.innerHTML, "error avatar");
});

test("every markup the page produces uses only known tags and attributes: shell, ready, flat, no projects, empty and error", async () => {
  assertSafe(spaceShell().value, "shell");
  assertSafe((await opened()).targets.body.innerHTML, "ready");
  assertSafe((await opened(EMPTY_STATS)).targets.body.innerHTML, "flat");
  assertSafe((await opened(makeStats({ namespaces: [makeStats().namespaces[0]], sampled: true }))).targets.body.innerHTML, "no projects");
  const gone = createSpace({ client: statsClient(() => failure("NOT_FOUND")) });
  await gone.open();
  assertSafe(gone.targets.body.innerHTML, "empty");
  const broken = createSpace({ client: statsClient(() => failure("STORAGE_BUSY")) });
  await broken.open();
  assertSafe(broken.targets.body.innerHTML, "error");
});

test("the shell keeps a way back first in the tab order, a focusable title that is never replaced, and the timeline slot outside the re-rendered body", () => {
  const markup = spaceShell().value;
  const order = [...markup.matchAll(/<(a|button|select|input|textarea)\b|tabindex="(-?\d+)"/gu)].map((match) => match[1] ?? `tabindex=${match[2]}`);
  assert.deepEqual(order, ["a", "tabindex=-1"], "the back link is the only tab stop, and the title can take programmatic focus");
  assert.ok(markup.includes('<a class="btn-link" href="#/" data-back>← 回到團隊</a>'));
  assert.ok(markup.includes('<h2 id="space-title" tabindex="-1"></h2>'));
  assert.ok(!/tabindex="[1-9]/u.test(markup));
  for (const id of ["space-avatar", "space-id", "space-meta", "space-body"]) assert.ok(markup.includes(`id="${id}"`), id);
  assert.ok(markup.indexOf('id="space-body"') < markup.indexOf('id="space-timeline"') && markup.includes('data-slot="timeline"'));
  assert.ok(markup.includes('id="space-body" class="space-body"></div>'), "the body is an empty container the controller fills, and the slot is not inside it");
  assert.ok(!/[<>]/u.test(tokenize(markup).rest));
});

test("a ready page adds no tab stops of its own, and an error adds exactly one: the retry button", async () => {
  const ready = (await opened()).targets.body.innerHTML;
  assert.ok(!/<(a|button|select|input)\b|tabindex=/u.test(ready), "charts and cards are read, not focused");
  const broken = createSpace({ client: statsClient(() => failure("STORAGE_BUSY")) });
  await broken.open();
  assert.equal(count(broken.targets.body.innerHTML, /<button\b/gu), 1);
  assert.ok(!/<a\b|tabindex=/u.test(broken.targets.body.innerHTML));
});

test("the retry click is the only event the page listens for", () => {
  const listeners = [];
  const root = { addEventListener: (type, listener) => listeners.push({ type, listener }) };
  const log = [];
  bindSpaceEvents(root, { retry: () => log.push("retry") });
  assert.deepEqual(listeners.map((entry) => entry.type), ["click"]);
  const click = (act) => listeners[0].listener({ target: { closest: () => (act === null ? null : { dataset: { act } }) } });
  click("retrySpace");
  click("reload");
  click(null);
  listeners[0].listener({ target: null });
  listeners[0].listener({ target: {} });
  assert.deepEqual(log, ["retry"]);
});

test("the same data renders the same page, so a refresh does not make it flicker", async () => {
  const first = (await opened()).targets.body.innerHTML;
  const again = (await opened(makeStats(), { now: () => NOW })).targets.body.innerHTML;
  assert.equal(first, again);
});
