import { avatar } from "../components/avatar.js";
import { html, type SafeHtml } from "../dom/html.js";
import { t } from "../i18n/index.js";
import { relativeTime } from "../i18n/relativeTime.js";
import { displayName, idTail, type OverviewAgent } from "../state/teamHome.js";

export const SPACE_TITLE_ID = "space-title";

export function renderMemorySpaceShell(agentId: string, agent: OverviewAgent | undefined, nowMs: number): SafeHtml {
  const name = agent === undefined ? idTail(agentId) : displayName(agent);
  const summary = agent === undefined ? "" : t("space.summary", { count: agent.counts.total.toLocaleString("zh-TW"), ago: relativeTime(agent.lastAt, nowMs) });
  return html`<p><a class="btn-link" href="#/" data-back>${t("space.back")}</a></p>
<header class="space-head">${avatar(agentId, name, 64)}<div class="space-who"><h2 id="space-title" tabindex="-1">${name}</h2><p class="acard-id">${agentId}</p><p class="muted">${summary}</p></div></header>
<div class="empty"><h2>${t("space.soon.title")}</h2><p>${t("space.soon.body", { name })}</p></div>`;
}
