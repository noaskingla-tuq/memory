import type { z } from "zod";
import type { uiAgentStatsSuccess } from "../../contracts/uiContract.js";
import { t } from "../i18n/index.js";
import { parseInstant } from "../i18n/relativeTime.js";

export type Scope = "personal" | "project";

export interface SpaceAgentNames {
  readonly displayName: string;
  readonly name?: string | undefined;
  readonly title?: string | undefined;
  readonly teamKey: string;
  readonly teamName?: string | undefined;
}

export interface SpaceProjectNames {
  readonly displayName: string;
  readonly name?: string | undefined;
}

export interface SpaceNamespace {
  readonly scope: Scope;
  readonly projectId: string | null;
  readonly count: number;
  readonly firstAt: string | null;
  readonly lastAt: string | null;
  readonly project?: SpaceProjectNames | null | undefined;
}

export interface SpaceTool {
  readonly cli: string | null;
  readonly model: string | null;
  readonly n: number;
}

export interface SpaceRepeat {
  readonly title: string;
  readonly count: number;
}

export interface SpaceWork {
  readonly startIso: string;
  readonly endIso: string;
  readonly cli: string | null;
  readonly model: string | null;
  readonly title: string | null;
}

export interface SpaceItem {
  readonly ref: { readonly agentId: string; readonly scope: Scope; readonly projectId: string | null; readonly memoryId: string };
  readonly updatedAt: string;
  readonly snippet: string;
  readonly work?: SpaceWork | undefined;
  readonly names?: { readonly project: SpaceProjectNames | null } | undefined;
}

export interface AgentStats {
  readonly agentId: string;
  readonly agent?: SpaceAgentNames | undefined;
  readonly namespaces: readonly SpaceNamespace[];
  readonly byDay30: readonly { readonly date: string; readonly count: number }[];
  readonly byHour: readonly number[];
  readonly byWeekday: readonly number[];
  readonly tools: readonly SpaceTool[];
  readonly repeatedRequests: readonly SpaceRepeat[];
  readonly representative: readonly SpaceItem[];
  readonly sampled: boolean;
}

// why: the view cannot run zod, so a hand-written parser guards the response and this assertion fails tsc when the contract's agentStats shape drifts away from it
type Contract = z.infer<typeof uiAgentStatsSuccess>;
type StatsContractMatches = Contract extends AgentStats ? true : never;
export const STATS_CONTRACT_MATCHES: StatsContractMatches = true;

type JsonRecord = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is JsonRecord => typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const isText = (value: unknown): value is string => typeof value === "string";
const isScope = (value: unknown): value is Scope => value === "personal" || value === "project";
const optionalText = (value: unknown): string | undefined | null => (value === undefined ? undefined : isText(value) ? value : null);
const textOrNull = (value: unknown): string | null | undefined => (value === null ? null : isText(value) ? value : undefined);
const countList = (value: unknown, length: number): value is readonly number[] => Array.isArray(value) && value.length === length && value.every(isCount);

function parseProjectNames(value: unknown): SpaceProjectNames | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !isText(value.displayName)) return undefined;
  const name = optionalText(value.name);
  return name === null ? undefined : { displayName: value.displayName, name };
}

function parseAgentNames(value: unknown): SpaceAgentNames | null {
  if (!isRecord(value) || !isText(value.displayName) || !isText(value.teamKey)) return null;
  const name = optionalText(value.name);
  const title = optionalText(value.title);
  const teamName = optionalText(value.teamName);
  return name === null || title === null || teamName === null ? null : { displayName: value.displayName, name, title, teamKey: value.teamKey, teamName };
}

function parseNamespace(value: unknown): SpaceNamespace | null {
  if (!isRecord(value) || !isScope(value.scope) || !isCount(value.count)) return null;
  const projectId = textOrNull(value.projectId);
  const firstAt = textOrNull(value.firstAt);
  const lastAt = textOrNull(value.lastAt);
  if (projectId === undefined || firstAt === undefined || lastAt === undefined) return null;
  if ((value.scope === "personal") !== (projectId === null)) return null;
  const project = value.project === undefined ? undefined : parseProjectNames(value.project);
  return project === undefined && value.project !== undefined ? null : { scope: value.scope, projectId, count: value.count, firstAt, lastAt, project };
}

function parseWork(value: unknown): SpaceWork | null {
  if (!isRecord(value) || !isText(value.startIso) || !isText(value.endIso)) return null;
  const cli = textOrNull(value.cli);
  const model = textOrNull(value.model);
  const title = textOrNull(value.title);
  return cli === undefined || model === undefined || title === undefined ? null : { startIso: value.startIso, endIso: value.endIso, cli, model, title };
}

function parseItem(value: unknown): SpaceItem | null {
  if (!isRecord(value) || !isRecord(value.ref) || !isText(value.updatedAt) || !isText(value.snippet)) return null;
  const { ref } = value;
  const projectId = textOrNull(ref.projectId);
  if (!isText(ref.agentId) || !isText(ref.memoryId) || !isScope(ref.scope) || projectId === undefined) return null;
  const work = value.work === undefined ? undefined : parseWork(value.work);
  if (work === null) return null;
  let names: SpaceItem["names"];
  if (value.names !== undefined) {
    const project = isRecord(value.names) ? parseProjectNames(value.names.project) : undefined;
    if (project === undefined) return null;
    names = { project };
  }
  return { ref: { agentId: ref.agentId, scope: ref.scope, projectId, memoryId: ref.memoryId }, updatedAt: value.updatedAt, snippet: value.snippet, work, names };
}

