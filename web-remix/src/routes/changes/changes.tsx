// The Changes screen (ADR 0065) and, under it, Files (ADR 0083): what changed under a WORKSPACE's
// folder since the last commit, read-only. Two routes share it: `/pane/:paneId/changes` (the bridge
// resolves the pane's workspace) and `/space/:spaceId/changes` (the workspace asked directly). Port of
// web/src/routes/changes.tsx.
//
// ONE SCREEN, THREE LEVELS. `level` says which the URL is at (routes/frame/map.tsx):
//   list    the root: the folder tree with every change marked on its row, or, with the device's
//           `changesOnly` pref, the list of changes alone (flat or as a tree); `?repo=&path=` is one
//           changed file's diff
//   commit  a clean repo's last commit (`?repo=`, with `&path=` one file of it), a level below the list
//   files   a folder (`?dir=`) or a file (`?path=`) of the tree
// The route is keyed by target and id only, so the list, the commit and the tree are ONE instance:
// the list, its filter and its folds keep their state under the commit, and Previous / Next can walk it.
//
// NOT ON THE ROOT POLL LOOP (ADR 0065 rule 8). The screen has its own slow beat while mounted and the
// page visible: every POLL_MS it re-reads the list and, on a file or the commit view, the open diff and
// the commit too. A re-read that returns the same data changes nothing, down to object identity
// (`state.ts`), so nothing re-renders and no row moves. A failed re-read keeps the last good data. A
// folder or a file of the tree is read on open and on the refresh button only: a list that re-sorts
// under a thumb is the fault DESIGN.md §2 names. All timers end on `handle.signal`.
//
// THE HEADER is the Shell's. This route claims it with `override` (the size-11 arrow and the h1 "Files"
// or "Last commit") and puts the layout toggle, the filter button and Refresh in the claim's trailing
// slot; the workspace's label and the root folder's last name sit on the quiet line under it.
//
// THE GLIDE (lib/glide.ts, the `changes` pair; web/src/routes/changes.tsx `rootScreen`, `backOut`): a
// space's root screen claims the override with `glide`, so its subtitle's workspace label is where the
// dashboard's Files row lands; its back arrow glides the label back down into that row, but only when
// the arrow lands on the dashboard and the dashboard shows the Files tab, where the row lives.
//
// WHAT IS NOT PORTED (see the report): the seeded header count from the Changes tab's kept answer, and
// `history.state`: a Files link row's "this may be a folder" hint and the diff's "open on Preview"
// ask are held in memory for the click that made them instead (Remix stores nothing in history.state).
import { on, type Handle, type RemixNode } from "remix/component";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide";

import { unavailableKey } from "@web/lib/changes-reason";
import { keepChangesList, keptChangesList } from "@web/lib/changes-list-cache";
import {
  countFiles,
  EMPTY_FILTER,
  filterRepos,
  folderInRepo,
  isFilterActive,
  layoutOrder,
  openFolderChain,
  type ChangesFilter,
} from "@web/lib/changes-tree";
import { folderView, isNameFilterOn } from "@web/lib/files-filter";
import { changeAt, EMPTY_CHANGE_INDEX, indexChanges, markFolder, type MarkedFolder, type RootChange } from "@web/lib/files-marks";
import { baseName, formatBytes, headerFolder, previewKindFor, rootPathOf } from "@web/lib/files-view";
import { t, tn, type MessageKey } from "@web/lib/i18n";
import {
  changesCommitPath,
  changesPath,
  changesSettingsPath,
  filesParent,
  filesPath,
  pairedDevicesPath,
  panePath,
  spaceChangesCommitPath,
  spaceChangesPath,
  spaceFilesPath,
  spacePath,
  upTarget,
  type FilesAt,
} from "@web/lib/nav";
import type { ChangeCommitResponse, ChangedRepo, ChangeStatus, CleanRepo, FileEntry } from "@web/lib/types";
import { summarizeChanges, type WorkspaceChangeCount } from "@web/lib/workspace-changes";
import { cn } from "@web/lib/utils";

import { address, snapshot } from "../../lib/data";
import { useLocale } from "../../lib/i18n-store";
import { isLocked } from "../../lib/idle";
import { GLIDE_PAIRS, glideBack } from "../../lib/glide";
import { dashPrefs, setDashPref } from "../../lib/prefs";
import { scrollMemory } from "../../lib/scroll";
import { scheduleUpdate, useStore } from "../../lib/store";
import { headerOf } from "../../shell/context";
import type { CustomSlot, OverrideGlide } from "../../shell/header-model";
import { Button } from "../../ui/button";
import { Collapse } from "../../ui/collapse";
import { Icon } from "../../ui/icon";
import { Notice } from "../../ui/notice";
import { SectionLabel } from "../../ui/section-label";
import { Segmented } from "../../ui/segmented";
import { goDown, goSide, goUp, goUpExact, hereNow, previousEntry } from "../frame/up";
import {
  fetchChangeCommit,
  fetchChangeCommitDiff,
  fetchChangeDiff,
  fetchChanges,
  fetchFilesDir,
  fetchFileText,
  type ChangeRef,
  type ChangesLookup,
} from "./api";
import {
  entryPath,
  filesBreadcrumb,
  filesFilterBar,
  filesLoading,
  filesModeControl,
  changesListHead,
  quiet,
  refusedBody,
  treeFolderBody,
  type FilesReadState,
} from "./files-parts";
import {
  changePath,
  changesFilterBar,
  changesList,
  changesListSkeleton,
  changesNoMatch,
  changesTree,
  cleanRepos,
  commitHead,
  DiffView,
  filterButton,
  FilterOverlay,
  folderKey,
  layoutToggle,
  statusLetter,
} from "./parts";
import { defaultView, FileContent, type FileLinks, type FileView } from "./preview";
import {
  memoOf,
  nextCommit,
  nextFile,
  nextList,
  STALE_AFTER_FAILURES,
  type CommitState,
  type FileState,
  type ListState,
  type ReadMode,
} from "./state";
import { targetKey, type ChangesLevel, type ChangesTarget } from "./target";
import { readView, type ChangesView } from "./view";

export type { ChangesLevel, ChangesTarget } from "./target";

/** The screen's own beat while it is open and the page visible (web/'s CHANGES_POLL_MS). */
const POLL_MS = 5000;

