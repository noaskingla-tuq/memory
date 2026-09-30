import type { ErrorDescription } from "../api/errors.js";
import { avatar } from "../components/avatar.js";
import { sparkline } from "../components/sparkline.js";
import { EMPTY_HTML, html, type SafeHtml } from "../dom/html.js";
import { t } from "../i18n/index.js";
import { relativeTime } from "../i18n/relativeTime.js";
import { agentHref } from "../router.js";
import {
  buildGroups,
  displayName,
  projectLabel,
  SORT_KEYS,
  sparkSum,
  TEAM_OPTION_PREFIX,
  type OverviewAgent,
  type OverviewTiles,
  type ProfileHealth,
  type ProjectCount,
  type SortKey,
  type TeamGroup,
} from "../state/teamHome.js";

const CARD_PROJECTS = 2;
const SKELETON_CARDS = 6;

export interface HomeView {
  readonly phase: "loading" | "ready" | "error";
  readonly error: ErrorDescription | null;
  readonly notice: ErrorDescription | null;
  readonly moreError: ErrorDescription | null;
  readonly tiles: OverviewTiles | null;
  readonly agents: readonly OverviewAgent[];
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly complete: boolean;
  readonly unavailableAgents: number;
  readonly profile: ProfileHealth;
  readonly team: string | null;
  readonly sort: SortKey;
  readonly helpOpen: boolean;
}

const number = (value: number): string => value.toLocaleString("zh-TW");

export const homeShell = (): SafeHtml => html`<div id="home-help"></div>
<div id="home-banner"></div>
<div id="home-tiles"></div>
<div class="wall-tools"><div id="home-tools" class="wall-controls"></div><p id="home-count" class="muted count" aria-live="polite"></p></div>
<p id="home-note" class="note"></p>
<div id="home-wall"></div>`;

function actionFor(error: ErrorDescription, retryAct: "reload" | "loadMore"): SafeHtml {
  if (error.actionKind === "restartList") return html`<button type="button" class="btn" data-act="reload">${t("common.reloadFromStart")}</button>`;
  return error.retryable ? html`<button type="button" class="btn" data-act="${retryAct}">${t("common.retry")}</button>` : EMPTY_HTML;
}

export function renderError(error: ErrorDescription, retryAct: "reload" | "loadMore"): SafeHtml {
  return html`<div class="notice notice-error" role="alert" data-code="${error.code}"><strong>${error.message}</strong><p>${error.action}</p>${actionFor(error, retryAct)}</div>`;
}

export function renderHelp(view: HomeView): SafeHtml {
  if (view.phase !== "ready" || view.agents.length === 0 || !view.helpOpen) return EMPTY_HTML;
  return html`<section class="notice help" aria-labelledby="help-title"><h2 id="help-title" tabindex="-1">${t("home.help.title")}</h2><p>${t("home.help.body")}</p><button type="button" class="btn" data-act="dismissHelp">${t("home.help.dismiss")}</button></section>`;
}

const OMITTED_KEYS = ["agents", "teams", "projects"] as const;

// why: a name table with holes is a display matter only, so the notice says what falls back to ids and that the memories themselves are intact
export function profileNotice(profile: ProfileHealth): string {
  if (profile.corrupt) return t("home.profile.corrupt");
  if (!profile.incomplete) return "";
  const detail = OMITTED_KEYS.filter((key) => profile.omitted[key] > 0).map((key) => t(`home.profile.omitted.${key}`, { n: number(profile.omitted[key]) }));
  return detail.length === 0 ? t("home.profile.incompleteUnknown") : t("home.profile.incomplete", { detail: detail.join(t("home.profile.separator")) });
}

