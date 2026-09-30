import type { UiRef } from "../../contracts/uiContract.js";
import type { ErrorDescription } from "../api/errors.js";
import { EMPTY_HTML, html, type SafeHtml } from "../dom/html.js";
import { dateTime } from "../i18n/clock.js";
import { t } from "../i18n/index.js";
import { parseInstant } from "../i18n/relativeTime.js";
import { asItem, detailText, RECEIPTS_MAX, type DetailData, type DetailReceipt } from "../state/detail.js";
import { itemKey, projectOptionLabel, scopeText, toolText, workText, writtenText, type TimelineItem } from "../state/timeline.js";

export type DetailNotice = { readonly kind: "conflict" } | { readonly kind: "forgetFailed"; readonly error: ErrorDescription };

export interface DetailView {
  readonly phase: "loading" | "ready" | "error";
  readonly ref: UiRef;
  readonly data: DetailData | null;
  readonly error: ErrorDescription | null;
  readonly notice: DetailNotice | null;
  readonly forgetting: boolean;
}

const SUMMARY_CHARS = 120;

export const agentNameOf = (data: DetailData): string => data.agentName ?? data.ref.agentId;

function writtenFull(data: DetailData): string {
  const ms = parseInstant(data.updatedAt);
  return ms === null ? t("tl.item.writtenUnknown") : t("dt.written", { at: dateTime(ms) });
}

function errorNotice(error: ErrorDescription, heading: string | null): SafeHtml {
  const lead = heading === null ? html`<strong>${error.message}</strong>` : html`<strong>${heading}</strong> <span>${error.message}</span>`;
  return html`<div class="notice notice-error" role="alert" data-code="${error.code}">${lead}<p>${error.action}</p></div>`;
}

function renderNotice(notice: DetailNotice | null): SafeHtml {
  if (notice === null) return EMPTY_HTML;
  if (notice.kind === "conflict") return html`<div class="notice" role="alert" data-dt-notice="conflict">${t("dt.conflict")}</div>`;
  return html`<div data-dt-notice="forgetFailed">${errorNotice(notice.error, t("dt.forgetFailed"))}</div>`;
}

function renderReceipt(receipt: DetailReceipt): SafeHtml {
  const ms = parseInstant(receipt.createdAt);
  const role = t(receipt.role === "user" ? "dt.receipt.role.user" : "dt.receipt.role.assistant");
  const at = ms === null ? t("time.unknown") : dateTime(ms);
  return html`<li title="${receipt.eventId}">${t("dt.receipt.line", { client: receipt.client, session: receipt.sessionId, role, at })}</li>`;
}

function renderReceipts(data: DetailData): SafeHtml {
  const note = data.receipts.length >= RECEIPTS_MAX ? html`<p class="muted dr-note">${t("dt.receipts.capped", { n: RECEIPTS_MAX })}</p>` : EMPTY_HTML;
  const list = data.receipts.length === 0 ? html`<p class="muted">${t("dt.receipts.none")}</p>` : html`<ul class="dr-receipts">${data.receipts.map(renderReceipt)}</ul>`;
  return html`<h3 class="dr-h">${t("dt.section.receipts")}</h3>${list}${note}`;
}

function siblingSummary(item: TimelineItem): string {
  const title = item.work?.title?.trim() ?? "";
  const body = item.snippet.trim();
  return title !== "" ? title : body !== "" ? body : t("dt.noText");
}

function renderSibling(item: TimelineItem): SafeHtml {
  const summary = siblingSummary(item);
  const at = writtenText(item);
  return html`<button type="button" class="sib" data-dt="sibling" data-dt-key="${itemKey(item.ref)}" aria-label="${t("dt.sibling.aria", { at, summary })}"><span class="sib-at">${at}</span><span class="sib-text">${summary}</span></button>`;
}

function renderScope(data: DetailData): SafeHtml {
  if (data.ref.scope === "personal") return html`<p><span class="badge">${t("tl.item.personal")}</span> ${t("dt.scope.personal")}</p>`;
  const projectId = data.ref.projectId ?? "";
  return html`<p><span class="badge">${t("dt.scope.project", { name: projectOptionLabel({ projectId, name: data.projectName }) })}</span> <span class="muted mono">${projectId}</span></p>`;
}

