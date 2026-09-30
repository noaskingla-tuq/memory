import assert from "node:assert/strict";
import test from "node:test";
import { NOW, makeAgent, tokenize, ALLOWED_ATTRIBUTES, ALLOWED_TAGS, ui } from "./homeFixtures.mjs";

const { bindHomeEvents, renderMemorySpaceShell, homeShell, STRINGS } = ui;

function recorder() {
  const log = [];
  const actions = {
    reload: () => log.push("reload"),
    loadMore: () => log.push("loadMore"),
    dismissHelp: () => log.push("dismissHelp"),
    showHelp: () => log.push("showHelp"),
    setTeam: (value) => log.push(`team:${value}`),
    setSort: (value) => log.push(`sort:${value}`),
  };
  const handlers = {};
  bindHomeEvents({ addEventListener: (type, listener) => (handlers[type] = listener) }, actions);
  return { log, handlers };
}

const hit = (dataset, value) => ({ closest: () => ({ dataset, ...(value === undefined ? {} : { value }) }) });

test("clicks on the data-act controls reach the matching action and nothing else does", () => {
  const { log, handlers } = recorder();
  for (const act of ["reload", "loadMore", "dismissHelp", "showHelp", "unknown"]) handlers.click({ target: hit({ act }) });
  handlers.click({ target: { closest: () => null } });
  handlers.click({ target: {} });
  handlers.click({ target: null });
  assert.deepEqual(log, ["reload", "loadMore", "dismissHelp", "showHelp"]);
});

test("changes on the department and sort selects carry their value, and other changes are ignored", () => {
  const { log, handlers } = recorder();
  handlers.change({ target: hit({ role: "team" }, "t:sw") });
  handlers.change({ target: hit({ role: "sort" }, "count") });
  handlers.change({ target: hit({ role: "other" }, "x") });
  handlers.change({ target: hit({ role: "team" }) });
  handlers.change({ target: {} });
  assert.deepEqual(log, ["team:t:sw", "sort:count"]);
});

test("the home shell has every container the controller writes into, and only safe markup", () => {
  const markup = homeShell().value;
  for (const id of ["home-help", "home-banner", "home-tiles", "home-tools", "home-count", "home-note", "home-wall"]) assert.ok(markup.includes(`id="${id}"`), id);
  assert.ok(markup.includes('id="home-count" class="muted count" aria-live="polite"'), "the count is a live region");
  assert.equal(tokenize(markup).rest.trim(), "");
});

test("the memory space page is an empty shell with a way back, the agent's name and a plain note that it is coming", () => {
  const agent = makeAgent(3, { id: "sw/developer", name: "開發工程師" });
  const markup = renderMemorySpaceShell("sw/developer", agent, NOW).value;
  assert.ok(markup.includes('href="#/"') && markup.includes(STRINGS["space.back"]));
  assert.ok(markup.includes('<h2 id="space-title" tabindex="-1">開發工程師</h2>'), "focus can land on the title after navigation");
  assert.ok(markup.includes(">sw/developer<") && markup.includes("累積 ") && markup.includes("最近寫入"));
  assert.ok(markup.includes(STRINGS["space.soon.title"]));
  assert.ok(markup.includes("之後這裡會顯示 開發工程師 的個人與專案記憶"));
  const unknown = renderMemorySpaceShell("hw/layout", undefined, NOW).value;
  assert.ok(unknown.includes(">layout</h2>") && unknown.includes(">hw/layout<"), "an agent that is not loaded still gets a title from its id");
  assert.ok(!/undefined|null/u.test(unknown));
});

test("the memory space page escapes a hostile id and name", () => {
  const payload = `"><script>alert(1)</script><img src=x onerror=alert(2)>`;
  const markup = renderMemorySpaceShell(`t/${payload}`, makeAgent(1, { id: `t/${payload}`, name: payload }), NOW).value;
  const { tags, rest } = tokenize(markup);
  assert.ok(!/[<>]/u.test(rest));
  for (const tag of tags) {
    assert.ok(ALLOWED_TAGS.has(tag.name), tag.name);
    for (const [name] of tag.attributes) assert.ok(ALLOWED_ATTRIBUTES.has(name), name);
  }
  assert.ok(!markup.includes("<script") && !markup.includes("<img"));
});
