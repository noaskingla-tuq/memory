import { html, type SafeHtml } from "../dom/html.js";
import { t, type StringKey } from "../i18n/index.js";
import type { SettingsState } from "../state/settings.js";
import type { AiModelChoice, AiOptionsView, AiProviderChoice, AiProviderState } from "../api/aiOptionsClient.js";

export type AiChoices =
  | { readonly status: "pending" }
  | { readonly status: "unavailable" }
  | { readonly status: "ready"; readonly options: AiOptionsView };

const STATE_LABELS: Readonly<Record<Exclude<AiProviderState, "ready">, StringKey>> = {
  not_installed: "settings.provider.state.notInstalled",
  not_logged_in: "settings.provider.state.notLoggedIn",
  unsupported_version: "settings.provider.state.unsupportedVersion",
  unavailable: "settings.provider.state.unavailable",
  not_supported_yet: "settings.provider.state.notSupportedYet",
};

// why: mirrors the backend, which uses the named provider when it is given and otherwise the default provider if ready, then the first ready one
export function effectiveProvider(options: AiOptionsView, providerId: string): AiProviderChoice | undefined {
  if (providerId !== "") return options.providers.find((provider) => provider.id === providerId);
  const ready = options.providers.filter((provider) => provider.state === "ready");
  return ready.find((provider) => provider.id === options.defaultProviderId) ?? ready[0];
}

export function modelsFor(options: AiOptionsView, providerId: string): readonly AiModelChoice[] {
  return effectiveProvider(options, providerId)?.models ?? [];
}

export function modelSurvivesProviderChange(options: AiOptionsView, providerId: string, modelId: string): boolean {
  return modelId === "" || modelsFor(options, providerId).some((model) => model.id === modelId);
}

export function changeProvider(settings: Pick<SettingsState, "update" | "view">, choices: AiChoices, providerId: string): void {
  settings.update("organizationProvider", providerId);
  const draft = settings.view().draft;
  if (choices.status !== "ready" || draft === null) return;
  if (!modelSurvivesProviderChange(choices.options, draft.organizationProvider, draft.organizationModel)) settings.update("organizationModel", "");
}

function option(value: string, label: string, selected: boolean, disabled: boolean): SafeHtml {
  if (selected) return disabled ? html`<option value="${value}" selected disabled>${label}</option>` : html`<option value="${value}" selected>${label}</option>`;
  return disabled ? html`<option value="${value}" disabled>${label}</option>` : html`<option value="${value}">${label}</option>`;
}

function select(id: string, key: string, describedBy: string, disabled: boolean, options: readonly SafeHtml[]): SafeHtml {
  return disabled
    ? html`<select id="${id}" data-setting-key="${key}" aria-describedby="${describedBy}" disabled>${options}</select>`
    : html`<select id="${id}" data-setting-key="${key}" aria-describedby="${describedBy}">${options}</select>`;
}

export function providerSelect(options: AiOptionsView, value: string, describedBy: string, disabled: boolean): SafeHtml {
  const known = options.providers.some((provider) => provider.id === value);
  const items = [
    option("", t("settings.provider.default"), value === "", false),
    ...options.providers.map((provider) => {
      const label = provider.state === "ready" ? provider.label : t("settings.choice.unusable", { label: provider.label, reason: t(STATE_LABELS[provider.state as Exclude<AiProviderState, "ready">]) });
      return option(provider.id, label, provider.id === value, provider.state !== "ready");
    }),
    ...(value === "" || known ? [] : [option(value, t("settings.choice.missing", { id: value }), true, false)]),
  ];
  return select("settings-provider", "organizationProvider", describedBy, disabled, items);
}

export function modelSelect(options: AiOptionsView, providerId: string, value: string, describedBy: string, disabled: boolean): SafeHtml {
  const models = modelsFor(options, providerId);
  const known = models.some((model) => model.id === value);
  const items = [
    option("", t("settings.model.default"), value === "", false),
    ...models.map((model) => option(model.id, model.label, model.id === value, false)),
    ...(value === "" || known ? [] : [option(value, t("settings.choice.missing", { id: value }), true, false)]),
  ];
  return select("settings-model", "organizationModel", describedBy, disabled, items);
}
