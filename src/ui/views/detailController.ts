import type { UiRef } from "../../contracts/uiContract.js";
import type { BackendClient, BackendParams } from "../api/backendClient.js";
import { describeError } from "../api/errors.js";
import { confirmDialog, type DialogHandle } from "../components/dialog.js";
import { openDrawer, type DrawerHandle } from "../components/drawer.js";
import { mount } from "../dom/html.js";
import { t } from "../i18n/index.js";
import { focusCandidates, parseDetail } from "../state/detail.js";
import { itemKey } from "../state/timeline.js";
import { bindDetailEvents } from "./detailEvents.js";
import { renderConfirmBody, renderDetailBody, renderDetailFoot, type DetailNotice, type DetailView } from "./detailView.js";

export const GET_KEY = "detail";
export const FORGET_KEY = "detail.forget";
export const STATUS_CLEAR_MS = 6000;

export interface Scheduler {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface DetailDeps {
  readonly client: Pick<BackendClient, "call">;
  readonly reloadList: () => Promise<void>;
  readonly listKeys: () => readonly string[];
  readonly cardFor: (key: string) => HTMLElement | null;
  readonly listHeading: () => HTMLElement | null;
  readonly backgrounds: () => readonly HTMLElement[];
  readonly document?: Document;
  readonly host?: HTMLElement;
  readonly schedule?: Scheduler;
}

export interface Detail {
  open(ref: UiRef): Promise<void>;
  close(options?: { readonly force?: boolean }): boolean;
  isOpen(): boolean;
  view(): DetailView | null;
  element(): HTMLElement | null;
}

const refParams = (ref: UiRef): BackendParams => ({ agentId: ref.agentId, scope: ref.scope, projectId: ref.projectId, memoryId: ref.memoryId });

function isForgetSuccess(value: unknown): boolean {
  const record = value as { ok?: unknown; forgotten?: unknown } | null;
  return typeof value === "object" && record !== null && record.ok === true && typeof record.forgotten === "boolean";
}

const DEFAULT_SCHEDULER: Scheduler = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createDetail(deps: DetailDeps): Detail {
  const doc = deps.document ?? document;
  const host = deps.host ?? doc.body;
  const schedule = deps.schedule ?? DEFAULT_SCHEDULER;
  let drawer: DrawerHandle | null = null;
  let dialog: DialogHandle | null = null;
  let state: DetailView | null = null;
  let generation = 0;
  let session = 0;
  let origin: string | null = null;
  let confirming = false;
  let clearTimer: unknown = null;

  // why: the live region exists from the start and only its text changes, because a region created together with its message is often not announced
  const status = doc.createElement("div");
  status.className = "dt-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  host.appendChild(status);

  function announce(text: string): void {
    if (clearTimer !== null) schedule.clear(clearTimer);
    status.textContent = text;
    clearTimer = schedule.set(() => {
      status.textContent = "";
      clearTimer = null;
    }, STATUS_CLEAR_MS);
  }

  const inside = (element: Element | null): boolean => drawer !== null && element !== null && drawer.element.contains(element);

  // why: re-rendering the body or footer replaces the focused button, so focus is put back on the forget button when a notice asks for a decision, and on the drawer title otherwise, instead of dropping to the page
  function render(): void {
    if (drawer === null || state === null) return;
    const hadFocus = inside(doc.activeElement);
    mount(drawer.body, renderDetailBody(state));
    mount(drawer.footer, renderDetailFoot(state));
    if (!hadFocus || inside(doc.activeElement)) return;
    const forget = Array.from(drawer.element.querySelectorAll<HTMLElement>("button")).find((button) => button.getAttribute("data-dt") === "forget");
    (state.phase === "ready" && state.notice !== null && forget !== undefined ? forget : drawer.heading).focus();
  }

  function patch(change: Partial<DetailView>): void {
    if (state !== null) state = { ...state, ...change };
  }

  async function load(ref: UiRef, notice: DetailNotice | null): Promise<void> {
    generation += 1;
    const mine = generation;
    state = { phase: "loading", ref, data: null, error: null, notice: null, forgetting: false };
    render();
    const result = await deps.client.call("ui.get", refParams(ref), { key: GET_KEY });
    // why: a slower answer for a memory the drawer has already moved on from must never overwrite the one on screen
    if (mine !== generation || drawer === null) return;
    if (!result.ok && result.superseded) return;
    const data = result.ok ? parseDetail(result.value) : null;
    const mismatched = data !== null && itemKey(data.ref) !== itemKey(ref);
    if (!result.ok || data === null || mismatched) {
      patch({ phase: "error", error: result.ok ? describeError("malformed_response", "client") : result, notice: null });
      render();
      return;
    }
    patch({ phase: "ready", data, error: null, notice });
    render();
  }

  function teardown(focusTo: HTMLElement | null | undefined): void {
    generation += 1;
    session += 1;
    dialog?.close();
    dialog = null;
    drawer?.close(focusTo);
    drawer = null;
    state = null;
    origin = null;
  }

  function close(options: { readonly force?: boolean } = {}): boolean {
    if (drawer === null) return true;
    if (options.force === true) {
      teardown(null);
      return true;
    }
    if (state?.forgetting === true) return false;
    const card = origin === null ? null : deps.cardFor(origin);
    teardown(card ?? deps.listHeading());
    return true;
  }

  async function finishForgotten(ref: UiRef, keys: readonly string[], present: boolean, from: string | null): Promise<void> {
    if (present) teardown(null);
    announce(t("dt.forgotten"));
    try {
      await deps.reloadList();
    } catch {
      // why: the forget already happened, so a list that could not be refreshed is reported by the list itself and must not undo the focus move
    }
    if (!present) return;
    const target = focusCandidates(keys, itemKey(ref), from).map((key) => deps.cardFor(key)).find((card) => card !== null) ?? deps.listHeading();
    target?.focus();
  }

  async function forget(ref: UiRef, revision: number): Promise<void> {
    if (state === null || state.forgetting) return;
    const mine = session;
    const keys = deps.listKeys();
    const from = origin;
    patch({ forgetting: true, notice: null });
    render();
    const result = await deps.client.call("ui.forget", { ...refParams(ref), expectedRevision: revision }, { key: FORGET_KEY });
    const present = drawer !== null && session === mine;
    if (result.ok && isForgetSuccess(result.value)) return finishForgotten(ref, keys, present, from);
    if (!result.ok && result.code === "NOT_FOUND") return finishForgotten(ref, keys, present, from);
    if (!present) return;
    if (!result.ok && result.code === "REVISION_CONFLICT") return load(ref, { kind: "conflict" });
    patch({ forgetting: false, notice: { kind: "forgetFailed", error: result.ok ? describeError("malformed_response", "client") : result } });
    render();
  }

  async function requestForget(): Promise<void> {
    const current = state;
    if (drawer === null || current === null || current.phase !== "ready" || current.data === null || current.forgetting || confirming) return;
    const { data } = current;
    confirming = true;
    const handle = confirmDialog({
      document: doc,
      host,
      background: drawer.element,
      role: "alertdialog",
      title: t("dt.confirm.title"),
      body: renderConfirmBody(data),
      cancel: { id: "cancel", label: t("dt.confirm.cancel") },
      confirm: { id: "forget", label: t("dt.confirm.ok"), kind: "danger" },
      initialFocus: "cancel",
      returnFocusTo: drawer.heading,
    });
    dialog = handle;
    const outcome = await handle.result;
    confirming = false;
    if (dialog === handle) dialog = null;
    if (outcome.action === "forget" && drawer !== null && state === current) await forget(data.ref, data.revision);
  }

  function createDrawer(): DrawerHandle {
    const made = openDrawer({
      document: doc,
      host,
      title: t("dt.title"),
      closeLabel: t("dt.close"),
      backgrounds: deps.backgrounds(),
      isSuspended: () => confirming,
      onDismiss: () => void close(),
    });
    bindDetailEvents(made.element, {
      retry() {
        if (state !== null) void load(state.ref, null);
      },
      closeReload() {
        const previous = origin;
        close();
        void deps.reloadList().then(() => (previous === null ? null : (deps.cardFor(previous) ?? deps.listHeading()))?.focus());
      },
      forget: () => void requestForget(),
      sibling(key) {
        const found = state?.data?.sameSession.find((item) => itemKey(item.ref) === key);
        if (found === undefined || state === null || state.forgetting) return;
        drawer?.focusHeading();
        void load(found.ref, null);
      },
    });
    return made;
  }

  return {
    async open(ref) {
      if (state?.forgetting === true) return;
      if (drawer === null) {
        origin = itemKey(ref);
        drawer = createDrawer();
      }
      await load(ref, null);
    },
    close,
    isOpen: () => drawer !== null,
    view: () => state,
    element: () => drawer?.element ?? null,
  };
}