export function renderReady(data: DetailData): SafeHtml {
  const item = asItem(data);
  const text = detailText(data);
  const tool = toolText(item);
  const work = data.work === undefined ? EMPTY_HTML : html`<span>${workText(item)}</span>${tool === null ? EMPTY_HTML : html`<span>${tool}</span>`}`;
  const request = text.request === null ? EMPTY_HTML : html`<h3 class="dr-h">${t("dt.section.request")}</h3><div class="dr-txt">${text.request}</div>`;
  const result = text.result.trim() === "" ? t("dt.noText") : text.result;
  const siblings = data.sameSession.length === 0 ? EMPTY_HTML : html`<h3 class="dr-h">${t("dt.section.sameSession", { n: data.sameSession.length })}</h3><div class="dr-sibs">${data.sameSession.map(renderSibling)}</div>`;
  return html`<p class="dr-who"><b>${agentNameOf(data)}</b> <span class="badge">${scopeText(item)}</span></p><p class="muted dr-meta"><span>${writtenFull(data)}</span>${work}</p>${request}<h3 class="dr-h">${text.isWork ? t("dt.section.result") : t("dt.section.content")}</h3><div class="dr-txt">${result}</div><h3 class="dr-h">${t("dt.section.scope")}</h3>${renderScope(data)}${renderReceipts(data)}<details class="dr-raw"><summary>${t("dt.section.raw")}</summary><pre>${data.content}</pre></details>${siblings}`;
}

function skeleton(): SafeHtml {
  return html`<div role="status" aria-live="polite"><span class="sr">${t("dt.loading")}</span></div><div aria-hidden="true"><div class="dr-skel"></div><div class="dr-skel"></div><div class="dr-skel dr-skel-short"></div></div>`;
}

function renderError(error: ErrorDescription): SafeHtml {
  const action =
    error.actionKind === "reload"
      ? html`<button type="button" class="btn" data-dt="closeReload">${t("dt.closeReload")}</button>`
      : error.retryable
        ? html`<button type="button" class="btn" data-dt="retry">${t("common.retry")}</button>`
        : EMPTY_HTML;
  return html`<h3 class="sr">${t("dt.error.title")}</h3>${errorNotice(error, null)}<p>${action}</p>`;
}

export function renderDetailBody(view: DetailView): SafeHtml {
  if (view.phase === "loading") return skeleton();
  if (view.phase === "error" && view.error !== null) return renderError(view.error);
  if (view.data === null) return EMPTY_HTML;
  return html`${renderNotice(view.notice)}${renderReady(view.data)}`;
}

export function renderDetailFoot(view: DetailView): SafeHtml {
  if (view.phase !== "ready" || view.data === null) return EMPTY_HTML;
  const label = view.forgetting ? t("dt.forgetting") : t("dt.forget");
  return html`<span class="muted dr-hint">${t("dt.foot.hint")}</span><button type="button" class="btn btn-danger-outline" data-dt="forget" aria-disabled="${view.forgetting ? "true" : "false"}">${label}</button>`;
}

function quoteSummary(data: DetailData): string {
  const text = detailText(data);
  const source = text.request ?? (text.result.trim() === "" ? t("dt.noText") : text.result);
  const flat = source.replace(/\s+/gu, " ").trim();
  const chars = [...flat];
  return chars.length > SUMMARY_CHARS ? `${chars.slice(0, SUMMARY_CHARS).join("")}…` : flat;
}

export function renderConfirmBody(data: DetailData): SafeHtml {
  const agent = agentNameOf(data);
  return html`<div class="dlg-quote"><b>${agent}</b>　${writtenFull(data)}<div>${quoteSummary(data)}</div></div><ul><li>${t("dt.confirm.forever", { agent })}</li><li>${t("dt.confirm.receipts")}</li><li>${t("dt.confirm.again")}</li><li>${t("dt.confirm.untouched")}</li></ul>`;
}
