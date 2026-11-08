export type AiProviderState = "ready" | "not_installed" | "not_logged_in" | "unsupported_version" | "unavailable" | "not_supported_yet";

export interface AiModelChoice {
  readonly id: string;
  readonly label: string;
}

export interface AiProviderChoice {
  readonly id: string;
  readonly label: string;
  readonly state: AiProviderState;
  readonly models: readonly AiModelChoice[];
}

export interface AiOptionsView {
  readonly providers: readonly AiProviderChoice[];
  readonly defaultProviderId: string | null;
}

export interface AiOptionsClient {
  load(): Promise<AiOptionsView | null>;
}

type AiBridgeSource = () => unknown;

const STATES: readonly string[] = ["ready", "not_installed", "not_logged_in", "unsupported_version", "unavailable", "not_supported_yet"];
export const AI_OPTIONS_TIMEOUT_MS = 8000;

// why: the memory backend never uses an astra provider or model, so the picker must not offer one either
const isDenied = (id: string): boolean => /astra/i.test(id);

function defaultBridge(): unknown {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { tuqPlugin?: { ai?: unknown } }).tuqPlugin?.ai;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function parseAiOptions(raw: unknown): AiOptionsView | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.providers)) return null;
  const providers: AiProviderChoice[] = [];
  for (const entry of record.providers as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const provider = entry as Record<string, unknown>;
    if (!nonEmpty(provider.id) || isDenied(provider.id) || providers.some((known) => known.id === provider.id)) continue;
    const models: AiModelChoice[] = [];
    for (const item of Array.isArray(provider.models) ? provider.models as unknown[] : []) {
      if (typeof item !== "object" || item === null) continue;
      const model = item as Record<string, unknown>;
      if (!nonEmpty(model.id) || isDenied(model.id) || models.some((known) => known.id === model.id)) continue;
      models.push({ id: model.id, label: nonEmpty(model.label) ? model.label : model.id });
    }
    providers.push({
      id: provider.id,
      label: nonEmpty(provider.label) ? provider.label : provider.id,
      state: typeof provider.state === "string" && STATES.includes(provider.state) ? provider.state as AiProviderState : "unavailable",
      models,
    });
  }
  return { providers, defaultProviderId: nonEmpty(record.defaultProviderId) ? record.defaultProviderId : null };
}

export function createAiOptionsClient(source: AiBridgeSource = defaultBridge, timeoutMs: number = AI_OPTIONS_TIMEOUT_MS): AiOptionsClient {
  return {
    async load() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const bridge = source();
        if (typeof bridge !== "object" || bridge === null || typeof (bridge as { getOptions?: unknown }).getOptions !== "function") return null;
        const pending = Promise.resolve((bridge as { getOptions(): unknown }).getOptions());
        const timeout = new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), timeoutMs);
        });
        return parseAiOptions(await Promise.race([pending, timeout]));
      } catch {
        return null;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}

export const aiOptionsClient = (): AiOptionsClient => createAiOptionsClient();