const NO_REPOS: readonly ChangedRepo[] = [];
const NO_CLEAN: readonly CleanRepo[] = [];

/**
 * Collapsed tree folders, per target, for this session: in memory, so leaving the view and coming
 * back keeps them, and a reload opens every folder again.
 */
const collapsedByTarget = new Map<string, ReadonlySet<string>>();

/** The one file whose Preview the diff's own button just asked for: consumed by the file screen it opens. */
let previewAsked: string | null = null;

/** What a file of the tree can show: its diff when it changed, its source, and a preview. */
type TreeView = "diff" | FileView;

const TREE_VIEW_LABEL = {
  diff: "files.view.diff",
  source: "files.view.source",
  preview: "files.view.preview",
} satisfies Record<TreeView, MessageKey>;

function commitUnavailableKey(reason: Extract<ChangeCommitResponse, { available: false }>["reason"]): MessageKey {
  if (reason === "no-commit") return "changes.commit.noCommit";
  if (reason === "unknown-repo") return "changes.commit.unknown";
  return unavailableKey(reason);
}

function lookup(): ChangesLookup {
  const p = dashPrefs.get();
  return { depth: p.changesDepth, nested: p.changesNested };
}

function toggleIn(set: ReadonlySet<string>, k: string): Set<string> {
  const next = new Set(set);
  if (!next.delete(k)) next.add(k);
  return next;
}

interface ReadStarted {
  commitRepo: string | null;
  openKey: string | null;
  filesKey: string | null;
}

interface ReadWanted {
  commitRepo: string | null;
  openKey: string | null;
  readKey: string | null;
  dir: string | null;
  path: string | null;
}

interface Controls {
  render: () => RemixNode;
}

export interface ChangesRouteProps {
  target: ChangesTarget;
  level: ChangesLevel;
}

