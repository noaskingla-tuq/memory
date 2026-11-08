export const ZOOM_KEY = "memory.ui.zoom";
export const ZOOM_MIN = 80;
export const ZOOM_MAX = 150;
export const ZOOM_STEP = 10;
export const ZOOM_DEFAULT = 100;

export interface ZoomStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export interface Zoom {
  percent(): number;
  larger(): number;
  smaller(): number;
  reset(): number;
}

// why: a stored value from an older build or a hand edit must never leave the allowed range or an off-step size
export function normalizeZoom(raw: string | number | null): number {
  if (raw === null || raw === "") return ZOOM_DEFAULT;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) return ZOOM_DEFAULT;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value / ZOOM_STEP) * ZOOM_STEP));
}

export function createZoom(store: ZoomStore, apply: (percent: number) => void): Zoom {
  let current = normalizeZoom(store.get(ZOOM_KEY));
  apply(current);
  const change = (next: number): number => {
    const value = normalizeZoom(next);
    if (value === current) return current;
    current = value;
    apply(current);
    store.set(ZOOM_KEY, String(current));
    return current;
  };
  return {
    percent: () => current,
    larger: () => change(current + ZOOM_STEP),
    smaller: () => change(current - ZOOM_STEP),
    reset: () => change(ZOOM_DEFAULT),
  };
}
