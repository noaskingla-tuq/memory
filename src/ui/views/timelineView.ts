import type { ErrorDescription } from "../api/errors.js";
import { EMPTY_HTML, html, type SafeHtml } from "../dom/html.js";
import { t } from "../i18n/index.js";
import {
  DEFAULT_CLI_OPTIONS,
  groupByDay,
  isFiltered,
  itemKey,
  projectOptionLabel,
  RANGE_KEYS,
  scopeText,
  scopeValue,
  splitByTerms,
  termsOf,
  toolText,
  workText,
  writtenText,
  writtenTitle,
  PROJECT_VALUE_PREFIX,
  type ProjectOption,
  type TimelineFilters,
  type TimelineItem,
} from "../state/timeline.js";

export interface TimelineView {
  readonly phase: "loading" | "ready" | "error";
  readonly searching: boolean;
  readonly query: string | null;
  readonly normalizedQuery: string | null;
  readonly filters: TimelineFilters;
  readonly projects: readonly ProjectOption[];
  readonly cliOptions: readonly string[];
  readonly items: readonly TimelineItem[];
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly complete: boolean;
  readonly restarted: boolean;
  readonly error: ErrorDescription | null;
  readonly notice: ErrorDescription | null;
  readonly moreError: ErrorDescription | null;
}

export const TIMELINE_IDS = {
  title: "tl-title",
  form: "tl-form",
  query: "tl-query",
  filters: "tl-filters",
  clear: "tl-clear",
  banner: "tl-banner",
  count: "tl-count",
  list: "tl-list",
  scope: "tl-scope",
} as const;

const number = (value: number): string => value.toLocaleString("zh-TW");

export const timelineShell = (): SafeHtml => html`<section class="tl" aria-labelledby="tl-title">
<h2 id="tl-title" class="tl-h" tabindex="-1">${t("tl.title")}</h2>
<form id="tl-form" class="tl-search" role="search" data-tl-form><label class="sr" for="tl-query">${t("tl.search.label")}</label><input id="tl-query" name="q" type="search" maxlength="100" autocomplete="off" placeholder="${t("tl.search.placeholder")}" aria-describedby="tl-hint"><button type="submit" class="btn btn-primary">${t("tl.search.submit")}</button></form>
<p id="tl-hint" class="muted tl-hint">${t("tl.search.hint")}</p>
<div class="tl-tools"><div id="tl-filters" class="tl-filters"></div><div id="tl-clear"></div></div>
<div id="tl-banner"></div>
<p id="tl-count" class="muted count" aria-live="polite"></p>
<div id="tl-list"></div>
</section>`;

function option(value: string, label: string, selected: boolean): SafeHtml {
  return selected ? html`<option value="${value}" selected>${label}</option>` : html`<option value="${value}">${label}</option>`;
}

function scopeOptions(view: TimelineView): SafeHtml[] {
  const current = scopeValue(view.filters);
  const known = new Set(view.projects.map((project) => project.projectId));
  const projects = [...view.projects];
  // why: a project chosen earlier that is no longer in the supplied list must stay selectable, or the select would silently show "all" while the query still filters by it
  if (view.filters.projectId !== null && !known.has(view.filters.projectId)) projects.push({ projectId: view.filters.projectId });
  return [
    option("all", t("tl.filter.scope.all"), current === "all"),
    option("personal", t("tl.filter.scope.personal"), current === "personal"),
    option("project", t("tl.filter.scope.project"), current === "project"),
    ...projects.map((project) => option(`${PROJECT_VALUE_PREFIX}${project.projectId}`, t("tl.filter.scope.oneProject", { name: projectOptionLabel(project) }), current === `${PROJECT_VALUE_PREFIX}${project.projectId}`)),
  ];
}

function cliChoices(view: TimelineView): string[] {
  const choices = view.cliOptions.length === 0 ? [...DEFAULT_CLI_OPTIONS] : [...view.cliOptions];
  if (view.filters.cli !== null && !choices.includes(view.filters.cli)) choices.push(view.filters.cli);
  return choices;
}

