import { createHash } from "node:crypto";
import type { SettledPunch } from "./punchDataPorts.js";

const MAX_CONTENT_UNITS = 3_600;
const MAX_NAME_UNITS = 300;
const ELLIPSIS = " …… ";
const SOURCE_PREFIXES = [
  "〔已結算工作紀錄摘要〕name（工作名稱／請求欄位）；role=user 是外掛配置的合成角色，不代表原始發話者：",
  "〔已結算工作紀錄摘要〕description（Lexical 純文字成果欄位；作者未知）；role=assistant 是外掛配置的合成角色，不代表原始發話者：",
] as const;
const BLOCK_TYPES = new Set(["root", "paragraph", "heading", "quote", "list", "listitem", "code", "table", "tablerow", "tablecell"]);

export interface PunchMemoryContent {
  readonly content: string;
  readonly contentSha256: string;
  readonly operationId: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function plainTextOf(node: unknown): string {
  if (node === null || typeof node !== "object") return "";
  const value = node as Record<string, unknown>;
  if (value.type === "text") return typeof value.text === "string" ? value.text : "";
  if (value.type === "linebreak") return "\n";
  if (value.type === "tab") return "\t";
  if (!Array.isArray(value.children)) return "";
  let output = "";
  let previousBlock = false;
  value.children.forEach((child, index) => {
    const type = child !== null && typeof child === "object" ? (child as Record<string, unknown>).type : undefined;
    const block = typeof type === "string" && BLOCK_TYPES.has(type);
    if (index > 0 && (block || previousBlock)) output += "\n";
    output += plainTextOf(child);
    previousBlock = block;
  });
  return output;
}

function lexicalToPlainText(value: string | null): string {
  const raw = value ?? "";
  const trimmed = raw.trim();
  if (trimmed === "" || !trimmed.startsWith("{")) return raw;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const root = (parsed.root ?? parsed) as Record<string, unknown>;
    return Array.isArray(root.children) ? plainTextOf({ ...root, type: "root" }) : raw;
  } catch {
    return raw;
  }
}

function clean(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�")
    .replace(/\s+/g, " ")
    .trim();
}

function head(text: string, units: number): string {
  if (text.length <= units) return text;
  return text.slice(0, /[\uD800-\uDBFF]/.test(text[units - 1] ?? "") ? units - 1 : units);
}

function tail(text: string, units: number): string {
  if (text.length <= units) return text;
  const start = text.length - units;
  return text.slice(/[\uDC00-\uDFFF]/.test(text[start] ?? "") ? start + 1 : start);
}

export function punchOperationId(punchId: string): string {
  return `punch:${sha256(punchId).slice(0, 32)}`;
}

export function buildPunchSourceMessages(punch: SettledPunch) {
  const texts = [clean(punch.name ?? ""), clean(lexicalToPlainText(punch.description))];
  const id = punchOperationId(punch.id);
  return texts.flatMap((text, index) => {
    if (text === "") return [];
    const prefix = SOURCE_PREFIXES[index]!;
    let content = head(text, index === 0 ? 300 : 1200);
    // why: Cairn bounds each model input to 6000 units; UTF-8 bytes conservatively bound source text alongside its extraction prompt
    while (Buffer.byteLength(prefix + content, "utf8") > (index === 0 ? 900 : 2400)) content = head(content, content.length - 1);
    return [{ id: `${id}:${index === 0 ? "request" : "outcome"}`, role: index === 0 ? "user" as const : "assistant" as const, content: prefix + content }];
  });
}

export function buildPunchMemoryContent(punch: SettledPunch): PunchMemoryContent | null {
  const request = head(clean(punch.name ?? ""), MAX_NAME_UNITS);
  const outcome = clean(lexicalToPlainText(punch.description));
  if (request === "" && outcome === "") return null;
  const label = `${head(clean(punch.providerId ?? "unknown"), 40)}/${head(clean(punch.model ?? "unknown"), 64)}`;
  const prefix = `[工作紀錄 ${new Date(punch.startedAtMs).toISOString().slice(0, 16)}Z～${new Date(punch.endedAtMs).toISOString().slice(0, 16)}Z ${label}] 請求：${request === "" ? "（未命名）" : request}。成果：`;
  const body = outcome === "" ? "（無文字）" : outcome;
  const budget = MAX_CONTENT_UNITS - prefix.length;
  const content = body.length <= budget
    ? prefix + body
    : prefix + head(body, Math.floor(budget * 0.6)) + ELLIPSIS + tail(body, budget - Math.floor(budget * 0.6) - ELLIPSIS.length);
  return { content, contentSha256: sha256(content), operationId: punchOperationId(punch.id) };
}
