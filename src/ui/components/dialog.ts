import { isSafeHtml, type SafeHtml } from "../dom/html.js";
import { cycleFocus, pickInitialFocus, type FocusCandidate } from "./dialogFocus.js";

export interface DialogAction {
  readonly id: string;
  readonly label: string;
  readonly kind?: "default" | "primary" | "danger";
}

export interface DialogOptions {
  readonly title: string;
  readonly body: SafeHtml;
  readonly actions: readonly DialogAction[];
  readonly initialFocus?: string;
  readonly role?: "dialog" | "alertdialog";
  readonly dismissible?: boolean;
  readonly dismissAction?: string;
  readonly document?: Document;
  readonly host?: HTMLElement;
  readonly background?: HTMLElement | null;
  readonly returnFocusTo?: HTMLElement | null;
}

export interface DialogResult {
  readonly action: string;
  readonly via: "action" | "escape" | "backdrop" | "programmatic";
}

export interface DialogHandle {
  readonly result: Promise<DialogResult>;
  readonly element: HTMLElement;
  readonly bodyElement: HTMLElement;
  close(): void;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const ACTION_ATTRIBUTE = "data-dialog-action";

let openCount = 0;
let nextId = 0;

function button(doc: Document, action: DialogAction): HTMLButtonElement {
  const element = doc.createElement("button");
  element.setAttribute("type", "button");
  element.setAttribute(ACTION_ATTRIBUTE, action.id);
  element.className = action.kind === "primary" ? "btn btn-primary" : action.kind === "danger" ? "btn btn-danger" : "btn";
  element.textContent = action.label;
  return element;
}

export function openDialog(options: DialogOptions): DialogHandle {
  if (openCount > 0) throw new Error("dialog_already_open");
  const doc = options.document ?? document;
  const host = options.host ?? doc.body;
  const active = doc.activeElement as HTMLElement | null;
  const opener = active !== null && active !== doc.body && typeof active.focus === "function" ? active : null;
  const dismissible = options.dismissible ?? true;
  const dismissAction = options.dismissAction ?? "dismiss";
  const serial = nextId++;

  const overlay = doc.createElement("div");
  overlay.className = "dlg-wrap";
  const dialog = doc.createElement("div");
  dialog.className = "dlg";
  dialog.setAttribute("role", options.role ?? "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", `dlg-title-${serial}`);
  dialog.setAttribute("aria-describedby", `dlg-body-${serial}`);
  dialog.setAttribute("tabindex", "-1");
  const heading = doc.createElement("h2");
  heading.id = `dlg-title-${serial}`;
  heading.textContent = options.title;
  const body = doc.createElement("div");
  body.id = `dlg-body-${serial}`;
  body.className = "dlg-body";
  if (!isSafeHtml(options.body)) throw new TypeError("dialog body must come from the html template tag");
  body.innerHTML = options.body.value;
  const footer = doc.createElement("div");
  footer.className = "dlg-actions";
  const buttons = options.actions.map((action) => button(doc, action));
  for (const element of buttons) footer.appendChild(element);
  dialog.appendChild(heading);
  dialog.appendChild(body);
  dialog.appendChild(footer);
  overlay.appendChild(dialog);

  let finished = false;
  let settle: (result: DialogResult) => void = () => undefined;
  const result = new Promise<DialogResult>((resolve) => {
    settle = resolve;
  });

  const focusables = (): HTMLElement[] => Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
  const candidateOf = (element: HTMLElement): FocusCandidate => {
    const actionId = element.getAttribute(ACTION_ATTRIBUTE);
    const declared = options.actions.find((action) => action.id === actionId);
    return { id: actionId ?? (element.id === "" ? null : element.id), danger: declared?.kind === "danger" };
  };

  function finish(outcome: DialogResult): void {
    if (finished) return;
    finished = true;
    doc.removeEventListener("keydown", onKeydown, true);
    doc.removeEventListener("focusin", onFocusin, true);
    overlay.remove();
    if (options.background) options.background.removeAttribute("inert");
    openCount -= 1;
    const target = opener !== null && opener.isConnected ? opener : (options.returnFocusTo ?? null);
    target?.focus();
    settle(outcome);
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (dismissible) finish({ action: dismissAction, via: "escape" });
      return;
    }
    if (event.key !== "Tab") return;
    event.preventDefault();
    const items = focusables();
    if (items.length === 0) {
      dialog.focus();
      return;
    }
    const current = items.indexOf(doc.activeElement as HTMLElement);
    items[cycleFocus(current, items.length, event.shiftKey)]?.focus();
  }

  function onFocusin(event: FocusEvent): void {
    const target = event.target as Node | null;
    if (target !== null && !dialog.contains(target)) (focusables()[0] ?? dialog).focus();
  }

  buttons.forEach((element, index) => {
    element.addEventListener("click", () => finish({ action: (options.actions[index] as DialogAction).id, via: "action" }));
  });
  overlay.addEventListener("click", (event) => {
    if (dismissible && event.target === overlay) finish({ action: dismissAction, via: "backdrop" });
  });

  openCount += 1;
  if (options.background) options.background.setAttribute("inert", "");
  host.appendChild(overlay);
  doc.addEventListener("keydown", onKeydown, true);
  doc.addEventListener("focusin", onFocusin, true);
  const items = focusables();
  const initial = pickInitialFocus(items.map(candidateOf), options.initialFocus);
  (initial.kind === "candidate" ? items[initial.index] : dialog)?.focus();

  return { result, element: dialog, bodyElement: body, close: () => finish({ action: dismissAction, via: "programmatic" }) };
}

export function confirmDialog(options: Omit<DialogOptions, "actions"> & { readonly confirm: DialogAction; readonly cancel: DialogAction }): DialogHandle {
  return openDialog({ ...options, actions: [options.cancel, options.confirm], dismissAction: options.dismissAction ?? options.cancel.id });
}