export function ChangesRoute(handle: Handle<ChangesRouteProps>) {
  useLocale(handle);
  const readPrefs = useStore(handle, dashPrefs);
  const header = headerOf(handle).owner(handle.signal);
  // The route is keyed by target and scope (frame/map.tsx, REMIX3.md rule 3), so both are fixed for
  // this instance's life and safe to read once.
  const target = handle.props.target;
  const scope = address.get().scope;
  const key = targetKey(target);
  const redraw = (): void => scheduleUpdate(handle);

  // ── The paths this screen moves between ───────────────────────────────────────────────────────
  const pathTo = (ref?: ChangeRef): string =>
    target.kind === "pane" ? changesPath(target.paneId, scope, ref) : spaceChangesPath(target.spaceId, scope, ref);
  const commitPathTo = (repo: string, path?: string): string =>
    target.kind === "pane" ? changesCommitPath(target.paneId, scope, repo, path) : spaceChangesCommitPath(target.spaceId, scope, repo, path);
  const filesPathTo = (to?: FilesAt): string =>
    target.kind === "pane" ? filesPath(target.paneId, scope, to) : spaceFilesPath(target.spaceId, scope, to);
  const backFallback = target.kind === "pane" ? panePath(target.paneId, scope) : spacePath(target.spaceId, scope);
  /** The dashboard Files row this space's screen was opened from (files-tab.tsx `data-glide-key`). */
  const glideKey = target.kind === "space" ? spaceChangesPath(target.spaceId, scope) : "";
  /** Where the arrow lands from the root level: the entry behind when it is a parent, else the fallback. */
  const upDestination = (): string => {
    const from = previousEntry();
    return upTarget(hereNow(), from, backFallback, from !== undefined);
  };
  /** Up from the root level; to the dashboard's Files tab it is the `changes` pair's back glide. */
  const upFromRoot = (): void => {
    const home = target.kind === "space" && GLIDE_PAIRS.changes.origin(upDestination()) && readPrefs().dashView === "changes";
    if (home) glideBack("changes", glideKey, () => goUp(backFallback));
    else goUp(backFallback);
  };

  // ── The list ──────────────────────────────────────────────────────────────────────────────────
  // A screen this page has read before opens on that list, and the open read replaces it only if the
  // answer differs.
  let list: ListState = (() => {
    const kept = keptChangesList(scope, key, lookup());
    return kept ? { phase: "ready", data: kept } : { phase: "loading" };
  })();
  // The first answer after the skeleton fades in (`count-arrive`): set once, on that answer only.
  let listArrive = false;
  let refreshing = false;
  let failures = 0;
  let listCtl: AbortController | null = null;

  const readList = async (mode: ReadMode): Promise<boolean> => {
    // The timer never stacks a read on one still in flight; it waits for the next tick.
    if (mode === "poll" && listCtl !== null) return true;
    listCtl?.abort();
    const ctl = new AbortController();
    listCtl = ctl;
    const signal = AbortSignal.any([ctl.signal, handle.signal]);
    try {
      const data = await fetchChanges(target, lookup(), scope, signal);
      if (signal.aborted) return true;
      const next = nextList(list, data);
      if (next !== list) {
        if (list.phase !== "ready") listArrive = true;
        list = next;
        if (next.phase === "ready") keepChangesList(scope, key, lookup(), next.data);
        redraw();
      }
      return true;
    } catch {
      if (signal.aborted) return true;
      // A re-read that fails keeps the last good list; only a failed first read shows the error.
      if (mode === "open" || list.phase !== "ready") {
        list = { phase: "error" };
        redraw();
      }
      return false;
    } finally {
      if (listCtl === ctl) listCtl = null;
    }
  };

  // ── The last commit ───────────────────────────────────────────────────────────────────────────
  let commit: CommitState | null = null;
  let commitCtl: AbortController | null = null;

  const readCommit = async (repo: string, mode: ReadMode): Promise<boolean> => {
    if (mode === "poll" && commitCtl !== null) return true;
    commitCtl?.abort();
    const ctl = new AbortController();
    commitCtl = ctl;
    const signal = AbortSignal.any([ctl.signal, handle.signal]);
    // Opening asks for the commit that is last NOW, so it starts clean rather than as a re-read.
    if (mode === "open") {
      commit = { phase: "loading", repo };
      redraw();
    }
    try {
      const data = await fetchChangeCommit(target, lookup(), repo, scope, signal);
      if (signal.aborted) return true;
      const next = nextCommit(commit, repo, data);
      if (next !== commit) {
        commit = next;
        redraw();
      }
      return true;
    } catch {
      if (signal.aborted) return true;
      if (mode === "open" || commit?.repo !== repo || commit.phase !== "ready") {
        commit = { phase: "error", repo };
        redraw();
      }
      return false;
    } finally {
      if (commitCtl === ctl) commitCtl = null;
    }
  };

  const loadNewer = (): void => {
    if (commit?.phase === "ready" && commit.newer) {
      commit = { phase: "ready", repo: commit.repo, data: commit.newer };
      redraw();
    }
  };

  // ── One file's diff ───────────────────────────────────────────────────────────────────────────
  let file: FileState | null = null;
  let fileCtl: AbortController | null = null;

  const readFile = async (fileKey: string, mode: ReadMode): Promise<boolean> => {
    if (mode === "poll" && fileCtl !== null) return true;
    fileCtl?.abort();
    const ctl = new AbortController();
    fileCtl = ctl;
    const signal = AbortSignal.any([ctl.signal, handle.signal]);
    const [kind = "", repo = "", ...rest] = fileKey.split("\n");
    const ref = { repo, path: rest.join("\n") };
    if (mode === "open") {
      file = { phase: "loading", key: fileKey };
      redraw();
    }
    try {
      let data;
      let shownHash: string | undefined;
      if (kind === "commit") {
        data = await fetchChangeCommitDiff(target, lookup(), ref, scope, signal);
        shownHash = commit?.phase === "ready" && commit.repo === repo && commit.data.available ? commit.data.commit.hash : undefined;
      } else {
        data = await fetchChangeDiff(target, lookup(), ref, scope, signal);
      }
      if (signal.aborted) return true;
      const next = nextFile(file, fileKey, data, shownHash);
      if (next !== file) {
        file = next;
        redraw();
      }
      return true;
    } catch {
      if (signal.aborted) return true;
      if (mode === "open" || file?.key !== fileKey || file.phase !== "ready") {
        file = { phase: "error", key: fileKey };
        redraw();
      }
      return false;
    } finally {
      if (fileCtl === ctl) fileCtl = null;
    }
  };

  // ── A folder or a file of the tree ────────────────────────────────────────────────────────────
  let filesState: FilesReadState = { key: "", phase: "loading" };
  let filesCtl: AbortController | null = null;

  /** Read the tree's folder or file now. `keepShown` keeps what is on screen until the answer replaces it. */
  const readFiles = async (readKey: string, dir: string | null, path: string | null, keepShown: boolean): Promise<void> => {
    filesCtl?.abort();
    const ctl = new AbortController();
    filesCtl = ctl;
    const signal = AbortSignal.any([ctl.signal, handle.signal]);
    if (!keepShown) {
      filesState = { key: readKey, phase: "loading" };
      redraw();
    }
    try {
      let answer;
      if (path === null) {
        answer = await fetchFilesDir(target, dir ?? "", scope, signal);
      } else {
        const read = await fetchFileText(target, path, scope, signal);
        answer = read;
        // A `link` row opened as a file that turns out to be a folder: the file read answers
        // `unknown-path`, the one answer for "not a file". Ask once more as a folder, and if it lists,
        // replace this entry with the folder's own address, so a reload and the back arrow agree with
        // what is on screen. If it does not list, the first answer stands.
        if (read.outcome === "unknown-path" && !signal.aborted) {
          const folder = await fetchFilesDir(target, path, scope, signal);
          if (folder.outcome === "body" && folder.body.available && !signal.aborted) {
            goSide(filesPathTo({ dir: path }));
            answer = folder;
          }
        }
      }
      if (signal.aborted) return;
      filesState =
        answer.outcome === "body" ? { key: readKey, phase: "ready", data: answer.body } : { key: readKey, phase: "refused", why: answer.outcome };
    } catch {
      if (signal.aborted) return;
      filesState = { key: readKey, phase: "error" };
    }
    redraw();
  };

  // ── What the URL wants read, started after each commit ────────────────────────────────────────
  const started: ReadStarted = {
    commitRepo: null,
    openKey: null,
    filesKey: null,
  };
  let booted = false;
  let wanted: ReadWanted = { commitRepo: null, openKey: null, readKey: null, dir: null, path: null };

  const sync = (): void => {
    if (!booted) {
      booted = true;
      void readList("open");
    }
    if (wanted.commitRepo !== started.commitRepo) {
      commitCtl?.abort();
      commitCtl = null;
      started.commitRepo = wanted.commitRepo;
      if (wanted.commitRepo !== null) void readCommit(wanted.commitRepo, "open");
    }
    if (wanted.openKey !== started.openKey) {
      fileCtl?.abort();
      fileCtl = null;
      started.openKey = wanted.openKey;
      if (wanted.openKey !== null) void readFile(wanted.openKey, "open");
    }
    if (wanted.readKey !== started.filesKey) {
      filesCtl?.abort();
      filesCtl = null;
      started.filesKey = wanted.readKey;
      if (wanted.readKey !== null) void readFiles(wanted.readKey, wanted.dir, wanted.path, false);
    }
  };

  // ── Re-reading ────────────────────────────────────────────────────────────────────────────────
  // One pass reads the list, and on the file view the open diff as well: the list is what says the
  // file has left, and what Previous / Next walk, so it must not go stale under an open file.
  const reread = async (mode: "manual" | "poll"): Promise<void> => {
    if (mode === "manual") {
      refreshing = true;
      redraw();
    }
    // On the commit view the list is still read: it is what says the repo has new uncommitted work.
    const reads = [readList(mode)];
    if (wanted.commitRepo !== null) reads.push(readCommit(wanted.commitRepo, mode));
    if (wanted.openKey !== null) reads.push(readFile(wanted.openKey, mode));
    // A folder or a file of the tree is read on the refresh button only: it has no timer (ADR 0083).
    const files = mode === "manual" && wanted.readKey !== null ? readFiles(wanted.readKey, wanted.dir, wanted.path, true) : Promise.resolve();
    const [ok] = await Promise.all([Promise.all(reads).then((all) => all.every(Boolean)), files]);
    if (handle.signal.aborted) return;
    if (mode === "manual") refreshing = false;
    failures = ok ? 0 : failures + 1;
    redraw();
  };
  const beat = setInterval(() => {
    if (document.hidden || isLocked()) return;
    void reread("poll");
  }, POLL_MS);
  handle.signal.addEventListener("abort", () => clearInterval(beat), { once: true });

  // ── Filter, layout and folds ──────────────────────────────────────────────────────────────────
  // They live here, in an instance that stays mounted across the hop to a file and back, so a filter
  // survives Previous / Next and the back arrow. It does not survive a reload, on purpose: a stale
  // filter on a fresh list would hide files the operator did not know were hidden.
  let filter: ChangesFilter = EMPTY_FILTER;
  let commitFilter: ChangesFilter = EMPTY_FILTER;
  let filterOpen = false;
  let collapsed: ReadonlySet<string> = collapsedByTarget.get(key) ?? new Set();
  let commitCollapsed: ReadonlySet<string> = new Set();
  const toggleFolder = (k: string): void => {
    collapsed = toggleIn(collapsed, k);
    collapsedByTarget.set(key, collapsed);
    redraw();
  };
  const toggleCommitFolder = (k: string): void => {
    commitCollapsed = toggleIn(commitCollapsed, k);
    redraw();
  };
  // The name filter belongs to one folder or file: another place starts it blank and closed.
  let nameFilter = { key: "", query: "", open: false };
  const nameFilterFor = (k: string): { query: string; open: boolean } => (nameFilter.key === k ? nameFilter : { query: "", open: false });
  let nameFilterKey = "";
  const patchNameFilter = (change: { query?: string; open?: boolean }): void => {
    nameFilter = { ...(nameFilter.key === nameFilterKey ? nameFilter : { key: nameFilterKey, query: "", open: false }), ...change, key: nameFilterKey };
    redraw();
  };
  let viewChoice: { path: string; view: TreeView } | null = null;
  let keptChange: { path: string; change: RootChange } | null = null;
  let lastAt: { key: string; at: number } | null = null;
  let markedFor: string | null = null;

  // The derived lists, once per input identity (a Shell update re-renders every route, so a render
  // that changes nothing about the files builds nothing).
  const shownReposOf = memoOf((repos: readonly ChangedRepo[], f: ChangesFilter) => filterRepos(repos, f));
  const orderOf = memoOf((repos: readonly ChangedRepo[], layout: "list" | "tree") => layoutOrder(repos, layout));
  const indexOf = memoOf((l: ListState) =>
    l.phase === "ready" && l.data.available ? indexChanges(l.data.root, l.data.repos, l.data.clean ?? []) : EMPTY_CHANGE_INDEX,
  );
  const commitReposOf = memoOf((data: Extract<ChangeCommitResponse, { available: true }> | null): readonly ChangedRepo[] =>
    data ? [{ relPath: data.repo, name: data.name, files: data.files }] : NO_REPOS,
  );
  const markedOf = memoOf(
    (dir: string | null, listing: { entries: FileEntry[] } | null, gone: boolean, index: typeof EMPTY_CHANGE_INDEX): MarkedFolder | null => {
      if (dir === null) return null;
      if (listing !== null) return markFolder(listing.entries, dir, index);
      if (!gone) return null;
      const left = markFolder([], dir, index);
      return left.entries.length > 0 ? left : null;
    },
  );
  const countedOf = memoOf((marked: MarkedFolder | null, query: string, showIgnored: boolean) =>
    marked === null || marked.entries.length === 0 ? null : folderView(marked.entries, query, showIgnored),
  );

  // ── The header ────────────────────────────────────────────────────────────────────────────────
  // The claim carries callbacks made ONCE, here. What the trailing buttons draw changes with state, so
  // the render function reads `controls` (rewritten each render) and `rev` says when to redraw it.
  let controls: Controls = { render: () => null };
  let backNow: () => void = () => goUp(backFallback);
  const onBack = (): void => backNow();
  let trailing: CustomSlot = { kind: "custom", render: () => controls.render(), rev: "" };

  return () => {
    const prefs = readPrefs();
    const v: ChangesView = readView(handle.props.level, window.location.search, prefs.changesOnly);
    const layout = prefs.changesLayout;
    const lookupNow = lookup();
    const snap = snapshot.get().data;
    const pane = target.kind === "pane" ? (snap?.agents.find((a) => a.paneId === target.paneId) ?? snap?.shellPanes.find((p) => p.paneId === target.paneId)) : undefined;
    const space = snap?.workspaces.find((w) => w.workspaceId === (target.kind === "space" ? target.spaceId : pane?.workspaceId));

    // ── Derived lists ──
    const listRepos = list.phase === "ready" && list.data.available ? list.data.repos : NO_REPOS;
    const cleanList = list.phase === "ready" && list.data.available ? (list.data.clean ?? NO_CLEAN) : NO_CLEAN;
    const commitState = v.commitRepo !== null && commit !== null && commit.repo === v.commitRepo ? commit : null;
    const commitData = commitState?.phase === "ready" && commitState.data.available ? commitState.data : null;
    const allRepos = v.commitView ? commitReposOf(commitData) : listRepos;
    const activeFilter = v.commitView ? commitFilter : filter;
    const setActiveFilter = (next: ChangesFilter): void => {
      if (v.commitView) commitFilter = next;
      else filter = next;
      redraw();
    };
    const shownRepos = shownReposOf(allRepos, activeFilter);
    const total = countFiles(allRepos);
    const shown = countFiles(shownRepos);
    const filtering = isFilterActive(activeFilter);
    const clearFilter = (): void => setActiveFilter(EMPTY_FILTER);
    const order = orderOf(shownRepos, layout);

    // ── The tree ──
    const changeIndex = indexOf(list);
    const treeChangeNow = v.treeFile === null ? undefined : changeAt(changeIndex, v.treeFile);
    if (v.treeFile !== null && treeChangeNow !== undefined) keptChange = { path: v.treeFile, change: treeChangeNow };
    const treeChange = treeChangeNow ?? (keptChange !== null && keptChange.path === v.treeFile ? keptChange.change : undefined);
    const treeDeleted = treeChange?.status === "D";
    // Diff only for a changed file, Source and Preview only for one still on disk, Preview only for a
    // type that has one. A changed file opens on its Diff, unless the diff's own Preview sent it here.
    const treeViews: TreeView[] =
      v.treeFile === null
        ? []
        : [
            ...(treeChange ? (["diff"] as const) : []),
            ...(treeDeleted ? [] : (["source"] as const)),
            ...(!treeDeleted && previewKindFor(v.treeFile) !== null ? (["preview"] as const) : []),
          ];
    const askedPreview = v.treeFile !== null && previewAsked === v.treeFile && treeViews.includes("preview");
    const treeDefault: TreeView = askedPreview ? "preview" : treeChange ? "diff" : defaultView(v.treeFile ?? "");
    const treeView: TreeView =
      v.treeFile !== null && viewChoice !== null && viewChoice.path === v.treeFile && treeViews.includes(viewChoice.view) ? viewChoice.view : treeDefault;
    const filesKey = v.treeDir !== null ? `dir\n${v.treeDir}` : v.treeFile !== null && !treeDeleted ? `file\n${v.treeFile}` : null;
    const readKey = filesKey === null ? null : `${scope.host ?? ""}\n${scope.session ?? ""}\n${key}\n${filesKey}`;
    // An answer for another key is not this screen's: until its own arrives the screen is loading.
    const filesNow: FilesReadState = filesState.key === readKey ? filesState : { key: readKey ?? "", phase: "loading" };
    const listing = v.treeDir !== null && filesNow.phase === "ready" && filesNow.data.available && "entries" in filesNow.data ? filesNow.data : null;
    const folderGone = v.treeDir !== null && v.treeDir !== "" && filesNow.phase === "refused" && filesNow.why === "unknown-path";
    const marked = markedOf(v.treeDir, listing, folderGone, changeIndex);
    nameFilterKey = v.treeFile !== null ? `file\n${v.treeFile}` : `dir\n${v.treeDir ?? ""}`;
    const nameNow = nameFilterFor(nameFilterKey);
    const counted = countedOf(marked, nameNow.query, prefs.filesShowIgnored);

    // ── One file ──
    const treeDiffRef: ChangeRef | null = v.treeFile !== null && treeView === "diff" && treeChange ? { repo: treeChange.repo, path: treeChange.path } : null;
    const diffRef = v.current ?? treeDiffRef;
    const openKey = diffRef ? `${v.commitView ? "commit" : "changes"}\n${diffRef.repo}\n${diffRef.path}` : null;
    wanted = { commitRepo: v.commitRepo, openKey, readKey, dir: v.treeDir, path: v.treeFile };
    const fileState = file !== null && file.key === openKey ? file : null;
    const plainRef = v.open ?? treeDiffRef;
    const listedFile = plainRef
      ? list.phase === "ready" && list.data.available
        ? list.data.repos.find((r) => r.relPath === plainRef.repo)?.files.find((f) => f.path === plainRef.path)
        : undefined
      : v.commitOpen
        ? commitData?.files.find((f) => f.path === v.commitOpen?.path)
        : undefined;
    const shownDiff = fileState?.phase === "ready" && fileState.data.available ? fileState.data : undefined;
    // Gone: the diff read says so, or the list no longer names a file whose diff we hold. A commit's
    // files never leave it, so the commit view has no gone.
    const gone =
      !v.commitView &&
      fileState?.phase === "ready" &&
      (fileState.gone === true || (shownDiff !== undefined && list.phase === "ready" && list.data.available && listedFile === undefined));

    // Previous / Next walk what the list shows. A file that leaves keeps its neighbours.
    const at = v.current ? order.findIndex((r) => r.repo === v.current?.repo && r.path === v.current.path) : -1;
    if (openKey !== null && at >= 0) lastAt = { key: openKey, at };
    const slot = at < 0 && gone && lastAt?.key === openKey ? lastAt.at : -1;
    const prev = at > 0 ? order[at - 1] : slot > 0 ? order[slot - 1] : undefined;
    const next = at >= 0 && at < order.length - 1 ? order[at + 1] : slot >= 0 ? order[slot] : undefined;

    // ── Moves (ADR 0067): down pushes, sideways replaces, up steps back onto a parent or replaces ──
    const filePathTo = (ref: ChangeRef): string => (v.commitView ? commitPathTo(ref.repo, ref.path) : pathTo(ref));
    const openFile = (ref: ChangeRef): void => goDown(filePathTo(ref));
    const showCommit = (repo: string): void => goDown(commitPathTo(repo));
    const stepTo = (ref: ChangeRef): void => goSide(filePathTo(ref));
    const treeAt: FilesAt | null = v.treeFile !== null ? { path: v.treeFile } : v.treeDir !== null && v.treeDir !== "" ? { dir: v.treeDir } : null;
    const treeParent = treeAt === null ? null : filesParent(treeAt);
    const upTree = (parent: FilesAt): void => goUpExact(filesPathTo(parent));
    const upToList = (): void => goUpExact(v.commitRepo !== null && v.commitOpen !== null ? commitPathTo(v.commitRepo) : pathTo());
    const openEntry = (entry: FileEntry): void => goDown(filesPathTo(entry.kind === "dir" ? { dir: entryPath(v.treeDir ?? "", entry) } : { path: entryPath(v.treeDir ?? "", entry) }));
    const fileLinks: FileLinks = { hrefFor: (to) => filesPathTo(to), onOpen: (to) => goDown(filesPathTo(to)) };
    const openCrumb = (to: string): void => goSide(filesPathTo(to === "" ? undefined : { dir: to }));
    const pair = (): void => goDown(pairedDevicesPath(scope));
    const changeChangesOnly = (only: boolean): void => {
      setDashPref("changesOnly", only);
      if (only && treeAt !== null) goUpExact(filesPathTo());
    };
    // The diff's "Preview": the same file's screen in the tree, a level below this one (`?path=` is
    // from the root), opened on its Preview. Null for a file the tree cannot reach.
    const previewPath = (ref: ChangeRef): string | null => {
      const root = list.phase === "ready" && list.data.available ? list.data.root : null;
      if (root === null && ref.repo.startsWith("..")) return null;
      return rootPathOf(root ?? "", ref.repo, ref.path) || null;
    };
    const previewInFiles = (path: string): void => {
      previewAsked = path;
      goDown(filesPathTo({ path }));
    };
    const backAria = ((): string => {
      if (v.commitOpen) return t("changes.commit.backAria");
      if (v.open || v.commitView) return t("changes.listBackAria");
      if (treeParent !== null) return t(v.treeFile !== null ? "files.backAria.folder" : "files.backAria.parent");
      const dest = upDestination();
      return t(dest.startsWith("/pane/") ? "changes.backAria.pane" : dest.startsWith("/space/") ? "changes.backAria.workspace" : "changes.backAria.dashboard");
    })();
    backNow = (): void => {
      if (v.current) upToList();
      else if (v.commitView) upToList();
      else if (treeParent !== null) upTree(treeParent);
      else upFromRoot();
    };

    // ── The pane's repo opened once, on the first list the tree-less list shows ──
    if (v.showList && list.phase === "ready" && markedFor !== key) {
      markedFor = key;
      const data = list.data;
      if (target.kind === "pane" && data.available && data.paneRepo !== undefined) {
        const repo = data.paneRepo;
        const inRepo = folderInRepo(pane?.cwd ?? "", data.root, repo);
        if (inRepo !== null) {
          const opened = openFolderChain(collapsed, folderKey(repo, ""), inRepo);
          if (opened !== collapsed) {
            collapsed = opened;
            collapsedByTarget.set(key, opened);
          }
        }
        handle.queueTask(() => document.querySelector("[data-pane-repo]")?.scrollIntoView({ block: "start" }));
      }
    }

    // ── The header's words ──
    const ready = list.phase === "ready" ? list.data : null;
    const workspaceLabel = ready?.workspaceLabel ?? space?.label ?? pane?.workspaceLabel ?? (target.kind === "space" ? target.spaceId : target.paneId);
    const listRoot = ready?.available ? ready.root : null;
    const filesRoot = filesNow.phase === "ready" && filesNow.data.available ? filesNow.data.root : null;
    const rootFolder = v.treeFile !== null || (v.treeDir !== null && v.treeDir !== "") ? (filesRoot ?? listRoot) : (listRoot ?? filesRoot);
    const rootName = rootFolder === null ? null : baseName(rootFolder.replace(/[\\/]+$/, ""));
    const rootSegment = rootFolder === null ? "" : headerFolder(rootFolder, workspaceLabel);
    const stale = failures >= STALE_AFTER_FAILURES;
    let headerCount: WorkspaceChangeCount;
    if (list.phase === "ready") headerCount = summarizeChanges(list.data);
    else headerCount = list.phase === "error" ? { kind: "unavailable" } : { kind: "loading" };
    if (listArrive && !v.showList) listArrive = false;

    // ── The trailing buttons ──
    const listControls = (v.showList || v.commitView) && !v.current;
    const folderFilter = v.treeDir !== null && counted !== null;
    const rev = [listControls, layout, filtering, filterOpen, shown, total, folderFilter, nameNow.open, isNameFilterOn(nameNow.query), counted?.rows.length ?? 0, counted?.pool ?? 0, refreshing].join("|");
    controls = {
      render: () => (
        <>
          {listControls ? layoutToggle(layout, (l) => setDashPref("changesLayout", l)) : null}
          {listControls
            ? filterButton(filterOpen, filtering, shown, total, () => {
                filterOpen = !filterOpen;
                redraw();
              })
            : null}
          {folderFilter && counted !== null
            ? filterButton(nameNow.open, isNameFilterOn(nameNow.query), counted.rows.length, counted.pool, () => patchNameFilter({ open: !nameNow.open }))
            : null}
          <button
            type="button"
            data-testid="refresh"
            aria-label={t("changes.refreshAria")}
            disabled={refreshing}
            mix={on("click", () => void reread("manual"))}
            class="flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground active:bg-muted disabled:opacity-50"
          >
            <Icon icon={RefreshCw} class={cn("size-5", refreshing && "animate-spin")} />
          </button>
        </>
      ),
    };
    // A slot is compared by identity first (header-model.ts `sameSlot`): a changed `rev` needs a NEW object,
    // or the host never learns that the filter button, the layout toggle or the spinner changed.
    if (trailing.rev !== rev) trailing = { ...trailing, rev };
    const title = v.commitView ? t("changes.commit.title") : t("files.title");
    // web/ prints the workspace, the root folder's last name and the stale note on the line under the h1.
    const subtitle = [workspaceLabel, rootSegment, stale ? t("changes.stale") : ""].filter((part) => part !== "").join(" · ");
    // A space's root screen is the `changes` glide's destination; the label is the subtitle's lead.
    const glide: OverrideGlide | undefined = target.kind === "space" && v.atRoot ? { pair: "changes", label: workspaceLabel } : undefined;
    handle.queueTask(() => {
      header.claim({ override: { title, subtitle, backLabel: backAria, onBack, trailing, glide }, width: "wide" });
      sync();
    });

    // ── The body ──
    const listBody = (): RemixNode => {
      if (list.phase === "loading") return changesListSkeleton(t("changes.loading"));
      if (list.phase === "error") {
        return (
          <Notice variant="box" tone="danger" announce="alert">
            {t("changes.error")}
          </Notice>
        );
      }
      const data = list.data;
      if (!data.available) return quiet(t(unavailableKey(data.reason)));
      const paneRepo = target.kind === "pane" ? data.paneRepo : undefined;
      let body: RemixNode;
      if (data.repos.length === 0) {
        body = (
          <div class="flex flex-col gap-4 py-16">
            <p class="px-2 text-center text-sm leading-relaxed text-muted-foreground">{t("changes.empty")}</p>
            {cleanRepos(cleanList, showCommit)}
          </div>
        );
      } else if (shownRepos.length === 0) body = changesNoMatch(clearFilter);
      else if (layout === "tree") body = changesTree(shownRepos, paneRepo, collapsed, toggleFolder, openFile);
      else body = changesList(shownRepos, paneRepo, openFile);
      return (
        <div class={cn("flex flex-col gap-4", listArrive && "count-arrive")} data-testid="changes-list">
          {body}
          {data.repos.length > 0 && cleanList.length > 0 ? (
            <section aria-label={t("changes.commit.cleanHeading")} class="flex flex-col">
              <SectionLabel class="mb-1.5 normal-case">{t("changes.commit.cleanHeading")}</SectionLabel>
              {cleanRepos(cleanList, showCommit, true)}
            </section>
          ) : null}
          {/* One quiet note at the end when a bound was hit. A cut list says so first; otherwise a
              repo past the depth offers the setting that would reach it. */}
          <Collapse open={data.truncated}>
            <p class="text-xs text-muted-foreground">{t("changes.truncated")}</p>
          </Collapse>
          <Collapse open={!data.truncated && data.depthLimited === true}>
            <p class="text-xs text-muted-foreground">
              {tn("changes.bound.depth", lookupNow.depth)}{" "}
              <button type="button" mix={on("click", () => goDown(changesSettingsPath(scope)))} class="underline underline-offset-2 active:text-foreground">
                {t("changes.bound.settings")}
              </button>
            </p>
          </Collapse>
        </div>
      );
    };

    const commitBody = (): RemixNode => {
      if (v.commitRepo !== null && commitState === null) return quiet(t("changes.commit.loading"));
      if (commitState === null) return quiet(t("changes.commit.unknown"));
      if (commitState.phase === "loading") return quiet(t("changes.commit.loading"));
      if (commitState.phase === "error") {
        return (
          <Notice variant="box" tone="danger" announce="alert">
            {t("changes.commit.error")}
          </Notice>
        );
      }
      const data = commitState.data;
      if (!data.available) return quiet(t(commitUnavailableKey(data.reason)));
      let body: RemixNode;
      if (data.files.length === 0) body = quiet(t("changes.commit.empty"));
      else if (shownRepos.length === 0) body = changesNoMatch(clearFilter);
      else if (layout === "tree") body = changesTree(shownRepos, undefined, commitCollapsed, toggleCommitFolder, openFile);
      else body = changesList(shownRepos, undefined, openFile);
      const uncommitted = v.commitRepo !== null && list.phase === "ready" && list.data.available && list.data.repos.some((r) => r.relPath === v.commitRepo);
      return (
        <div class="flex flex-col gap-4" data-testid="commit-view">
          {commitHead(data.commit, commitState.newer !== undefined, uncommitted, loadNewer, upToList)}
          {body}
          <Collapse open={data.truncated}>
            <p class="text-xs text-muted-foreground">{t("changes.truncated")}</p>
          </Collapse>
        </div>
      );
    };

    const mainBody = (): RemixNode => {
      if (v.current) {
        return fileScreen({
          path: v.current.path,
          oldPath: listedFile ? listedFile.oldPath : shownDiff?.oldPath,
          status: listedFile?.status ?? shownDiff?.status,
          gone,
          onPreview: v.commitView || previewPath(v.current) === null ? undefined : () => previewInFiles(previewPath(v.current ?? { repo: "", path: "" }) ?? ""),
          state: fileState,
          prev,
          next,
          onStep: stepTo,
        });
      }
      if (v.commitView) return <div class="p-4">{commitBody()}</div>;
      if (v.treeFile !== null) {
        return treeFileScreen({
          path: v.treeFile,
          change: treeChange,
          gone,
          waiting: list.phase === "loading",
          views: treeViews,
          view: treeView,
          onView: (view) => {
            viewChoice = { path: v.treeFile ?? "", view };
            redraw();
          },
          diff: fileState,
          read: filesNow,
          links: fileLinks,
          onPair: pair,
        });
      }
      if (v.treeDir !== null) {
        return (
          <div class="flex flex-col gap-3 p-4" data-testid="files-folder">
            {filesBreadcrumb(v.treeDir, rootName, (to) => filesPathTo(to === "" ? undefined : { dir: to }), openCrumb)}
            {treeFolderBody({
              state: filesNow,
              folder: marked,
              truncated: listing?.truncated === true,
              listAvailable: list.phase === "ready" && list.data.available,
              query: nameNow.query,
              showIgnored: prefs.filesShowIgnored,
              onShowIgnored: (show) => setDashPref("filesShowIgnored", show),
              onClearQuery: () => patchNameFilter({ query: "" }),
              onOpen: openEntry,
              onPair: pair,
              onChangesOnly: () => changeChangesOnly(true),
            })}
          </div>
        );
      }
      return (
        <div class="flex flex-col gap-4 p-4">
          {changesListHead(headerCount)}
          {listBody()}
        </div>
      );
    };

    const rootScreen = v.atRoot;
    return (
      <div
        data-testid="changes-route"
        data-level={v.level}
        class="relative mx-auto flex min-h-0 w-full max-w-[100dvw] min-w-0 flex-1 flex-col md:max-w-screen-md lg:max-w-screen-lg xl:max-w-screen-xl 2xl:max-w-[1400px]"
      >
        {/* Floats over the list, anchored under the header: opening and closing move neither by a
            pixel. A tap outside it or Escape closes it; the filter itself stays applied. It is out of
            flow, so the bare conditional is not a layout appearance (REMIX3.md rule 7). */}
        {listControls && filterOpen ? (
          <FilterOverlay
            onClose={() => {
              filterOpen = false;
              redraw();
            }}
          >
            {changesFilterBar(activeFilter, setActiveFilter, clearFilter, shown, total)}
          </FilterOverlay>
        ) : null}
        {folderFilter && nameNow.open && counted !== null ? (
          <FilterOverlay onClose={() => patchNameFilter({ open: false })}>
            {filesFilterBar(nameNow.query, (query) => patchNameFilter({ query }), prefs.filesShowIgnored, (show) => setDashPref("filesShowIgnored", show), counted.rows.length, counted.pool)}
          </FilterOverlay>
        ) : null}

        {/* The scope sits in the header's second line; the stale note also speaks to a screen reader here. */}
        <span role="status" class="sr-only">
          {stale ? t("changes.stale") : ""}
        </span>

        {rootScreen || treeAt !== null ? filesModeControl(prefs.changesOnly, countFiles(listRepos), changeChangesOnly) : null}

        <main data-testid="route-main" class="relative flex min-h-0 flex-1 flex-col overflow-y-auto" mix={scrollMemory()}>
          {mainBody()}
        </main>
      </div>
    );
  };
}

