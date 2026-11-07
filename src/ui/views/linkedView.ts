import type { ErrorDescription } from "../api/errors.js";
import { EMPTY_HTML, html, type SafeHtml } from "../dom/html.js";
import { dateTime } from "../i18n/clock.js";
import { t } from "../i18n/index.js";
import { relativeTime } from "../i18n/relativeTime.js";
import { sizeText, sourceName, type LinkDetail, type LinkItemRow, type LinkSourceRow, type LinkedNotice, type LinkedView, type SourcePanel } from "../state/linked.js";

export const LINKED_IDS = { title: "linked-title", body: "linked-body" } as const;

export type DrawerNotice = { readonly kind: "conflict" } | { readonly kind: "failed"; readonly error: ErrorDescription };

export interface LinkedDrawerView {
  readonly phase: "loading" | "ready" | "error";
  readonly source: string;
  readonly id: string;
  readonly detail: LinkDetail | null;
  readonly error: ErrorDescription | null;
  readonly notice: DrawerNotice | null;
  readonly forgetting: boolean;
}

export const linkedShell = (): SafeHtml => html`<section class="lk" aria-labelledby="${LINKED_IDS.title}">
<h2 id="${LINKED_IDS.title}" class="lk-h" tabindex="-1">${t("lk.title")}</h2>
<p class="muted lk-help">${t("lk.help")}</p>
<div id="${LINKED_IDS.body}"></div>
</section>`;

export const nameOf = (source: string): string => sourceName(source, { core: t("lk.source.core"), plugin: (id) => t("lk.source.plugin", { id }) });
export const sizeOf = (bytes: number): string => sizeText(bytes, { bytes: (n) => t("lk.size.bytes", { n }), kb: (n) => t("lk.size.kb", { n }) });
const agoOf = (ms: number, nowMs: number): string => relativeTime(new Date(ms).toISOString(), nowMs);

function errorNotice(error: ErrorDescription, heading: string | null): SafeHtml {
  const lead = heading === null ? html`<strong>${error.message}</strong>` : html`<strong>${heading}</strong> <span>${error.message}</span>`;
  return html`<div class="notice notice-error" role="alert" data-code="${error.code}">${lead}<p>${error.action}</p></div>`;
}

function renderNotice(notice: LinkedNotice | null): SafeHtml {
  if (notice === null) return EMPTY_HTML;
  if (notice.kind === "text") return html`<div class="notice" role="status" data-lk-notice="text">${notice.text}</div>`;
  return html`<div data-lk-notice="error">${errorNotice(notice.error, notice.heading)}</div>`;
}

function tile(value: string, label: string): SafeHtml {
  return html`<div class="card tile"><b>${value}</b><span>${label}</span></div>`;
}

function renderTags(tags: readonly string[]): SafeHtml {
  return tags.length === 0 ? EMPTY_HTML : html`<span class="lk-tags">${tags.map((tag) => html`<span class="chip">${tag}</span>`)}</span>`;
}

function renderItem(source: string, item: LinkItemRow, nowMs: number): SafeHtml {
  const summary = item.snippet.trim() === "" ? t("lk.item.noText") : item.snippet;
  const written = t("lk.item.written", { ago: agoOf(item.updatedAtMs, nowMs) });
  const expires = item.expiresAtMs === null ? EMPTY_HTML : html`<span>${t("lk.item.expires", { at: dateTime(item.expiresAtMs) })}</span>`;
  const label = t("lk.item.aria", { written, summary });
  return html`<button type="button" class="mcard" data-lk="open" data-lk-source="${source}" data-lk-id="${item.id}" aria-label="${label}"><span class="mc-l1"><span title="${dateTime(item.updatedAtMs)}">${written}</span>${expires}</span><span class="mc-snip">${summary}</span><span class="mc-meta">${t("lk.item.size", { size: sizeOf(item.sizeBytes) })}${renderTags(item.tags)}</span></button>`;
}

