import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { readCairn } from "../out/adapters/ui/cairnReader.js";
import { uiWorkSchema } from "../out/contracts/uiContract.js";
import { parsePunchContent } from "../out/application/ui/punchContent.js";
import { REPO_ROOT } from "./backendHarness.mjs";
import { actorOf, databasePathOf, openStore, scratchDirectory } from "./readerHarness.mjs";

const FIXTURES = join(REPO_ROOT, "vendor", "teamuq-contract", "fixtures", "requests");

function prefixFixtures() {
  const files = readdirSync(FIXTURES).filter((name) => name.startsWith("remember.work-prefix-"));
  return files.map((name) => {
    const fixture = JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
    const [, variant, form] = /^remember\.work-prefix-(.+)\.(core-form|nfkc-form)\.json$/u.exec(name) ?? [];
    return { name, variant, form, content: fixture.params.ops[0].content };
  });
}

const EXPECTED = {
  normal: {
    work: { startIso: "2026-09-29T03:15:00.000Z", endIso: "2026-09-29T03:42:00.000Z", cli: "claude", model: "claude-opus-4-7", title: "修正登入頁的表單驗證" },
    body: "已修正(含空白欄位)並補上測試 100%。",
  },
  "no-text": {
    work: { startIso: "2026-09-29T03:15:00.000Z", endIso: "2026-09-29T03:42:00.000Z", cli: "claude", model: "claude-opus-4-7", title: "修正登入頁的表單驗證" },
    body: "",
  },
  unnamed: {
    work: { startIso: "2026-09-29T03:15:00.000Z", endIso: "2026-09-29T03:42:00.000Z", cli: "codex", model: "gpt-5.1-codex", title: null },
    body: "已修正(含空白欄位)並補上測試 100%。",
  },
};

test("the Core fixtures cover three prefix variants in both the written form and the NFKC form", () => {
  const found = prefixFixtures();
  assert.deepEqual(found.map((item) => `${item.variant}/${item.form}`).sort(), [
    "no-text/core-form",
    "no-text/nfkc-form",
    "normal/core-form",
    "normal/nfkc-form",
    "unnamed/core-form",
    "unnamed/nfkc-form",
  ]);
  assert.ok(found.some((item) => item.form === "core-form" && item.content.includes("～") && item.content.includes("：")), "the written form has fullwidth punctuation");
  assert.ok(found.every((item) => item.form !== "nfkc-form" || (!item.content.includes("～") && item.content.includes("~"))), "the NFKC form has ASCII punctuation");
});

test("every Core fixture sample, before and after NFKC, parses to the same work, title and body", () => {
  for (const { name, variant, content } of prefixFixtures()) {
    const parsed = parsePunchContent(content);
    assert.equal(parsed.parsed, true, name);
    assert.deepEqual(parsed.work, EXPECTED[variant].work, name);
    assert.equal(parsed.body, EXPECTED[variant].body, name);
    assert.equal(uiWorkSchema.safeParse(parsed.work).success, true, name);
  }
});

test("what Cairn really stores for the written form parses exactly like the fixture NFKC form", async (t) => {
  const base = scratchDirectory(t, "punch");
  const { app, root } = openStore(base, t);
  const actor = actorOf("sw/developer");
  for (const { name, form, content } of prefixFixtures().filter((item) => item.form === "core-form")) {
    const written = await app.execute("memory_remember", { scope: "personal", kind: "context", content, operationId: `punch-${name}` }, actor);
    assert.equal(written.ok, true, name);
    const stored = readCairn(databasePathOf(root, "sw/developer"), (reader) =>
      reader.get({ ownerId: "sw/developer", scope: "personal", projectId: null }, written.value.memory.id, 1),
    );
    assert.equal(stored.ok, true);
    const storedContent = stored.value.memory.content;
    assert.equal(storedContent, content.normalize("NFKC"), `${name}: Cairn stores the NFKC form`);
    assert.notEqual(storedContent, content, `${name}: the written form really differs`);
    const twin = prefixFixtures().find((item) => item.form === "nfkc-form" && item.name === name.replace("core-form", "nfkc-form"));
    assert.equal(storedContent, twin.content, `${name}: it equals the fixture NFKC sample`);
    assert.deepEqual(parsePunchContent(storedContent), parsePunchContent(content));
    assert.equal(form, "core-form");
  }
});

test("text that is not a work-record prefix falls back to the original content untouched", () => {
  const inputs = [
    "",
    "just a plain memory",
    "使用者偏好簡短回答：不要重複題目（全形標點保持原樣）",
    "[工作紀錄 2026-09-29T03:15Z~2026-09-29T03:42Z claude/x] 沒有請求欄位",
    "[工作紀錄 2026-13-45T25:61Z~2026-09-29T03:42Z claude/x] 請求:a。成果:b",
    "[工作紀錄 2026-02-30T03:15Z~2026-09-29T03:42Z claude/x] 請求:a。成果:b",
    "[工作紀錄 2026-09-29T03:15:00Z~2026-09-29T03:42Z claude/x] 請求:a。成果:b",
    "[工作紀錄 2026-09-29T03:15Z~2026-09-29T03:42Z claude] 請求:a。成果:b",
    "前綴 [工作紀錄 2026-09-29T03:15Z~2026-09-29T03:42Z claude/x] 請求:a。成果:b",
    "[工作紀錄 2026-09-29T03:15Z~2026-09-29T03:42Z claude/x] 請求:被截斷的很長標題沒有結尾",
  ];
  for (const input of inputs) assert.deepEqual(parsePunchContent(input), { parsed: false, body: input }, input);
});

test("titles and bodies keep their own punctuation, unknown cli and model become null, and the first terminator ends the title", () => {
  const written = "[工作紀錄 2026-09-29T03:15Z～2026-09-29T03:42Z unknown/unknown] 請求：修正。第二句、含「引號」。成果：內容裡再出現。成果：也要保留。";
  const parsed = parsePunchContent(written);
  assert.equal(parsed.parsed, true);
  assert.deepEqual(parsed.work, {
    startIso: "2026-09-29T03:15:00.000Z",
    endIso: "2026-09-29T03:42:00.000Z",
    cli: null,
    model: null,
    title: "修正。第二句、含「引號」",
  });
  assert.equal(parsed.body, "內容裡再出現。成果:也要保留。");
});

test("a maximum length record with the elision marker parses, and a read of only its first characters does not guess", () => {
  const title = "長".repeat(300);
  const body = `${"甲".repeat(2000)} …… ${"乙".repeat(1000)}`;
  const content = `[工作紀錄 2026-09-29T03:15Z～2026-09-29T03:42Z claude/claude-opus-4-7] 請求：${title}。成果：${body}`.normalize("NFKC");
  const parsed = parsePunchContent(content);
  assert.equal(parsed.parsed, true);
  assert.equal(parsed.work.title, title);
  assert.equal(parsed.body, body.normalize("NFKC"));
  const snippet = [...content].slice(0, 160).join("");
  assert.deepEqual(parsePunchContent(snippet), { parsed: false, body: snippet });
});
