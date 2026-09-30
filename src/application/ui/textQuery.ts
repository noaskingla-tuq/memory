const MAX_TERMS = 16;
const SNIPPET_LEAD_POINTS = 30;

export interface ParsedQuery {
  readonly terms: string[];
  readonly normalized: string;
}

// why: SQLite lower() folds only A-Z, so the query folds exactly the same range and a non-ASCII letter must match by its own case
export function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

// why: Cairn stores content in NFKC form, so the query goes through NFKC and whitespace compression before it is compared with anything
export function parseQuery(query: string): ParsedQuery | null {
  const normalized = query.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (normalized === "") return null;
  const terms = [...new Set(asciiLower(normalized).split(" "))];
  return terms.length > MAX_TERMS ? null : { terms, normalized };
}

export function snippetAround(text: string, terms: readonly string[], limit: number): string {
  const points = Array.from(text);
  if (points.length <= limit) return text;
  const lowered = asciiLower(text);
  let at = -1;
  for (const term of terms) {
    const found = lowered.indexOf(term);
    if (found >= 0 && (at < 0 || found < at)) at = found;
  }
  const hit = at < 0 ? 0 : Array.from(text.slice(0, at)).length;
  const start = Math.max(0, hit - SNIPPET_LEAD_POINTS);
  const lead = start > 0 ? "…" : "";
  return lead + points.slice(start, start + limit - lead.length).join("");
}