function renderPanelBody(source: string, panel: SourcePanel, nowMs: number): SafeHtml {
  if (!panel.open) return EMPTY_HTML;
  if (panel.load === "idle" || panel.load === "loading") return html`<div role="status" aria-live="polite"><span class="muted">${t("lk.source.loading")}</span></div>`;
  if (panel.load === "error" && panel.error !== null) return html`${errorNotice(panel.error, null)}<p><button type="button" class="btn" data-lk="retry" data-lk-source="${source}">${t("lk.source.retry")}</button></p>`;
  if (panel.items.length === 0) return html`<p class="muted">${t("lk.source.none")}</p>`;
  const more = panel.nextCursor === null ? EMPTY_HTML : html`<p><button type="button" class="btn" data-lk="more" data-lk-source="${source}" aria-disabled="${panel.loadingMore ? "true" : "false"}">${panel.loadingMore ? t("common.loading") : t("lk.source.more")}</button></p>`;
  return html`<div class="lk-items">${panel.items.map((item) => renderItem(source, item, nowMs))}</div>${more}`;
}

function renderSource(row: LinkSourceRow, panel: SourcePanel, index: number, busy: boolean, nowMs: number): SafeHtml {
  const source = row.source as string;
  const name = nameOf(source);
  const summary = row.updatedAtMs === null
    ? t("lk.source.summaryEmpty", { count: row.count, size: sizeOf(row.sizeBytes) })
    : t("lk.source.summary", { count: row.count, size: sizeOf(row.sizeBytes), ago: agoOf(row.updatedAtMs, nowMs) });
  const toggleLabel = panel.open ? t("lk.source.collapse") : t("lk.source.expand");
  const toggleAria = panel.open ? t("lk.source.collapseAria", { name }) : t("lk.source.expandAria", { name });
  return html`<section class="lk-source" aria-labelledby="lk-h-${index}"><div class="team-h"><h3 class="lk-name" id="lk-h-${index}"><b>${name}</b> <span class="muted">${summary}</span></h3><button type="button" class="btn" data-lk="toggle" data-lk-source="${source}" aria-expanded="${panel.open ? "true" : "false"}" aria-controls="lk-p-${index}" aria-label="${toggleAria}">${toggleLabel}</button><button type="button" class="btn btn-danger-outline" data-lk="forgetSource" data-lk-source="${source}" aria-label="${t("lk.source.forgetAllAria", { name })}" aria-disabled="${busy ? "true" : "false"}">${t("lk.source.forgetAll")}</button></div><div id="lk-p-${index}" class="lk-panel">${renderPanelBody(source, panel, nowMs)}</div></section>`;
}

export const shortId = (fileId: string): string => fileId.slice(0, 8);

function renderDamaged(row: LinkSourceRow, busy: boolean): SafeHtml {
  return html`<section class="notice notice-error lk-damaged" aria-label="${t("lk.damaged.title", { id: shortId(row.fileId) })}"><p><b>${t("lk.damaged.title", { id: shortId(row.fileId) })}</b></p><p>${t("lk.damaged.body")}</p><p><button type="button" class="btn" data-lk="removeDamaged" data-lk-file="${row.fileId}" aria-disabled="${busy ? "true" : "false"}">${t("lk.damaged.remove")}</button></p></section>`;
}

function renderSources(view: LinkedView, nowMs: number): SafeHtml {
  const rows = view.sources.map((row, index) => {
    if (row.state === "corrupt" || row.source === null) return renderDamaged(row, view.busy);
    const panel = view.panels[row.source];
    return panel === undefined ? EMPTY_HTML : renderSource(row, panel, index, view.busy, nowMs);
  });
  return html`${rows}`;
}

export function renderLinkedBody(view: LinkedView, nowMs: number): SafeHtml {
  if (view.phase === "loading") return html`<div role="status" aria-live="polite"><span class="sr">${t("lk.loading")}</span></div><div class="tiles" aria-hidden="true"><div class="card tile skeleton"></div><div class="card tile skeleton"></div><div class="card tile skeleton"></div></div>`;
  if (view.phase === "error" && view.error !== null) {
    const action = view.error.retryable || view.error.actionKind === "reload" ? html`<p><button type="button" class="btn" data-lk="reload">${t("common.retry")}</button></p>` : EMPTY_HTML;
    return html`<h3 class="sr">${t("lk.error.title")}</h3>${errorNotice(view.error, null)}${action}`;
  }
  const tiles = html`<div class="tiles">${tile(String(view.totals.sources), t("lk.tile.sources"))}${tile(String(view.totals.count), t("lk.tile.count"))}${tile(sizeOf(view.totals.sizeBytes), t("lk.tile.size"))}</div>`;
  const empty = view.sources.length === 0 ? html`<div class="notice"><p>${t("lk.empty")}</p></div>` : EMPTY_HTML;
  return html`${renderNotice(view.notice)}${tiles}${empty}${renderSources(view, nowMs)}`;
}

