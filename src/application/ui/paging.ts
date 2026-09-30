import { fitToBudget } from "./budget.js";

export interface PageInput<T> {
  readonly items: readonly T[];
  readonly more: boolean;
  readonly position: (item: T) => readonly string[];
  readonly encode: (position: readonly string[]) => string;
  readonly build: (kept: readonly T[], nextCursor: string | null) => unknown;
}

export type PageResult<T> =
  | { readonly ok: true; readonly kept: readonly T[]; readonly response: unknown }
  | { readonly ok: false };

// why: the cursor always points behind the last item that is actually returned, so a page cut short by the byte budget continues with exactly the item it dropped
export function fitPage<T>(input: PageInput<T>): PageResult<T> {
  const cursorFor = (kept: readonly T[]): string | null => {
    const last = kept[kept.length - 1];
    if (last === undefined) return null;
    return kept.length < input.items.length || input.more ? input.encode(input.position(last)) : null;
  };
  const build = (kept: readonly T[]): unknown => input.build(kept, cursorFor(kept));
  const fit = fitToBudget(input.items, build);
  return fit.ok ? { ok: true, kept: fit.kept, response: build(fit.kept) } : { ok: false };
}
