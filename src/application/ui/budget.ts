export const UI_RESPONSE_BUDGET_BYTES = 56_000;

// why: the platform gate counts UTF-8 bytes of the serialized answer while other checks count UTF-16 units, so only Buffer.byteLength is a safe measure for CJK text at 3 bytes per unit
export function serializedBytes(value: unknown): number {
  const text = JSON.stringify(value);
  return text === undefined ? 0 : Buffer.byteLength(text, "utf8");
}

export type FitResult<T> =
  | { readonly ok: true; readonly kept: readonly T[]; readonly truncated: boolean; readonly bytes: number }
  | { readonly ok: false; readonly code: "result_too_large" };

// why: build must only ever append the kept items, so the size never shrinks as the prefix grows and a binary search finds the longest prefix that still fits
export function fitToBudget<T>(
  items: readonly T[],
  build: (kept: readonly T[]) => unknown,
  budget: number = UI_RESPONSE_BUDGET_BYTES,
): FitResult<T> {
  const all = serializedBytes(build(items));
  if (all <= budget) return { ok: true, kept: items, truncated: false, bytes: all };
  const empty = serializedBytes(build([]));
  if (empty > budget) return { ok: false, code: "result_too_large" };
  let low = 0;
  let high = items.length - 1;
  let lowBytes = empty;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const bytes = serializedBytes(build(items.slice(0, middle)));
    if (bytes <= budget) {
      low = middle;
      lowBytes = bytes;
    } else {
      high = middle - 1;
    }
  }
  // why: keeping nothing while more items remain would hand the caller a cursor that points at the same first item forever
  if (low === 0) return { ok: false, code: "result_too_large" };
  return { ok: true, kept: items.slice(0, low), truncated: true, bytes: lowBytes };
}

export function clipCodePoints(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const points = Array.from(text);
  return points.length <= limit ? text : points.slice(0, limit).join("");
}
