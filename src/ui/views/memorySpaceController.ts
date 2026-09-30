import type { BackendClient } from "../api/backendClient.js";
import { describeError } from "../api/errors.js";
import { mount, type MountTarget } from "../dom/html.js";
import { parseAgentStats, spaceTotals } from "../state/memorySpace.js";
import type { OverviewAgent } from "../state/teamHome.js";
import { renderSpaceAvatar, renderSpaceBody, spaceMeta, spaceName, type SpaceView } from "./memorySpaceView.js";

export interface SpaceTargets {
  readonly avatar: MountTarget;
  readonly title: { textContent: string | null };
  readonly id: { textContent: string | null };
  readonly meta: { textContent: string | null };
  readonly body: MountTarget;
}

export interface MemorySpaceDeps {
  readonly client: Pick<BackendClient, "call">;
  readonly now: () => number;
}

export interface MemorySpace {
  open(agentId: string, hint: OverviewAgent | undefined, targets: SpaceTargets): Promise<void>;
  retry(): Promise<void>;
  close(): void;
  view(): SpaceView;
}

export const SPACE_REQUEST_KEY = "space";

export function createMemorySpace(deps: MemorySpaceDeps): MemorySpace {
  let targets: SpaceTargets | null = null;
  let generation = 0;
  let state: SpaceView = { phase: "loading", agentId: "", hint: undefined, stats: null, error: null };

  function render(): void {
    if (targets === null) return;
    mount(targets.avatar, renderSpaceAvatar(state));
    // why: the title element is never replaced, only its text, so keyboard focus stays on it while the stats arrive
    targets.title.textContent = spaceName(state);
    targets.id.textContent = state.agentId;
    targets.meta.textContent = spaceMeta(state, deps.now());
    mount(targets.body, renderSpaceBody(state));
  }

  function tzOffsetMin(): number {
    return -new Date(deps.now()).getTimezoneOffset() + 0;
  }

  async function load(): Promise<void> {
    generation += 1;
    const mine = generation;
    const { agentId } = state;
    state = { ...state, phase: "loading", stats: null, error: null };
    render();
    const result = await deps.client.call("ui.agentStats", { agentId, tzOffsetMin: tzOffsetMin() }, { key: SPACE_REQUEST_KEY });
    if (mine !== generation || (!result.ok && result.superseded)) return;
    if (!result.ok) {
      // why: the backend only answers NOT_FOUND for an agent that has no memory left, which is an empty space and not a fault
      state = result.code === "NOT_FOUND" ? { ...state, phase: "empty" } : { ...state, phase: "error", error: result };
      render();
      return;
    }
    const stats = parseAgentStats(result.value);
    if (stats === null || stats.agentId !== agentId) state = { ...state, phase: "error", error: describeError("malformed_response", "client") };
    else state = { ...state, phase: spaceTotals(stats.namespaces).total === 0 ? "empty" : "ready", stats };
    render();
  }

  return {
    open(agentId, hint, next) {
      targets = next;
      state = { phase: "loading", agentId, hint, stats: null, error: null };
      return load();
    },
    retry: () => (state.agentId === "" || targets === null ? Promise.resolve() : load()),
    close() {
      generation += 1;
      targets = null;
    },
    view: () => state,
  };
}