// ── The file screens ────────────────────────────────────────────────────────────────────────────

interface FileScreenArgs {
  path: string;
  oldPath: string | undefined;
  status: ChangeStatus | undefined;
  /** A re-read found the file no longer changed; the diff below is the last one there was. */
  gone: boolean;
  /** Open this file in Files; absent for a file the tree cannot reach. */
  onPreview: (() => void) | undefined;
  state: FileState | null;
  prev: ChangeRef | undefined;
  next: ChangeRef | undefined;
  onStep: (ref: ChangeRef) => void;
}

/** One changed file: its path and letter under a sticky bar, its diff, and Previous / Next. */
function fileScreen(a: FileScreenArgs): RemixNode {
  const { path, oldPath, status, gone, onPreview, state, prev, next, onStep } = a;
  return (
    <>
      {/* Sticky, so the reader always knows which file this is, however far down the diff. */}
      <div data-testid="file-bar" class="sticky top-0 z-10 flex min-h-11 items-center gap-3 border-b border-rule bg-background px-4 py-2">
        {status ? statusLetter(status) : null}
        <div class="min-w-0 flex-1">
          {changePath(path)}
          {oldPath ? <div class="truncate font-mono text-xs text-muted-foreground">{t("changes.file.renamedFrom", { path: oldPath })}</div> : null}
        </div>
        {/* In the row that is already there, so the diff under it does not move. */}
        <span role="status" class="shrink-0 text-xs text-muted-foreground">
          {gone ? t("changes.file.gone") : ""}
        </span>
        {onPreview && status !== "D" && previewKindFor(path) !== null ? (
          <Button variant="outline" size="sm" class="h-8 shrink-0" aria-label={t("changes.file.previewAria")} mix={on("click", onPreview)}>
            {t("changes.file.preview")}
          </Button>
        ) : null}
      </div>
      <div class="flex-1 py-2">{fileBody(state)}</div>
      {/* Across what the list shows, repos included. Disabled rather than hidden at either end, so
          the pair never moves. */}
      <div class="sticky bottom-0 grid grid-cols-2 gap-2 border-t border-rule bg-background p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <Button variant="outline" class="h-11" data-testid="prev-file" disabled={!prev} mix={on("click", () => prev && onStep(prev))}>
          <Icon icon={ChevronLeft} class="size-4" />
          {t("changes.file.prev")}
        </Button>
        <Button variant="outline" class="h-11" data-testid="next-file" disabled={!next} mix={on("click", () => next && onStep(next))}>
          {t("changes.file.next")}
          <Icon icon={ChevronRight} class="size-4" />
        </Button>
      </div>
    </>
  );
}

