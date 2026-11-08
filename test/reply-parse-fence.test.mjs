import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseReply } from "../out/adapters/model/replyParse.js";

const F = String.fromCharCode(96).repeat(3);
const VALUE = { items: [{ content: "a", kind: "decision" }] };
const JSON_TEXT = JSON.stringify(VALUE, null, 2);

const cases = [
  ["a json fence", F + "json\n" + JSON_TEXT + "\n" + F],
  ["a fence without a language", F + "\n" + JSON_TEXT + "\n" + F],
  ["a json fence with blanks around it", "  \n\n" + F + "json\n" + JSON_TEXT + "\n" + F + "  \n\n"],
  ["a json fence with trailing blanks after the language", F + "json   \n" + JSON_TEXT + "\n" + F],
  ["CRLF line ends", (F + "json\n" + JSON_TEXT + "\n" + F).replaceAll("\n", "\r\n")],
  ["CRLF line ends and no language", (F + "\n" + JSON_TEXT + "\n" + F).replaceAll("\n", "\r\n")],
  ["a one-line json body", F + "json\n" + JSON.stringify(VALUE) + "\n" + F],
  ["plain JSON", JSON_TEXT],
  ["plain JSON with blanks", "\n  " + JSON_TEXT + "  \n"],
];

for (const [name, text] of cases) {
  test("parseReply reads " + name, () => {
    assert.deepEqual(parseReply(text), VALUE);
  });
}

test("parseReply still refuses text that is not JSON, fenced or not", () => {
  for (const text of ["not json", F + "json\nnot json\n" + F, F + "json\n" + JSON_TEXT, ""]) {
    assert.throws(() => parseReply(text), { code: "MODEL_OUTPUT_INVALID", retryable: false });
  }
});

test("the fence pattern in replyParse.ts is a regex literal, so no backslash can be lost from a quoted string", () => {
  const source = readFileSync(new URL("../src/adapters/model/replyParse.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /new RegExp\(/u);
  assert.match(source, /\.replace\(\/\^/u);
});
