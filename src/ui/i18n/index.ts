import { STRINGS, type StringKey } from "./zhTW.js";

export type { StringKey } from "./zhTW.js";

export function t(key: StringKey, params: Readonly<Record<string, string | number>> = {}): string {
  return STRINGS[key].replace(/\{([A-Za-z0-9_]+)\}/gu, (whole, name: string) => (name in params ? String(params[name]) : whole));
}