function fileBody(state: FileState | null): RemixNode {
  if (state === null || state.phase === "loading") return filesLoadingFor(t("changes.loading"));
  if (state.phase === "error") {
    return (
      <div class="px-4">
        <Notice variant="box" tone="danger" announce="alert">
          {t("changes.file.error")}
        </Notice>
      </div>
    );
  }
  if (state.moved) return quiet(t("changes.commit.fileNewer"));
  const data = state.data;
  if (!data.available) {
    const reason = data.reason;
    return quiet(reason === "unknown-repo" || reason === "unknown-path" || reason === "no-commit" ? t("changes.file.unknown") : t(unavailableKey(reason)));
  }
  if (data.binary) return quiet(t("changes.file.binary"));
  if (data.directory) return quiet(t("changes.file.directory"));
  if (data.diff.trim() === "" || !data.diff.includes("@@")) return quiet(t("changes.file.noLines"));
  return (
    <>
      <DiffView diff={data.diff} path={data.path} />
      <Collapse open={data.truncated}>
        <p class="px-4 pt-3 text-xs text-muted-foreground">{t("changes.file.truncated")}</p>
      </Collapse>
    </>
  );
}

/** A status line with its own words (the diff's "loading", the tree's own for a file read). */
function filesLoadingFor(label: string): RemixNode {
  return (
    <div role="status" class="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
      {label}
    </div>
  );
}

