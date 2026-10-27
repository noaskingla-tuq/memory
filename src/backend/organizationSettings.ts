export type OrganizationFrequency = "daily" | "immediate";

export interface OrganizationSettings {
  readonly enabled: boolean;
  readonly providerId: string;
  readonly modelId: string;
  readonly contextBudget: number;
  readonly frequency: OrganizationFrequency;
  readonly dailyTime: string;
}

export function isOrganizationDailyTime(value: unknown): value is string {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value);
}

export function readOrganizationSettings(values: Readonly<Record<string, boolean | number | string>> = {}): OrganizationSettings {
  const text = (key: string): string => typeof values[key] === "string" ? (values[key] as string).trim().slice(0, 128) : "";
  const budget = values["organizationContextBudget"];
  return {
    enabled: values["organizationEnabled"] !== false,
    providerId: text("organizationProvider"), modelId: text("organizationModel"),
    contextBudget: typeof budget === "number" && Number.isSafeInteger(budget) && budget >= 8192 && budget <= 262144 ? budget : 32768,
    frequency: values["organizationFrequency"] === "immediate" ? "immediate" : "daily",
    dailyTime: isOrganizationDailyTime(values["organizationDailyTime"]) ? values["organizationDailyTime"] : "02:00",
  };
}
