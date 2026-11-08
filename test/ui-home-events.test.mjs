import assert from "node:assert/strict";
import test from "node:test";
import { tokenize, ui } from "./homeFixtures.mjs";

const { bindHomeEvents, homeShell } = ui;

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
  for (const id of ["home-help", "home-banner", "home-tiles", "home-tools", "home-count", "home-wall"]) assert.ok(markup.includes(`id="${id}"`), id);
  assert.ok(markup.includes('id="home-count" class="muted count" aria-live="polite"'), "the count is a live region");
  assert.equal(tokenize(markup).rest.trim(), "");
});
