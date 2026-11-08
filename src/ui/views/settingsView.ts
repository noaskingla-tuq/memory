import { html, type SafeHtml } from "../dom/html.js";
import { t, type StringKey } from "../i18n/index.js";
import type { SettingKey } from "../api/settingsClient.js";
import type { SettingsOutcome, SettingsSnapshot } from "../state/settings.js";
import { modelSelect, providerSelect, type AiChoices } from "./settingsPicker.js";

const labels: Readonly<Record<SettingKey, StringKey>> = {
  organizationEnabled: "settings.enabled.label",
  organizationProvider: "settings.provider.label",
  organizationModel: "settings.model.label",
  organizationContextBudget: "settings.budget.label",
  organizationFrequency: "settings.frequency.label",
  organizationDailyTime: "settings.dailyTime.label",
};

function checkboxInput(disabled: boolean, checked: boolean): SafeHtml {
  if (checked) {
    return disabled
      ? html`<input id="settings-enabled" data-setting-key="organizationEnabled" type="checkbox" checked aria-describedby="settings-enabled-help settings-enabled-effect settings-enabled-status" disabled>`
      : html`<input id="settings-enabled" data-setting-key="organizationEnabled" type="checkbox" checked aria-describedby="settings-enabled-help settings-enabled-effect settings-enabled-status">`;
  }
  return disabled
    ? html`<input id="settings-enabled" data-setting-key="organizationEnabled" type="checkbox" aria-describedby="settings-enabled-help settings-enabled-effect settings-enabled-status" disabled>`
    : html`<input id="settings-enabled" data-setting-key="organizationEnabled" type="checkbox" aria-describedby="settings-enabled-help settings-enabled-effect settings-enabled-status">`;
}

function textInput(id: string, key: SettingKey, value: string, placeholder: string, describedBy: string, disabled: boolean): SafeHtml {
  if (disabled) return html`<input id="${id}" data-setting-key="${key}" type="text" value="${value}" placeholder="${placeholder}" aria-describedby="${describedBy}" maxlength="128" autocomplete="off" spellcheck="false" disabled>`;
  return html`<input id="${id}" data-setting-key="${key}" type="text" value="${value}" placeholder="${placeholder}" aria-describedby="${describedBy}" maxlength="128" autocomplete="off" spellcheck="false">`;
}

function rangeInput(value: number, describedBy: string, disabled: boolean, invalid: boolean): SafeHtml {
  if (disabled) return html`<input id="settings-budget" data-setting-key="organizationContextBudget" type="range" min="8192" max="262144" step="8192" value="${value}" aria-describedby="${describedBy}" aria-invalid="${invalid}" disabled>`;
  return html`<input id="settings-budget" data-setting-key="organizationContextBudget" type="range" min="8192" max="262144" step="8192" value="${value}" aria-describedby="${describedBy}" aria-invalid="${invalid}">`;
}

function frequencySelect(value: string, describedBy: string, disabled: boolean): SafeHtml {
  const daily = value === "daily"
    ? html`<option value="daily" selected>${t("settings.frequency.daily")}</option>`
    : html`<option value="daily">${t("settings.frequency.daily")}</option>`;
  const immediate = value === "immediate"
    ? html`<option value="immediate" selected>${t("settings.frequency.immediate")}</option>`
    : html`<option value="immediate">${t("settings.frequency.immediate")}</option>`;
  return disabled
    ? html`<select id="settings-frequency" data-setting-key="organizationFrequency" aria-describedby="${describedBy}" disabled>${daily}${immediate}</select>`
    : html`<select id="settings-frequency" data-setting-key="organizationFrequency" aria-describedby="${describedBy}">${daily}${immediate}</select>`;
}

function dailyTimeInput(value: string, describedBy: string, disabled: boolean, invalid: boolean): SafeHtml {
  if (disabled) return html`<input id="settings-daily-time" data-setting-key="organizationDailyTime" type="time" step="60" value="${value}" aria-describedby="${describedBy}" aria-invalid="${invalid}" disabled>`;
  return html`<input id="settings-daily-time" data-setting-key="organizationDailyTime" type="time" step="60" value="${value}" aria-describedby="${describedBy}" aria-invalid="${invalid}">`;
}

function actionButton(label: string, action: string, type: "button" | "submit", disabled: boolean, primary = false): SafeHtml {
  const buttonClass = primary ? "btn btn-primary" : "btn";
  return disabled
    ? html`<button class="${buttonClass}" type="${type}" data-settings-action="${action}" disabled>${label}</button>`
    : html`<button class="${buttonClass}" type="${type}" data-settings-action="${action}">${label}</button>`;
}

