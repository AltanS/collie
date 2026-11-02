// THE REPO FACTS WRAPPER: `repoRoot`, `isWorktree` and `folder` on every space, for every multiplexer.
//
// The adapter reports the spaces it has. This wrapper adds the three facts the web nests worktrees
// by (web/src/lib/spaces.ts), read from the space's folder on disk (repo-facts.ts), so tmux, zellij
// and the rest nest exactly like Herdr did when only Herdr could. It touches ONE thing, the spaces
// coming out of `snapshot()`; every other method and the capability declaration are the wrapped
// adapter's, verbatim, in the shape `beacon/hint.ts` set.
//
// ── THE SPACE'S FOLDER ───────────────────────────────────────────────────────────────────────────
// `MuxSpace.folder` when the adapter sets it; else the `cwd` of the space's first pane in the SAME
// snapshot when that is absolute (a pane that reports `""` says nothing); else none. A space without
// a folder is left exactly as it came. A `folder` filled here is only ever filled when empty.
//
// ── WHO WINS ─────────────────────────────────────────────────────────────────────────────────────
// When the disk states facts for the folder, they replace whatever the adapter set for `repoRoot`
// and `isWorktree`, so two sources never disagree. When the disk states none (a plain folder, a
// submodule), the adapter's own values, if any, stay.
//
// ── THE CACHE ────────────────────────────────────────────────────────────────────────────────────
// Keyed by folder. An entry is dropped once no space of the current snapshot names its folder, so it
// never outgrows the last snapshot's spaces. An entry also expires after {@link REPO_FACTS_TTL_MS}:
// a `git init`, a removed worktree or a moved checkout would otherwise stay wrong for as long as a
// space sits in that folder. A miss costs a few `stat` and `readFile` calls and never a spawn.

import { isAbsolute } from "node:path";

import type { RepoFacts } from "./repo-facts.ts";
import {
  muxDataFields,
  muxOptionalMethods,
  type MuxAck,
  type MuxAdapter,
  type MuxCapabilityDeclaration,
  type MuxCreatedPane,
  type MuxGrid,
  type MuxGridRequest,
  type MuxOutcome,
  type MuxSession,
  type MuxSnapshot,
  type MuxSpace,
  type MuxSpaceRequest,
  type MuxSubscription,
  type MuxTabRequest,
  type MuxWatchOptions,
  type MuxWorktree,
  type MuxWorktreeCreateRequest,
  type MuxWorktreeOpenRequest,
  type MuxWorktreeOpened,
  type MuxWorktreeScope,
} from "./mux/types.ts";

/** How long a folder's facts stand before the next snapshot reads the disk again. */
export const REPO_FACTS_TTL_MS = 30_000;

export interface RepoFactsDeps {
  /** The disk read: `repoFactsOf` in the bridge, a fake in a test. */
  facts(folder: string): Promise<RepoFacts | null>;
  /** The clock, for the cache's expiry. */
  now?: () => number;
}

interface CacheEntry {
  /** The read itself, so two spaces in one folder share one read while it is in flight. */
  readonly facts: Promise<RepoFacts | null>;
  readonly at: number;
}

/** The folder a space sits in, per the rules in the header, or `undefined` when none is known. */
function folderOf(space: MuxSpace, snapshot: MuxSnapshot): string | undefined {
  if (space.folder !== undefined && space.folder !== "") return space.folder;
  const cwd = snapshot.panes.find((pane) => pane.spaceId === space.spaceId)?.cwd;
  if (cwd === undefined || cwd === "" || !isAbsolute(cwd)) return undefined;
  return cwd;
}

/**
 * `adapter`, with `folder`, `repoRoot` and `isWorktree` filled on its spaces from disk.
 *
 * Wrapped OUTSIDE the beacon and hint wrappers, once, for every multiplexer. The adapter's data
 * fields ride along through {@link muxDataFields} and its optional methods through
 * {@link muxOptionalMethods}, so a new one is added in one place and cannot be forgotten here.
 */
