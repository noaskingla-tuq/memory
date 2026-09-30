import type { UiItem, UiRef, UiWork } from "../../contracts/uiContract.js";
import type { BackendParams } from "../api/backendClient.js";
import { clockTime, dateTime, formatDuration } from "../i18n/clock.js";
import { t } from "../i18n/index.js";
import { localDate, parseInstant } from "../i18n/relativeTime.js";
import { projectTitle, type AgentStats } from "./memorySpace.js";

export type RangeKey = "all" | "24h" | "7d" | "14d" | "30d";
export type ScopeKey = "all" | "personal" | "project";

export const RANGE_KEYS: readonly RangeKey[] = ["all", "24h", "7d", "14d", "30d"];
export const PROJECT_VALUE_PREFIX = "p:";
export const DEFAULT_CLI_OPTIONS: readonly string[] = ["claude", "codex"];

const HOUR_MS = 3_600_000;
const RANGE_MS: Readonly<Record<Exclude<RangeKey, "all">, number>> = { "24h": 24 * HOUR_MS, "7d": 7 * 24 * HOUR_MS, "14d": 14 * 24 * HOUR_MS, "30d": 30 * 24 * HOUR_MS };

export const isRangeKey = (value: string): value is RangeKey => (RANGE_KEYS as readonly string[]).includes(value);

export interface TimelineFilters {
  readonly scope: ScopeKey;
  readonly projectId: string | null;
  readonly range: RangeKey;
  readonly cli: string | null;
}

export const NO_FILTERS: TimelineFilters = { scope: "all", projectId: null, range: "all", cli: null };

export const isFiltered = (filters: TimelineFilters): boolean => filters.scope !== "all" || filters.range !== "all" || filters.cli !== null;

export function scopeValue(filters: TimelineFilters): string {
  return filters.scope === "project" && filters.projectId !== null ? `${PROJECT_VALUE_PREFIX}${filters.projectId}` : filters.scope;
}

export function withScopeValue(filters: TimelineFilters, value: string): TimelineFilters {
  if (value.startsWith(PROJECT_VALUE_PREFIX) && value.length > PROJECT_VALUE_PREFIX.length) return { ...filters, scope: "project", projectId: value.slice(PROJECT_VALUE_PREFIX.length) };
  if (value === "personal" || value === "project") return { ...filters, scope: value, projectId: null };
  return { ...filters, scope: "all", projectId: null };
}

export interface ProjectOption {
  readonly projectId: string;
  readonly name?: string | undefined;
}

export function projectOptionLabel(option: ProjectOption): string {
  const named = option.name?.trim();
  return named === undefined || named === "" ? t("card.projectFallback", { id: [...option.projectId].slice(0, 8).join("") }) : named;
}

// why: the since bound is fixed when the query starts and every continuation reuses it, because the cursor carries a hash of the filters and a bound that moved with the clock would make every next page CURSOR_STALE
export interface TimelineQuery {
  readonly agentId: string;
  readonly q: string | null;
  readonly filters: TimelineFilters;
  readonly sinceIso: string | undefined;
}

export function makeQuery(agentId: string, q: string | null, filters: TimelineFilters, nowMs: number): TimelineQuery {
  const span = filters.range === "all" ? null : RANGE_MS[filters.range];
  return { agentId, q, filters, sinceIso: span === null ? undefined : new Date(nowMs - span).toISOString() };
}

export const queryMethod = (query: TimelineQuery): "ui.list" | "ui.search" => (query.q === null ? "ui.list" : "ui.search");

export function queryParams(query: TimelineQuery, limit: number, cursor: string | null): BackendParams {
  const { filters } = query;
  return {
    agentId: query.agentId,
    ...(query.q === null ? {} : { q: query.q }),
    ...(filters.scope === "all" ? {} : { scope: filters.scope }),
    ...(filters.scope === "project" && filters.projectId !== null ? { projectId: filters.projectId } : {}),
    ...(query.sinceIso === undefined ? {} : { sinceIso: query.sinceIso }),
    ...(filters.cli === null ? {} : { cli: filters.cli }),
    limit,
    ...(cursor === null ? {} : { cursor }),
  };
}

export interface FilterChoices {
  readonly projects: readonly ProjectOption[];
  readonly clis: readonly string[];
}