function keyStatus(status: SettingsOutcome | undefined, dirty: boolean, saving = false): SafeHtml {
  if (saving) return html`<span class="setting-status" data-kind="saving">${t("settings.key.saving")}</span>`;
  if (status === "unknown") return html`<span class="setting-status" data-kind="unknown">${t("settings.key.unknown")}</span>`;
  if (status === "conflict") return html`<span class="setting-status" data-kind="conflict">${t("settings.key.conflict")}</span>`;
  if (status === "failed") return html`<span class="setting-status" data-kind="failed">${t("settings.key.failed")}</span>`;
  if (status === "saved") return html`<span class="setting-status" data-kind="saved">${t("settings.key.saved")}</span>`;
  if (dirty) return html`<span class="setting-status" data-kind="dirty">${t("settings.key.dirty")}</span>`;
  return html``;
}

function conflictCopy(snapshot: SettingsSnapshot, key: SettingKey): SafeHtml {
  if (snapshot.outcomes[key] !== "conflict") return html``;
  const current = snapshot.currentValues[key];
  const draft = snapshot.draft?.[key];
  return html`<p class="setting-conflict" role="alert">${t("settings.state.conflict", { current: String(current), draft: String(draft) })}</p>`;
}

function organizationField(snapshot: SettingsSnapshot, disabled: boolean): SafeHtml {
  const key: SettingKey = "organizationEnabled";
  const checked = snapshot.draft?.[key] === true;
  const status = keyStatus(snapshot.outcomes[key], snapshot.dirtyKeys.includes(key), snapshot.savingKey === key);
  return html`<div class="setting-row setting-row-switch">
    <div class="setting-copy"><label for="settings-enabled">${t("settings.enabled.label")}</label><p id="settings-enabled-help">${t("settings.enabled.help")}</p><p id="settings-enabled-effect">${t("settings.enabled.effect")}</p>${conflictCopy(snapshot, key)}</div>
    <div class="setting-control"><label class="settings-switch" for="settings-enabled">${checkboxInput(disabled, checked)}<span class="settings-switch-track" aria-hidden="true"></span><span class="settings-switch-state">${checked ? t("settings.enabled.on") : t("settings.enabled.off")}</span></label><p id="settings-enabled-status" class="setting-key-status" aria-live="polite">${status}</p></div>
  </div>`;
}

function frequencyField(snapshot: SettingsSnapshot, disabled: boolean): SafeHtml {
  const key: SettingKey = "organizationFrequency";
  const value = snapshot.draft?.[key] as string ?? "daily";
  const status = keyStatus(snapshot.outcomes[key], snapshot.dirtyKeys.includes(key), snapshot.savingKey === key);
  return html`<div class="setting-row">
    <div class="setting-copy"><label for="settings-frequency">${t(labels[key])}</label><p id="settings-frequency-help">${t("settings.frequency.help")}</p><p id="settings-frequency-effect">${t("settings.frequency.effect")}</p>${conflictCopy(snapshot, key)}</div>
    <div class="setting-control">${frequencySelect(value, "settings-frequency-help settings-frequency-effect settings-frequency-status", disabled)}<p id="settings-frequency-status" class="setting-key-status" aria-live="polite">${status}</p></div>
  </div>`;
}

function dailyTimeField(snapshot: SettingsSnapshot, disabled: boolean): SafeHtml {
  const key: SettingKey = "organizationDailyTime";
  const value = snapshot.draft?.[key] as string ?? "02:00";
  const isDisabled = disabled || snapshot.draft?.organizationFrequency !== "daily";
  const status = keyStatus(snapshot.outcomes[key], snapshot.dirtyKeys.includes(key), snapshot.savingKey === key);
  const issue = snapshot.dailyTimeIssue === "invalid"
    ? html`<p id="settings-daily-time-issue" class="setting-note setting-invalid" role="alert">${t("settings.dailyTime.invalid")}</p>`
    : html``;
  const issueId = snapshot.dailyTimeIssue === null ? "" : "settings-daily-time-issue";
  const describedBy = ["settings-daily-time-help", "settings-daily-time-effect", "settings-daily-time-status", issueId].filter((part) => part !== "").join(" ");
  const disabledHelp = isDisabled ? html`<p class="setting-note">${t("settings.dailyTime.disabled")}</p>` : html``;
  return html`<div class="setting-row">
    <div class="setting-copy"><label for="settings-daily-time">${t(labels[key])}</label><p id="settings-daily-time-help">${t("settings.dailyTime.help")}</p><p id="settings-daily-time-effect">${t("settings.dailyTime.effect")}</p>${disabledHelp}${issue}${conflictCopy(snapshot, key)}</div>
    <div class="setting-control">${dailyTimeInput(value, describedBy, isDisabled, snapshot.dailyTimeIssue === "invalid")}<p id="settings-daily-time-status" class="setting-key-status" aria-live="polite">${status}</p></div>
  </div>`;
}

