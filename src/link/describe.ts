import { refuse } from "./errors.js";

export const SPEC_VERSION = "0.7";

const AVAILABILITY_KEYS = Object.freeze(["group", "features", "language", "voiceId"]);

export interface GroupInfo {
  readonly id: string;
  readonly version: number;
  readonly features: readonly string[];
  readonly limits: Readonly<Record<string, number>>;
  readonly extras?: unknown;
}

export interface GroupEntry {
  readonly group: GroupInfo;
  readonly methods: readonly string[];
}

export function buildDescription({ category, dataClass, entries }: { readonly category: string; readonly dataClass: string; readonly entries: readonly GroupEntry[] }): unknown {
  return {
    specVersion: SPEC_VERSION,
    category,
    dataClass,
    groups: entries.map(({ group, methods }) => ({
      id: group.id,
      version: group.version,
      methods,
      features: [...group.features],
      limits: { ...group.limits },
      models: [],
      ...(group.extras === undefined ? {} : { extras: group.extras }),
    })),
  };
}

export async function availability(args: unknown, entries: readonly GroupEntry[]): Promise<unknown> {
  if (!Array.isArray(args) || args.length > 1) throw refuse("capability_request_invalid");
  const query: unknown = args[0] ?? {};
  if (typeof query !== "object" || query === null || Array.isArray(query)) throw refuse("capability_request_invalid");
  const body = query as { group?: unknown; features?: unknown };
  if (Object.keys(body).some((key) => !AVAILABILITY_KEYS.includes(key))) throw refuse("capability_request_invalid");
  const entry = body.group === undefined ? undefined : entries.find(({ group }) => group.id === body.group);
  if (body.group !== undefined && entry === undefined) return { state: "unsupported", reason: "other" };
  const asked = body.features;
  if (asked !== undefined && !(Array.isArray(asked) && asked.every((name) => typeof name === "string"))) throw refuse("capability_request_invalid");
  const offered = entry === undefined ? entries.flatMap(({ group }) => group.features) : entry.group.features;
  if ((asked as string[] | undefined)?.some((name) => !offered.includes(name)) === true) return { state: "unsupported", reason: "feature_unsupported" };
  return { state: "ready" };
}