export function renderBanner(view: HomeView): SafeHtml {
  if (view.phase !== "ready") return EMPTY_HTML;
  const parts: SafeHtml[] = [];
  if (view.notice !== null) parts.push(renderError(view.notice, "reload"));
  if (!view.complete) parts.push(html`<div class="notice" role="status"><span>${t("overview.incomplete")}</span> <button type="button" class="btn" data-act="reload">${t("common.refresh")}</button></div>`);
  if (view.unavailableAgents > 0) parts.push(html`<div class="notice" role="status">${t("home.unavailable", { n: view.unavailableAgents })}</div>`);
  const profile = profileNotice(view.profile);
  if (profile !== "") parts.push(html`<div class="notice" role="status" data-notice="profile">${profile}</div>`);
  return html`${parts}`;
}

function tile(value: string, label: string): SafeHtml {
  return html`<div class="card tile"><b>${value}</b><span>${label}</span></div>`;
}

export function renderTiles(view: HomeView): SafeHtml {
  if (view.phase === "loading") return html`<div class="tiles" aria-hidden="true"><div class="card tile skeleton"></div><div class="card tile skeleton"></div><div class="card tile skeleton"></div></div>`;
  if (view.phase !== "ready" || view.tiles === null) return EMPTY_HTML;
  const { tiles } = view;
  return html`<div class="tiles">${tile(number(tiles.totalMemories), t("home.tile.total"))}${tile(number(tiles.writtenToday), t("home.tile.today"))}${tile(`${number(tiles.activeAgents7d)} / ${number(tiles.agents)}`, t("home.tile.active"))}</div>`;
}

function teamOption(value: string, label: string, selected: boolean): SafeHtml {
  return selected ? html`<option value="${value}" selected>${label}</option>` : html`<option value="${value}">${label}</option>`;
}

function sortOption(sort: SortKey, selected: boolean): SafeHtml {
  const label = t(`home.sort.${sort}`);
  return selected ? html`<option value="${sort}" selected>${label}</option>` : html`<option value="${sort}">${label}</option>`;
}

export function renderTools(view: HomeView): SafeHtml {
  if (view.phase !== "ready" || view.agents.length === 0) return EMPTY_HTML;
  const groups = buildGroups(view.agents, view.sort);
  const teams = groups.map((group) => teamOption(`${TEAM_OPTION_PREFIX}${group.key}`, t("home.filter.teamOption", { name: group.label, n: group.agents.length }), view.team === group.key));
  const help = view.helpOpen ? EMPTY_HTML : html`<button type="button" class="btn-link" data-act="showHelp">${t("home.help.open")}</button>`;
  return html`<label class="sr" for="home-team">${t("home.filter.team")}</label><select id="home-team" data-role="team">${teamOption("", t("home.filter.allTeams", { n: groups.length }), view.team === null)}${teams}</select><label class="sr" for="home-sort">${t("home.sort.label")}</label><select id="home-sort" data-role="sort">${SORT_KEYS.map((sort) => sortOption(sort, sort === view.sort))}</select>${help}`;
}

export function visibleAgents(view: HomeView): readonly OverviewAgent[] {
  return view.team === null ? view.agents : view.agents.filter((agent) => agent.team.key === view.team);
}

export function renderCount(view: HomeView, announceMore: boolean): string {
  if (view.phase !== "ready" || view.agents.length === 0) return "";
  const shown = visibleAgents(view).length;
  if (announceMore) return t("home.count.loadedMore", { shown });
  const total = view.tiles?.agents ?? shown;
  return view.hasMore && view.team === null ? t("home.count.partial", { shown, total }) : t("home.count.shown", { shown });
}

export function renderNote(view: HomeView): string {
  return view.phase === "ready" && view.agents.length > 0 ? t("home.projectNote") : "";
}

function projectChip(project: ProjectCount): SafeHtml {
  return html`<span class="chip">${t("card.project", { name: projectLabel(project), n: number(project.count) })}</span>`;
}

