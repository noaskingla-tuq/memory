import { edgeTab } from "./dialogFocus.js";

export interface DrawerOptions {
  readonly title: string;
  readonly closeLabel: string;
  readonly backgrounds: readonly HTMLElement[];
  readonly onDismiss: (via: "escape" | "backdrop" | "button") => void;
  readonly isSuspended?: () => boolean;
  readonly document?: Document;
  readonly host?: HTMLElement;
}

export interface DrawerHandle {
  readonly element: HTMLElement;
  readonly heading: HTMLElement;
  readonly body: HTMLElement;
  readonly footer: HTMLElement;
  readonly isOpen: () => boolean;
  focusHeading(): void;
  close(returnFocusTo?: HTMLElement | null): void;
}

const FOCUSABLE = 'a[href], button:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

let nextId = 0;

export function openDrawer(options: DrawerOptions): DrawerHandle {
  const doc = options.document ?? document;
  const host = options.host ?? doc.body;
  const active = doc.activeElement as HTMLElement | null;
  const opener = active !== null && active !== doc.body && typeof active.focus === "function" ? active : null;
  const suspended = options.isSuspended ?? (() => false);
  const serial = nextId++;

  const wrap = doc.createElement("div");
  wrap.className = "dr-wrap";
  const scrim = doc.createElement("div");
  scrim.className = "dr-scrim";
  scrim.setAttribute("aria-hidden", "true");
  const drawer = doc.createElement("aside");
  drawer.className = "drawer";
  drawer.setAttribute("role", "dialog");
  drawer.setAttribute("aria-modal", "true");
  drawer.setAttribute("aria-labelledby", `dr-title-${serial}`);
  drawer.setAttribute("tabindex", "-1");
  const head = doc.createElement("div");
  head.className = "dr-head";
  const heading = doc.createElement("h2");
  heading.id = `dr-title-${serial}`;
  heading.setAttribute("tabindex", "-1");
  heading.textContent = options.title;
  const closeButton = doc.createElement("button");
  closeButton.setAttribute("type", "button");
  closeButton.className = "dr-x";
  closeButton.setAttribute("aria-label", options.closeLabel);
  closeButton.textContent = "✕";
  head.appendChild(heading);
  head.appendChild(closeButton);
  const body = doc.createElement("div");
  body.className = "dr-body";
  const footer = doc.createElement("div");
  footer.className = "dr-foot";
  drawer.appendChild(head);
  drawer.appendChild(body);
  drawer.appendChild(footer);
  wrap.appendChild(scrim);
  wrap.appendChild(drawer);

  let open = true;
  const focusables = (): HTMLElement[] => Array.from(drawer.querySelectorAll<HTMLElement>(FOCUSABLE));

  function onKeydown(event: KeyboardEvent): void {
    if (suspended() || event.defaultPrevented) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      options.onDismiss("escape");
      return;
    }
    if (event.key !== "Tab") return;
    const items = focusables();
    const move = edgeTab(items.indexOf(doc.activeElement as HTMLElement), items.length, event.shiftKey);
    if (move.kind === "natural") return;
    event.preventDefault();
    (move.index < 0 ? drawer : items[move.index])?.focus();
  }

  function onFocusin(event: FocusEvent): void {
    if (suspended()) return;
    const target = event.target as Node | null;
    if (target !== null && !drawer.contains(target)) heading.focus();
  }

  closeButton.addEventListener("click", () => options.onDismiss("button"));
  scrim.addEventListener("click", () => options.onDismiss("backdrop"));
  for (const background of options.backgrounds) background.setAttribute("inert", "");
  host.appendChild(wrap);
  doc.addEventListener("keydown", onKeydown, true);
  doc.addEventListener("focusin", onFocusin, true);
  heading.focus();

  return {
    element: drawer,
    heading,
    body,
    footer,
    isOpen: () => open,
    focusHeading: () => heading.focus(),
    close(returnFocusTo) {
      if (!open) return;
      open = false;
      doc.removeEventListener("keydown", onKeydown, true);
      doc.removeEventListener("focusin", onFocusin, true);
      wrap.remove();
      for (const background of options.backgrounds) background.removeAttribute("inert");
      if (returnFocusTo === null) return;
      const target = returnFocusTo ?? opener;
      if (target !== null && target.isConnected) target.focus();
    },
  };
}
