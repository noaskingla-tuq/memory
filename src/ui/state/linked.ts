import type { z } from "zod";
import type { uiLinkForgetSuccess, uiLinkGetSuccess, uiLinkListSuccess, uiLinkSourcesSuccess } from "../../contracts/uiContract.js";
import type { ErrorDescription } from "../api/errors.js";

export interface LinkSourceRow {
  readonly source: string | null;
  readonly fileId: string;
  readonly state: "ok" | "corrupt";
  readonly count: number;
  readonly sizeBytes: number;
  readonly revision: number;
  readonly updatedAtMs: number | null;
}

export interface LinkTotals {
  readonly sources: number;
  readonly count: number;
  readonly sizeBytes: number;
  readonly corrupt: number;
}

export interface LinkItemRow {
  readonly id: string;
  readonly snippet: string;
  readonly tags: readonly string[];
  readonly sizeBytes: number;
  readonly rev: number;
  readonly updatedAtMs: number;
  readonly expiresAtMs: number | null;
}

export interface LinkItemDetail {
  readonly id: string;
  readonly text: string;
  readonly tags: readonly string[];
  readonly sizeBytes: number;
  readonly rev: number;
  readonly updatedAtMs: number;
  readonly expiresAtMs: number | null;
}

export interface LinkSources {
  readonly sources: readonly LinkSourceRow[];
  readonly totals: LinkTotals;
}

export interface LinkPage {
  readonly source: string;
  readonly revision: number;
  readonly total: number;
  readonly items: readonly LinkItemRow[];
  readonly nextCursor: string | null;
}

export interface LinkDetail {
  readonly source: string;
  readonly revision: number;
  readonly item: LinkItemDetail;
}

// why: the view cannot run zod, so hand-written parsers guard the answers and these assertions fail tsc when the contract shapes drift away from them
type SourcesSuccess = z.infer<typeof uiLinkSourcesSuccess>;
type ListSuccess = z.infer<typeof uiLinkListSuccess>;
type GetSuccess = z.infer<typeof uiLinkGetSuccess>;
type ForgetSuccess = z.infer<typeof uiLinkForgetSuccess>;
type SourceMatches = SourcesSuccess["sources"][number] extends LinkSourceRow ? true : never;
type TotalsMatch = SourcesSuccess["totals"] extends LinkTotals ? true : never;
type ItemMatches = ListSuccess["items"][number] extends LinkItemRow ? true : never;
type DetailMatches = GetSuccess["item"] extends LinkItemDetail ? true : never;
type ForgetMatches = ForgetSuccess extends { forgotten: number; revision: number | null } ? true : never;
export const LINKED_CONTRACT_MATCHES: [SourceMatches, TotalsMatch, ItemMatches, DetailMatches, ForgetMatches] = [true, true, true, true, true];

type JsonRecord = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is JsonRecord => typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
const isText = (value: unknown): value is string => typeof value === "string";
const isTags = (value: unknown): value is string[] => Array.isArray(value) && value.every(isText);
const isNullableCount = (value: unknown): value is number | null => value === null || isCount(value);

function parseSourceRow(value: unknown): LinkSourceRow | null {
  if (!isRecord(value) || !isText(value.fileId) || (value.source !== null && !isText(value.source))) return null;
  if (value.state !== "ok" && value.state !== "corrupt") return null;
  if (!isCount(value.count) || !isCount(value.sizeBytes) || !isCount(value.revision) || !isNullableCount(value.updatedAtMs)) return null;
  return { source: value.source, fileId: value.fileId, state: value.state, count: value.count, sizeBytes: value.sizeBytes, revision: value.revision, updatedAtMs: value.updatedAtMs };
}

export function parseSources(value: unknown): LinkSources | null {
  if (!isRecord(value) || value.ok !== true || !Array.isArray(value.sources) || !isRecord(value.totals)) return null;
  const rows = value.sources.map(parseSourceRow);
  const { totals } = value;
  if (rows.includes(null) || !isCount(totals.sources) || !isCount(totals.count) || !isCount(totals.sizeBytes) || !isCount(totals.corrupt)) return null;
  return { sources: orderSources(rows as LinkSourceRow[]), totals: { sources: totals.sources, count: totals.count, sizeBytes: totals.sizeBytes, corrupt: totals.corrupt } };
}

function parseItemRow(value: unknown): LinkItemRow | null {
  if (!isRecord(value) || !isText(value.id) || !isText(value.snippet) || !isTags(value.tags)) return null;
  if (!isCount(value.sizeBytes) || !isCount(value.rev) || value.rev < 1 || !isCount(value.updatedAtMs) || !isNullableCount(value.expiresAtMs)) return null;
  return { id: value.id, snippet: value.snippet, tags: value.tags, sizeBytes: value.sizeBytes, rev: value.rev, updatedAtMs: value.updatedAtMs, expiresAtMs: value.expiresAtMs };
}