export function renderFilters(view: TimelineView): SafeHtml {
  const ranges = RANGE_KEYS.map((key) => option(key, t(`tl.filter.range.${key}`), view.filters.range === key));
  const tools = [option("", t("tl.filter.cli.all"), view.filters.cli === null), ...cliChoices(view).map((cli) => option(cli, cli, view.filters.cli === cli))];
  return html`<label class="sr" for="tl-scope">${t("tl.filter.scope")}</label><select id="tl-scope" data-tl-role="scope">${scopeOptions(view)}</select><label class="sr" for="tl-range">${t("tl.filter.range")}</label><select id="tl-range" data-tl-role="range">${ranges}</select><label class="sr" for="tl-cli">${t("tl.filter.cli")}</label><select id="tl-cli" data-tl-role="cli">${tools}</select>`;
}

export function renderClear(view: TimelineView): SafeHtml {
  return isFiltered(view.filters) ? html`<button type="button" class="btn-link" data-tl="clearFilters">${t("tl.filter.clear")}</button>` : EMPTY_HTML;
}

function errorAction(error: ErrorDescription, retryAct: "reload" | "loadMore"): SafeHtml {
  if (error.actionKind === "restartList") return html`<button type="button" class="btn" data-tl="reload">${t("common.reloadFromStart")}</button>`;
  return error.retryable ? html`<button type="button" class="btn" data-tl="${retryAct}">${t("common.retry")}</button>` : EMPTY_HTML;
}

function errorNotice(error: ErrorDescription, retryAct: "reload" | "loadMore", heading: string | null): SafeHtml {
  const lead = heading === null ? html`<strong>${error.message}</strong>` : html`<strong>${heading}</strong> <span>${error.message}</span>`;
  return html`<div class="notice notice-error" role="alert" data-code="${error.code}">${lead}<p>${error.action}</p>${errorAction(error, retryAct)}</div>`;
}

export function renderBanner(view: TimelineView): SafeHtml {
  if (view.phase !== "ready") return EMPTY_HTML;
  const parts: SafeHtml[] = [];
  if (view.restarted) parts.push(html`<div class="notice" role="status" data-tl-notice="restarted">${t("tl.restarted")}</div>`);
  if (view.notice !== null) parts.push(errorNotice(view.notice, "reload", t("tl.refreshFailed")));
  if (view.searching && !view.complete) parts.push(html`<div class="notice" role="status" data-tl-notice="incomplete"><span>${t("tl.incomplete")}</span> <button type="button" class="btn" data-tl="reload">${t("tl.retrySearch")}</button></div>`);
  return html`${parts}`;
}

export function renderSummary(view: TimelineView): SafeHtml {
  if (view.phase !== "ready" || !view.searching || view.query === null) return EMPTY_HTML;
  const normalized = view.normalizedQuery !== null && view.normalizedQuery !== view.query ? html`<span class="muted">${t("tl.search.normalized", { q: view.normalizedQuery })}</span>` : EMPTY_HTML;
  return html`<div class="tl-active"><b>${t("tl.search.active", { q: view.query })}</b> ${normalized} <button type="button" class="btn-link" data-tl="clearSearch">${t("tl.search.clear")}</button></div>`;
}

export function renderCount(view: TimelineView, announceMore: boolean): string {
  if (view.phase !== "ready" || view.items.length === 0) return "";
  const n = number(view.items.length);
  if (announceMore) return t("tl.count.loadedMore", { n });
  if (view.searching) return view.hasMore ? t("tl.count.searchMore", { n }) : t("tl.count.search", { n });
  return view.hasMore ? t("tl.count.listMore", { n }) : t("tl.count.list", { n });
}

function highlighted(text: string, terms: readonly string[]): SafeHtml {
  return html`${splitByTerms(text, terms).map((piece) => (piece.hit ? html`<mark>${piece.text}</mark>` : piece.text))}`;
}

