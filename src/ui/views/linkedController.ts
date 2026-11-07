import type { BackendClient, BackendParams, BackendResult } from "../api/backendClient.js";
import { describeError } from "../api/errors.js";
import { confirmDialog, type DialogHandle } from "../components/dialog.js";
import { openDrawer, type DrawerHandle } from "../components/drawer.js";
import { mount, type MountTarget } from "../dom/html.js";
import { t } from "../i18n/index.js";
import { INITIAL_LINKED, applySources, isForgetSuccess, mergeItems, parseDetail, parsePage, parseSources, withPanel, type LinkedView } from "../state/linked.js";
import { bindLinkedDrawerEvents } from "./linkedEvents.js";
import {
  LINKED_IDS, nameOf, renderConfirmDamaged, renderConfirmItem, renderConfirmSource, renderDrawerBody, renderDrawerFoot, renderLinkedBody, shortId,
  type LinkedDrawerView,
} from "./linkedView.js";

export const LINKED_PAGE_SIZE = 12;
export const LINKED_STALE_MS = 60_000;
const SOURCES_KEY = "linked.sources";
const GET_KEY = "linked.get";
const FORGET_KEY = "linked.forget";
const listKey = (source: string): string => `linked.list:${source}`;

export interface LinkedTargets {
  readonly body: MountTarget;
}

export interface LinkedDeps {
  readonly client: Pick<BackendClient, "call">;
  readonly now: () => number;
  readonly pageSize?: number;
  readonly document?: Document;
  readonly host?: HTMLElement;
  readonly backgrounds?: () => readonly HTMLElement[];
  readonly heading?: () => HTMLElement | null;
}

export interface Linked {
  attach(targets: LinkedTargets | null): void;
  reload(): Promise<void>;
  refreshIfStale(maxAgeMs: number): Promise<void>;
  toggle(source: string): Promise<void>;
  more(source: string): Promise<readonly string[]>;
  retry(source: string): Promise<void>;
  open(source: string, id: string): Promise<void>;
  forgetSource(source: string): Promise<void>;
  removeDamaged(fileId: string): Promise<void>;
  closeDrawer(options?: { readonly force?: boolean }): boolean;
  view(): LinkedView;
  drawer(): LinkedDrawerView | null;
  drawerElement(): HTMLElement | null;
}

const failed = (result: BackendResult): boolean => !result.ok;

