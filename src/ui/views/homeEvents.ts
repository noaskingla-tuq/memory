export interface HomeActions {
  reload(): void;
  loadMore(): void;
  dismissHelp(): void;
  showHelp(): void;
  setTeam(value: string): void;
  setSort(value: string): void;
  upgradeLegacy?(count: number): void;
}

interface Found {
  readonly dataset: { readonly act?: string | undefined; readonly role?: string | undefined; readonly legacyN?: string | undefined };
  readonly value?: string;
}

export interface EventLike {
  readonly target: unknown;
}

export interface EventRoot {
  addEventListener(type: "click" | "change", listener: (event: EventLike) => void): void;
}

// why: the events are matched by duck typing on closest(), so the same binding runs against a real element and against the plain objects the node tests use
function closest(target: unknown, selector: string): Found | null {
  const candidate = target as { closest?: (selector: string) => Found | null } | null;
  return typeof candidate?.closest === "function" ? candidate.closest(selector) : null;
}

export function bindHomeEvents(root: EventRoot, actions: HomeActions): void {
  root.addEventListener("click", (event) => {
    const hit = closest(event.target, "[data-act]");
    switch (hit?.dataset.act) {
      case "reload":
        actions.reload();
        break;
      case "loadMore":
        actions.loadMore();
        break;
      case "dismissHelp":
        actions.dismissHelp();
        break;
      case "showHelp":
        actions.showHelp();
        break;
      case "upgradeLegacy":
        actions.upgradeLegacy?.(Number(hit.dataset.legacyN ?? 0));
        break;
      default:
        break;
    }
  });
  root.addEventListener("change", (event) => {
    const hit = closest(event.target, "[data-role]");
    if (hit === null || typeof hit.value !== "string") return;
    if (hit.dataset.role === "team") actions.setTeam(hit.value);
    else if (hit.dataset.role === "sort") actions.setSort(hit.value);
  });
}
