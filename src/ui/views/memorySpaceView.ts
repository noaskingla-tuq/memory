import type { ErrorDescription } from "../api/errors.js";
import { avatar } from "../components/avatar.js";
import { EMPTY_HTML, html, type SafeHtml } from "../dom/html.js";
import { t, type StringKey } from "../i18n/index.js";
import { clockTime, monthDay } from "../i18n/clock.js";
import { localDate, parseInstant, relativeTime } from "../i18n/relativeTime.js";
import {
  firstText,
  peakOf,
  percentText,
  projectTitle,
  spaceRows,
  spaceTotals,
  sumOf,
  toolRows,
  type AgentStats,
  type SpaceItem,
  type SpaceRows,
} from "../state/memorySpace.js";
import { displayName, idTail, type OverviewAgent } from "../state/teamHome.js";
import { axis, barRow, columnChart, spaceBarRow } from "./memorySpaceCharts.js";

export const SPACE_TITLE_ID = "space-title";
export const SPACE_TIMELINE_ID = "space-timeline";
export const SPACE_ORG_ID = "space-org";

export interface SpaceView {
  readonly phase: "loading" | "ready" | "empty" | "error";
  readonly agentId: string;
  readonly hint: OverviewAgent | undefined;
  readonly stats: AgentStats | null;
  readonly error: ErrorDescription | null;
}

const number = (value: number): string => value.toLocaleString("zh-TW");

// why: the timeline slot lives in the shell, outside the body that the stats controller re-renders, so the timeline slice can mount into it without being wiped by a stats refresh
export const spaceShell = (): SafeHtml => html`<p><a class="btn-link" href="#/" data-back>${t("space.back")}</a></p>
<header class="space-head"><span id="space-avatar"></span><div class="space-who"><h2 id="space-title" tabindex="-1"></h2><p id="space-id" class="acard-id"></p><p id="space-meta" class="muted"></p></div></header>
<div id="space-body" class="space-body"></div>
<div id="space-org" class="ao" data-slot="org"></div>
<div id="space-timeline" data-slot="timeline"></div>`;

export function spaceName(view: SpaceView): string {
  const fromStats = firstText(view.stats?.agent?.displayName, view.stats?.agent?.name);
  if (fromStats !== undefined) return fromStats;
  return view.hint === undefined ? idTail(view.agentId) : displayName(view.hint);
}

export const renderSpaceAvatar = (view: SpaceView): SafeHtml => avatar(view.agentId, spaceName(view), 64);

export function spaceMeta(view: SpaceView, nowMs: number): string {
  const { stats, hint } = view;
  if (stats === null) return view.phase === "loading" && hint !== undefined ? t("space.summary", { count: number(hint.counts.total), ago: relativeTime(hint.lastAt, nowMs) }) : "";
  const totals = spaceTotals(stats.namespaces);
  const parts: string[] = [];
  parts.push(t("space.meta.total", { count: number(totals.total) }));
  if (totals.lastMs !== null) parts.push(t("space.meta.last", { ago: relativeTime(new Date(totals.lastMs).toISOString(), nowMs) }));
  return parts.join(t("space.meta.separator"));
}

function section(id: string, title: string, body: SafeHtml): SafeHtml {
  return html`<section class="card space-card" aria-labelledby="${id}"><h3 id="${id}">${title}</h3>${body}</section>`;
}

function spacesSection(rows: SpaceRows): SafeHtml {
  const personal = spaceBarRow(rows.personal.label, rows.personal.hint, t("space.spaces.count", { n: number(rows.personal.count) }), (rows.personal.count / rows.peak) * 100, "personal", "");
  const projects = rows.projects.map((row) => spaceBarRow(row.label, row.hint, t("space.spaces.count", { n: number(row.count) }), (row.count / rows.peak) * 100, "project", row.projectId ?? ""));
  const projectBody = rows.projects.length === 0 ? html`<p class="muted">${t("space.spaces.noProject")}</p>` : html`<ul class="bars">${projects}</ul>`;
  return section("space-h-spaces", t("space.spaces.title"), html`<ul class="bars">${personal}</ul><h4>${t("space.spaces.projects")}</h4>${projectBody}`);
}

function daysSection(stats: AgentStats): SafeHtml {
  const counts = stats.byDay30.map((day) => day.count);
  const peak = peakOf(counts);
  const sum = sumOf(counts);
  const label = peak === null ? t("space.days.ariaNone") : t("space.days.aria", { sum: number(sum), date: monthDay(stats.byDay30[peak.index]?.date ?? ""), n: number(peak.value) });
  const chart = columnChart(counts, label, (value, index) => t("space.days.tip", { date: monthDay(stats.byDay30[index]?.date ?? ""), n: number(value) }));
  const first = stats.byDay30[0]?.date;
  const scale = axis([first === undefined ? "" : monthDay(first), t("space.days.today")]);
  const note = peak === null ? t("space.days.none") : t("space.days.peak", { n: number(peak.value) });
  return section("space-h-days", t("space.days.title"), html`${chart}${scale}<p class="muted">${note}</p>`);
}

