export interface OrganizationSettings {
  readonly enabled: boolean;
  readonly providerId: string;
  readonly modelId: string;
  readonly contextBudget: number;
}

export function readOrganizationSettings(values: Readonly<Record<string, boolean | number | string>> = {}): OrganizationSettings {
  const text = (key: string): string => typeof values[key] === "string" ? (values[key] as string).trim().slice(0, 128) : "";
  const budget = values["organizationContextBudget"];
  return {
    enabled: values["organizationEnabled"] === true,
    providerId: text("organizationProvider"), modelId: text("organizationModel"),
    contextBudget: typeof budget === "number" && Number.isSafeInteger(budget) && budget >= 8192 && budget <= 262144 ? budget : 32768,
  };
}