// why: the complete project list and the tools actually used come from the agent's own stats, so the selects offer every project of that agent and only tools that occur in its memories
export function choicesFromStats(stats: AgentStats): FilterChoices {
  const projects = new Map<string, ProjectOption>();
  for (const namespace of stats.namespaces) {
    if (namespace.scope === "project" && namespace.projectId !== null && !projects.has(namespace.projectId)) projects.set(namespace.projectId, { projectId: namespace.projectId, name: projectTitle(namespace.projectId, namespace.project) });
  }
  const used = new Map<string, number>();
  for (const tool of stats.tools) if (tool.cli !== null && tool.cli !== "") used.set(tool.cli, (used.get(tool.cli) ?? 0) + tool.n);
  const clis = [...used.entries()].sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1)).map(([cli]) => cli);
  return { projects: [...projects.values()], clis };
}

export interface TimelineItem {
  readonly ref: UiRef;
  readonly kind: string;
  readonly revision: number;
  readonly updatedAt: string;
  readonly snippet: string;
  readonly work?: UiWork | undefined;
  readonly receiptCount: number;
  readonly projectName?: string | undefined;
}

// why: the view cannot run zod, so a hand-written parser guards the response and this assertion fails tsc when the contract's item shape drifts away from it
type ItemContractMatches = UiItem extends Omit<TimelineItem, "projectName"> ? true : never;
export const ITEM_CONTRACT_MATCHES: ItemContractMatches = true;

export interface TimelinePage {
  readonly items: readonly TimelineItem[];
  readonly nextCursor: string | null;
  readonly complete: boolean;
  readonly normalizedQuery: string | null;
}

type JsonRecord = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is JsonRecord => typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
const isText = (value: unknown): value is string => typeof value === "string";
const textOrNull = (value: unknown): string | null | undefined => (value === null ? null : isText(value) ? value : undefined);

export function parseWork(value: unknown): UiWork | null {
  if (!isRecord(value) || !isText(value.startIso) || !isText(value.endIso)) return null;
  const cli = textOrNull(value.cli);
  const model = textOrNull(value.model);
  const title = textOrNull(value.title);
  return cli === undefined || model === undefined || title === undefined ? null : { startIso: value.startIso, endIso: value.endIso, cli, model, title };
}

function projectNameOf(names: unknown): string | undefined {
  if (!isRecord(names) || !isRecord(names.project)) return undefined;
  const { displayName } = names.project;
  return isText(displayName) && displayName.trim() !== "" ? displayName : undefined;
}

export function parseRef(ref: unknown): UiRef | null {
  if (!isRecord(ref)) return null;
  const projectId = textOrNull(ref.projectId);
  if (!isText(ref.agentId) || !isText(ref.memoryId) || projectId === undefined || (ref.scope !== "personal" && ref.scope !== "project")) return null;
  return { agentId: ref.agentId, scope: ref.scope, projectId, memoryId: ref.memoryId };
}

export function parseItem(value: unknown): TimelineItem | null {
  if (!isRecord(value)) return null;
  const ref = parseRef(value.ref);
  if (ref === null) return null;
  if (!isText(value.kind) || !isCount(value.revision) || !isText(value.updatedAt) || !isText(value.snippet) || !isCount(value.receiptCount)) return null;
  const work = value.work === undefined ? undefined : parseWork(value.work);
  if (work === null) return null;
  return {
    ref,
    kind: value.kind,
    revision: value.revision,
    updatedAt: value.updatedAt,
    snippet: value.snippet,
    work,
    receiptCount: value.receiptCount,
    projectName: projectNameOf(value.names),
  };
}

export function parsePage(method: "ui.list" | "ui.search", value: unknown): TimelinePage | null {
  if (!isRecord(value) || value.ok !== true || !Array.isArray(value.items)) return null;
  const nextCursor = textOrNull(value.nextCursor);
  if (nextCursor === undefined) return null;
  const items = value.items.map(parseItem);
  if (items.includes(null)) return null;
  let complete = true;
  let normalizedQuery: string | null = null;
  if (method === "ui.search") {
    if (!isRecord(value.scanned) || typeof value.scanned.complete !== "boolean" || !isText(value.normalizedQuery)) return null;
    complete = value.scanned.complete;
    normalizedQuery = value.normalizedQuery;
  }
  return { items: items as TimelineItem[], nextCursor, complete, normalizedQuery };
}

