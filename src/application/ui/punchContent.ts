import type { UiWork } from "../../contracts/uiContract.js";

export type PunchContent =
  | { readonly parsed: true; readonly work: UiWork; readonly body: string }
  | { readonly parsed: false; readonly body: string };

const UNNAMED = "(未命名)";
const NO_TEXT = "(無文字)";
const UNKNOWN = "unknown";

// why: this mirrors buildPunchMemoryContent in Core, which writes fullwidth punctuation that Cairn then stores after NFKC, so the pattern is written for the NFKC form and any change of the Core prefix must add fixtures before this changes
const HEADER =
  /^\[工作紀錄 (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z)~(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z) ([^/\]]+)\/([^\]]+)\] 請求:(.*?)。成果:/su;

function minuteToIso(minute: string): string | null {
  const instant = new Date(`${minute.slice(0, 16)}:00.000Z`);
  if (Number.isNaN(instant.getTime())) return null;
  const iso = instant.toISOString();
  return `${iso.slice(0, 16)}Z` === minute ? iso : null;
}

const orNull = (value: string): string | null => (value === UNKNOWN || value === "" ? null : value);

export function parsePunchContent(content: string): PunchContent {
  const text = content.normalize("NFKC");
  const match = HEADER.exec(text);
  if (match === null) return { parsed: false, body: content };
  const [header, start = "", end = "", cli = "", model = "", request = ""] = match;
  const startIso = minuteToIso(start);
  const endIso = minuteToIso(end);
  if (startIso === null || endIso === null) return { parsed: false, body: content };
  const rest = text.slice(header.length);
  return {
    parsed: true,
    work: {
      startIso,
      endIso,
      cli: orNull(cli),
      model: orNull(model),
      title: request === UNNAMED || request === "" ? null : request,
    },
    body: rest === NO_TEXT ? "" : rest,
  };
}