function projectsRow(agent: OverviewAgent): SafeHtml {
  const { projects, otherProjects } = agent.counts;
  const hidden = projects.length - CARD_PROJECTS;
  const more = otherProjects > 0 ? t("card.moreProjectsAtLeast", { n: Math.max(0, hidden) + 1 }) : hidden > 0 ? t("card.moreProjects", { n: hidden }) : "";
  return html`${projects.slice(0, CARD_PROJECTS).map(projectChip)}${more === "" ? EMPTY_HTML : html`<span class="muted">${more}</span>`}${projects.length === 0 ? html`<span class="muted">${t("card.noProject")}</span>` : EMPTY_HTML}`;
}

export function renderCard(agent: OverviewAgent, nowMs: number): SafeHtml {
  const name = displayName(agent);
  const ago = relativeTime(agent.lastAt, nowMs);
  const snippet = agent.latest?.snippet.trim() ?? "";
  return html`<a class="acard" href="${agentHref(agent.id)}" data-agent-id="${agent.id}" aria-label="${t("card.aria", { name, count: number(agent.counts.total), ago })}"><span class="acard-top">${avatar(agent.id, name, 40)}<span class="acard-who"><span class="acard-name">${name}</span><span class="acard-id">${agent.id}</span></span></span><span class="acard-row"><span class="badge">${t("card.personal", { n: number(agent.counts.personal) })}</span>${projectsRow(agent)}</span><span class="acard-latest"><b>${t("card.latest")}</b>${snippet === "" ? t("card.noLatest") : snippet}</span><span class="acard-foot"><span>${t("card.total", { n: number(agent.counts.total) })}<br>${t("card.lastAt", { ago })}</span>${sparkline(agent.spark14, t("card.spark", { sum: sparkSum(agent) }))}</span></a>`;
}

function renderGroup(group: TeamGroup, index: number, nowMs: number): SafeHtml {
  return html`<section class="team" aria-labelledby="team-${index}"><h2 class="team-h" id="team-${index}"><b>${group.label}</b><span class="muted">${t("home.team.summary", { agents: number(group.agents.length), count: number(group.total) })}</span></h2><div class="wall">${group.agents.map((agent) => renderCard(agent, nowMs))}</div></section>`;
}

function skeletonWall(): SafeHtml {
  const cards = Array.from({ length: SKELETON_CARDS }, () => html`<div class="acard skeleton" aria-hidden="true"></div>`);
  return html`<div role="status" aria-live="polite"><span class="sr">${t("home.skeleton")}</span></div><div class="wall" aria-hidden="true">${cards}</div>`;
}

function emptyWall(): SafeHtml {
  return html`<div class="empty"><h2>${t("home.empty.title")}</h2><p>${t("home.empty.body")}</p><p>${t("home.help.body")}</p><p class="muted">${t("home.projectNote")}</p></div>`;
}

function loadMoreArea(view: HomeView): SafeHtml {
  const failure =
    view.moreError === null
      ? EMPTY_HTML
      : html`<div class="notice notice-error" role="alert" data-code="${view.moreError.code}"><strong>${t("home.moreFailed")}</strong> <span>${view.moreError.message}</span> <span>${view.moreError.action}</span> ${actionFor(view.moreError, "loadMore")}</div>`;
  if (!view.hasMore) return failure;
  const button = view.loadingMore
    ? html`<button type="button" class="btn" disabled>${t("common.loading")}</button>`
    : html`<button type="button" class="btn" data-act="loadMore">${t("common.loadMore")}</button>`;
  return html`${failure}<p class="more">${button}</p>`;
}

export function renderWall(view: HomeView, nowMs: number): SafeHtml {
  if (view.phase === "loading") return skeletonWall();
  if (view.phase === "error" && view.error !== null) return html`<h2 class="sr">${t("home.error.title")}</h2>${renderError(view.error, "reload")}`;
  if (view.agents.length === 0 && !view.hasMore) return emptyWall();
  const groups = buildGroups(visibleAgents(view), view.sort);
  return html`${groups.map((group, index) => renderGroup(group, index, nowMs))}${loadMoreArea(view)}`;
}