export function withRepoFacts(adapter: MuxAdapter, deps: RepoFactsDeps): MuxAdapter {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, CacheEntry>();

  function factsFor(folder: string, at: number): Promise<RepoFacts | null> {
    const hit = cache.get(folder);
    if (hit !== undefined && at - hit.at < REPO_FACTS_TTL_MS) return hit.facts;
    const facts = deps.facts(folder);
    cache.set(folder, { facts, at });
    // A read that failed must not stand for the whole TTL: the next snapshot asks again.
    facts.catch(() => cache.delete(folder));
    return facts;
  }

  async function fill(space: MuxSpace, folder: string | undefined, at: number): Promise<MuxSpace> {
    if (folder === undefined) return space;
    const facts = await factsFor(folder, at);
    const withFolder = space.folder === folder ? space : { ...space, folder };
    if (facts === null) return withFolder;
    return { ...withFolder, repoRoot: facts.repoRoot, isWorktree: facts.isWorktree };
  }

  return {
    ...muxDataFields(adapter),
    ...muxOptionalMethods(adapter),
    mux: adapter.mux,
    // A getter, because the wrapped declaration is itself one and may be re-read per request.
    get capabilities(): MuxCapabilityDeclaration {
      return adapter.capabilities;
    },

    reachable: (): Promise<boolean> => adapter.reachable(),

    async snapshot(): Promise<MuxSnapshot> {
      const snapshot = await adapter.snapshot();
      const at = now();
      const folders = snapshot.spaces.map((space) => folderOf(space, snapshot));
      const spaces = await Promise.all(snapshot.spaces.map((space, i) => fill(space, folders[i], at)));
      const named = new Set(folders);
      for (const folder of cache.keys()) if (!named.has(folder)) cache.delete(folder);
      return { ...snapshot, spaces };
    },

    // ── Everything below is the wrapped adapter's, verbatim ────────────────────
    refresh: (): Promise<void> => adapter.refresh(),
    readGrid: (paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>> =>
      adapter.readGrid(paneId, request),
    typeText: (paneId: string, txt: string): Promise<MuxAck> => adapter.typeText(paneId, txt),
    writeKeys: (paneId: string, keys: readonly string[]): Promise<MuxAck> => adapter.writeKeys(paneId, keys),
    renamePane: (paneId: string, label: string | null): Promise<MuxAck> => adapter.renamePane(paneId, label),
    closePane: (paneId: string): Promise<MuxAck> => adapter.closePane(paneId),
    setFocus: (paneId: string): Promise<MuxAck> => adapter.setFocus(paneId),
    createTab: (request: MuxTabRequest): Promise<MuxOutcome<MuxCreatedPane>> => adapter.createTab(request),
    renameTab: (tabId: string, label: string): Promise<MuxAck> => adapter.renameTab(tabId, label),
    closeTab: (tabId: string): Promise<MuxAck> => adapter.closeTab(tabId),
    createSpace: (request: MuxSpaceRequest): Promise<MuxOutcome<MuxCreatedPane>> => adapter.createSpace(request),
    listWorktrees: (scope: MuxWorktreeScope): Promise<MuxOutcome<readonly MuxWorktree[]>> =>
      adapter.listWorktrees(scope),
    createWorktree: (request: MuxWorktreeCreateRequest): Promise<MuxOutcome<MuxCreatedPane>> =>
      adapter.createWorktree(request),
    openWorktree: (request: MuxWorktreeOpenRequest): Promise<MuxOutcome<MuxWorktreeOpened>> =>
      adapter.openWorktree(request),
    listSessions: (): Promise<MuxOutcome<readonly MuxSession[]>> => adapter.listSessions(),
    watch: (options: MuxWatchOptions): MuxSubscription => adapter.watch(options),
  };
}
