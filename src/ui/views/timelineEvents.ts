import type { FilterName } from "./timelineController.js";

export interface TimelineActions {
  search(text: string): void;
  clearSearch(): void;
  clearFilters(): void;
  reload(): void;
  loadMore(): void;
  setFilter(name: FilterName, value: string): void;
  openItem(key: string): void;
}

interface Found {
  readonly dataset: { readonly tl?: string | undefined; readonly tlRole?: string | undefined; readonly tlKey?: string | undefined };
  readonly value?: string;
}

interface FormLike {
  readonly elements?: { readonly q?: { readonly value?: unknown } };
}

export interface TimelineEventLike {
  readonly target: unknown;
  preventDefault?(): void;
}

export interface TimelineEventRoot {
  addEventListener(type: "click" | "change" | "submit", listener: (event: TimelineEventLike) => void): void;
}

const FILTER_NAMES: readonly string[] = ["scope", "range", "cli"];

// why: the events are matched by duck typing on closest(), so the same binding runs against a real element and against the plain objects the node tests use
function closest(target: unknown, selector: string): Found | null {
  const candidate = target as { closest?: (selector: string) => Found | null } | null;
  return typeof candidate?.closest === "function" ? candidate.closest(selector) : null;
}

// why: the timeline uses data-tl attributes of its own, so one delegated listener on the shared view root never answers a click that belongs to the team home
export function bindTimelineEvents(root: TimelineEventRoot, actions: TimelineActions): void {
  root.addEventListener("click", (event) => {
    const hit = closest(event.target, "[data-tl]");
    switch (hit?.dataset.tl) {
      case "open":
        if (hit.dataset.tlKey !== undefined) actions.openItem(hit.dataset.tlKey);
        break;
      case "loadMore":
        actions.loadMore();
        break;
      case "reload":
        actions.reload();
        break;
      case "clearSearch":
        actions.clearSearch();
        break;
      case "clearFilters":
        actions.clearFilters();
        break;
      default:
        break;
    }
  });
  root.addEventListener("change", (event) => {
    const hit = closest(event.target, "[data-tl-role]");
    const name = hit?.dataset.tlRole;
    if (hit === null || name === undefined || typeof hit.value !== "string" || !FILTER_NAMES.includes(name)) return;
    actions.setFilter(name as FilterName, hit.value);
  });
  // why: Enter reaches the search through the form's submit event, which a browser does not fire for the Enter that only confirms an IME composition
  root.addEventListener("submit", (event) => {
    const form = closest(event.target, "[data-tl-form]") as unknown as FormLike | null;
    if (form === null) return;
    event.preventDefault?.();
    const value = form.elements?.q?.value;
    actions.search(typeof value === "string" ? value : "");
  });
}
