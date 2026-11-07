export interface LinkedActions {
  reload(): void;
  toggle(source: string): void;
  more(source: string): void;
  retry(source: string): void;
  open(source: string, id: string): void;
  forgetSource(source: string): void;
  removeDamaged(fileId: string): void;
}

interface Found {
  readonly dataset: { readonly lk?: string | undefined; readonly lkSource?: string | undefined; readonly lkId?: string | undefined; readonly lkFile?: string | undefined };
}

export interface LinkedEventLike {
  readonly target: unknown;
}

export interface LinkedEventRoot {
  addEventListener(type: "click", listener: (event: LinkedEventLike) => void): void;
}

// why: the same duck-typed closest() lookup as the other views, so this runs against a real element and against the plain objects the node tests use
function closest(target: unknown, selector: string): Found | null {
  const candidate = target as { closest?: (selector: string) => Found | null } | null;
  return typeof candidate?.closest === "function" ? candidate.closest(selector) : null;
}

// why: this page uses data-lk attributes of its own, so one delegated listener on the shared view root never answers a click that belongs to another page
export function bindLinkedEvents(root: LinkedEventRoot, actions: LinkedActions): void {
  root.addEventListener("click", (event) => {
    const hit = closest(event.target, "[data-lk]");
    if (hit === null) return;
    const { lk, lkSource, lkId, lkFile } = hit.dataset;
    switch (lk) {
      case "reload":
        actions.reload();
        break;
      case "toggle":
        if (lkSource !== undefined) actions.toggle(lkSource);
        break;
      case "more":
        if (lkSource !== undefined) actions.more(lkSource);
        break;
      case "retry":
        if (lkSource !== undefined) actions.retry(lkSource);
        break;
      case "open":
        if (lkSource !== undefined && lkId !== undefined) actions.open(lkSource, lkId);
        break;
      case "forgetSource":
        if (lkSource !== undefined) actions.forgetSource(lkSource);
        break;
      case "removeDamaged":
        if (lkFile !== undefined) actions.removeDamaged(lkFile);
        break;
      default:
        break;
    }
  });
}

export interface LinkedDrawerActions {
  retry(): void;
  closeReload(): void;
  forget(): void;
}

export function bindLinkedDrawerEvents(root: LinkedEventRoot, actions: LinkedDrawerActions): void {
  root.addEventListener("click", (event) => {
    const hit = closest(event.target, "[data-lk]");
    switch (hit?.dataset.lk) {
      case "drawerRetry":
        actions.retry();
        break;
      case "drawerCloseReload":
        actions.closeReload();
        break;
      case "forgetItem":
        actions.forget();
        break;
      default:
        break;
    }
  });
}
