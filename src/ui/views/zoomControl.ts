import { t } from "../i18n/index.js";
import { ZOOM_DEFAULT, ZOOM_MAX, ZOOM_MIN, type Zoom } from "../state/zoom.js";

export interface ZoomNode {
  textContent: string | null;
  setAttribute(name: string, value: string): void;
}

export interface ZoomRoot {
  addEventListener(type: "click", listener: (event: { target: unknown }) => void): void;
  querySelector(selector: string): ZoomNode | null;
}

type Action = "out" | "in" | "reset";

const ACTIONS: readonly Action[] = ["out", "in", "reset"];

function actionOf(target: unknown): Action | null {
  const candidate = target as { closest?: (selector: string) => { dataset: { zoom?: string | undefined } } | null } | null;
  const hit = typeof candidate?.closest === "function" ? candidate.closest("[data-zoom]") : null;
  const found = hit?.dataset.zoom;
  return ACTIONS.find((action) => action === found) ?? null;
}

// why: the buttons stay enabled at the ends, because a disabled button would drop the keyboard focus the user is pressing it with
export function bindZoomControl(root: ZoomRoot, zoom: Zoom): void {
  const node = (action: Action): ZoomNode | null => root.querySelector(`[data-zoom="${action}"]`);
  const status = root.querySelector("[data-zoom-status]");
  function sync(): void {
    const percent = zoom.percent();
    const group = root.querySelector("[data-zoom-group]");
    group?.setAttribute("aria-label", t("zoom.group"));
    const out = node("out");
    const larger = node("in");
    const reset = node("reset");
    if (out !== null) {
      out.textContent = t("zoom.out");
      out.setAttribute("aria-label", t("zoom.outLabel"));
      out.setAttribute("aria-disabled", String(percent <= ZOOM_MIN));
    }
    if (larger !== null) {
      larger.textContent = t("zoom.in");
      larger.setAttribute("aria-label", t("zoom.inLabel"));
      larger.setAttribute("aria-disabled", String(percent >= ZOOM_MAX));
    }
    if (reset !== null) {
      reset.textContent = t("zoom.reset");
      reset.setAttribute("aria-label", t("zoom.resetLabel", { percent }));
      reset.setAttribute("aria-disabled", String(percent === ZOOM_DEFAULT));
    }
    if (status !== null) status.textContent = t("zoom.value", { percent });
  }
  root.addEventListener("click", (event) => {
    const action = actionOf(event.target);
    if (action === null) return;
    if (action === "out") zoom.smaller();
    else if (action === "in") zoom.larger();
    else zoom.reset();
    sync();
  });
  sync();
}
