import { t } from "./index.js";

const MINUTE_MS = 60_000;
const DAY_LIMIT = 30;

const pad = (value: number): string => String(value).padStart(2, "0");

export function localDate(at: Date): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

export function parseInstant(iso: string | null | undefined): number | null {
  if (iso === null || iso === undefined) return null;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? null : parsed;
}

export function relativeTime(iso: string | null | undefined, nowMs: number): string {
  const at = parseInstant(iso);
  if (at === null) return t("time.unknown");
  const minutes = Math.floor(Math.max(0, nowMs - at) / MINUTE_MS);
  if (minutes < 1) return t("time.justNow");
  if (minutes < 60) return t("time.minutes", { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("time.hours", { n: hours });
  const days = Math.floor(hours / 24);
  return days < DAY_LIMIT ? t("time.days", { n: days }) : localDate(new Date(at));
}
