import type { EventRoot } from "./homeEvents.js";

export interface SpaceActions {
  retry(): void;
}

// why: the same duck-typed closest() lookup as the home events, so this runs against a real element and against the plain objects the node tests use
export function bindSpaceEvents(root: EventRoot, actions: SpaceActions): void {
  root.addEventListener("click", (event) => {
    const candidate = event.target as { closest?: (selector: string) => { dataset: { act?: string | undefined } } | null } | null;
    const hit = typeof candidate?.closest === "function" ? candidate.closest("[data-act]") : null;
    if (hit?.dataset.act === "retrySpace") actions.retry();
  });
}
