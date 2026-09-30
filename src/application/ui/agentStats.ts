import { openCairn, readCairn, type ScannedMemory } from "../../adapters/ui/cairnReader.js";
import { UI_LIMITS, type UiAgentStatsRequest, type UiFailure, type UiItem } from "../../contracts/uiContract.js";
import { HEAD_CHARS, type IndexedAgent } from "./agentIndex.js";
import { clipCodePoints, fitToBudget } from "./budget.js";
import { readerFailure, uiFailure, UiResultTooLarge } from "./failures.js";
import { compareText, newestFirst } from "./ordering.js";
import { parsePunchContent, type PunchContent } from "./punchContent.js";
import type { Clock } from "./timeSlice.js";
import type { UiServices } from "./uiServices.js";
import { namespaceOfOrigin, toItem, type RowOrigin } from "./workItem.js";

const PARSE_BATCH = 250;
const DAYS = 30;
const DAY_MS = 86_400_000;
const CACHE_LIMIT = 16;
const TOOLS_MAX = 12;
const NAMESPACES_MAX = 150;
const TITLE_CHARS = 80;

interface Sampled {
  readonly row: ScannedMemory;
  readonly origin: RowOrigin;
}

const dateOf = (localMs: number): string => new Date(localMs).toISOString().slice(0, 10);

async function sample(indexed: IndexedAgent, clock: Clock, sampleRows: number): Promise<Sampled[] | UiFailure> {
  const rows: Sampled[] = [];
  const opened = openCairn(indexed.path);
  if (!opened.ok) return readerFailure(opened.code);
  try {
    for (const namespace of indexed.agent.namespaces) {
      await clock.yieldIfDue();
      if (clock.timeUp()) return uiFailure("RESOURCE_BUSY");
      const origin: RowOrigin = { agentId: indexed.agent.agentId, scope: namespace.scope, projectId: namespace.projectId };
      const read = opened.value.run((reader) => reader.scan(namespaceOfOrigin(origin), { want: sampleRows, headChars: HEAD_CHARS, withReceipts: false }));
      if (!read.ok) return readerFailure(read.code);
      for (const row of read.value.rows) rows.push({ row, origin });
    }
  } finally {
    opened.value.close();
  }
  rows.sort((left, right) => newestFirst(left.row, right.row));
  return rows.slice(0, sampleRows);
}

function representativeOf(rows: readonly Sampled[], parsed: readonly PunchContent[], counts: ReadonlyMap<string, number>): Sampled[] {
  const newestByTitle = new Map<string, Sampled>();
  rows.forEach((entry, index) => {
    const title = parsed[index]?.parsed === true ? parsed[index].work.title : null;
    if (title !== null && title !== undefined && !newestByTitle.has(title)) newestByTitle.set(title, entry);
  });
  const chosen = [...newestByTitle.entries()]
    .sort((left, right) => (counts.get(right[0]) ?? 0) - (counts.get(left[0]) ?? 0) || compareText(left[0], right[0]))
    .slice(0, UI_LIMITS.representativeMax)
    .map(([, entry]) => entry);
  for (const entry of rows) {
    if (chosen.length >= UI_LIMITS.representativeMax) break;
    if (!chosen.includes(entry)) chosen.push(entry);
  }
  return chosen;
}

