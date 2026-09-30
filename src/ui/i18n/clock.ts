import { t } from "./index.js";
import { localDate } from "./relativeTime.js";

const MINUTE_MS = 60_000;

const pad = (value: number): string => String(value).padStart(2, "0");

export function clockTime(ms: number): string {
  const at = new Date(ms);
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

// why: a backend day key is already the caller's local date, so the label is cut from the text instead of round-tripping through a Date in another zone
export function monthDay(dayKey: string): string {
  const month = Number(dayKey.slice(5, 7));
  const day = Number(dayKey.slice(8, 10));
  return Number.isInteger(month) && Number.isInteger(day) && month > 0 && day > 0 ? `${month}/${day}` : dayKey;
}

export function dateTime(ms: number): string {
  return `${localDate(new Date(ms))} ${clockTime(ms)}`;
}

export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / MINUTE_MS);
  if (minutes < 1) return t("tl.duration.lessThanMinute");
  if (minutes < 60) return t("tl.duration.minutes", { n: minutes });
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? t("tl.duration.hours", { n: hours }) : t("tl.duration.hoursMinutes", { h: hours, m: rest });
}
