import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { UI_ROOT, loadUiModule } from "./uiViewHarness.mjs";

const { esc, html, isSafeHtml, SafeHtml, mount, EMPTY_HTML } = await loadUiModule("dom/html.ts");

const HOSTILE = [
  "<script>alert(1)</script>",
  "<img src=x onerror=alert(1)>",
  '" onmouseover="alert(1)',
  "' onfocus='alert(1)",
  "`onclick=`alert(1)",
  "</textarea><script>",
  "javascript:alert(1)",
  "&lt;already&gt; & &amp;",
  "a\u0000b c",
  "<!-- --><svg/onload=alert(1)>",
];

test("esc escapes the five HTML metacharacters and the backtick, and turns null and undefined into nothing", () => {
  assert.equal(esc('<a href="x">&\'`'), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&#96;");
  assert.equal(esc(null), "");
  assert.equal(esc(undefined), "");
  assert.equal(esc(0), "0");
  assert.equal(esc(false), "false");
  assert.equal(esc("&amp;"), "&amp;amp;");
  for (const sample of HOSTILE) assert.ok(!/[<>"'`]/u.test(esc(sample)), sample);
});

test("interpolated text is escaped, while the template's own markup and nested html fragments stay", () => {
  for (const sample of HOSTILE) {
    const out = html`<p>${sample}</p>`.value;
    assert.equal(out, `<p>${esc(sample)}</p>`);
    assert.equal((out.match(/</gu) ?? []).length, 2, sample);
  }
  const inner = html`<b>${"<i>"}</b>`;
  assert.equal(html`<p>${inner}</p>`.value, "<p><b>&lt;i&gt;</b></p>");
  assert.equal(html`<ul>${["a", "<b>"].map((item) => html`<li>${item}</li>`)}</ul>`.value, "<ul><li>a</li><li>&lt;b&gt;</li></ul>");
  assert.equal(html`<p>${null}${undefined}${false}${true}${0}${1.5}</p>`.value, "<p>01.5</p>");
  assert.equal(html`<p>${["<x>", "y"]}</p>`.value, "<p>&lt;x&gt;y</p>");
});

test("a quoted attribute value cannot be broken out of with quotes, angle brackets or backticks", () => {
  for (const sample of HOSTILE) {
    const double = html`<div title="${sample}">x</div>`.value;
    assert.equal(double, `<div title="${esc(sample)}">x</div>`);
    const between = double.slice(double.indexOf('"') + 1, double.lastIndexOf('">'));
    assert.ok(!/["<>]/u.test(between), sample);
    const single = html`<div title='${sample}'>x</div>`.value;
    assert.equal(single, `<div title='${esc(sample)}'>x</div>`);
    assert.ok(!/['<>]/u.test(single.slice(single.indexOf("'") + 1, single.lastIndexOf("'>"))), sample);
  }
});

test("fuzz: no random string from a hostile alphabet ever adds a tag or an attribute", () => {
  const alphabet = ['<', '>', '"', "'", "&", "`", "=", " ", "/", "o", "n", "e", "r", ":", ";", "\n", "\t", "j", "s", "!", "-"];
  let state = 0x2545f491;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  for (let round = 0; round < 800; round += 1) {
    const length = 1 + (next() % 24);
    let sample = "";
    for (let index = 0; index < length; index += 1) sample += alphabet[next() % alphabet.length];
    const out = html`<p class="row" title="${sample}" data-n='${sample}'>${sample}</p>`.value;
    assert.equal((out.match(/</gu) ?? []).length, 2, JSON.stringify(sample));
    assert.equal((out.match(/"/gu) ?? []).length, 4, JSON.stringify(sample));
    assert.equal((out.match(/'/gu) ?? []).length, 2, JSON.stringify(sample));
    assert.equal(out, `<p class="row" title="${esc(sample)}" data-n='${esc(sample)}'>${esc(sample)}</p>`);
  }
});

test("only the html tag can mint a SafeHtml, and a fragment is refused inside an attribute", () => {
  assert.throws(() => new SafeHtml(Symbol("guess"), "<script>"), TypeError);
  assert.equal(isSafeHtml(html`<p></p>`), true);
  assert.equal(isSafeHtml("<p></p>"), false);
  assert.equal(isSafeHtml({ value: "<p></p>" }), false);
  assert.equal(EMPTY_HTML.value, "");
  assert.throws(() => html`<a title="${html`<b>`}">x</a>`, TypeError);
  assert.throws(() => html`<a title="${["a"]}">x</a>`, TypeError);
});

test("an interpolation outside text or a quoted attribute value is refused", () => {
  const value = "x";
  assert.throws(() => html`<a title=${value}>x</a>`, /afterEq|not allowed/u);
  assert.throws(() => html`<a title=a${value}>x</a>`, TypeError);
  assert.throws(() => html`<${value}>x</${value}>`, TypeError);
  assert.throws(() => html`<a ${value}>x</a>`, TypeError);
  assert.throws(() => html`<a data-${value}="1">x</a>`, TypeError);
  assert.throws(() => html`<a title="1" ${value}="2">x</a>`, TypeError);
  assert.throws(() => html`<!-- ${value} -->`, TypeError);
  assert.throws(() => html`<script>var a = "${value}";</script>`, TypeError);
  assert.throws(() => html`<style>a { color: ${value}; }</style>`, TypeError);
  assert.throws(() => html`<div></div${value}>`, TypeError);
});

test("text inside title and textarea is escaped, and text after a closed script stays text", () => {
  assert.equal(html`<textarea>${"</textarea><b>"}</textarea>`.value, "<textarea>&lt;/textarea&gt;&lt;b&gt;</textarea>");
  assert.throws(() => html`<textarea>${html`<b>`}</textarea>`, TypeError);
  assert.equal(html`<script src="app.js"></script><p>${"<x>"}</p>`.value, '<script src="app.js"></script><p>&lt;x&gt;</p>');
  assert.equal(html`<p>a < b ${"c"}</p>`.value, "<p>a < b c</p>");
  assert.equal(html`<input disabled> ${"<"}`.value, "<input disabled> &lt;");
  assert.equal(html`<br/>${"<"}`.value, "<br/>&lt;");
  assert.equal(html`<!-- note --><p>${"<"}</p>`.value, "<!-- note --><p>&lt;</p>");
});

test("event handler attributes are refused even when the template writes them itself", () => {
  assert.throws(() => html`<button onclick="run()">x</button>`, /event handler/u);
  assert.throws(() => html`<button onmouseover='run()'>x</button>`, /event handler/u);
  assert.throws(() => html`<button ONCLICK="run()">x</button>`, /event handler/u);
  assert.throws(() => html`<img src="a" onerror>`, /event handler/u);
  assert.equal(html`<button data-onclick="1" class="one">${"x"}</button>`.value, '<button data-onclick="1" class="one">x</button>');
});

test("a value that starts a URL attribute cannot use a script scheme, and style values stay plain", () => {
  for (const sample of ["javascript:alert(1)", "  JaVaScRiPt:alert(1)", "java\tscript:alert(1)", "java\nscript:alert(1)", "data:text/html,<b>", "vbscript:x"]) {
    assert.equal(html`<a href="${sample}">x</a>`.value, '<a href="#">x</a>', JSON.stringify(sample));
    assert.equal(html`<img src="${sample}">`.value, '<img src="#">', JSON.stringify(sample));
  }
  assert.equal(html`<a href="#agent-${"a b"}">x</a>`.value, '<a href="#agent-a b">x</a>');
  assert.equal(html`<a href="${"#ok"}">x</a>`.value, '<a href="#ok">x</a>');
  assert.equal(html`<i style="width:${42}%"></i>`.value, '<i style="width:42%"></i>');
  assert.equal(html`<i style="width:${"12.5"}%"></i>`.value, '<i style="width:12.5%"></i>');
  for (const sample of ["1;position:fixed", "url(x)", "1}a{", 'x"y', "a\\b", "expression(1)"]) {
    assert.throws(() => html`<i style="width:${sample}"></i>`, TypeError, sample);
  }
});

test("mount writes the fragment through innerHTML and nothing else", () => {
  const target = { innerHTML: "old" };
  mount(target, html`<p>${"<b>"}</p>`);
  assert.equal(target.innerHTML, "<p>&lt;b&gt;</p>");
});

function sources(directory) {
  return readdirSync(directory).flatMap((name) => {
    const full = join(directory, name);
    return statSync(full).isDirectory() ? sources(full) : full.endsWith(".ts") ? [full] : [];
  });
}

test("innerHTML is written only by mount and the dialog body, and bridge APIs stay in UI API adapters", () => {
  const writers = [];
  const bridge = [];
  for (const file of sources(UI_ROOT)) {
    const text = readFileSync(file, "utf8");
    const name = relative(UI_ROOT, file).split("\\").join("/");
    if (/innerHTML|outerHTML|insertAdjacentHTML|document\.write/u.test(text)) writers.push(name);
    if (/tuqPlugin/u.test(text)) bridge.push(name);
  }
  assert.deepEqual(writers.sort(), ["components/dialog.ts", "dom/html.ts"]);
  assert.deepEqual(bridge.sort(), ["api/agentAvatarClient.ts", "api/backendClient.ts"]);
});
