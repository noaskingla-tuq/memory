export interface DetailActions {
  retry(): void;
  closeReload(): void;
  forget(): void;
  sibling(key: string): void;
}

interface Found {
  readonly dataset: { readonly dt?: string | undefined; readonly dtKey?: string | undefined };
}

export interface DetailEventLike {
  readonly target: unknown;
}

export interface DetailEventRoot {
  addEventListener(type: "click", listener: (event: DetailEventLike) => void): void;
}

// why: the same duck-typed closest() lookup as the other views, so this runs against a real element and against the plain objects the node tests use
function closest(target: unknown, selector: string): Found | null {
  const candidate = target as { closest?: (selector: string) => Found | null } | null;
  return typeof candidate?.closest === "function" ? candidate.closest(selector) : null;
}

// why: the drawer's controls carry data-dt attributes of their own, so a click inside it never answers to the timeline's data-tl or the home's data-act
export function bindDetailEvents(root: DetailEventRoot, actions: DetailActions): void {
  root.addEventListener("click", (event) => {
    const hit = closest(event.target, "[data-dt]");
    switch (hit?.dataset.dt) {
      case "retry":
        actions.retry();
        break;
      case "closeReload":
        actions.closeReload();
        break;
      case "forget":
        actions.forget();
        break;
      case "sibling":
        if (hit.dataset.dtKey !== undefined) actions.sibling(hit.dataset.dtKey);
        break;
      default:
        break;
    }
  });
}
