import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { UI_ROOT, loadUiModule } from "./uiViewHarness.mjs";

const ui = await loadUiModule("state/zoom.ts", "views/zoomControl.ts", "i18n/index.ts");
const { ZOOM_KEY, ZOOM_MAX, ZOOM_MIN, bindZoomControl, createZoom, normalizeZoom, t } = ui;

function memoryStore(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { data, get: (key) => data.get(key) ?? null, set: (key, value) => data.set(key, value) };
}

test("the zoom starts at 100, moves 10 at a time and stays between 80 and 150", () => {
  const applied = [];
  const zoom = createZoom(memoryStore(), (percent) => applied.push(percent));
  assert.deepEqual(applied, [100], "the page is sized once on start");
  for (let index = 0; index < 5; index += 1) zoom.smaller();
  assert.equal(zoom.percent(), ZOOM_MIN);
  assert.equal(zoom.smaller(), ZOOM_MIN, "pressing past the end changes nothing");
  for (let index = 0; index < 10; index += 1) zoom.larger();
  assert.equal(zoom.percent(), ZOOM_MAX);
  assert.equal(zoom.larger(), ZOOM_MAX);
  assert.deepEqual(applied, [100, 90, 80, 90, 100, 110, 120, 130, 140, 150]);
  assert.equal(zoom.reset(), 100);
  assert.equal(applied.at(-1), 100);
});

test("the chosen size is stored and a reload (a new zoom over the same storage) starts from it", () => {
  const store = memoryStore();
  const first = createZoom(store, () => undefined);
  first.larger();
  first.larger();
  assert.equal(store.data.get(ZOOM_KEY), "120");
  const applied = [];
  const reloaded = createZoom(store, (percent) => applied.push(percent));
  assert.equal(reloaded.percent(), 120);
  assert.deepEqual(applied, [120], "the stored size is applied before anything is drawn");
  reloaded.reset();
  assert.equal(createZoom(store, () => undefined).percent(), 100, "reset is remembered too");
});

test("a stored value that is junk, off-step or out of range is pulled back to an allowed size", () => {
  for (const [raw, expected] of [[null, 100], ["", 100], ["abc", 100], ["NaN", 100], ["Infinity", 100], ["400", 150], ["10", 80], ["-5", 80], ["113", 110], ["115", 120], ["95", 100]]) assert.equal(normalizeZoom(raw), expected, String(raw));
  assert.equal(createZoom(memoryStore({ [ZOOM_KEY]: "999" }), () => undefined).percent(), 150);
});

test("a store that remembers nothing still lets the size change for the session", () => {
  const throwing = { get: () => null, set: () => undefined };
  const zoom = createZoom(throwing, () => undefined);
  assert.equal(zoom.larger(), 110);
});

function fakeRoot() {
  const nodes = new Map(["out", "in", "reset"].map((name) => [`[data-zoom="${name}"]`, { textContent: "", attributes: new Map(), setAttribute(key, value) { this.attributes.set(key, value); } }]));
  const status = { textContent: "", attributes: new Map(), setAttribute(key, value) { this.attributes.set(key, value); } };
  const group = { textContent: "", attributes: new Map(), setAttribute(key, value) { this.attributes.set(key, value); } };
  nodes.set("[data-zoom-status]", status);
  nodes.set("[data-zoom-group]", group);
  let listener = null;
  return {
    nodes,
    root: { addEventListener: (_type, callback) => { listener = callback; }, querySelector: (selector) => nodes.get(selector) ?? null },
    press: (action) => listener({ target: { closest: (selector) => (selector === "[data-zoom]" ? { dataset: { zoom: action } } : null) } }),
    pressElsewhere: () => listener({ target: { closest: () => null } }),
  };
}

test("the three buttons carry spoken labels, act on the zoom, and tell the current size", () => {
  const harness = fakeRoot();
  const zoom = createZoom(memoryStore(), () => undefined);
  bindZoomControl(harness.root, zoom);
  const out = harness.nodes.get('[data-zoom="out"]');
  const larger = harness.nodes.get('[data-zoom="in"]');
  const reset = harness.nodes.get('[data-zoom="reset"]');
  assert.equal(out.attributes.get("aria-label"), "A− 縮小文字");
  assert.equal(larger.attributes.get("aria-label"), "A＋ 放大文字");
  assert.equal(reset.attributes.get("aria-label"), "重設文字大小（目前 100%）");
  assert.deepEqual([out.textContent, larger.textContent, reset.textContent], ["A−", "A＋", "重設"]);
  assert.equal(harness.nodes.get("[data-zoom-group]").attributes.get("aria-label"), "文字大小");
  assert.equal(reset.attributes.get("aria-disabled"), "true", "already at the default");
  harness.press("in");
  harness.press("in");
  assert.equal(zoom.percent(), 120);
  assert.equal(harness.nodes.get("[data-zoom-status]").textContent, "120%", "a polite status announces the size");
  assert.equal(reset.attributes.get("aria-label"), "重設文字大小（目前 120%）");
  assert.equal(reset.attributes.get("aria-disabled"), "false");
  harness.press("out");
  assert.equal(zoom.percent(), 110);
  harness.pressElsewhere();
  assert.equal(zoom.percent(), 110, "other clicks do nothing");
  harness.press("reset");
  assert.equal(zoom.percent(), 100);
  for (let index = 0; index < 6; index += 1) harness.press("in");
  assert.equal(larger.attributes.get("aria-disabled"), "true", "the end is announced, the button stays focusable");
  assert.equal(t("zoom.value", { percent: 150 }), "150%");
});