function parseTool(value: unknown): SpaceTool | null {
  if (!isRecord(value) || !isCount(value.n)) return null;
  const cli = textOrNull(value.cli);
  const model = textOrNull(value.model);
  return cli === undefined || model === undefined ? null : { cli, model, n: value.n };
}

function parseRepeat(value: unknown): SpaceRepeat | null {
  return isRecord(value) && isText(value.title) && isCount(value.count) ? { title: value.title, count: value.count } : null;
}

function parseDay(value: unknown): { readonly date: string; readonly count: number } | null {
  return isRecord(value) && isText(value.date) && value.date.length === 10 && isCount(value.count) ? { date: value.date, count: value.count } : null;
}

function listOf<T>(value: unknown, parse: (entry: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null;
  const parsed = value.map(parse);
  return parsed.includes(null) ? null : (parsed as T[]);
}

export function parseAgentStats(value: unknown): AgentStats | null {
  if (!isRecord(value) || value.ok !== true || !isText(value.agentId) || value.agentId === "" || typeof value.sampled !== "boolean") return null;
  if (!countList(value.byHour, 24) || !countList(value.byWeekday, 7)) return null;
  const namespaces = listOf(value.namespaces, parseNamespace);
  const byDay30 = listOf(value.byDay30, parseDay);
  const tools = listOf(value.tools, parseTool);
  const repeatedRequests = listOf(value.repeatedRequests, parseRepeat);
  const representative = listOf(value.representative, parseItem);
  if (namespaces === null || byDay30 === null || tools === null || repeatedRequests === null || representative === null) return null;
  let agent: SpaceAgentNames | undefined;
  if (value.agent !== undefined) {
    const names = parseAgentNames(value.agent);
    if (names === null) return null;
    agent = names;
  }
  return { agentId: value.agentId, agent, namespaces, byDay30, byHour: value.byHour, byWeekday: value.byWeekday, tools, repeatedRequests, representative, sampled: value.sampled };
}

export const firstText = (...candidates: readonly (string | null | undefined)[]): string | undefined => candidates.map((entry) => entry?.trim()).find((entry) => entry !== undefined && entry !== "");

export const idHead = (id: string): string => [...id].slice(0, 8).join("");

// why: the name table may miss a project, and the id prefix is what tells two unnamed projects apart
export function projectTitle(projectId: string, names: SpaceProjectNames | null | undefined): string {
  return firstText(names?.displayName, names?.name) ?? t("card.projectFallback", { id: idHead(projectId) });
}

export interface SpaceTotals {
  readonly total: number;
  readonly firstMs: number | null;
  readonly lastMs: number | null;
}

export function spaceTotals(namespaces: readonly SpaceNamespace[]): SpaceTotals {
  let firstMs: number | null = null;
  let lastMs: number | null = null;
  for (const namespace of namespaces) {
    const first = parseInstant(namespace.firstAt);
    const last = parseInstant(namespace.lastAt);
    if (first !== null && (firstMs === null || first < firstMs)) firstMs = first;
    if (last !== null && (lastMs === null || last > lastMs)) lastMs = last;
  }
  return { total: namespaces.reduce((sum, namespace) => sum + namespace.count, 0), firstMs, lastMs };
}

export interface SpaceRow {
  readonly label: string;
  readonly hint: string;
  readonly count: number;
  readonly scope: Scope;
  readonly projectId: string | null;
}

export interface SpaceRows {
  readonly personal: SpaceRow;
  readonly projects: readonly SpaceRow[];
  readonly peak: number;
}

export function spaceRows(namespaces: readonly SpaceNamespace[]): SpaceRows {
  const personalCount = namespaces.filter((namespace) => namespace.scope === "personal").reduce((sum, namespace) => sum + namespace.count, 0);
  const personal: SpaceRow = { label: t("space.spaces.personal"), hint: t("space.spaces.personal"), count: personalCount, scope: "personal", projectId: null };
  const projects = namespaces
    .filter((namespace) => namespace.scope === "project" && namespace.projectId !== null)
    .map((namespace): SpaceRow => ({ label: projectTitle(namespace.projectId ?? "", namespace.project), hint: namespace.projectId ?? "", count: namespace.count, scope: "project", projectId: namespace.projectId }))
    .sort((left, right) => right.count - left.count || (left.hint < right.hint ? -1 : left.hint > right.hint ? 1 : 0));
  return { personal, projects, peak: Math.max(1, personal.count, ...projects.map((row) => row.count)) };
}

export interface ToolRow {
  readonly label: string;
  readonly n: number;
  readonly percent: number;
}

export function toolRows(tools: readonly SpaceTool[]): ToolRow[] {
  const sum = tools.reduce((total, tool) => total + tool.n, 0);
  if (sum === 0) return [];
  return tools.map((tool) => {
    const cli = firstText(tool.cli);
    const model = firstText(tool.model);
    const label = cli === undefined && model === undefined ? t("space.tools.unknown") : [cli, model].filter((part) => part !== undefined).join(" / ");
    return { label, n: tool.n, percent: (tool.n / sum) * 100 };
  });
}

export function percentText(percent: number): string {
  if (percent > 0 && percent < 1) return t("space.tools.lessThanOne");
  return t("space.tools.percent", { n: Math.round(percent) });
}

export interface Peak {
  readonly index: number;
  readonly value: number;
}

// why: the first of several equal peaks wins, so the spoken summary does not change between two loads of the same data
export function peakOf(values: readonly number[]): Peak | null {
  let index = -1;
  for (let at = 0; at < values.length; at += 1) if ((values[at] ?? 0) > (index < 0 ? 0 : (values[index] ?? 0))) index = at;
  return index < 0 ? null : { index, value: values[index] ?? 0 };
}

export const sumOf = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0);
