export interface AgentOrgClickRoot {
  addEventListener(type: "click", listener: (event: { readonly target: unknown }) => void): void;
}

export interface AgentOrgActions {
  run(): void;
  stop(): void;
}

interface Hit {
  readonly dataset: { readonly ao?: string | undefined };
}

// why: the same duck-typed closest() lookup as the other event files, so this runs against a real element and against the plain objects the node tests use
export function bindAgentOrgEvents(root: AgentOrgClickRoot, actions: AgentOrgActions): void {
  root.addEventListener("click", (event) => {
    const candidate = event.target as { closest?: (selector: string) => Hit | null } | null;
    const hit = typeof candidate?.closest === "function" ? candidate.closest("[data-ao]") : null;
    if (hit?.dataset.ao === "run") actions.run();
    else if (hit?.dataset.ao === "stop") actions.stop();
  });
}
