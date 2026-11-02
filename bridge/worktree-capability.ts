// WHERE `createWorktree` COMES FROM (M81 spec 02).
//
// A worktree is made by the bridge with git (bridge/worktree-add.ts) and opened by the multiplexer as
// a space. So "can this collie make a worktree?" is a fact about two things, neither of which is a
// multiplexer verb: the adapter can open a space (`createSpace`), and this host has git. This wrapper
// is THE ONLY THING that declares `createWorktree` true, the way the beacon decorator is the only
// thing that lifts `agentSessionRef` on a blind adapter (bridge/beacon/decorate.ts).
//
// It touches one thing, the capability declaration, and copies it rather than mutating it: the
// adapter's own declaration is rebuilt through `declareCapabilities`, so the fail-closed total stays
// total. Every method passes straight through.
//
// It refuses to wrap an adapter that declares `createWorktree` itself. Two sources for one capability
// would disagree the first time one of them changed, and the route no longer calls a multiplexer's
// worktree verb at all, so such a declaration would promise a path nothing takes.

import { declareCapabilities, MUX_CAPABILITIES, type MuxCapabilityDeclaration } from "./mux/capabilities.ts";
import { muxDataFields, muxOptionalMethods, type MuxAdapter } from "./mux/types.ts";

/** What the wrapper needs besides the adapter. */
export interface WorktreeCapabilityDeps {
  /** The git binary this host runs (`gitBinary()`), or `null` when there is none. */
  readonly git: string | null;
}

/** The operator's answer when the adapter opens spaces but this host has no git. */
export const NO_GIT_NOTE = "Collie makes a worktree with git, and found no git on this machine.";

/** The adapter's declaration, with `createWorktree` lifted when a space can be opened and git is there. */
export function worktreeDeclaration(inner: MuxCapabilityDeclaration, git: string | null): MuxCapabilityDeclaration {
  const inherited = MUX_CAPABILITIES.filter((capability) => inner.supports[capability]);
  const notes = { ...inner.notes };
  const lifted = inner.supports.createSpace && git !== null;
  // The adapter's own note says its multiplexer has no worktree verb, which stops being the
  // operator's answer: the bridge makes the worktree. Without git, the useful sentence says so.
  if (lifted) delete notes.createWorktree;
  else if (inner.supports.createSpace) notes.createWorktree = NO_GIT_NOTE;
  return declareCapabilities({
    supports: lifted ? [...inherited, "createWorktree"] : inherited,
    unsupportedKeys: inner.unsupportedKeys,
    notes,
    spaces: inner.spaces,
    topologyLatency: inner.topologyLatency,
  });
}

/**
 * `adapter`, declaring `createWorktree` when it can open a space and this host has git.
 *
 * Throws when the adapter declares `createWorktree` itself: a wiring mistake, the same on every start.
 */
export function withWorktreeCapability(adapter: MuxAdapter, deps: WorktreeCapabilityDeps): MuxAdapter {
  if (adapter.capabilities.supports.createWorktree) {
    throw new Error(
      `refusing to wrap the "${adapter.mux}" adapter with the worktree capability: it already declares ` +
        "createWorktree itself, and the bridge makes worktrees with git now (bridge/worktree-add.ts)",
    );
  }
  // The wrapped declaration may be a getter that changes (the beacon decorator's), so the lift is
  // worked out per read, and kept for as long as the wrapped answer is the same object.
  let seen: MuxCapabilityDeclaration | undefined;
  let answer: MuxCapabilityDeclaration | undefined;
  return {
    ...muxDataFields(adapter),
    ...muxOptionalMethods(adapter),
    mux: adapter.mux,
    get capabilities(): MuxCapabilityDeclaration {
      const inner = adapter.capabilities;
      if (inner !== seen || answer === undefined) {
        seen = inner;
        answer = worktreeDeclaration(inner, deps.git);
      }
      return answer;
    },

    // ── Everything below is the wrapped adapter's, verbatim ────────────────────
    reachable: () => adapter.reachable(),
    snapshot: () => adapter.snapshot(),
    refresh: () => adapter.refresh(),
    readGrid: (paneId, request) => adapter.readGrid(paneId, request),
    typeText: (paneId, text) => adapter.typeText(paneId, text),
    writeKeys: (paneId, keys) => adapter.writeKeys(paneId, keys),
    renamePane: (paneId, label) => adapter.renamePane(paneId, label),
    closePane: (paneId) => adapter.closePane(paneId),
    setFocus: (paneId) => adapter.setFocus(paneId),
    createTab: (request) => adapter.createTab(request),
    renameTab: (tabId, label) => adapter.renameTab(tabId, label),
    closeTab: (tabId) => adapter.closeTab(tabId),
    createSpace: (request) => adapter.createSpace(request),
    listWorktrees: (scope) => adapter.listWorktrees(scope),
    createWorktree: (request) => adapter.createWorktree(request),
    openWorktree: (request) => adapter.openWorktree(request),
    listSessions: () => adapter.listSessions(),
    watch: (options) => adapter.watch(options),
  };
}
