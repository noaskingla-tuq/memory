import { classifySettingsError, SETTING_KEYS, SettingsApiError, type SettingKey, type SettingValue, type SettingsClient, type SettingsValues } from "../api/settingsClient.js";

export const SETTINGS_DEFAULTS: SettingsValues = {
  organizationEnabled: true,
  organizationProvider: "",
  organizationModel: "",
  organizationContextBudget: 32768,
  organizationFrequency: "daily",
  organizationDailyTime: "02:00",
};

const BUDGET_MIN = 8192;
const BUDGET_MAX = 262144;
const BUDGET_STEP = 8192;
const DAILY_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;

export type SettingsPhase = "loading" | "ready" | "read-error" | "permission-error" | "unsupported";
export type SettingsOutcome = "saved" | "failed" | "unknown" | "conflict";
export type SettingsErrorKind = "permission" | "failure" | null;

export interface SettingsSnapshot {
  readonly phase: SettingsPhase;
  readonly baseline: SettingsValues | null;
  readonly draft: SettingsValues | null;
  readonly saving: boolean;
  readonly savingKey: SettingKey | null;
  readonly reconciling: boolean;
  readonly lastSave: "saved" | "partial" | "failed" | "unknown" | null;
  readonly lastErrorKind: SettingsErrorKind;
  readonly savedCount: number;
  readonly budgetIssue: "invalid" | "off-step" | null;
  readonly dailyTimeIssue: "invalid" | null;
  readonly outcomes: Readonly<Partial<Record<SettingKey, SettingsOutcome>>>;
  readonly currentValues: Readonly<Partial<Record<SettingKey, SettingValue>>>;
  readonly dirtyKeys: readonly SettingKey[];
  readonly hasUnknown: boolean;
}