export function createLinked(deps: LinkedDeps): Linked {
  const doc = deps.document ?? document;
  const host = deps.host ?? doc.body;
  const pageSize = deps.pageSize ?? LINKED_PAGE_SIZE;
  const heading = (): HTMLElement | null => (deps.heading !== undefined ? deps.heading() : doc.getElementById(LINKED_IDS.title));
  let targets: LinkedTargets | null = null;
  let view: LinkedView = INITIAL_LINKED;
  let loadedAt: number | null = null;
  let generation = 0;
  const panelGeneration = new Map<string, number>();
  let drawerHandle: DrawerHandle | null = null;
  let drawerState: LinkedDrawerView | null = null;
  let drawerGeneration = 0;
  let session = 0;
  let confirming = false;
  let dialog: DialogHandle | null = null;

  const attributeOf = (element: Element | null, name: string): string => element?.getAttribute(name) ?? "";
  const focusKey = (element: Element | null): string | null => (element === null || !element.hasAttribute("data-lk") ? null : ["data-lk", "data-lk-source", "data-lk-id", "data-lk-file"].map((name) => attributeOf(element, name)).join("|"));

  function render(): void {
    if (targets === null) return;
    const body = targets.body as unknown as HTMLElement;
    const active = doc.activeElement as Element | null;
    const wanted = active !== null && typeof body.contains === "function" && body.contains(active) ? focusKey(active) : null;
    mount(targets.body, renderLinkedBody(view, deps.now()));
    if (wanted === null || typeof body.querySelectorAll !== "function") return;
    const again = Array.from(body.querySelectorAll<HTMLElement>("button")).find((button) => focusKey(button) === wanted && button.getAttribute("aria-disabled") !== "true");
    again?.focus({ preventScroll: true });
  }

  function set(next: LinkedView): void {
    view = next;
    render();
  }

  const noticeText = (text: string): LinkedView["notice"] => ({ kind: "text", text });
  const noticeError = (result: Extract<BackendResult, { ok: false }>, heading: string): LinkedView["notice"] => ({ kind: "error", error: result, heading });

  async function loadFirst(source: string, keep: boolean): Promise<void> {
    const mine = (panelGeneration.get(source) ?? 0) + 1;
    panelGeneration.set(source, mine);
    const panel = view.panels[source];
    if (panel === undefined) return;
    set(withPanel(view, source, { load: keep && panel.items.length > 0 ? "ready" : "loading", error: null }));
    const result = await deps.client.call("ui.linkList", { source, limit: pageSize }, { key: listKey(source) });
    if (panelGeneration.get(source) !== mine) return;
    if (!result.ok && result.superseded) return;
    const page = result.ok ? parsePage(result.value) : null;
    if (result.ok && page !== null && page.source === source) {
      set(withPanel(view, source, { load: "ready", items: page.items, nextCursor: page.nextCursor, total: page.total, revision: page.revision, loadingMore: false, error: null }));
      return;
    }
    if (!result.ok && (result.code === "NOT_FOUND" || result.code === "STORAGE_UNSUPPORTED")) {
      void load();
      return;
    }
    set(withPanel(view, source, { load: "error", loadingMore: false, error: result.ok ? describeError("malformed_response", "client") : result }));
  }

  async function load(): Promise<void> {
    generation += 1;
    const mine = generation;
    if (view.phase !== "ready") set({ ...view, phase: "loading", error: null });
    const result = await deps.client.call("ui.linkSources", {}, { key: SOURCES_KEY });
    if (mine !== generation) return;
    if (!result.ok && result.superseded) return;
    const parsed = result.ok ? parseSources(result.value) : null;
    if (!result.ok || parsed === null) {
      set({ ...view, phase: "error", error: result.ok ? describeError("malformed_response", "client") : result });
      return;
    }
    loadedAt = deps.now();
    set(applySources(view, parsed));
    const wanted = Object.entries(view.panels).filter(([, panel]) => panel.open).map(([source, panel]) => loadFirst(source, panel.items.length > 0));
    await Promise.all(wanted);
  }

  function teardownDrawer(focusTo: HTMLElement | null | undefined): void {
    drawerGeneration += 1;
    session += 1;
    dialog?.close();
    dialog = null;
    drawerHandle?.close(focusTo);
    drawerHandle = null;
    drawerState = null;
  }

  function renderDrawer(): void {
    if (drawerHandle === null || drawerState === null) return;
    const inside = drawerHandle.element.contains(doc.activeElement as Node | null);
    mount(drawerHandle.body, renderDrawerBody(drawerState));
    mount(drawerHandle.footer, renderDrawerFoot(drawerState));
    if (inside && !drawerHandle.element.contains(doc.activeElement as Node | null)) drawerHandle.heading.focus();
  }

  function patchDrawer(change: Partial<LinkedDrawerView>): void {
    if (drawerState !== null) drawerState = { ...drawerState, ...change };
  }

  async function loadDrawer(source: string, id: string, notice: LinkedDrawerView["notice"]): Promise<void> {
    drawerGeneration += 1;
    const mine = drawerGeneration;
    drawerState = { phase: "loading", source, id, detail: null, error: null, notice: null, forgetting: false };
    renderDrawer();
    const result = await deps.client.call("ui.linkGet", { source, id }, { key: GET_KEY });
    if (mine !== drawerGeneration || drawerHandle === null) return;
    if (!result.ok && result.superseded) return;
    if (!result.ok && result.code === "NOT_FOUND") {
      closeAfterGone(source);
      return;
    }
    const detail = result.ok ? parseDetail(result.value) : null;
    if (!result.ok || detail === null || detail.item.id !== id) {
      patchDrawer({ phase: "error", error: result.ok ? describeError("malformed_response", "client") : result, notice: null });
    } else {
      patchDrawer({ phase: "ready", detail, error: null, notice });
    }
    renderDrawer();
  }

  function closeAfterGone(source: string): void {
    teardownDrawer(null);
    set({ ...view, notice: noticeText(t("lk.notice.gone")) });
    void reloadAll(source);
  }

  async function reloadAll(focusSource?: string): Promise<void> {
    await load();
    const panel = focusSource === undefined ? undefined : view.panels[focusSource];
    const target = panel?.items[0] === undefined ? null : targets?.body as unknown as HTMLElement | null;
    const first = target === null || target === undefined ? undefined : Array.from(target.querySelectorAll<HTMLElement>("button")).find((button) => attributeOf(button, "data-lk") === "open" && attributeOf(button, "data-lk-source") === focusSource);
    (first ?? heading())?.focus({ preventScroll: true });
  }

  async function forgetItem(): Promise<void> {
    const current = drawerState;
    if (drawerHandle === null || current === null || current.phase !== "ready" || current.detail === null || current.forgetting || view.busy) return;
    const { source, detail } = current;
    const mine = session;
    patchDrawer({ forgetting: true, notice: null });
    renderDrawer();
    set({ ...view, busy: true });
    const result = await deps.client.call("ui.linkForget", { action: "item", source, id: detail.item.id, expectedItemRev: detail.item.rev }, { key: FORGET_KEY });
    set({ ...view, busy: false });
    const present = drawerHandle !== null && session === mine;
    if (result.ok && isForgetSuccess(result.value)) {
      if (present) teardownDrawer(null);
      set({ ...view, notice: noticeText(t("lk.notice.forgotten")) });
      await reloadAll(source);
      return;
    }
    if (!result.ok && result.code === "NOT_FOUND") {
      if (present) closeAfterGone(source);
      return;
    }
    if (!present) return;
    if (!result.ok && result.code === "REVISION_CONFLICT") {
      await loadDrawer(source, detail.item.id, { kind: "conflict" });
      void loadFirst(source, true);
      return;
    }
    patchDrawer({ forgetting: false, notice: { kind: "failed", error: result.ok ? describeError("malformed_response", "client") : result } });
    renderDrawer();
  }

  async function confirm(title: string, body: ReturnType<typeof renderConfirmItem>, okLabel: string, cancelLabel: string, background: HTMLElement | null, returnFocusTo: HTMLElement | null): Promise<boolean> {
    if (confirming) return false;
    confirming = true;
    const handle = confirmDialog({
      document: doc,
      host,
      ...(background === null ? {} : { background }),
      role: "alertdialog",
      title,
      body,
      cancel: { id: "cancel", label: cancelLabel },
      confirm: { id: "confirm", label: okLabel, kind: "danger" },
      initialFocus: "cancel",
      returnFocusTo,
    });
    dialog = handle;
    const outcome = await handle.result;
    confirming = false;
    if (dialog === handle) dialog = null;
    return outcome.action === "confirm";
  }

  function openDrawerFor(): DrawerHandle {
    const made = openDrawer({
      document: doc,
      host,
      title: t("lk.drawer.title"),
      closeLabel: t("lk.drawer.close"),
      backgrounds: deps.backgrounds?.() ?? [],
      isSuspended: () => confirming,
      onDismiss: () => void closeDrawer(),
    });
    bindLinkedDrawerEvents(made.element, {
      retry() {
        if (drawerState !== null) void loadDrawer(drawerState.source, drawerState.id, null);
      },
      closeReload() {
        const source = drawerState?.source;
        closeDrawer();
        void reloadAll(source);
      },
      forget: () => {
        const current = drawerState;
        if (drawerHandle === null || current === null || current.phase !== "ready" || current.forgetting || view.busy) return;
        void confirm(t("lk.confirm.item.title"), renderConfirmItem(), t("lk.confirm.item.ok"), t("lk.confirm.item.cancel"), drawerHandle.element, drawerHandle.heading).then((yes) => {
          if (yes && drawerState === current) return forgetItem();
          return undefined;
        });
      },
    });
    return made;
  }

  function closeDrawer(options: { readonly force?: boolean } = {}): boolean {
    if (drawerHandle === null) return true;
    if (options.force === true) {
      teardownDrawer(null);
      return true;
    }
    if (drawerState?.forgetting === true) return false;
    const source = drawerState?.source;
    const id = drawerState?.id;
    const body = targets?.body as unknown as HTMLElement | null;
    const card = body === null || body === undefined ? null : Array.from(body.querySelectorAll<HTMLElement>("button")).find((button) => attributeOf(button, "data-lk-source") === source && attributeOf(button, "data-lk-id") === id) ?? null;
    teardownDrawer(card ?? heading());
    return true;
  }

  async function forgetSource(source: string): Promise<void> {
    const row = view.sources.find((entry) => entry.source === source);
    const panel = view.panels[source];
    if (row === undefined || panel === undefined || view.busy || confirming) return;
    const name = nameOf(source);
    const count = panel.load === "ready" ? panel.total : row.count;
    const revision = panel.revision ?? row.revision;
    const opener = doc.activeElement as HTMLElement | null;
    const yes = await confirm(t("lk.confirm.source.title", { name }), renderConfirmSource(name, count), t("lk.confirm.source.ok"), t("lk.confirm.item.cancel"), (targets?.body as unknown as HTMLElement | undefined) ?? null, opener);
    if (!yes || view.panels[source] === undefined) return;
    set({ ...view, busy: true });
    const result = await deps.client.call("ui.linkForget", { action: "source", source, expectedRevision: Math.max(1, revision) } as BackendParams, { key: FORGET_KEY });
    set({ ...view, busy: false });
    if (result.ok && isForgetSuccess(result.value)) {
      set({ ...view, notice: noticeText(t("lk.notice.forgottenSource", { name })) });
      await reloadAll();
      return;
    }
    if (!result.ok && result.code === "REVISION_CONFLICT") {
      set({ ...view, notice: noticeText(t("lk.notice.conflict")) });
      await reloadAll();
      return;
    }
    if (!result.ok && result.code === "NOT_FOUND") {
      set({ ...view, notice: noticeText(t("lk.notice.gone")) });
      await reloadAll();
      return;
    }
    set({ ...view, notice: failed(result) ? noticeError(result as Extract<BackendResult, { ok: false }>, t("lk.notice.failed")) : noticeText(t("lk.notice.failed")) });
  }

  async function removeDamaged(fileId: string): Promise<void> {
    if (view.busy || confirming) return;
    const opener = doc.activeElement as HTMLElement | null;
    const id = shortId(fileId);
    const yes = await confirm(t("lk.confirm.damaged.title"), renderConfirmDamaged(id), t("lk.confirm.damaged.ok"), t("lk.confirm.item.cancel"), (targets?.body as unknown as HTMLElement | undefined) ?? null, opener);
    if (!yes) return;
    set({ ...view, busy: true });
    const result = await deps.client.call("ui.linkForget", { action: "damaged", fileId }, { key: FORGET_KEY });
    set({ ...view, busy: false });
    if (result.ok && isForgetSuccess(result.value)) {
      set({ ...view, notice: noticeText(t("lk.notice.damagedRemoved")) });
      await reloadAll();
      return;
    }
    if (!result.ok && (result.code === "NOT_FOUND" || result.code === "REVISION_CONFLICT")) {
      set({ ...view, notice: noticeText(t(result.code === "NOT_FOUND" ? "lk.notice.gone" : "lk.notice.conflict")) });
      await reloadAll();
      return;
    }
    if (!result.ok) set({ ...view, notice: noticeError(result, t("lk.notice.failed")) });
  }

  return {
    attach(next) {
      targets = next;
      if (next !== null) render();
    },
    reload: () => load(),
    async refreshIfStale(maxAgeMs) {
      if (loadedAt !== null && deps.now() - loadedAt < maxAgeMs) {
        render();
        return;
      }
      await load();
    },
    async toggle(source) {
      const panel = view.panels[source];
      if (panel === undefined) return;
      set(withPanel(view, source, { open: !panel.open }));
      if (!panel.open && (panel.load === "idle" || panel.load === "error")) await loadFirst(source, false);
    },
    async more(source) {
      const panel = view.panels[source];
      if (panel === undefined || panel.nextCursor === null || panel.loadingMore) return [];
      const cursor = panel.nextCursor;
      set(withPanel(view, source, { loadingMore: true }));
      const result = await deps.client.call("ui.linkList", { source, limit: pageSize, cursor }, { key: `${listKey(source)}:more` });
      const latest = view.panels[source];
      if (latest === undefined || latest.nextCursor !== cursor) return [];
      if (!result.ok && result.code === "CURSOR_STALE") {
        await loadFirst(source, false);
        return [];
      }
      const page = result.ok ? parsePage(result.value) : null;
      if (!result.ok || page === null) {
        set({ ...withPanel(view, source, { loadingMore: false }), notice: noticeError(result.ok ? ({ ...describeError("malformed_response", "client"), ok: false, superseded: false, attempts: 1 }) : result, t("lk.notice.failed")) });
        return [];
      }
      if (latest.revision !== null && page.revision !== latest.revision) {
        await loadFirst(source, false);
        return [];
      }
      const merged = mergeItems(latest.items, page.items);
      set(withPanel(view, source, { items: merged, nextCursor: page.nextCursor, total: page.total, revision: page.revision, loadingMore: false }));
      return page.items.map((item) => item.id).filter((id) => !latest.items.some((old) => old.id === id));
    },
    retry: (source) => loadFirst(source, false),
    async open(source, id) {
      if (drawerState?.forgetting === true) return;
      if (drawerHandle === null) drawerHandle = openDrawerFor();
      await loadDrawer(source, id, null);
    },
    forgetSource,
    removeDamaged,
    closeDrawer,
    view: () => view,
    drawer: () => drawerState,
    drawerElement: () => drawerHandle?.element ?? null,
  };
}
