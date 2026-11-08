import type { BackendClient } from "../api/backendClient.js";
import { openDialog, type DialogHandle, type DialogOptions } from "../components/dialog.js";
import { EMPTY_HTML, html, mount, type SafeHtml } from "../dom/html.js";
import { t } from "../i18n/index.js";

export interface LegacyUpgradeDeps {
  readonly client: Pick<BackendClient, "call">;
  readonly reload: () => Promise<void>;
  readonly background?: () => HTMLElement | null;
  readonly document?: Document;
}

export interface LegacyUpgrade {
  run(count: number): Promise<void>;
}

interface Tally {
  upgraded: number;
  failed: number;
}

interface Batch {
  readonly upgraded: number;
  readonly failed: number;
  readonly failedHashes: readonly string[];
  readonly remaining: number;
  readonly handled: number;
}

const BATCH_LIMIT = 5;
const SKIP_MAX = 200;

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

// why: the view cannot run zod, so the answer is checked by hand and anything unexpected counts as a stop instead of as success
function parseBatch(value: unknown): Batch | null {
  const answer = value as { ok?: unknown; upgraded?: unknown; failed?: unknown; remaining?: unknown; results?: unknown } | null;
  if (typeof answer !== "object" || answer === null || answer.ok !== true || !Array.isArray(answer.results)) return null;
  if (!isCount(answer.upgraded) || !isCount(answer.failed) || !isCount(answer.remaining)) return null;
  const failedHashes: string[] = [];
  for (const entry of answer.results as readonly { agentHash?: unknown; ok?: unknown }[]) {
    if (typeof entry?.agentHash !== "string" || typeof entry.ok !== "boolean") return null;
    if (!entry.ok) failedHashes.push(entry.agentHash);
  }
  return { upgraded: answer.upgraded, failed: answer.failed, failedHashes, remaining: answer.remaining, handled: answer.results.length };
}

function progressBody(total: number, tally: Tally): SafeHtml {
  const done = tally.upgraded + tally.failed;
  return html`<p role="status">${t("legacy.progress.body", { done, total, upgraded: tally.upgraded, failed: tally.failed })}</p>`;
}

export function createLegacyUpgrade(deps: LegacyUpgradeDeps): LegacyUpgrade {
  let busy = false;
  const show = (options: Pick<DialogOptions, "title" | "body" | "actions" | "initialFocus" | "dismissible" | "dismissAction">): DialogHandle | null => {
    try {
      return openDialog({ ...options, background: deps.background?.() ?? null, ...(deps.document === undefined ? {} : { document: deps.document }) });
    } catch {
      return null;
    }
  };

  const confirm = async (count: number): Promise<boolean> => {
    const body = html`<p>${t("legacy.confirm.intro", { n: count })}</p><p>${t("legacy.confirm.backup")}</p>`;
    const handle = show({
      title: t("legacy.confirm.title"),
      body,
      actions: [{ id: "cancel", label: t("legacy.confirm.cancel") }, { id: "start", label: t("legacy.confirm.start", { n: count }), kind: "primary" }],
      initialFocus: "cancel",
      dismissAction: "cancel",
    });
    return handle !== null && (await handle.result).action === "start";
  };

  const upgradeAll = async (total: number, progress: DialogHandle | null): Promise<{ tally: Tally; stopped: string | null }> => {
    const tally: Tally = { upgraded: 0, failed: 0 };
    const skip: string[] = [];
    let stopped: string | null = null;
    while (skip.length < SKIP_MAX) {
      const result = await deps.client.call("ui.upgradeLegacy", { skip, limit: BATCH_LIMIT });
      if (!result.ok) {
        stopped = `${result.message}${result.action}`;
        break;
      }
      const batch = parseBatch(result.value);
      if (batch === null) {
        stopped = t("legacy.result.unreadable");
        break;
      }
      tally.upgraded += batch.upgraded;
      tally.failed += batch.failed;
      skip.push(...batch.failedHashes);
      if (progress !== null) mount(progress.bodyElement, progressBody(total, tally));
      if (batch.remaining === 0 || batch.handled === 0) break;
    }
    return { tally, stopped };
  };

  return {
    async run(count) {
      if (busy || !(count > 0)) return;
      busy = true;
      try {
        if (!(await confirm(count))) return;
        const progress = show({ title: t("legacy.progress.title"), body: progressBody(count, { upgraded: 0, failed: 0 }), actions: [], dismissible: false });
        const { tally, stopped } = await upgradeAll(count, progress);
        progress?.close();
        const summary = html`<p>${t("legacy.result.summary", { upgraded: tally.upgraded, failed: tally.failed })}</p>`;
        const hint = tally.failed > 0 ? html`<p>${t("legacy.result.failedHint")}</p>` : EMPTY_HTML;
        const reason = stopped === null ? EMPTY_HTML : html`<p>${stopped}</p>`;
        const done = show({ title: t("legacy.result.title"), body: html`${summary}${hint}${reason}`, actions: [{ id: "ok", label: t("legacy.result.ok"), kind: "primary" }], initialFocus: "ok" });
        const reloaded = deps.reload();
        if (done !== null) await done.result;
        await reloaded;
      } finally {
        busy = false;
      }
    },
  };
}