export function itemKey(ref: UiRef): string {
  return JSON.stringify([ref.agentId, ref.scope, ref.projectId, ref.memoryId]);
}

export function mergeItems(existing: readonly TimelineItem[], incoming: readonly TimelineItem[]): { readonly items: TimelineItem[]; readonly added: string[] } {
  const known = new Set(existing.map((item) => itemKey(item.ref)));
  const items = [...existing];
  const added: string[] = [];
  for (const item of incoming) {
    const key = itemKey(item.ref);
    if (known.has(key)) continue;
    known.add(key);
    items.push(item);
    added.push(key);
  }
  return { items, added };
}

export interface DayGroup {
  readonly key: string;
  readonly label: string;
  readonly items: readonly TimelineItem[];
}

const UNKNOWN_DAY = "unknown";

function dayKey(item: TimelineItem): string {
  const ms = parseInstant(item.updatedAt);
  return ms === null ? UNKNOWN_DAY : localDate(new Date(ms));
}

function dayLabel(key: string, nowMs: number): string {
  if (key === UNKNOWN_DAY) return t("tl.day.unknown");
  const yesterday = new Date(nowMs);
  yesterday.setDate(yesterday.getDate() - 1);
  if (key === localDate(new Date(nowMs))) return t("tl.day.today");
  return key === localDate(yesterday) ? t("tl.day.yesterday") : t("tl.day.other", { date: key });
}

export function groupByDay(items: readonly TimelineItem[], nowMs: number): DayGroup[] {
  const groups: { key: string; label: string; items: TimelineItem[] }[] = [];
  for (const item of items) {
    const key = dayKey(item);
    const last = groups[groups.length - 1];
    if (last !== undefined && last.key === key) last.items.push(item);
    else groups.push({ key, label: dayLabel(key, nowMs), items: [item] });
  }
  return groups;
}

export function writtenText(item: TimelineItem): string {
  const ms = parseInstant(item.updatedAt);
  return ms === null ? t("tl.item.writtenUnknown") : t("tl.item.writtenAt", { at: clockTime(ms) });
}

export function writtenTitle(item: TimelineItem): string {
  const ms = parseInstant(item.updatedAt);
  return ms === null ? "" : dateTime(ms);
}

export function workText(item: TimelineItem): string {
  const start = parseInstant(item.work?.startIso);
  const end = parseInstant(item.work?.endIso);
  if (start === null || end === null) return t("tl.item.workUnknown");
  const sameDay = localDate(new Date(start)) === localDate(new Date(end));
  const range = sameDay ? `${clockTime(start)}～${clockTime(end)}` : `${dateTime(start)}～${dateTime(end)}`;
  return end >= start ? t("tl.item.work", { range, duration: formatDuration(end - start) }) : t("tl.item.workNoDuration", { range });
}

export function toolText(item: TimelineItem): string | null {
  const parts = [item.work?.cli, item.work?.model].filter((part): part is string => part !== null && part !== undefined && part !== "");
  return parts.length === 0 ? null : parts.join("/");
}

export function scopeText(item: TimelineItem): string {
  if (item.ref.scope === "personal") return t("tl.item.personal");
  return t("tl.item.project", { name: projectOptionLabel({ projectId: item.ref.projectId ?? "", name: item.projectName }) });
}

export interface TextPiece {
  readonly text: string;
  readonly hit: boolean;
}

export function termsOf(normalizedQuery: string | null): string[] {
  return normalizedQuery === null ? [] : normalizedQuery.split(" ").filter((term) => term !== "");
}

const escapePattern = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

export function splitByTerms(text: string, terms: readonly string[]): TextPiece[] {
  if (terms.length === 0 || text === "") return [{ text, hit: false }];
  const pattern = new RegExp([...terms].sort((left, right) => right.length - left.length).map(escapePattern).join("|"), "giu");
  const pieces: TextPiece[] = [];
  let from = 0;
  for (const match of text.matchAll(pattern)) {
    if (match[0] === "") continue;
    const at = match.index ?? 0;
    if (at > from) pieces.push({ text: text.slice(from, at), hit: false });
    pieces.push({ text: match[0], hit: true });
    from = at + match[0].length;
  }
  if (from < text.length) pieces.push({ text: text.slice(from), hit: false });
  return pieces.length === 0 ? [{ text, hit: false }] : pieces;
}