function textField(snapshot: SettingsSnapshot, key: "organizationProvider" | "organizationModel", disabled: boolean, choices: AiChoices): SafeHtml {
  const provider = key === "organizationProvider";
  const id = provider ? "settings-provider" : "settings-model";
  const helpId = `${id}-help`;
  const effectId = `${id}-effect`;
  const statusId = `${id}-status`;
  const status = keyStatus(snapshot.outcomes[key], snapshot.dirtyKeys.includes(key), snapshot.savingKey === key);
  const describedBy = `${helpId} ${effectId} ${statusId}`;
  const value = snapshot.draft?.[key] as string ?? "";
  const control = choices.status === "ready"
    ? provider
      ? providerSelect(choices.options, value, describedBy, disabled)
      : modelSelect(choices.options, snapshot.draft?.organizationProvider ?? "", value, describedBy, disabled)
    : textInput(id, key, value, t(provider ? "settings.provider.placeholder" : "settings.model.placeholder"), describedBy, disabled || choices.status === "pending");
  return html`<div class="setting-row">
    <div class="setting-copy"><label for="${id}">${t(labels[key])}</label><p id="${helpId}">${t(provider ? "settings.provider.help" : "settings.model.help")}</p><p id="${effectId}">${t(provider ? "settings.provider.effect" : "settings.model.effect")}</p>${conflictCopy(snapshot, key)}</div>
    <div class="setting-control">${control}<p id="${statusId}" class="setting-key-status" aria-live="polite">${status}</p></div>
  </div>`;
}

function budgetField(snapshot: SettingsSnapshot, disabled: boolean): SafeHtml {
  const key: SettingKey = "organizationContextBudget";
  const value = snapshot.draft?.[key] as number ?? 32768;
  const status = keyStatus(snapshot.outcomes[key], snapshot.dirtyKeys.includes(key), snapshot.savingKey === key);
  const issue = snapshot.budgetIssue === "invalid"
    ? html`<p id="settings-budget-issue" class="setting-note" role="status">${t("settings.budget.invalid")}</p>`
    : snapshot.budgetIssue === "off-step"
      ? html`<p id="settings-budget-issue" class="setting-note" role="status">${t("settings.budget.offStep", { value })}</p>`
      : html``;
  const issueId = snapshot.budgetIssue === null ? "" : "settings-budget-issue";
  const describedBy = ["settings-budget-help", "settings-budget-effect", "settings-budget-status", issueId].filter((part) => part !== "").join(" ");
  return html`<div class="setting-row">
    <div class="setting-copy"><label for="settings-budget">${t("settings.budget.label")}</label><p id="settings-budget-help">${t("settings.budget.help")}</p><p id="settings-budget-effect">${t("settings.budget.effect")}</p>${issue}${conflictCopy(snapshot, key)}</div>
    <div class="setting-control">${rangeInput(value, describedBy, disabled, snapshot.budgetIssue === "invalid")}<output class="settings-budget-value" for="settings-budget" data-budget-value>${value.toLocaleString("en-US")} ${t("settings.bytes")}</output><p id="settings-budget-status" class="setting-key-status" aria-live="polite">${status}</p></div>
  </div>`;
}

