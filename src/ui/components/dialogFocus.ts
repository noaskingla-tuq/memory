export interface FocusCandidate {
  readonly id: string | null;
  readonly danger: boolean;
}

export type InitialFocus = { readonly kind: "candidate"; readonly index: number } | { readonly kind: "container" };

// why: a destructive dialog must never open with its danger action focused, so an unknown or missing request falls back to the first safe target or the dialog itself
export function pickInitialFocus(candidates: readonly FocusCandidate[], requested?: string): InitialFocus {
  if (requested !== undefined) {
    const found = candidates.findIndex((candidate) => candidate.id === requested);
    if (found !== -1) return { kind: "candidate", index: found };
  }
  const safe = candidates.findIndex((candidate) => !candidate.danger);
  return safe === -1 ? { kind: "container" } : { kind: "candidate", index: safe };
}

export function cycleFocus(current: number, count: number, backwards: boolean): number {
  if (count <= 0) return -1;
  if (current < 0 || current >= count) return backwards ? count - 1 : 0;
  return backwards ? (current - 1 + count) % count : (current + 1) % count;
}

export type TabMove = { readonly kind: "natural" } | { readonly kind: "focus"; readonly index: number };

// why: a drawer only steps in at its two ends, so every Tab inside it keeps the browser's own order (summary, scrollers and all) while focus still cannot leave; index -1 means the container itself
export function edgeTab(current: number, count: number, backwards: boolean): TabMove {
  if (count <= 0) return { kind: "focus", index: -1 };
  if (backwards) return current <= 0 ? { kind: "focus", index: count - 1 } : { kind: "natural" };
  return current === count - 1 ? { kind: "focus", index: 0 } : { kind: "natural" };
}
