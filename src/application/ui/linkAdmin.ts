import { createHash } from "node:crypto";
import type { UiFailure, UiLinkForgetRequest, UiLinkGetRequest, UiLinkListRequest, UiLinkGet, UiLinkList, UiLinkSources } from "../../contracts/uiContract.js";
import { clipCodePoints } from "./budget.js";
import { UiResultTooLarge, uiFailure } from "./failures.js";
import { fitPage } from "./paging.js";
import { LinkAdminError, type LinkAdminPort, type LinkRawItem } from "./linkAdminPort.js";

const SNIPPET_CHARS = 160;
const PRETTY_TEXT_LIMIT = 16_000;
const CONTROL_RUNS = /[\u0000-\u001f\u007f\s]+/gu;

function failureOf(error: unknown): UiFailure {
  if (error instanceof LinkAdminError) return uiFailure(error.code);
  throw error;
}

async function guarded<T>(work: () => Promise<T>): Promise<T | UiFailure> {
  try {
    return await work();
  } catch (error) {
    return failureOf(error);
  }
}

const sourceTag = (source: string): string => createHash("sha256").update(source).digest("hex").slice(0, 12);

function encodeCursor(source: string, position: readonly string[]): string {
  return `${Buffer.from(JSON.stringify([Number(position[0]), position[1]])).toString("base64url")}.${sourceTag(source)}`;
}

function decodeCursor(source: string, cursor: string): { readonly updatedAtMs: number; readonly id: string } | null {
  const [body, tag, ...rest] = cursor.split(".");
  if (body === undefined || tag !== sourceTag(source) || rest.length > 0) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2 || !Number.isSafeInteger(parsed[0]) || typeof parsed[1] !== "string") return null;
    return { updatedAtMs: parsed[0] as number, id: parsed[1] };
  } catch {
    return null;
  }
}

const newestFirst = (left: LinkRawItem, right: LinkRawItem): number => right.updatedAtMs - left.updatedAtMs || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

function snippetOf(payload: unknown): string {
  const text = typeof payload === "string" ? payload : (JSON.stringify(payload) ?? "");
  return clipCodePoints(text.replace(CONTROL_RUNS, " ").trim(), SNIPPET_CHARS);
}

export async function runLinkSources(port: LinkAdminPort): Promise<UiLinkSources | UiFailure> {
  return guarded(async () => {
    const rows = [...(await port.sources())].sort((left, right) => (right.updatedAtMs ?? -1) - (left.updatedAtMs ?? -1) || (left.fileId < right.fileId ? -1 : 1));
    return {
      ok: true as const,
      sources: rows.map((row) => ({ ...row })),
      totals: {
        sources: rows.length,
        count: rows.reduce((sum, row) => sum + row.count, 0),
        sizeBytes: rows.reduce((sum, row) => sum + row.sizeBytes, 0),
        corrupt: rows.filter((row) => row.state === "corrupt").length,
      },
      limits: { ...port.limits() },
    };
  });
}

export async function runLinkList(request: UiLinkListRequest, port: LinkAdminPort): Promise<UiLinkList | UiFailure> {
  const after = request.cursor === undefined ? undefined : decodeCursor(request.source, request.cursor);
  if (after === null) return uiFailure("CURSOR_STALE");
  return guarded(async () => {
    const page = await port.list(request.source);
    const ordered = [...page.items].sort(newestFirst);
    const rest = after === undefined ? ordered : ordered.filter((item) => item.updatedAtMs < after.updatedAtMs || (item.updatedAtMs === after.updatedAtMs && item.id > after.id));
    const window = rest.slice(0, request.limit);
    const view = (item: LinkRawItem) => ({ id: item.id, snippet: snippetOf(item.payload), tags: [...item.tags], sizeBytes: item.sizeBytes, rev: item.rev, updatedAtMs: item.updatedAtMs, expiresAtMs: item.expiresAtMs });
    const fit = fitPage({
      items: window,
      more: rest.length > window.length,
      position: (item) => [String(item.updatedAtMs), item.id],
      encode: (position) => encodeCursor(request.source, position),
      build: (kept, nextCursor) => ({ ok: true, source: request.source, revision: page.revision, total: ordered.length, items: kept.map(view), nextCursor }),
    });
    if (!fit.ok) throw new UiResultTooLarge();
    return fit.response as UiLinkList;
  });
}

export async function runLinkGet(request: UiLinkGetRequest, port: LinkAdminPort): Promise<UiLinkGet | UiFailure> {
  return guarded(async () => {
    const { revision, item } = await port.get(request.source, request.id);
    const pretty = JSON.stringify(item.payload, null, 2) ?? "";
    const text = pretty.length > PRETTY_TEXT_LIMIT ? (JSON.stringify(item.payload) ?? "") : pretty;
    return {
      ok: true as const,
      source: request.source,
      revision,
      item: { id: item.id, text, tags: [...item.tags], sizeBytes: item.sizeBytes, rev: item.rev, updatedAtMs: item.updatedAtMs, expiresAtMs: item.expiresAtMs },
    };
  });
}

export async function runLinkForget(request: UiLinkForgetRequest, port: LinkAdminPort): Promise<Record<string, unknown> | UiFailure> {
  return guarded(async () => {
    if (request.action === "damaged") {
      await port.discardDamaged(request.fileId);
      return { ok: true, forgotten: 0, revision: null };
    }
    const outcome = request.action === "item"
      ? await port.forgetItem(request.source, request.id, request.expectedItemRev)
      : await port.forgetSource(request.source, request.expectedRevision);
    return { ok: true, forgotten: outcome.forgotten, revision: outcome.revision };
  });
}