function saveFeedback(snapshot: SettingsSnapshot): SafeHtml {
  if (snapshot.saving) return html`<p class="settings-feedback" role="status" aria-live="polite">${t(snapshot.savingKey === null ? "settings.state.saving" : "settings.state.savingKey", snapshot.savingKey === null ? {} : { label: t(labels[snapshot.savingKey]) })}</p>`;
  if (snapshot.reconciling) return html`<p class="settings-feedback" role="status" aria-live="polite">${t("settings.state.reconciling")}</p>`;
  if (snapshot.lastSave === "unknown") return html`<div class="settings-feedback" role="alert"><p>${t("settings.state.unknown")}</p>${actionButton(t("settings.action.reconcile"), "reconcile", "button", snapshot.saving || snapshot.reconciling)}</div>`;
  if (snapshot.lastSave === "failed") {
    const message: StringKey = snapshot.lastErrorKind === "permission" ? "settings.state.permissionShort" : "settings.state.failed";
    return html`<p class="settings-feedback" role="alert">${t(message)}</p>`;
  }
  if (snapshot.lastSave === "partial") return html`<p class="settings-feedback" role="status" aria-live="polite">${t("settings.state.partial", { savedCount: snapshot.savedCount, remainingCount: snapshot.dirtyKeys.length })}</p>`;
  if (snapshot.lastSave === "saved") return html`<p class="settings-feedback" role="status" aria-live="polite">${t("settings.state.saved")}</p>`;
  if (snapshot.dirtyKeys.length > 0) return html`<p class="settings-feedback" role="status" aria-live="polite">${t("settings.state.dirty")}</p>`;
  return html`<p class="settings-feedback" role="status" aria-live="polite">${t("settings.state.loaded")}</p>`;
}

function errorState(snapshot: SettingsSnapshot): SafeHtml {
  const message = snapshot.phase === "unsupported"
    ? "settings.state.unsupported"
    : snapshot.phase === "permission-error"
      ? "settings.state.permission"
      : "settings.state.readError";
  const retry = actionButton(t("settings.action.retryLoad"), "retry-load", "button", false);
  return html`<div class="settings-feedback settings-error" role="alert"><p>${t(message)}</p><div class="settings-error-actions">${retry}<a class="btn btn-linklike" href="#/">${t("settings.action.overview")}</a></div></div>`;
}

function actions(snapshot: SettingsSnapshot, busy: boolean): SafeHtml {
  const dirty = snapshot.dirtyKeys.length > 0;
  const canCancel = dirty && !busy && !snapshot.hasUnknown;
  const canSave = dirty && !busy && !snapshot.hasUnknown && snapshot.dailyTimeIssue === null && !Object.values(snapshot.outcomes).includes("conflict");
  const saveLabel: StringKey = snapshot.saving ? "settings.state.saving" : snapshot.lastSave === "partial" || snapshot.lastSave === "failed" ? "settings.action.retrySave" : "settings.action.save";
  return html`<div class="settings-actions">${actionButton(t(saveLabel), "save", "submit", !canSave, true)}${actionButton(t("settings.action.cancel"), "cancel", "button", !canCancel)}</div>`;
}

export function settingsPage(snapshot: SettingsSnapshot, choices: AiChoices = { status: "unavailable" }): SafeHtml {
  const isReady = snapshot.phase === "ready" && snapshot.draft !== null;
  const busy = snapshot.phase === "loading" || snapshot.saving || snapshot.reconciling;
  const fieldsDisabled = busy || snapshot.hasUnknown;
  const body = isReady
    ? html`<fieldset class="settings-card"><legend>${t("settings.group.organization")}</legend>${organizationField(snapshot, fieldsDisabled)}${frequencyField(snapshot, fieldsDisabled)}${dailyTimeField(snapshot, fieldsDisabled)}</fieldset>
      <fieldset class="settings-card"><legend>${t("settings.group.provider")}</legend>${textField(snapshot, "organizationProvider", fieldsDisabled, choices)}${textField(snapshot, "organizationModel", fieldsDisabled, choices)}</fieldset>
      <fieldset class="settings-card"><legend>${t("settings.group.budget")}</legend>${budgetField(snapshot, fieldsDisabled)}</fieldset>
      ${saveFeedback(snapshot)}${snapshot.savedCount > 0 && snapshot.dirtyKeys.length > 0 ? html`<p class="settings-saved-note">${t("settings.note.savedKeys")}</p>` : html``}`
    : snapshot.phase === "loading"
      ? html`<p class="settings-loading" role="status" aria-live="polite">${t("settings.state.loading")}</p>`
      : errorState(snapshot);
  return html`<section class="settings-page" aria-labelledby="settings-title">
    <header class="settings-intro"><h1 id="settings-title" tabindex="-1">${t("settings.title")}</h1><p>${t("settings.intro")}</p></header>
    <form data-settings-form aria-busy="${busy}">${body}${actions(snapshot, busy)}</form>
  </section>`;
}
