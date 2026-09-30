import { NOW, failure, ui } from "./homeFixtures.mjs";

export { NOW, failure, ui };

const pad = (value) => String(value).padStart(2, "0");

export function dayKey(back) {
  const at = new Date(2026, 8, 30 - back);
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

export const AGENT_ID = "sw/developer";
const localIso = (day, hour, minute) => new Date(2026, 8, day, hour, minute).toISOString();

export function makeItem(index, overrides = {}) {
  const projectId = index % 2 === 0 ? null : "proj-alpha";
  return {
    ref: { agentId: AGENT_ID, scope: projectId === null ? "personal" : "project", projectId, memoryId: `mem-${index}` },
    kind: "context",
    revision: 1,
    updatedAt: localIso(30 - index, 15, 40),
    snippet: `第 ${index} 筆的成果說明`,
    work: { startIso: localIso(30 - index, 14, 5), endIso: localIso(30 - index, 14, 35), cli: "claude", model: "opus-4", title: `請求標題 ${index}` },
    receiptCount: 2,
    names: { agent: { displayName: "開發工程師", teamKey: "sw" }, project: projectId === null ? null : { displayName: "官網改版", name: "官網改版" } },
    ...overrides,
  };
}

export function makeStats(overrides = {}) {
  return {
    ok: true,
    agentId: AGENT_ID,
    agent: { displayName: "開發工程師", name: "開發工程師", title: "寫程式的人", teamKey: "sw", teamName: "軟體開發組" },
    namespaces: [
      { scope: "personal", projectId: null, count: 12, firstAt: localIso(2, 9, 0), lastAt: localIso(30, 11, 0), project: null },
      { scope: "project", projectId: "proj-alpha", count: 7, firstAt: localIso(10, 9, 0), lastAt: localIso(29, 11, 0), project: { displayName: "官網改版", name: "官網改版" } },
      { scope: "project", projectId: "proj-unnamed-0001", count: 3, firstAt: localIso(12, 9, 0), lastAt: localIso(20, 11, 0), project: { displayName: "專案 proj-unn" } },
    ],
    byDay30: Array.from({ length: 30 }, (_, index) => ({ date: dayKey(29 - index), count: index % 5 === 0 ? 0 : (index % 7) + 1 })),
    byHour: Array.from({ length: 24 }, (_, hour) => (hour >= 9 && hour <= 18 ? hour - 7 : 0)),
    byWeekday: [0, 5, 6, 7, 4, 3, 1],
    tools: [
      { cli: "claude", model: "opus-4", n: 14 },
      { cli: "codex", model: "gpt-5", n: 6 },
      { cli: null, model: null, n: 2 },
    ],
    repeatedRequests: [
      { title: "整理本週工作", count: 5 },
      { title: "檢查結帳流程", count: 2 },
    ],
    representative: [1, 2, 3, 4].map((index) => makeItem(index)),
    sampled: false,
    ...overrides,
  };
}

export const EMPTY_STATS = makeStats({
  namespaces: [{ scope: "personal", projectId: null, count: 1, firstAt: null, lastAt: null, project: null }],
  byDay30: Array.from({ length: 30 }, (_, index) => ({ date: dayKey(29 - index), count: 0 })),
  byHour: new Array(24).fill(0),
  byWeekday: new Array(7).fill(0),
  tools: [],
  repeatedRequests: [],
  representative: [],
});

export function fakeSpaceTargets() {
  return { avatar: { innerHTML: "" }, title: { textContent: "" }, id: { textContent: "" }, meta: { textContent: "" }, body: { innerHTML: "" } };
}

// why: the fake client answers from a function so a test can return a stats object, a failure or a promise it settles itself
export function statsClient(answer) {
  const calls = [];
  return {
    calls,
    async call(method, params, options) {
      calls.push({ method, params, options });
      const given = await answer(params, calls.length);
      return given !== null && typeof given === "object" && given.ok === false && "code" in given && "superseded" in given ? given : { ok: true, value: given };
    },
  };
}

export function createSpace({ client, now = () => NOW, agentId = AGENT_ID, hint } = {}) {
  const targets = fakeSpaceTargets();
  const space = ui.createMemorySpace({ client, now });
  return { space, targets, open: () => space.open(agentId, hint, targets) };
}

export const SPACE_ALLOWED_TAGS = new Set(["a", "article", "b", "br", "button", "div", "h2", "h3", "h4", "header", "i", "li", "p", "section", "span", "strong", "ul"]);
export const SPACE_ALLOWED_ATTRIBUTES = new Set([
  "aria-hidden", "aria-label", "aria-labelledby", "aria-live", "class", "data-act", "data-back", "data-code", "data-memory-id", "data-project-id", "data-scope", "data-slot", "href", "id", "role", "style", "tabindex", "title", "type",
]);


export const clone = (value) => JSON.parse(JSON.stringify(value));
export const sectionOf = (markup, id) => markup.split("</section>").find((part) => part.includes(`id="${id}"`)) ?? "";

export async function opened(stats = makeStats(), extra = {}) {
  const client = statsClient(() => clone(stats));
  const made = createSpace({ client, ...extra });
  await made.open();
  return { ...made, client };
}