export function parsePage(value: unknown): LinkPage | null {
  if (!isRecord(value) || value.ok !== true || !isText(value.source) || !isCount(value.revision) || !isCount(value.total) || !Array.isArray(value.items)) return null;
  if (value.nextCursor !== null && !isText(value.nextCursor)) return null;
  const items = value.items.map(parseItemRow);
  if (items.includes(null)) return null;
  return { source: value.source, revision: value.revision, total: value.total, items: items as LinkItemRow[], nextCursor: value.nextCursor };
}

export function parseDetail(value: unknown): LinkDetail | null {
  if (!isRecord(value) || value.ok !== true || !isText(value.source) || !isCount(value.revision) || !isRecord(value.item)) return null;
  const { item } = value;
  if (!isText(item.id) || !isText(item.text) || !isTags(item.tags) || !isCount(item.sizeBytes) || !isCount(item.rev) || item.rev < 1) return null;
  if (!isCount(item.updatedAtMs) || !isNullableCount(item.expiresAtMs)) return null;
  return {
    source: value.source,
    revision: value.revision,
    item: { id: item.id, text: item.text, tags: item.tags, sizeBytes: item.sizeBytes, rev: item.rev, updatedAtMs: item.updatedAtMs, expiresAtMs: item.expiresAtMs },
  };
}

export function isForgetSuccess(value: unknown): boolean {
  return isRecord(value) && value.ok === true && isCount(value.forgotten) && isNullableCount(value.revision);
}

export function orderSources(rows: readonly LinkSourceRow[]): LinkSourceRow[] {
  return [...rows].sort((left, right) => {
    if ((left.state === "corrupt") !== (right.state === "corrupt")) return left.state === "corrupt" ? 1 : -1;
    return (right.updatedAtMs ?? -1) - (left.updatedAtMs ?? -1) || (left.fileId < right.fileId ? -1 : 1);
  });
}

export type PanelLoad = "idle" | "loading" | "ready" | "error";

export interface SourcePanel {
  readonly open: boolean;
  readonly load: PanelLoad;
  readonly items: readonly LinkItemRow[];
  readonly nextCursor: string | null;
  readonly total: number;
  readonly revision: number | null;
  readonly loadingMore: boolean;
  readonly error: ErrorDescription | null;
}

export const NEW_PANEL: SourcePanel = { open: false, load: "idle", items: [], nextCursor: null, total: 0, revision: null, loadingMore: false, error: null };

export type LinkedNotice =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "error"; readonly error: ErrorDescription; readonly heading: string };

export interface LinkedView {
  readonly phase: "loading" | "ready" | "error";
  readonly error: ErrorDescription | null;
  readonly sources: readonly LinkSourceRow[];
  readonly totals: LinkTotals;
  readonly panels: Readonly<Record<string, SourcePanel>>;
  readonly busy: boolean;
  readonly notice: LinkedNotice | null;
}

export const EMPTY_TOTALS: LinkTotals = { sources: 0, count: 0, sizeBytes: 0, corrupt: 0 };

export const INITIAL_LINKED: LinkedView = { phase: "loading", error: null, sources: [], totals: EMPTY_TOTALS, panels: {}, busy: false, notice: null };

// why: with a single source the page opens it at once, and a source the user already opened or closed keeps that choice across a reload
export function applySources(previous: LinkedView, loaded: LinkSources): LinkedView {
  const okRows = loaded.sources.filter((row) => row.state === "ok" && row.source !== null);
  const panels: Record<string, SourcePanel> = {};
  for (const row of okRows) {
    const key = row.source as string;
    const existing = previous.panels[key];
    panels[key] = existing ?? { ...NEW_PANEL, open: okRows.length === 1 };
  }
  return { ...previous, phase: "ready", error: null, sources: loaded.sources, totals: loaded.totals, panels };
}

export function withPanel(view: LinkedView, source: string, change: Partial<SourcePanel>): LinkedView {
  const current = view.panels[source];
  if (current === undefined) return view;
  return { ...view, panels: { ...view.panels, [source]: { ...current, ...change } } };
}

export function mergeItems(existing: readonly LinkItemRow[], incoming: readonly LinkItemRow[]): LinkItemRow[] {
  const seen = new Set(existing.map((item) => item.id));
  return [...existing, ...incoming.filter((item) => !seen.has(item.id))];
}

export function sourceName(source: string, labels: { readonly core: string; readonly plugin: (id: string) => string }): string {
  return source === "core" ? labels.core : labels.plugin(source.startsWith("plugin:") ? source.slice("plugin:".length) : source);
}

export function sizeText(bytes: number, labels: { readonly bytes: (n: number) => string; readonly kb: (n: string) => string }): string {
  return bytes < 1024 ? labels.bytes(bytes) : labels.kb((bytes / 1024).toFixed(1));
}
