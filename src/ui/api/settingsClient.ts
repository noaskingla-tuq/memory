export const SETTING_KEYS = [
  "organizationEnabled",
  "organizationProvider",
  "organizationModel",
  "organizationContextBudget",
  "organizationFrequency",
  "organizationDailyTime",
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];
export type SettingValue = boolean | number | string;
export type OrganizationFrequency = "daily" | "immediate";
export type SettingsValues = Readonly<{
  organizationEnabled: boolean;
  organizationProvider: string;
  organizationModel: string;
  organizationContextBudget: number;
  organizationFrequency: OrganizationFrequency;
  organizationDailyTime: string;
}>;

type SettingsBridge = Pick<Window["tuqPlugin"]["settings"], "all" | "get" | "set">;
type SettingsBridgeSource = () => unknown;

export type SettingsApiErrorKind = "unsupported" | "permission" | "failure";

export class SettingsApiError extends Error {
  readonly kind: SettingsApiErrorKind;

  constructor(kind: SettingsApiErrorKind) {
    super(kind);
    this.name = "SettingsApiError";
    this.kind = kind;
  }
}

export interface SettingsClient {
  all(): Promise<Record<string, unknown>>;
  get(key: SettingKey): Promise<unknown>;
  set(key: SettingKey, value: SettingValue): Promise<true>;
}

function errorText(error: unknown): string {
  if (typeof error !== "object" || error === null) return String(error ?? "");
  const record = error as Record<string, unknown>;
  return [record.code, record.name, record.message].filter((part) => typeof part === "string").join(" ").toLowerCase();
}

export function classifySettingsError(error: unknown): SettingsApiErrorKind {
  if (error instanceof SettingsApiError) return error.kind;
  const description = errorText(error);
  return /permission|denied|notallowed/u.test(description) ? "permission" : "failure";
}

function defaultBridge(): unknown {
  if (typeof window === "undefined") return undefined;
  const host = window as Window & { tuqPlugin?: { settings?: unknown } };
  return host.tuqPlugin?.settings;
}

function assertSettingKey(key: string): asserts key is SettingKey {
  if (!SETTING_KEYS.includes(key as SettingKey)) throw new SettingsApiError("failure");
}

function bridgeFrom(source: SettingsBridgeSource): SettingsBridge {
  let value: unknown;
  try {
    value = source();
  } catch (error) {
    throw new SettingsApiError(classifySettingsError(error));
  }
  if (typeof value !== "object" || value === null) throw new SettingsApiError("unsupported");
  const candidate = value as Partial<SettingsBridge>;
  if (typeof candidate.all !== "function" || typeof candidate.get !== "function" || typeof candidate.set !== "function") {
    throw new SettingsApiError("unsupported");
  }
  return candidate as SettingsBridge;
}

export function createSettingsClient(source: SettingsBridgeSource = defaultBridge): SettingsClient {
  return {
    async all() {
      try {
        const values: unknown = await bridgeFrom(source).all();
        if (typeof values !== "object" || values === null || Array.isArray(values)) throw new SettingsApiError("failure");
        return values as Record<string, unknown>;
      } catch (error) {
        throw new SettingsApiError(classifySettingsError(error));
      }
    },
    async get(key) {
      assertSettingKey(key);
      try {
        return await bridgeFrom(source).get(key);
      } catch (error) {
        throw new SettingsApiError(classifySettingsError(error));
      }
    },
    async set(key, value) {
      assertSettingKey(key);
      try {
        const result: unknown = await bridgeFrom(source).set(key, value);
        if (result !== true) throw new SettingsApiError("failure");
        return true;
      } catch (error) {
        throw new SettingsApiError(classifySettingsError(error));
      }
    },
  };
}

export const settingsClient = (): SettingsClient => createSettingsClient();