function rhythmSection(stats: AgentStats): SafeHtml {
  const hourPeak = peakOf(stats.byHour);
  const hourLabel = hourPeak === null ? t("space.hours.ariaNone") : t("space.hours.aria", { hour: hourPeak.index, n: number(hourPeak.value) });
  const hours = columnChart(stats.byHour, hourLabel, (value, index) => t("space.hours.tip", { hour: index, n: number(value) }));
  const dayName = (index: number): string => t(`space.weekday.${index}` as StringKey);
  const weekPeak = peakOf(stats.byWeekday);
  const weekLabel = weekPeak === null ? t("space.weekday.ariaNone") : t("space.weekday.aria", { day: dayName(weekPeak.index), n: number(weekPeak.value) });
  const week = columnChart(stats.byWeekday, weekLabel, (value, index) => t("space.weekday.tip", { day: dayName(index), n: number(value) }));
  const weekAxis = axis(stats.byWeekday.map((_, index) => dayName(index)));
  const body = html`${hours}${axis([t("space.hours.axis0"), t("space.hours.axis12"), t("space.hours.axis23")])}<h4>${t("space.weekday.title")}</h4>${week}${weekAxis}`;
  return section("space-h-hours", t("space.hours.title"), body);
}

function toolsSection(stats: AgentStats): SafeHtml {
  const rows = toolRows(stats.tools);
  const body = rows.length === 0 ? html`<p class="muted">${t("space.tools.empty")}</p>` : html`<ul class="bars">${rows.map((row) => barRow(row.label, row.label, percentText(row.percent), row.percent))}</ul>`;
  return section("space-h-tools", t("space.tools.title"), body);
}

function repeatSection(stats: AgentStats): SafeHtml {
  const top = stats.repeatedRequests[0]?.count ?? 1;
  const rows = stats.repeatedRequests.map((entry) => barRow(entry.title, entry.title, t("space.repeat.times", { n: number(entry.count) }), (entry.count / top) * 100));
  const body = rows.length === 0 ? html`<p class="muted">${t("space.repeat.empty")}</p>` : html`<ul class="bars">${rows}</ul>`;
  return section("space-h-repeat", t("space.repeat.title"), body);
}

function whenOf(item: SpaceItem): string {
  const start = parseInstant(item.work?.startIso);
  const end = parseInstant(item.work?.endIso);
  if (start !== null && end !== null) return t("space.rep.worked", { date: localDate(new Date(start)), from: clockTime(start), to: clockTime(end) });
  const written = parseInstant(item.updatedAt);
  return written === null ? t("time.unknown") : t("space.rep.written", { at: `${localDate(new Date(written))} ${clockTime(written)}` });
}

function representativeCard(item: SpaceItem): SafeHtml {
  const tool = [firstText(item.work?.cli), firstText(item.work?.model)].filter((part) => part !== undefined).join(" / ");
  const where = item.ref.scope === "personal" || item.ref.projectId === null ? t("space.rep.personal") : projectTitle(item.ref.projectId, item.names?.project);
  const meta = [whenOf(item), tool, where].filter((part) => part !== "").join(t("space.meta.separator"));
  const snippet = item.snippet.trim();
  return html`<article class="rep" data-memory-id="${item.ref.memoryId}" data-scope="${item.ref.scope}" data-project-id="${item.ref.projectId ?? ""}"><p class="rep-title">${firstText(item.work?.title) ?? t("space.rep.noTitle")}</p><p class="rep-meta">${meta}</p><p class="rep-snip">${snippet === "" ? t("space.rep.noSnippet") : snippet}</p></article>`;
}

function representativeSection(stats: AgentStats): SafeHtml {
  const body = stats.representative.length === 0 ? html`<p class="muted">${t("space.rep.empty")}</p>` : html`<div class="rep-grid">${stats.representative.map(representativeCard)}</div>`;
  return section("space-h-rep", t("space.rep.title"), body);
}

function renderReady(stats: AgentStats): SafeHtml {
  const sampled = stats.sampled ? html`<div class="notice" role="status">${t("space.sampled")}</div>` : EMPTY_HTML;
  return html`${sampled}${spacesSection(spaceRows(stats.namespaces))}${daysSection(stats)}<div class="space-pair">${rhythmSection(stats)}${toolsSection(stats)}</div>${repeatSection(stats)}${representativeSection(stats)}`;
}

function renderLoading(): SafeHtml {
  return html`<div role="status" aria-live="polite"><span class="sr">${t("space.loading")}</span></div><div aria-hidden="true"><div class="card space-card skeleton space-skeleton"></div><div class="card space-card skeleton space-skeleton"></div></div>`;
}

function renderFailure(error: ErrorDescription): SafeHtml {
  const retry = error.retryable ? html`<button type="button" class="btn" data-act="retrySpace">${t("common.retry")}</button>` : EMPTY_HTML;
  return html`<h3 class="sr">${t("space.error.title")}</h3><div class="notice notice-error" role="alert" data-code="${error.code}"><strong>${error.message}</strong><p>${error.action}</p>${retry}</div>`;
}

function renderEmpty(): SafeHtml {
  return html`<div class="empty"><h3>${t("space.empty.title")}</h3><p>${t("space.empty.body")}</p></div>`;
}

export function renderSpaceBody(view: SpaceView): SafeHtml {
  if (view.phase === "loading") return renderLoading();
  if (view.phase === "error" && view.error !== null) return renderFailure(view.error);
  if (view.phase === "ready" && view.stats !== null) return renderReady(view.stats);
  return renderEmpty();
}
