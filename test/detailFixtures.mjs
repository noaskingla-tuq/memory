import { FakeDocument } from "./fakeDom.mjs";
import { loadUiModule } from "./uiViewHarness.mjs";

export const det = await loadUiModule(
  "state/detail.ts",
  "state/timeline.ts",
  "views/detailController.ts",
  "views/detailView.ts",
  "views/detailEvents.ts",
  "views/timelineView.ts",
  "components/drawer.ts",
  "components/dialog.ts",
  "components/dialogFocus.ts",
  "api/errors.ts",
  "dom/html.ts",
  "i18n/index.ts",
  "i18n/zhTW.ts",
  "i18n/detailStrings.ts",
  "i18n/clock.ts",
);

export const NOW = new Date(2026, 8, 30, 12, 0, 0).getTime();
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const AGENT = "sw/developer";
export const iso = (ms) => new Date(ms).toISOString();
export const hhmm = (ms) => `${String(new Date(ms).getHours()).padStart(2, "0")}:${String(new Date(ms).getMinutes()).padStart(2, "0")}`;

const minute = (ms) => `${new Date(ms).toISOString().slice(0, 16)}Z`;

// why: the backend stores the NFKC form of a work record, so the fixture is written in that form (ASCII colon and tilde) to match what ui.get really returns
export function workContent({ startMs = NOW - 90 * MINUTE, minutes = 30, cli = "claude", model = "opus-4", title = "整理週報", body = "已整理完成" } = {}) {
  return `[工作紀錄 ${minute(startMs)}~${minute(startMs + minutes * MINUTE)} ${cli}/${model}] 請求:${title}。成果:${body}`;
}

export const refOf = (id, overrides = {}) => ({ agentId: AGENT, scope: "personal", projectId: null, memoryId: id, ...overrides });

export function getResponse(overrides = {}) {
  const ref = overrides.ref ?? refOf("m1");
  const startMs = NOW - 90 * MINUTE;
  return {
    ok: true,
    memory: { ref, kind: "context", revision: overrides.revision ?? 1, createdAt: iso(NOW - 80 * MINUTE), updatedAt: iso(NOW - 60 * MINUTE), content: overrides.content ?? workContent({ startMs }) },
    ...("work" in overrides ? (overrides.work === null ? {} : { work: overrides.work }) : { work: { startIso: iso(startMs), endIso: iso(startMs + 30 * MINUTE), cli: "claude", model: "opus-4", title: "整理週報" } }),
    names: overrides.names ?? { agent: { displayName: "開發小幫手", teamKey: "sw" }, project: null },
    receipts: overrides.receipts ?? [{ client: "claude", sessionId: "S-100", eventId: "ev-1", role: "user", createdAt: iso(NOW - 75 * MINUTE) }],
    sameSession: overrides.sameSession ?? [],
  };
}

export function siblingItem(id, overrides = {}) {
  return { ref: refOf(id), kind: "context", revision: 1, updatedAt: iso(NOW - 70 * MINUTE), snippet: `同次工作的 ${id}`, receiptCount: 1, ...overrides };
}

export const ok = (value) => ({ ok: true, value });
export const fail = (code) => ({ ok: false, superseded: code === "superseded", attempts: 1, ...det.describeError(code) });

export function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export const flush = async (turns = 3) => {
  for (let index = 0; index < turns; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

// why: each handler answers one method; its second argument is how many times that method has been called, so a test can answer the same request differently the second time
export function fakeClient(handlers) {
  const calls = [];
  return {
    calls,
    of: (method) => calls.filter((call) => call.method === method),
    async call(method, params, options) {
      calls.push({ method, params: { ...params }, options });
      const count = calls.filter((call) => call.method === method).length;
      const handler = handlers[method];
      if (handler === undefined) throw new Error(`fake client has no handler for ${method}`);
      return handler(params, count);
    },
  };
}

export const keyOf = (ref) => det.itemKey(ref);

// why: a fake page stands in for the timeline, with the same two jobs the real one has: hand out the card for a key and replace every card when the list is reloaded
export function scene({ client, ids = ["m1", "m2", "m3"], reload } = {}) {
  const doc = new FakeDocument();
  const header = doc.createElement("header");
  const main = doc.createElement("main");
  doc.body.appendChild(header);
  doc.body.appendChild(main);
  const heading = doc.createElement("h2");
  heading.setAttribute("tabindex", "-1");
  heading.id = "tl-title";
  main.appendChild(heading);
  let current = [...ids];
  const cards = new Map();
  const timers = [];
  const schedule = {
    set(callback, ms) {
      timers.push({ callback, ms, cleared: false });
      return timers.length - 1;
    },
    clear(handle) {
      timers[handle].cleared = true;
    },
  };
  function paint() {
    for (const card of cards.values()) card.remove();
    cards.clear();
    for (const id of current) {
      const card = doc.createElement("button");
      card.setAttribute("type", "button");
      card.setAttribute("data-tl-key", keyOf(refOf(id)));
      main.appendChild(card);
      cards.set(keyOf(refOf(id)), card);
    }
  }
  paint();
  const reloads = [];
  const detail = det.createDetail({
    client,
    document: doc,
    host: doc.body,
    schedule,
    reloadList: async () => {
      reloads.push([...current]);
      if (reload !== undefined) await reload({ set: (next) => (current = next), current: () => current });
      paint();
    },
    listKeys: () => current.map((id) => keyOf(refOf(id))),
    cardFor: (key) => {
      const card = cards.get(key);
      return card !== undefined && card.isConnected ? card : null;
    },
    listHeading: () => heading,
    backgrounds: () => [header, main],
  });
  const all = (tag) => doc.root.querySelectorAll(tag);
  const find = (tag, predicate) => all(tag).find(predicate);
  return {
    doc,
    header,
    main,
    heading,
    detail,
    timers,
    reloads,
    setIds(next) {
      current = next;
      paint();
    },
    card: (id) => cards.get(keyOf(refOf(id))),
    drawer: () => find("aside", (element) => element.getAttribute("role") === "dialog"),
    dialog: () => find("div", (element) => element.getAttribute("role") === "alertdialog"),
    status: () => find("div", (element) => element.getAttribute("role") === "status"),
    buttons: (root = doc.root) => root.querySelectorAll("button"),
    drawerButton: (predicate) => find("button", (button) => predicate(button) && detail.element()?.contains(button)),
    forgetButton: () => find("button", (button) => button.getAttribute("data-dt") === "forget"),
    closeButton: () => find("button", (button) => button.getAttribute("aria-label") === "關閉詳情"),
    dialogButton: (action) => find("button", (button) => button.getAttribute("data-dialog-action") === action),
    click: (element, extra = {}) => doc.dispatch(element, "click", extra),
    clickData(dt, dtKey) {
      const dataset = dtKey === undefined ? { dt } : { dt, dtKey };
      return doc.dispatch(detail.element(), "click", { target: { closest: () => ({ dataset }) } });
    },
  };
}