interface TreeFileArgs {
  path: string;
  change: RootChange | undefined;
  gone: boolean;
  /** The list has not answered yet. */
  waiting: boolean;
  views: readonly TreeView[];
  view: TreeView;
  onView: (view: TreeView) => void;
  diff: FileState | null;
  read: FilesReadState;
  links: FileLinks;
  onPair: () => void;
}

/**
 * One file of the tree: its path and change under a sticky bar, the Diff | Source | Preview choice,
 * and the body the choice draws. Diff is offered only for a changed file and reads through the list's
 * own diff machinery; Source and Preview read the file itself. Until the list answers, the screen
 * cannot know whether the file changed, so it waits rather than open on Source and jump.
 */
function treeFileScreen(a: TreeFileArgs): RemixNode {
  const { path, change, gone, waiting, views, view, onView, diff, read, links, onPair } = a;
  const size = read.phase === "ready" && read.data.available && "size" in read.data ? read.data.size : null;
  let body: RemixNode;
  if (waiting) body = filesLoading();
  else if (view === "diff") body = fileBody(diff);
  else if (read.phase === "loading") body = filesLoading();
  else if (read.phase === "error") {
    body = (
      <div class="px-4">
        <Notice variant="box" tone="danger" announce="alert">
          {t("files.file.error")}
        </Notice>
      </div>
    );
  } else if (read.phase === "refused") body = refusedBody(read.why, "file", onPair);
  else if (!read.data.available) body = quiet(t(unavailableKey(read.data.reason)));
  // A link that led to a folder: the screen is moving there on its own.
  else if ("entries" in read.data) body = filesLoading();
  else body = <FileContent file={read.data} view={view} links={links} />;
  return (
    <div data-testid="files-file" class="flex min-h-0 flex-1 flex-col">
      {/* Sticky, so the reader always knows which file this is, however far down the page. */}
      <div class="sticky top-0 z-10 flex flex-col gap-2 border-b border-rule bg-background px-4 py-2">
        <div class="flex min-h-7 items-center gap-3">
          {change ? statusLetter(change.status) : null}
          <div class="min-w-0 flex-1">
            {changePath(path)}
            {change?.oldPath ? <div class="truncate font-mono text-xs text-muted-foreground">{t("changes.file.renamedFrom", { path: change.oldPath })}</div> : null}
          </div>
          <span role="status" class="shrink-0 text-xs text-muted-foreground">
            {gone ? t("changes.file.gone") : ""}
          </span>
          <span class="shrink-0 text-xs text-muted-foreground tabular-nums">{size === null ? "" : formatBytes(size)}</span>
        </div>
        {!waiting && views.length > 1 ? (
          <Segmented
            label={t("files.view.aria")}
            value={view}
            onChange={(value) => {
              const picked = views.find((x) => x === value);
              if (picked !== undefined) onView(picked);
            }}
            options={views.map((value) => ({ value, label: t(TREE_VIEW_LABEL[value]) }))}
          />
        ) : null}
      </div>
      <div class="flex-1 py-2">{body}</div>
    </div>
  );
}