function renderDrawerNotice(notice: DrawerNotice | null): SafeHtml {
  if (notice === null) return EMPTY_HTML;
  if (notice.kind === "conflict") return html`<div class="notice" role="alert" data-lk-notice="conflict">${t("lk.notice.conflict")}</div>`;
  return html`<div data-lk-notice="failed">${errorNotice(notice.error, t("lk.notice.failed"))}</div>`;
}

export function renderDrawerBody(view: LinkedDrawerView): SafeHtml {
  if (view.phase === "loading") return html`<div role="status" aria-live="polite"><span class="sr">${t("lk.drawer.loading")}</span></div><div aria-hidden="true"><div class="dr-skel"></div><div class="dr-skel"></div><div class="dr-skel dr-skel-short"></div></div>`;
  if (view.phase === "error" && view.error !== null) {
    const action = view.error.actionKind === "reload"
      ? html`<button type="button" class="btn" data-lk="drawerCloseReload">${t("lk.drawer.closeReload")}</button>`
      : view.error.retryable ? html`<button type="button" class="btn" data-lk="drawerRetry">${t("lk.drawer.retry")}</button>` : EMPTY_HTML;
    return html`${errorNotice(view.error, null)}<p>${action}</p>`;
  }
  if (view.detail === null) return EMPTY_HTML;
  const { item } = view.detail;
  const expires = item.expiresAtMs === null ? t("lk.drawer.never") : dateTime(item.expiresAtMs);
  const tags = item.tags.length === 0 ? EMPTY_HTML : html`<h3 class="dr-h">${t("lk.drawer.tags")}</h3><p class="lk-tags">${item.tags.map((tag) => html`<span class="chip">${tag}</span>`)}</p>`;
  return html`${renderDrawerNotice(view.notice)}<p class="dr-who"><b>${nameOf(view.source)}</b></p><p class="muted dr-meta"><span>${t("lk.drawer.written")} ${dateTime(item.updatedAtMs)}</span><span>${t("lk.drawer.expires")} ${expires}</span><span>${t("lk.drawer.size")} ${sizeOf(item.sizeBytes)}</span></p><h3 class="dr-h">${t("lk.drawer.content")}</h3><pre class="dr-txt lk-text">${item.text}</pre>${tags}<h3 class="dr-h">${t("lk.drawer.id")}</h3><p class="mono">${item.id}</p>`;
}

export function renderDrawerFoot(view: LinkedDrawerView): SafeHtml {
  if (view.phase !== "ready" || view.detail === null) return EMPTY_HTML;
  const label = view.forgetting ? t("lk.drawer.forgetting") : t("lk.drawer.forget");
  return html`<span class="muted dr-hint">${t("lk.drawer.hint")}</span><button type="button" class="btn btn-danger-outline" data-lk="forgetItem" aria-disabled="${view.forgetting ? "true" : "false"}">${label}</button>`;
}

export const renderConfirmItem = (): SafeHtml => html`<ul><li>${t("lk.confirm.item.forever")}</li><li>${t("lk.confirm.item.reader")}</li><li>${t("lk.confirm.item.untouched")}</li></ul>`;

export const renderConfirmSource = (name: string, count: number): SafeHtml => html`<div class="dlg-quote"><b>${name}</b></div><ul><li>${t("lk.confirm.source.count", { n: count })}</li><li>${t("lk.confirm.source.reader")}</li><li>${t("lk.confirm.source.untouched")}</li></ul>`;

export const renderConfirmDamaged = (id: string): SafeHtml => html`<p>${t("lk.confirm.damaged.body", { id })}</p>`;