export interface SettingsState {
  view(): SettingsSnapshot;
  subscribe(listener: (snapshot: SettingsSnapshot) => void): () => void;
  load(): Promise<void>;
  update(key: SettingKey, value: SettingValue): void;
  save(): Promise<void>;
  reconcile(): Promise<void>;
  cancel(): boolean;
  hasUnsavedChanges(): boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalize(raw: Readonly<Record<string, unknown>>): { readonly values: SettingsValues; readonly budgetIssue: SettingsSnapshot["budgetIssue"] } {
  const budget = raw.organizationContextBudget;
  const validBudget = Number.isSafeInteger(budget) && (budget as number) >= BUDGET_MIN && (budget as number) <= BUDGET_MAX;
  const budgetIssue = validBudget ? ((budget as number) % BUDGET_STEP === 0 ? null : "off-step") : (budget === undefined ? null : "invalid");
  return {
    values: {
      organizationEnabled: raw.organizationEnabled !== false,
      organizationProvider: typeof raw.organizationProvider === "string" ? raw.organizationProvider.trim().slice(0, 128) : "",
      organizationModel: typeof raw.organizationModel === "string" ? raw.organizationModel.trim().slice(0, 128) : "",
      organizationContextBudget: validBudget ? budget as number : SETTINGS_DEFAULTS.organizationContextBudget,
      organizationFrequency: raw.organizationFrequency === "immediate" ? "immediate" : "daily",
      organizationDailyTime: typeof raw.organizationDailyTime === "string" && DAILY_TIME_PATTERN.test(raw.organizationDailyTime) ? raw.organizationDailyTime : SETTINGS_DEFAULTS.organizationDailyTime,
    },
    budgetIssue,
  };
}

function effectiveDraft(key: SettingKey, value: SettingValue): SettingValue {
  if (key === "organizationEnabled") return value === false ? false : true;
  if (key === "organizationProvider" || key === "organizationModel") return typeof value === "string" ? value.trim().slice(0, 128) : "";
  if (key === "organizationFrequency") return value === "immediate" ? "immediate" : "daily";
  if (key === "organizationDailyTime") return typeof value === "string" ? value : SETTINGS_DEFAULTS.organizationDailyTime;
  return Number.isSafeInteger(value) && typeof value === "number" && value >= BUDGET_MIN && value <= BUDGET_MAX ? value : SETTINGS_DEFAULTS.organizationContextBudget;
}

function cloneValues(values: SettingsValues): SettingsValues {
  return { ...values };
}

export function createSettingsState(client: SettingsClient): SettingsState {
  let phase: SettingsPhase = "loading";
  let baseline: SettingsValues | null = null;
  let draft: SettingsValues | null = null;
  let saving = false;
  let savingKey: SettingKey | null = null;
  let reconciling = false;
  let lastSave: SettingsSnapshot["lastSave"] = null;
  let lastErrorKind: SettingsErrorKind = null;
  let budgetIssue: SettingsSnapshot["budgetIssue"] = null;
  let dailyTimeIssue: SettingsSnapshot["dailyTimeIssue"] = null;
  let loadedBudgetIssue: SettingsSnapshot["budgetIssue"] = null;
  let outcomes: Partial<Record<SettingKey, SettingsOutcome>> = {};
  let currentValues: Partial<Record<SettingKey, SettingValue>> = {};
  let confirmedKeys = new Set<SettingKey>();
  let requestGeneration = 0;
  const listeners = new Set<(snapshot: SettingsSnapshot) => void>();

  const dirtyKeys = (): SettingKey[] => {
    const loaded = baseline;
    const edited = draft;
    if (loaded === null || edited === null) return [];
    return SETTING_KEYS.filter((key) => effectiveDraft(key, edited[key]) !== loaded[key]);
  };

  const unknownKeys = (): SettingKey[] => SETTING_KEYS.filter((key) => outcomes[key] === "unknown");

  function view(): SettingsSnapshot {
    const dirty = dirtyKeys();
    return {
      phase,
      baseline: baseline === null ? null : cloneValues(baseline),
      draft: draft === null ? null : cloneValues(draft),
      saving,
      savingKey,
      reconciling,
      lastSave,
      lastErrorKind,
      savedCount: SETTING_KEYS.filter((key) => confirmedKeys.has(key) && !dirty.includes(key)).length,
      budgetIssue,
      dailyTimeIssue,
      outcomes: { ...outcomes },
      currentValues: { ...currentValues },
      dirtyKeys: dirty,
      hasUnknown: unknownKeys().length > 0,
    };
  }

  function emit(): void {
    const snapshot = view();
    for (const listener of listeners) listener(snapshot);
  }

  function errorKind(error: unknown): "permission" | "failure" {
    return classifySettingsError(error) === "permission" ? "permission" : "failure";
  }

  function pageErrorPhase(error: unknown): SettingsPhase {
    if (error instanceof SettingsApiError && error.kind === "unsupported") return "unsupported";
    return errorKind(error) === "permission" ? "permission-error" : "read-error";
  }

  function updateConfirmed(key: SettingKey, value: unknown): SettingValue {
    const confirmed = effectiveDraft(key, value as SettingValue);
    if (baseline !== null && draft !== null) {
      baseline = { ...baseline, [key]: confirmed };
      if (effectiveDraft(key, draft[key]) === confirmed) draft = { ...draft, [key]: confirmed };
    }
    currentValues = { ...currentValues, [key]: confirmed };
    return confirmed;
  }

  async function readKey(key: SettingKey): Promise<{ readonly ok: true; readonly value: SettingValue } | { readonly ok: false; readonly error: unknown }> {
    try {
      const normalized = normalize({ [key]: await client.get(key) }).values;
      return { ok: true, value: normalized[key] };
    } catch (error) {
      lastErrorKind = errorKind(error);
      return { ok: false, error };
    }
  }

  async function reconcileKey(key: SettingKey): Promise<"draft" | "baseline" | "conflict" | "unknown"> {
    const previousBaseline = baseline?.[key];
    const desired = draft === null ? undefined : effectiveDraft(key, draft[key]);
    const result = await readKey(key);
    if (!result.ok) {
      outcomes = { ...outcomes, [key]: "unknown" };
      return "unknown";
    }
    const confirmed = updateConfirmed(key, result.value);
    if (Object.is(confirmed, desired)) {
      outcomes = { ...outcomes, [key]: "saved" };
      confirmedKeys.add(key);
      if (key === "organizationContextBudget") {
        budgetIssue = null;
        loadedBudgetIssue = null;
      }
      return "draft";
    }
    if (Object.is(confirmed, previousBaseline)) {
      outcomes = { ...outcomes, [key]: "failed" };
      return "baseline";
    }
    outcomes = { ...outcomes, [key]: "conflict" };
    confirmedKeys.delete(key);
    return "conflict";
  }

  async function load(): Promise<void> {
    const generation = ++requestGeneration;
    phase = "loading";
    baseline = null;
    draft = null;
    saving = false;
    savingKey = null;
    reconciling = false;
    lastSave = null;
    lastErrorKind = null;
    budgetIssue = null;
    dailyTimeIssue = null;
    loadedBudgetIssue = null;
    outcomes = {};
    currentValues = {};
    confirmedKeys = new Set();
    emit();
    try {
      const loaded = normalize(asRecord(await client.all()));
      if (generation !== requestGeneration) return;
      baseline = loaded.values;
      draft = cloneValues(loaded.values);
      budgetIssue = loaded.budgetIssue;
      loadedBudgetIssue = loaded.budgetIssue;
      phase = "ready";
    } catch (error) {
      if (generation !== requestGeneration) return;
      phase = pageErrorPhase(error);
      lastErrorKind = errorKind(error);
    }
    emit();
  }

  function update(key: SettingKey, value: SettingValue): void {
    if (phase !== "ready" || saving || reconciling || unknownKeys().length > 0 || draft === null) return;
    if (key === "organizationEnabled" && typeof value !== "boolean") return;
    if ((key === "organizationProvider" || key === "organizationModel") && typeof value !== "string") return;
    if (key === "organizationFrequency" && value !== "daily" && value !== "immediate") return;
    if (key === "organizationDailyTime") {
      if (typeof value !== "string") return;
      dailyTimeIssue = DAILY_TIME_PATTERN.test(value) ? null : "invalid";
    }
    if (key === "organizationContextBudget") {
      if (!Number.isSafeInteger(value) || typeof value !== "number" || value < BUDGET_MIN || value > BUDGET_MAX || value % BUDGET_STEP !== 0) return;
      budgetIssue = null;
    }
    draft = { ...draft, [key]: key === "organizationProvider" || key === "organizationModel" ? (value as string).slice(0, 128) : value };
    delete outcomes[key];
    delete currentValues[key];
    lastSave = null;
    lastErrorKind = null;
    emit();
  }

  async function reconcile(): Promise<void> {
    if (phase !== "ready" || saving || reconciling || unknownKeys().length === 0) return;
    reconciling = true;
    lastErrorKind = null;
    emit();
    let unresolved = false;
    let conflict = false;
    for (const key of SETTING_KEYS) {
      if (outcomes[key] !== "unknown") continue;
      const result = await reconcileKey(key);
      if (result === "unknown") unresolved = true;
      if (result === "conflict") conflict = true;
    }
    reconciling = false;
    const snapshot = view();
    lastSave = unresolved ? "unknown" : snapshot.dirtyKeys.length === 0 && snapshot.savedCount > 0 ? "saved" : snapshot.savedCount > 0 ? "partial" : conflict ? "failed" : snapshot.dirtyKeys.length > 0 ? "failed" : null;
    emit();
  }

  async function save(): Promise<void> {
    if (phase !== "ready" || saving || reconciling || draft === null || baseline === null) return;
    if (dailyTimeIssue !== null) return;
    if (unknownKeys().length > 0) {
      await reconcile();
      if (unknownKeys().length > 0 || Object.values(outcomes).includes("conflict")) return;
    }
    if (Object.values(outcomes).includes("conflict")) return;
    const dirty = dirtyKeys();
    const scheduleOrder: readonly SettingKey[] = draft.organizationFrequency === "daily"
      ? ["organizationDailyTime", "organizationFrequency"]
      : ["organizationFrequency", "organizationDailyTime"];
    const otherKeys = dirty.filter((key) => key !== "organizationEnabled" && key !== "organizationFrequency" && key !== "organizationDailyTime");
    const enabledFirst = draft.organizationEnabled === false && dirty.includes("organizationEnabled");
    const enabledLast = draft.organizationEnabled === true && dirty.includes("organizationEnabled");
    const keys = [
      ...(enabledFirst ? ["organizationEnabled" as const] : []),
      ...otherKeys,
      ...scheduleOrder.filter((key) => dirty.includes(key)),
      ...(enabledLast ? ["organizationEnabled" as const] : []),
    ];
    if (keys.length === 0) return;
    saving = true;
    lastSave = null;
    lastErrorKind = null;
    emit();
    let stopped: "failed" | "unknown" | "conflict" | null = null;
    for (const key of keys) {
      if (baseline === null || draft === null) break;
      const expected = effectiveDraft(key, draft[key]);
      const previous = baseline[key];
      savingKey = key;
      emit();
      try {
        await client.set(key, expected);
      } catch (error) {
        lastErrorKind = errorKind(error);
        const reconciled = await reconcileKey(key);
        if (reconciled === "draft") continue;
        stopped = reconciled === "unknown" ? "unknown" : reconciled === "conflict" ? "conflict" : "failed";
        break;
      }
      const readback = await readKey(key);
      if (!readback.ok) {
        outcomes = { ...outcomes, [key]: "unknown" };
        stopped = "unknown";
        break;
      }
      const confirmed = readback.value;
      currentValues = { ...currentValues, [key]: confirmed };
      if (Object.is(confirmed, expected)) {
        baseline = { ...baseline, [key]: confirmed };
        draft = { ...draft, [key]: confirmed };
        outcomes = { ...outcomes, [key]: "saved" };
        confirmedKeys.add(key);
        if (key === "organizationContextBudget") {
          budgetIssue = null;
          loadedBudgetIssue = null;
        }
        continue;
      }
      if (Object.is(confirmed, previous)) {
        outcomes = { ...outcomes, [key]: "failed" };
        stopped = "failed";
        break;
      }
      baseline = { ...baseline, [key]: confirmed };
      outcomes = { ...outcomes, [key]: "conflict" };
      confirmedKeys.delete(key);
      stopped = "conflict";
      break;
    }
    saving = false;
    savingKey = null;
    const savedCount = view().savedCount;
    if (stopped === "unknown") lastSave = "unknown";
    else if (stopped !== null) lastSave = savedCount > 0 ? "partial" : "failed";
    else lastSave = savedCount > 0 ? "saved" : null;
    emit();
  }

  function cancel(): boolean {
    if (phase !== "ready" || saving || reconciling || baseline === null || draft === null || unknownKeys().length > 0) return false;
    draft = cloneValues(baseline);
    for (const key of SETTING_KEYS) {
      if (confirmedKeys.has(key)) outcomes = { ...outcomes, [key]: "saved" };
      else delete outcomes[key];
      delete currentValues[key];
    }
    lastSave = confirmedKeys.size > 0 ? "saved" : null;
    lastErrorKind = null;
    budgetIssue = loadedBudgetIssue;
    dailyTimeIssue = null;
    emit();
    return true;
  }

  return {
    view,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    load,
    update,
    save,
    reconcile,
    cancel,
    hasUnsavedChanges: () => dirtyKeys().length > 0,
  };
}