function summaryOf(item: TimelineItem): string {
  const title = item.work?.title?.trim() ?? "";
  const body = item.snippet.trim();
  return title !== "" ? title : body !== "" ? body : t("tl.item.noText");
}

function renderItem(item: TimelineItem, terms: readonly string[]): SafeHtml {
  const title = item.work?.title?.trim() ?? "";
  const body = item.snippet.trim();
  const tool = toolText(item);
  const label = t("tl.item.aria", { scope: scopeText(item), written: writtenText(item), summary: summaryOf(item) });
  const request = title === "" ? EMPTY_HTML : html`<span class="mc-req">${highlighted(title, terms)}</span>`;
  const snippet = body === "" && title !== "" ? EMPTY_HTML : html`<span class="mc-snip">${body === "" ? t("tl.item.noText") : highlighted(body, terms)}</span>`;
  return html`<button type="button" class="mcard" data-tl="open" data-tl-key="${itemKey(item.ref)}" aria-label="${label}"><span class="mc-l1"><span class="badge">${scopeText(item)}</span><span title="${writtenTitle(item)}">${writtenText(item)}</span></span>${request}${snippet}<span class="mc-meta">${workText(item)}${tool === null ? EMPTY_HTML : html`・${tool}`}</span></button>`;
}

function skeleton(searching: boolean): SafeHtml {
  const cards = Array.from({ length: 4 }, () => html`<div class="mcard skeleton" aria-hidden="true"></div>`);
  return html`<div role="status" aria-live="polite"><span class="sr">${searching ? t("tl.searching") : t("tl.loading")}</span></div><div aria-hidden="true">${cards}</div>`;
}

function emptyState(view: TimelineView): SafeHtml {
  if (view.searching) return html`<div class="empty"><h3>${t("tl.empty.search.title")}</h3><p>${t("tl.empty.search.body")}</p><p><button type="button" class="btn" data-tl="clearSearch">${t("tl.search.clear")}</button></p></div>`;
  if (isFiltered(view.filters)) return html`<div class="empty"><h3>${t("tl.empty.filtered.title")}</h3><p>${t("tl.empty.filtered.body")}</p><p><button type="button" class="btn" data-tl="clearFilters">${t("tl.filter.clear")}</button></p></div>`;
  return html`<div class="empty"><h3>${t("tl.empty.list.title")}</h3><p>${t("tl.empty.list.body")}</p></div>`;
}

function moreArea(view: TimelineView): SafeHtml {
  const failure = view.moreError === null ? EMPTY_HTML : errorNotice(view.moreError, "loadMore", t("tl.moreFailed"));
  if (!view.hasMore) return failure;
  const button = view.loadingMore
    ? html`<button type="button" class="btn" disabled>${t("common.loading")}</button>`
    : html`<button type="button" class="btn" data-tl="loadMore">${t("common.loadMore")}</button>`;
  return html`${failure}<p class="more">${button}</p>`;
}

export function renderList(view: TimelineView, nowMs: number): SafeHtml {
  if (view.phase === "loading") return skeleton(view.searching);
  if (view.phase === "error" && view.error !== null) return html`<h3 class="sr">${t("tl.error.title")}</h3>${errorNotice(view.error, "reload", null)}`;
  if (view.items.length === 0) {
    const pending = view.hasMore ? html`<p class="muted">${t("tl.empty.more")}</p>` : emptyState(view);
    return html`${pending}${moreArea(view)}`;
  }
  const terms = view.searching ? termsOf(view.normalizedQuery ?? view.query) : [];
  const groups = groupByDay(view.items, nowMs).map((group) => html`<section class="tl-day" aria-label="${group.label}"><h3 class="day">${group.label}</h3>${group.items.map((item) => renderItem(item, terms))}</section>`);
  return html`<p class="muted tl-order">${t("tl.order")}</p>${groups}${moreArea(view)}`;
}
