const pad = (value: number): string => String(value).padStart(2, "0");

export function timeOfDay(ms: number): string {
  const at = new Date(ms);
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

// why: a backend day key is already the caller's local date, so the label is cut from the text instead of round-tripping through a Date in another zone
export function monthDay(dayKey: string): string {
  const month = Number(dayKey.slice(5, 7));
  const day = Number(dayKey.slice(8, 10));
  return Number.isInteger(month) && Number.isInteger(day) && month > 0 && day > 0 ? `${month}/${day}` : dayKey;
}