const read = (file) => readFileSync(join(UI_ROOT, file), "utf8");
const css = readdirSync(join(UI_ROOT, "styles")).filter((name) => name.endsWith(".css") && name !== "tokens.css").map((name) => read(`styles/${name}`)).join("\n");
const indexHtml = readFileSync(join(UI_ROOT, "..", "..", "plugin", "ui", "index.html"), "utf8");

test("the page frame: header and content share one width and one gutter, and the root size follows --zoom", () => {
  assert.match(css, /html \{[^}]*font-size: calc\(100% \* var\(--zoom, 1\)\);/u);
  assert.match(css, /\.hdr-in \{[^}]*max-width: var\(--page-max\);[^}]*margin: 0 auto;[^}]*padding: var\(--sp-3\) var\(--page-pad\);/u);
  assert.match(css, /main \{[^}]*max-width: var\(--page-max\);[^}]*margin: 0 auto;[^}]*padding: var\(--sp-4\) var\(--page-pad\) 48px;/u);
  assert.match(css, /--page-pad: clamp\(16px, 4vw, 24px\);/u, "never less than 16px on either side");
  assert.ok(!/\.hdr \{[^}]*padding/u.test(css), "the outer header bar has no gutter of its own, the inner box has it");
  const sizes = [...css.matchAll(/font-size: (\d+(?:\.\d+)?)px/gu)];
  assert.deepEqual(sizes.map((match) => match[0]), [], "every font size is in rem so the zoom reaches it");
});

test("the header holds the three zoom buttons inside the inner box, as real buttons whose aria-labels come from i18n", () => {
  const inner = /<div class="hdr-in">([\s\S]*)<\/div>\s*<\/header>/u.exec(indexHtml);
  assert.ok(inner !== null, "header content sits in .hdr-in");
  for (const action of ["out", "in", "reset"]) assert.match(inner[1], new RegExp(`<button type="button" class="btn zoom-btn" data-zoom="${action}">`, "u"));
  assert.ok(!/\son[a-z]+\s*=|<script(?![^>]*src=)/iu.test(indexHtml), "no inline handler or script");
});

test("charts and bars are sized in rem and the grids shrink, so a larger root size reflows instead of overflowing", () => {
  assert.match(css, /\.space-body \.cols \{[^}]*height: 3\.5rem;/u);
  assert.match(css, /\.space-body \.bar-track \{[^}]*height: 0\.5rem;/u);
  assert.match(css, /grid-template-columns: minmax\(5rem, 42%\) minmax\(0, 1fr\) minmax\(4\.5em, max-content\);/u);
  assert.match(css, /\.spark \{[^}]*width: 5\.25rem;[^}]*height: 1\.5rem;/u);
  assert.match(css, /\.tl-search input \{[^}]*flex: 1 1 12\.5rem;[^}]*min-width: 0;/u);
});

test("each zoom button has a spoken label that contains its visible text, written once in i18n", () => {
  const harness = fakeRoot();
  bindZoomControl(harness.root, createZoom(memoryStore(), () => undefined));
  for (const action of ["out", "in", "reset"]) {
    const node = harness.nodes.get(`[data-zoom="${action}"]`);
    assert.ok(node.attributes.get("aria-label").includes(node.textContent), action + " label includes its visible text");
  }
  const html = readFileSync(new URL("../plugin/ui/index.html", import.meta.url), "utf8");
  const buttons = [...html.matchAll(/<button[^>]*data-zoom="\w+"([^>]*)>([^<]*)<\/button>/g)];
  assert.equal(buttons.length, 3);
  for (const [, attrs, text] of buttons) {
    assert.ok(text.length > 0, "the HTML keeps the visible text so the buttons read before the script runs");
    assert.ok(!/aria-label/.test(attrs), "the spoken label has one source");
  }
});
