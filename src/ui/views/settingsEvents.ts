import type { SettingKey, SettingValue } from "../api/settingsClient.js";
import { t } from "../i18n/index.js";

export interface SettingsActions {
  update(key: SettingKey, value: SettingValue): void;
  save(): void;
  cancel(): void;
  retryLoad(): void;
  reconcile(): void;
}

function keyOf(value: string | undefined): SettingKey | null {
  if (value === "organizationEnabled" || value === "organizationProvider" || value === "organizationModel" || value === "organizationContextBudget") return value;
  return null;
}

export function bindSettingsEvents(root: HTMLElement, actions: SettingsActions): () => void {
  const onInput = (event: Event): void => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    const key = keyOf(input.dataset.settingKey);
    if (key === "organizationProvider" || key === "organizationModel") actions.update(key, input.value);
    if (key === "organizationContextBudget") {
      const output = input.closest(".setting-control")?.querySelector<HTMLOutputElement>("[data-budget-value]");
      if (output !== null && output !== undefined) output.textContent = `${Number(input.value).toLocaleString("en-US")} ${t("settings.bytes")}`;
      actions.update(key, Number(input.value));
    }
  };
  const onChange = (event: Event): void => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    const key = keyOf(input.dataset.settingKey);
    if (key === "organizationEnabled") actions.update(key, input.checked);
  };
  const onSubmit = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof HTMLFormElement) || !target.matches("[data-settings-form]")) return;
    event.preventDefault();
    actions.save();
  };
  const onClick = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLElement>("[data-settings-action]");
    if (button === null || button.hasAttribute("disabled")) return;
    const action = button.dataset.settingsAction;
    if (action === "cancel") actions.cancel();
    else if (action === "retry-load") actions.retryLoad();
    else if (action === "reconcile") actions.reconcile();
  };
  root.addEventListener("input", onInput);
  root.addEventListener("change", onChange);
  root.addEventListener("submit", onSubmit);
  root.addEventListener("click", onClick);
  return () => {
    root.removeEventListener("input", onInput);
    root.removeEventListener("change", onChange);
    root.removeEventListener("submit", onSubmit);
    root.removeEventListener("click", onClick);
  };
}