export async function runAgentStats(
  request: UiAgentStatsRequest,
  services: UiServices,
  clock: Clock,
): Promise<Record<string, unknown> | UiFailure> {
  const found = services.index.lookup(request.agentId);
  if (found.kind === "missing") return uiFailure("NOT_FOUND");
  if (found.kind === "unavailable") return readerFailure(found.reason === "identity_mismatch" || found.reason === "owner_conflict" ? "unsupported_schema" : found.reason);
  const { indexed } = found;
  const localNow = services.now() + request.tzOffsetMin * 60_000;
  const cacheKey = `${indexed.agent.agentHash}|${request.tzOffsetMin}|${dateOf(localNow)}|${services.sampleRows}`;
  const cached = services.statsCache.get(cacheKey);
  if (cached !== undefined && cached.version === indexed.version) return cached.response as Record<string, unknown>;

  const rows = await sample(indexed, clock, services.sampleRows);
  if (!Array.isArray(rows)) return rows;
  const parsed: PunchContent[] = [];
  for (let start = 0; start < rows.length; start += PARSE_BATCH) {
    await clock.yieldIfDue();
    for (const entry of rows.slice(start, start + PARSE_BATCH)) parsed.push(parsePunchContent(entry.row.head));
  }
  const today = Date.parse(`${dateOf(localNow)}T00:00:00.000Z`);
  const perDay = new Map<string, number>();
  const byHour = new Array<number>(24).fill(0);
  const byWeekday = new Array<number>(7).fill(0);
  const tools = new Map<string, { cli: string | null; model: string | null; n: number }>();
  const titles = new Map<string, number>();
  rows.forEach((entry, index) => {
    const local = new Date(Date.parse(entry.row.updatedAt) + request.tzOffsetMin * 60_000);
    perDay.set(dateOf(local.getTime()), (perDay.get(dateOf(local.getTime())) ?? 0) + 1);
    byHour[local.getUTCHours()] = (byHour[local.getUTCHours()] ?? 0) + 1;
    byWeekday[local.getUTCDay()] = (byWeekday[local.getUTCDay()] ?? 0) + 1;
    const content = parsed[index];
    const work = content?.parsed === true ? content.work : null;
    const toolKey = `${work?.cli ?? ""}|${work?.model ?? ""}`;
    const tool = tools.get(toolKey) ?? { cli: work?.cli ?? null, model: work?.model ?? null, n: 0 };
    tool.n += 1;
    tools.set(toolKey, tool);
    if (work?.title !== null && work?.title !== undefined) titles.set(work.title, (titles.get(work.title) ?? 0) + 1);
  });
  const chosen = representativeOf(rows, parsed, titles);
  const counted = readCairn(indexed.path, (reader) => reader.receiptCounts(chosen.map((entry) => entry.row.id)));
  if (!counted.ok) return readerFailure(counted.code);
  const representative: UiItem[] = chosen.map((entry) => toItem({ ...entry.row, receiptCount: counted.value.get(entry.row.id) ?? 0 }, entry.origin));
  const build = (namespaces: readonly unknown[]): Record<string, unknown> => ({
    ok: true,
    agentId: indexed.agent.agentId,
    namespaces,
    byDay30: Array.from({ length: DAYS }, (_, back) => {
      const date = dateOf(today - (DAYS - 1 - back) * DAY_MS);
      return { date, count: perDay.get(date) ?? 0 };
    }),
    byHour,
    byWeekday,
    tools: [...tools.values()]
      .sort((left, right) => right.n - left.n || compareText(`${left.cli}${left.model}`, `${right.cli}${right.model}`))
      .slice(0, TOOLS_MAX),
    repeatedRequests: [...titles.entries()]
      .filter(([, count]) => count >= 2)
      .sort((left, right) => right[1] - left[1] || compareText(left[0], right[0]))
      .slice(0, UI_LIMITS.repeatedRequestsMax)
      .map(([title, count]) => ({ title: clipCodePoints(title, TITLE_CHARS), count })),
    representative,
    sampled: indexed.agent.total > services.sampleRows,
  });
  const namespaces = [...indexed.agent.namespaces]
    .sort((left, right) => right.count - left.count || compareText(left.projectId ?? "", right.projectId ?? ""))
    .slice(0, NAMESPACES_MAX)
    .map(({ scope, projectId, count, firstAt, lastAt }) => ({ scope, projectId, count, firstAt, lastAt }));
  // why: every other part of this answer is bounded, so the namespace list is the only thing that can push it over the byte budget
  const fitted = fitToBudget(namespaces, build);
  if (!fitted.ok) throw new UiResultTooLarge();
  const response = build(fitted.kept);
  services.statsCache.set(cacheKey, { version: indexed.version, response });
  if (services.statsCache.size > CACHE_LIMIT) {
    const oldest = services.statsCache.keys().next();
    if (!oldest.done) services.statsCache.delete(oldest.value);
  }
  return response;
}
