import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { ArrowLeft, ChevronLeft, ChevronRight, Code, Eye, GitCompareArrows, Loader2, RefreshCw } from "lucide-react";

import { RouteHeader } from "@/components/app-header";
import { FilesLoading, RefusedBody, TreeFolderBody, useFilesRead, type FilesReadState, type TreeRead } from "@/routes/changes-files";
import {
  ChangesListHead,
  entryPath,
  FilesBreadcrumb,
  FilesFilterBar,
  FilesModeControl,
  useFilesFilter,
} from "@/components/files-view";
import { FileContent, defaultView, type FileLinks, type FileView } from "@/components/file-preview";
import { CleanRepos, CommitHead } from "@/components/changes-commit";
import {
  ChangePath,
  ChangesFilterBar,
  ChangesFilterButton,
  ChangesFilterOverlay,
  ChangesLayoutToggle,
  ChangesList,
  ChangesListSkeleton,
  ChangesNoMatch,
  ChangesTree,
  DiffView,
  folderKey,
  StatusLetter,
  type ChangeRef,
} from "@/components/changes-view";
import { Button } from "@/components/ui/button";
import { STRIP_TAP_TARGET } from "@/components/ui/labelled-strip";
import { Notice } from "@/components/ui/notice";
import { SectionLabel } from "@/components/ui/section-label";
import { Segmented } from "@/components/ui/segmented";
import { useDashPrefs } from "@/hooks/use-dash-prefs";
import { useLocale } from "@/hooks/use-locale";
import { useNav } from "@/hooks/use-nav";
import { CHANGES_POLL_MS, useVisibleInterval } from "@/hooks/use-visible-interval";
import { keepChangeCount, keptChangeCount } from "@/hooks/use-workspace-change-counts";
import {
  fetchChangeCommit,
  fetchChangeCommitDiff,
  fetchChangeDiff,
  fetchChanges,
  fetchFilesDir,
  fetchFileText,
  type ChangesLookup,
  type ChangesTarget,
} from "@/lib/api";
import {
  countFiles,
  EMPTY_FILTER,
  filterRepos,
  folderInRepo,
  isFilterActive,
  layoutOrder,
  openFolderChain,
  type ChangesFilter,
  type ChangesLayout,
} from "@/lib/changes-tree";
import { keepChangesList, keptChangesList } from "@/lib/changes-list-cache";
import { unavailableKey } from "@/lib/changes-reason";
import { folderView, isNameFilterOn } from "@/lib/files-filter";
import { changeAt, EMPTY_CHANGE_INDEX, indexChanges, markFolder, type MarkedFolder, type RootChange } from "@/lib/files-marks";
import { baseName, formatBytes, headerFolder, previewKindFor, rootPathOf } from "@/lib/files-view";
import { GLIDE_PAIRS, glideBack } from "@/lib/glide";
import { isAbortError } from "@/lib/loaders";
import { t, tn, type MessageKey } from "@/lib/i18n";
import {
  canStepBack,
  changesCommitPath,
  changesPath,
  changesSettingsPath,
  filesParent,
  filesPath,
  pairedDevicesPath,
  panePath,
  readFrom,
  readPreviewAsked,
  readViaLink,
  spaceChangesCommitPath,
  spaceChangesPath,
  spaceFilesPath,
  spacePath,
  upTarget,
  type FilesAt,
} from "@/lib/nav";
import { useRootData } from "@/lib/route-data";
import { useScope } from "@/lib/session";
import { shareEqual } from "@/lib/share-equal";
import type {
  ChangeCommitDiffResponse,
  ChangeCommitResponse,
  ChangedRepo,
  ChangeDiffResponse,
  ChangesResponse,
  ChangeStatus,
  CleanRepo,
  FileEntry,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { fitPath } from "@/lib/fit-path";
import { useElementWidth } from "@/hooks/use-element-width";
import { summarizeChanges, type WorkspaceChangeCount } from "@/lib/workspace-changes";

// The Changes view (ADR 0065): what changed under a WORKSPACE's folder since the last commit,
// read-only. Two routes share it: `/pane/:paneId/changes` (the bridge resolves the pane's workspace)
// and `/space/:spaceId/changes` (the workspace asked directly). Every pane of a workspace shows the
// same list, and the header names the workspace and its folder so the scope is never a guess.
//
// ONE SCREEN, TWO BODIES (ADR 0083, 2026-10-06). By default the body is the root folder as a tree,
// one folder at a time, with every change marked on its row: a changed file wears its status letter
// and an icon in that colour, a folder says how many changed files sit below it, and a deleted file,
// which the disk no longer lists, is added back from the change set, struck through. The change set
// is this screen's own Changes list, joined by path (lib/files-marks.ts). The screen is called Files.
// The two-segment control under the header, All files | Changes (a per-device pref), swaps the tree
// for the list of changes alone, flat or as a tree, with its filter, its depth note and the way to
// the last commit, exactly as it was before the merge.
// A folder is `…/changes/files?dir=`, a file `…/changes/files?path=`; a changed file opens on its
// Diff, beside Source and, for Markdown, JSON and HTML, a Preview.
//
// The list's own file screen is `?repo=&path=`, one file's diff. Every screen lives in this one
// component so the list survives the hop to a file and back, and Previous / Next can walk it.
//
// THE COMMIT VIEW. Agents commit their own work, so the list goes empty right after the change the
// operator most wants to read. A clean repo offers "Show last commit": `…/changes/commit?repo=` is
// that repo's HEAD, and `&path=` one file of it, with the same list, filter and diff. It is a level
// below the list (a down move; up returns to the list), matched by the same route (`changes/*` in
// router.tsx), so this component stays mounted and the list under it keeps its state. The 5 s beat
// re-reads the commit too, but a newer HEAD never replaces the files on screen: it shows a quiet
// "A newer commit exists" to tap, and new uncommitted changes in that repo show a line back to the
// list.
//
// NOT ON THE ROOT POLL LOOP, BUT ON ITS OWN SLOW ONE (ADR 0065 rule 8). The route has no loader
// (router.tsx), so the root poll re-renders this screen and fetches nothing for it: git status over
// a big tree is not a 1.5 s question. Instead, while the screen is mounted and the page visible, it
// re-reads every CHANGES_POLL_MS (use-visible-interval.ts, which holds a beat while a finger
// scrolls): the list, and on the file view the open file's diff too. A re-read that returns the same
// data changes nothing, down to object identity (`shareEqual`), so nothing re-renders, no row moves
// and sugar-high does not re-colour. A changed diff keeps its colour on every unchanged line
// (DiffView). A failed re-read keeps the last good data on screen. Refresh stays as the manual "now".
//
// THE FIRST FRAME. The head of the Changes list carries the workspace's totals (`+12 −4`), seeded
// from the Changes tab's kept answer so it is right before any read; on the way in, the tab row's
// workspace label glides into the label under the header's title, and back down into the row on the
// back arrow (lib/glide.ts). The row's count line has no twin in the header any more, so it fades.
// The list starts on the last list this page read for the screen (lib/changes-list-cache.ts), or,
// on a first visit, on skeleton rows in the real rows' box, which the first answer fades out of. A
// re-read never shows the skeleton again.

/** Consecutive failed re-reads before the header says the screen has stopped updating. */
export const STALE_AFTER_FAILURES = 2;

/** Why a read runs: the screen opened, the operator tapped refresh, or the timer fired. */
type ReadMode = "open" | "manual" | "poll";

const COUNT_LOADING: WorkspaceChangeCount = { kind: "loading" };
const COUNT_UNAVAILABLE: WorkspaceChangeCount = { kind: "unavailable" };

type ListState =
  | { phase: "loading" }
  | { phase: "error" }
  | { phase: "ready"; data: ChangesResponse };

/** A diff either screen reads: an uncommitted file's, or one file of the last commit. */
type AnyDiff = ChangeDiffResponse | ChangeCommitDiffResponse;

type FileState =
  | { phase: "loading"; key: string }
  | { phase: "error"; key: string }
  // `gone`: a re-read found the file no longer changed. `data` stays the last diff that was.
  // `moved`: a commit file's first read came from a newer commit than the one on screen.
  | { phase: "ready"; key: string; data: AnyDiff; gone?: true; moved?: true };

/**
 * The file state after a read of `key` answered `data`. The same answer keeps the old state object,
 * so React skips the render. A file that has left the list keeps its last diff and is marked gone,
 * rather than turning into an error screen under the operator's eyes. A commit file answered from a
 * commit other than `shownHash` (HEAD moved) keeps the diff on screen, or, on a first read, says so.
 */
function nextFile(prev: FileState | null, key: string, data: AnyDiff, shownHash?: string): FileState {
  const same = prev?.key === key && prev.phase === "ready" ? prev : null;
  if (shownHash !== undefined && data.available && "hash" in data && data.hash !== shownHash) {
    return same ?? { phase: "ready", key, data, moved: true };
  }
  if (same === null) return { phase: "ready", key, data };
  const left = !data.available && (data.reason === "unknown-path" || data.reason === "unknown-repo");
  if (left && same.data.available) return same.gone ? same : { ...same, gone: true };
  const shared = shareEqual(same.data, data);
  if (shared === same.data && !same.gone && !same.moved) return same;
  return { phase: "ready", key, data: shared };
}

type CommitState =
  | { phase: "loading"; repo: string }
  | { phase: "error"; repo: string }
  // `newer`: a re-read found a newer HEAD. It waits for a tap; `data` stays on screen.
  | { phase: "ready"; repo: string; data: ChangeCommitResponse; newer?: ChangeCommitResponse };

/** The commit state after a re-read of `repo` answered `data`. Never swaps the commit on screen. */
function nextCommit(prev: CommitState | null, repo: string, data: ChangeCommitResponse): CommitState {
  if (prev?.repo !== repo || prev.phase !== "ready") return { phase: "ready", repo, data };
  const shown = prev.data;
  if (shown.available && data.available && data.commit.hash !== shown.commit.hash) {
    const newer = prev.newer === undefined ? data : shareEqual(prev.newer, data);
    return newer === prev.newer ? prev : { ...prev, newer };
  }
  // A re-read that cannot see the repo any more keeps the commit on screen.
  if (shown.available && !data.available) return prev;
  const shared = shareEqual(shown, data);
  if (shared === shown && prev.newer === undefined) return prev;
  return { phase: "ready", repo, data: shared };
}

/**
 * Collapsed tree folders, per route target (a pane or a space), for this session: in memory, so
 * leaving the view and coming back keeps them, and a reload opens every folder again.
 */
const collapsedByPane = new Map<string, ReadonlySet<string>>();

/**
 * The header's one place for the root folder, on every screen of this route (the root, a folder, a
 * file, the commit view): `· segment` in mono after the workspace label, where the segment is the
 * root folder's last name and only when it differs from the label. Never the path, never a cut from
 * the left; the breadcrumb says where you are, and the full path rides in the `title`. One function,
 * so the root and the folder screens cannot drift.
 *
 * It sits in a one-line `flex-wrap` box with `overflow-hidden` ({@link LABEL_LINE}): beside four icon
 * buttons the column is about 90px, and a segment that does not fit WHOLE wraps out of sight instead
 * of showing as "· …". The label never gives way to it.
 */
const LABEL_LINE = "flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5 overflow-hidden";

function RootSegment({ folder, label }: { folder: string | null; label: string }) {
  const segment = folder === null ? "" : headerFolder(folder, label);
  if (folder === null || segment === "") return null;
  return (
    <span className="max-w-full shrink-0 truncate font-mono text-xs leading-tight text-muted-foreground" data-slot="files-root-folder" title={folder}>
      · {segment}
    </span>
  );
}

/** Where the back arrow of a file view goes: the list entry it came from, when there is one. */
interface FromList {
  fromList: true;
}

/** What a file of the tree can show: its diff when it changed, its source, and a preview. */
type TreeView = "diff" | FileView;

const TREE_VIEW_LABEL = {
  diff: "files.view.diff",
  source: "files.view.source",
  preview: "files.view.preview",
} satisfies Record<TreeView, MessageKey>;

/** The switcher draws a glyph per view; the word rides along as the segment's name and tooltip. */
export const TREE_VIEW_ICON = {
  diff: <GitCompareArrows />,
  source: <Code />,
  preview: <Eye />,
} satisfies Record<TreeView, ReactNode>;

/**
 * The previous / next button at the end of the file screen when there is nothing to step to. The
 * primitive's `opacity-50` alone left an outline button looking tappable, so the box goes too: no
 * border, no fill, no shadow, muted ink. The 1px border is already reserved (it only turns
 * transparent), so the pair keeps its width and nothing moves.
 */
const STEP_OFF =
  "disabled:border-transparent disabled:bg-transparent disabled:shadow-none disabled:text-muted-foreground disabled:opacity-40";

/** The mono class the path row draws in, and the hidden `0` that measures one character of it. */
const PATH_ROW_MONO = "font-mono text-[11px] leading-4";
/** A mono character at 11px, when the measure gives 0 (jsdom has no layout). */
const FALLBACK_CHAR_WIDTH = 6.6;

/**
 * The thin row under the file screen's name row: the whole path from the repo root, as much of it as
 * the row's width holds (`fitPath`). The name row stays the title and gives the folder little; this
 * row is where the reader sees where the file lives. `title` carries the full path for a pointer.
 * Until the width is measured, the full path draws with `truncate`, so the row is one line either way.
 */
function FilePathRow({ path }: { path: string }) {
  const [rowRef, width] = useElementWidth<HTMLDivElement>(0);
  const probeRef = useRef<HTMLSpanElement>(null);
  const [charWidth, setCharWidth] = useState(FALLBACK_CHAR_WIDTH);
  useEffect(() => {
    const w = probeRef.current?.getBoundingClientRect().width ?? 0;
    if (w > 0) setCharWidth(w);
  }, []);
  // The row's padding is not text room: measure the content box by taking `px-4` (16 px) twice off.
  const budget = width === 0 ? null : Math.max(0, Math.floor((width - 32) / charWidth));
  return (
    <>
      <span ref={probeRef} aria-hidden className={cn("invisible absolute", PATH_ROW_MONO)}>0</span>
      <div
        ref={rowRef}
        data-slot="file-path-row"
        title={path}
        className={cn("h-[18px] min-w-0 px-4 text-muted-foreground", PATH_ROW_MONO, budget === null && "truncate")}
      >
        {budget === null ? path : fitPath(path, budget)}
      </div>
    </>
  );
}

/**
 * The Changes route: the tree or the list at the root, a folder or a file of the tree
 * (`…/changes/files`), one file's diff from the list, or the commit view (`…/changes/commit`).
 */
export function ChangesRoute() {
  return <ChangesScreen />;
}

function ChangesScreen() {
  useLocale();
  const { paneId = "", spaceId = "", "*": splat = "" } = useParams();
  // Which route this is: the pane form or the space form. Both read the same list.
  const target: ChangesTarget = useMemo(
    () => (spaceId !== "" ? { kind: "space", spaceId } : { kind: "pane", paneId }),
    [paneId, spaceId],
  );
  const targetKey = target.kind === "pane" ? `pane:${paneId}` : `space:${spaceId}`;
  const scope = useScope();
  const navigate = useNavigate();
  const nav = useNav();
  const location = useLocation();
  const [search] = useSearchParams();
  const root = useRootData();
  const { prefs, setChangesLayout, setChangesOnly, setFilesShowIgnored } = useDashPrefs();
  const layout = prefs.changesLayout;
  const lookup: ChangesLookup = useMemo(
    () => ({ depth: prefs.changesDepth, nested: prefs.changesNested }),
    [prefs.changesDepth, prefs.changesNested],
  );

  const repoParam = search.get("repo");
  const pathParam = search.get("path");
  // `…/changes/commit`: the commit view. Its repo and file ride the same two query names.
  const commitView = splat === "commit";
  // `…/changes/files`: a folder (`?dir=`) or a file (`?path=`) of the tree, from the root.
  const filesSplat = splat === "files";
  const dirParam = filesSplat ? (search.get("dir") ?? "") : "";
  const treePathParam = filesSplat ? (pathParam ?? "") : "";
  const fileRef: ChangeRef | null =
    !filesSplat && repoParam !== null && pathParam !== null ? { repo: repoParam, path: pathParam } : null;
  // The root: the screen itself, or `…/changes/files` with neither query, its address before the
  // merge. Its body is the tree, or the list when the operator chose Changes only.
  const atRoot = filesSplat ? dirParam === "" && treePathParam === "" : !commitView && fileRef === null;
  const showList = atRoot && prefs.changesOnly;
  const treeFile: string | null = treePathParam !== "" ? treePathParam : null;
  const treeDir: string | null = atRoot ? (prefs.changesOnly ? null : "") : filesSplat && treeFile === null ? dirParam : null;
  const open: ChangeRef | null = commitView ? null : fileRef;
  const commitRepo = commitView ? repoParam : null;
  const commitOpen: ChangeRef | null = commitView ? fileRef : null;

  const pane =
    target.kind === "pane"
      ? (root.agents.find((a) => a.paneId === paneId) ?? root.shellPanes.find((p) => p.paneId === paneId))
      : undefined;
  const space = root.workspaces.find((w) => w.workspaceId === (target.kind === "space" ? spaceId : pane?.workspaceId));

  // ── The list ──────────────────────────────────────────────────────────────
  // A screen this page has read before opens on that list, and the open read replaces it only if
  // the answer differs.
  const [list, setList] = useState<ListState>(() => {
    const kept = keptChangesList(scope, targetKey, lookup);
    return kept ? { phase: "ready", data: kept } : { phase: "loading" };
  });
  // The first answer after the skeleton fades in (`count-arrive`). Set once, on that answer only, so
  // a re-read, a cached open and a return from a file show the rows without motion.
  const [listArrive, setListArrive] = useState(false);
  // Whether a read has answered on this visit: until then the header trusts the tab's kept count
  // over a kept list, which may be older.
  const [answered, setAnswered] = useState(false);
  const answeredNow = useRef(false);
  // What is on screen now, for a read that has to decide whether to touch state at all. An unchanged
  // answer then calls no setter, so not even this component renders again.
  const listNow = useRef(list);
  listNow.current = list;
  // Only a manual refresh spins the button; the timer's reads are silent.
  const [refreshing, setRefreshing] = useState(false);
  const listCtl = useRef<AbortController | null>(null);

  /** Read the list. Resolves false on a failed read, true otherwise (an abort is not a failure). */
  const readList = useCallback(
    async (mode: ReadMode): Promise<boolean> => {
      // The timer never stacks a read on one still in flight; it waits for the next tick.
      if (mode === "poll" && listCtl.current !== null) return true;
      listCtl.current?.abort();
      const ctl = new AbortController();
      listCtl.current = ctl;
      try {
        const data = await fetchChanges(target, lookup, scope, ctl.signal);
        const prev = listNow.current;
        if (prev.phase !== "ready") {
          setList({ phase: "ready", data });
          setListArrive(true);
          keepChangesList(scope, targetKey, lookup, data);
        } else {
          const shared = shareEqual(prev.data, data);
          if (shared !== prev.data) {
            setList({ phase: "ready", data: shared });
            keepChangesList(scope, targetKey, lookup, shared);
          }
        }
        // Once per visit, so a later read with the same answer still sets nothing at all.
        if (!answeredNow.current) {
          answeredNow.current = true;
          setAnswered(true);
        }
        return true;
      } catch (e) {
        if (isAbortError(e)) return true;
        // A re-read that fails keeps the last good list; only a failed first read shows the error.
        if (mode === "open" || listNow.current.phase !== "ready") setList({ phase: "error" });
        return false;
      } finally {
        if (listCtl.current === ctl) listCtl.current = null;
      }
    },
    [target, targetKey, lookup, scope],
  );

  useEffect(() => {
    void readList("open");
    return () => {
      listCtl.current?.abort();
      listCtl.current = null;
    };
  }, [readList]);

  // ── Filter and layout ─────────────────────────────────────────────────────
  // The filter lives in this component, which stays mounted across the hop to a file and back, so
  // it survives Previous / Next and the back arrow. It does not survive a reload, on purpose: a
  // stale filter on a fresh list would hide files the operator did not know were hidden.
  const [filter, setFilter] = useState<ChangesFilter>(EMPTY_FILTER);
  const [filterOpen, setFilterOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => collapsedByPane.get(targetKey) ?? new Set());
  const toggleFolder = useCallback(
    (key: string) =>
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (!next.delete(key)) next.add(key);
        collapsedByPane.set(targetKey, next);
        return next;
      }),
    [targetKey],
  );

  // ── The asking pane's repo (pane route) ─────────────────────────────────
  // The bridge names the repo that holds the pane's folder (`paneRepo`). On the FIRST answer the
  // list shows, its folder chain is opened in the tree and its group is scrolled into view; a 5 s
  // re-read never moves the list, and a folder the operator closes afterwards stays closed.
  const mainRef = useRef<HTMLElement>(null);
  const markedFor = useRef<string | null>(null);
  const paneCwd = pane?.cwd ?? "";
  useEffect(() => {
    if (!showList || list.phase !== "ready" || markedFor.current === targetKey) return;
    markedFor.current = targetKey;
    const data = list.data;
    if (target.kind !== "pane" || !data.available || data.paneRepo === undefined) return;
    const repo = data.paneRepo;
    const inRepo = folderInRepo(paneCwd, data.root, repo);
    if (inRepo !== null) {
      setCollapsed((prev) => {
        const next = openFolderChain(prev, folderKey(repo, ""), inRepo);
        if (next !== prev) collapsedByPane.set(targetKey, next);
        return next;
      });
    }
    mainRef.current?.querySelector("[data-pane-repo]")?.scrollIntoView({ block: "start" });
  }, [list, showList, target.kind, targetKey, paneCwd]);

  // ── The last commit (commit view) ────────────────────────────────────────
  const [commit, setCommit] = useState<CommitState | null>(null);
  const commitNow = useRef(commit);
  commitNow.current = commit;
  const commitCtl = useRef<AbortController | null>(null);

  /** Read the repo's last commit. Same contract as `readList`. */
  const readCommit = useCallback(
    async (repo: string, mode: ReadMode): Promise<boolean> => {
      if (mode === "poll" && commitCtl.current !== null) return true;
      commitCtl.current?.abort();
      const ctl = new AbortController();
      commitCtl.current = ctl;
      // Opening asks for the commit that is last NOW, so it starts clean rather than as a re-read.
      if (mode === "open") setCommit({ phase: "loading", repo });
      try {
        const data = await fetchChangeCommit(target, lookup, repo, scope, ctl.signal);
        const next = nextCommit(commitNow.current, repo, data);
        if (next !== commitNow.current) setCommit(next);
        return true;
      } catch (e) {
        if (isAbortError(e)) return true;
        const prev = commitNow.current;
        if (mode === "open" || prev?.repo !== repo || prev.phase !== "ready") setCommit({ phase: "error", repo });
        return false;
      } finally {
        if (commitCtl.current === ctl) commitCtl.current = null;
      }
    },
    [target, lookup, scope],
  );

  useEffect(() => {
    if (commitRepo === null) return;
    void readCommit(commitRepo, "open");
    return () => {
      commitCtl.current?.abort();
      commitCtl.current = null;
    };
  }, [commitRepo, readCommit]);

  const loadNewer = () =>
    setCommit((prev) => (prev?.phase === "ready" && prev.newer ? { phase: "ready", repo: prev.repo, data: prev.newer } : prev));

  const commitState = commit !== null && commit.repo === commitRepo ? commit : null;
  const commitData = commitState?.phase === "ready" && commitState.data.available ? commitState.data : null;
  const commitRepos = useMemo<readonly ChangedRepo[]>(
    () => (commitData ? [{ relPath: commitData.repo, name: commitData.name, files: commitData.files }] : []),
    [commitData],
  );
  // The commit keeps its own filter and folds: it is another list, and one narrowed for the
  // uncommitted files should not hide the commit's.
  const [commitFilter, setCommitFilter] = useState<ChangesFilter>(EMPTY_FILTER);
  const [commitCollapsed, setCommitCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const toggleCommitFolder = useCallback(
    (key: string) =>
      setCommitCollapsed((prev) => {
        const next = new Set(prev);
        if (!next.delete(key)) next.add(key);
        return next;
      }),
    [],
  );
  useEffect(() => setFilterOpen(false), [commitView, prefs.changesOnly]);

  const listRepos = useMemo<readonly ChangedRepo[]>(
    () => (list.phase === "ready" && list.data.available ? list.data.repos : []),
    [list],
  );
  const allRepos = commitView ? commitRepos : listRepos;
  const activeFilter = commitView ? commitFilter : filter;
  const setActiveFilter = commitView ? setCommitFilter : setFilter;
  const shownRepos = useMemo(() => filterRepos(allRepos, activeFilter), [allRepos, activeFilter]);
  const total = countFiles(allRepos);
  const shown = countFiles(shownRepos);
  const filtering = isFilterActive(activeFilter);
  const clearFilter = () => setActiveFilter(EMPTY_FILTER);

  // Previous / Next walk what the list shows: the filtered files, in the layout's order.
  const order = useMemo(() => layoutOrder(shownRepos, layout), [shownRepos, layout]);

  // ── The tree ──────────────────────────────────────────────────────────────
  // The change set, keyed by path from the root, for the marks and for a file's Diff.
  const changeIndex = useMemo(
    () => (list.phase === "ready" && list.data.available ? indexChanges(list.data.root, list.data.repos, list.data.clean ?? []) : EMPTY_CHANGE_INDEX),
    [list],
  );
  // The change a tree file diffs. Kept for this file once found, so a file that stops being changed
  // keeps its Diff with the "no longer changed" note, as the list's own file screen does.
  const treeChangeNow = treeFile === null ? undefined : changeAt(changeIndex, treeFile);
  const keptChange = useRef<{ path: string; change: RootChange } | null>(null);
  if (treeFile !== null && treeChangeNow !== undefined) keptChange.current = { path: treeFile, change: treeChangeNow };
  const treeChange = treeChangeNow ?? (keptChange.current !== null && keptChange.current.path === treeFile ? keptChange.current.change : undefined);
  const treeDeleted = treeChange?.status === "D";
  // Diff only for a changed file, Source and Preview only for one still on disk, Preview only for a
  // type that has one. A changed file opens on its Diff, unless the diff's own Preview sent it here.
  const treeViews: TreeView[] =
    treeFile === null
      ? []
      : [
          ...(treeChange ? (["diff"] as const) : []),
          ...(treeDeleted ? [] : (["source"] as const)),
          ...(!treeDeleted && previewKindFor(treeFile) !== null ? (["preview"] as const) : []),
        ];
  const [viewChoice, setViewChoice] = useState<{ path: string; view: TreeView } | null>(null);
  const previewAsked = readPreviewAsked(location.state) && treeViews.includes("preview");
  const treeDefault: TreeView = previewAsked ? "preview" : treeChange ? "diff" : defaultView(treeFile ?? "");
  const treeView: TreeView =
    treeFile !== null && viewChoice !== null && viewChoice.path === treeFile && treeViews.includes(viewChoice.view)
      ? viewChoice.view
      : treeDefault;

  // One read of the bridge per folder or file, keyed by machine, target and place, so a move to
  // another level starts clean. A deleted file is not on disk, and is not asked for.
  const filesKey = treeDir !== null ? `dir\n${treeDir}` : treeFile !== null && !treeDeleted ? `file\n${treeFile}` : null;
  const readKey = filesKey === null ? null : `${scope.host ?? ""}\n${scope.session ?? ""}\n${targetKey}\n${filesKey}`;
  const filesPathTo = (to?: FilesAt) => (target.kind === "pane" ? filesPath(paneId, scope, to) : spaceFilesPath(spaceId, scope, to));
  // A `link` row opened as a file that turns out to be a folder: the file read answers `unknown-path`,
  // the one answer for "not a file". Ask once more as a folder, and if it lists, replace this entry
  // with the folder's own address, so a reload and the back arrow agree with what is on screen. If it
  // does not list, the first answer stands and says "This file is not available".
  const viaLink = readViaLink(location.state);
  const { state: filesState, reload: reloadFiles } = useFilesRead<TreeRead>(readKey, async (signal) => {
    if (treeFile === null) return fetchFilesDir(target, treeDir ?? "", scope, signal);
    const read = await fetchFileText(target, treeFile, scope, signal);
    if (read.outcome !== "unknown-path" || !viaLink) return read;
    const folder = await fetchFilesDir(target, treeFile, scope, signal);
    if (folder.outcome === "body" && folder.body.available && !signal.aborted) nav.side(filesPathTo({ dir: treeFile }));
    return folder.outcome === "body" && folder.body.available ? folder : read;
  });
  // The root folder as the last Files answer named it, for a header that has no list answer yet.
  const filesRoot = useRef<string | null>(null);
  if (filesState.phase === "ready" && filesState.data.available) filesRoot.current = filesState.data.root;

  // One folder's rows joined to the change set. A folder the bridge no longer has, that the change
  // set still names deleted files in, lists those files, so their diffs stay one tap away.
  const listing = treeDir !== null && filesState.phase === "ready" && filesState.data.available && "entries" in filesState.data ? filesState.data : null;
  const folderGone = treeDir !== null && treeDir !== "" && filesState.phase === "refused" && filesState.why === "unknown-path";
  const markedFolder = useMemo<MarkedFolder | null>(() => {
    if (treeDir === null) return null;
    if (listing !== null) return markFolder(listing.entries, treeDir, changeIndex);
    if (!folderGone) return null;
    const left = markFolder([], treeDir, changeIndex);
    return left.entries.length > 0 ? left : null;
  }, [treeDir, listing, folderGone, changeIndex]);
  // The name filter is one folder's: another folder, or a file, starts it blank and closed.
  const filesFilter = useFilesFilter(treeFile !== null ? `file\n${treeFile}` : `dir\n${treeDir ?? ""}`);
  const counted =
    markedFolder === null || markedFolder.entries.length === 0
      ? null
      : folderView(markedFolder.entries, filesFilter.query, prefs.filesShowIgnored);

  // ── One file ──────────────────────────────────────────────────────────────
  // Keyed with the screen it belongs to, so a commit's file and the same uncommitted file differ. A
  // tree file on its Diff reads through the same machinery as the list's file screen.
  const current = open ?? commitOpen;
  const treeDiffRef: ChangeRef | null =
    treeFile !== null && treeView === "diff" && treeChange ? { repo: treeChange.repo, path: treeChange.path } : null;
  const diffRef = current ?? treeDiffRef;
  const openKey = diffRef ? `${commitView ? "commit" : "changes"}\n${diffRef.repo}\n${diffRef.path}` : null;
  const [file, setFile] = useState<FileState | null>(null);
  const fileNow = useRef(file);
  fileNow.current = file;
  const fileCtl = useRef<AbortController | null>(null);

  /** Read one file's diff. Same contract as `readList`. */
  const readFile = useCallback(
    async (key: string, mode: ReadMode): Promise<boolean> => {
      if (mode === "poll" && fileCtl.current !== null) return true;
      fileCtl.current?.abort();
      const ctl = new AbortController();
      fileCtl.current = ctl;
      const [kind = "", repo = "", ...rest] = key.split("\n");
      const ref = { repo, path: rest.join("\n") };
      if (mode === "open") setFile({ phase: "loading", key });
      try {
        let data: AnyDiff;
        let shownHash: string | undefined;
        if (kind === "commit") {
          data = await fetchChangeCommitDiff(target, lookup, ref, scope, ctl.signal);
          const c = commitNow.current;
          shownHash = c?.phase === "ready" && c.repo === repo && c.data.available ? c.data.commit.hash : undefined;
        } else {
          data = await fetchChangeDiff(target, lookup, ref, scope, ctl.signal);
        }
        const next = nextFile(fileNow.current, key, data, shownHash);
        if (next !== fileNow.current) setFile(next);
        return true;
      } catch (e) {
        if (isAbortError(e)) return true;
        const prev = fileNow.current;
        if (mode === "open" || prev?.key !== key || prev.phase !== "ready") setFile({ phase: "error", key });
        return false;
      } finally {
        if (fileCtl.current === ctl) fileCtl.current = null;
      }
    },
    [target, lookup, scope],
  );

  // Keyed on the joined string, not on `open`, so a re-render (every root poll) never refetches.
  useEffect(() => {
    if (openKey === null) return;
    void readFile(openKey, "open");
    return () => {
      fileCtl.current?.abort();
      fileCtl.current = null;
    };
  }, [openKey, readFile]);

  // ── Re-reading ────────────────────────────────────────────────────────────
  // One pass reads the list, and on the file view the open diff as well: the list is what says the
  // file has left, and what Previous / Next walk, so it must not go stale under an open file.
  const [failures, setFailures] = useState(0);
  const reread = async (mode: "manual" | "poll") => {
    if (mode === "manual") setRefreshing(true);
    // On the commit view the list is still read: it is what says the repo has new uncommitted work.
    const reads = [readList(mode)];
    if (commitRepo !== null) reads.push(readCommit(commitRepo, mode));
    if (openKey !== null) reads.push(readFile(openKey, mode));
    // A folder or a file of the tree is read on the refresh button only: it has no timer (ADR 0083).
    // Its own failure shows in its body, so it does not count towards the stale note.
    const files = mode === "manual" ? reloadFiles() : Promise.resolve();
    const [ok] = await Promise.all([Promise.all(reads).then((all) => all.every(Boolean)), files]);
    if (mode === "manual") setRefreshing(false);
    if (!ok) setFailures((n) => n + 1);
    else if (failures !== 0) setFailures(0);
  };
  useVisibleInterval(() => void reread("poll"), CHANGES_POLL_MS);
  const stale = failures >= STALE_AFTER_FAILURES;

  const pathTo = (ref?: ChangeRef) =>
    target.kind === "pane" ? changesPath(paneId, scope, ref) : spaceChangesPath(spaceId, scope, ref);
  const commitPathTo = (repo: string, path?: string) =>
    target.kind === "pane" ? changesCommitPath(paneId, scope, repo, path) : spaceChangesCommitPath(spaceId, scope, repo, path);
  const filePathTo = (ref: ChangeRef) => (commitView ? commitPathTo(ref.repo, ref.path) : pathTo(ref));
  const openFile = (ref: ChangeRef) => {
    const state: FromList = { fromList: true };
    navigate(filePathTo(ref), { state });
  };
  // Down one level to a repo's last commit (ADR 0067): a push that records the list as `from`.
  const showCommit = (repo: string) => nav.down(commitPathTo(repo));
  // The diff's "Preview": the same file's screen in the tree, a level below this one (`?path=` is
  // from the root), opened on its Preview. Null for a file the tree cannot reach: one of a repo
  // above the root that lies outside the root. Only a repo above the root needs the root's name, so
  // every other file has its button from the first frame, before the list answers.
  const previewPath = (ref: ChangeRef): string | null => {
    const listRoot = list.phase === "ready" && list.data.available ? list.data.root : null;
    if (listRoot === null && ref.repo.startsWith("..")) return null;
    // `""` is the untracked root itself, which is a folder and has no Preview.
    return rootPathOf(listRoot ?? "", ref.repo, ref.path) || null;
  };
  const previewInFiles = (path: string) => nav.down(filesPathTo({ path }), { fileView: "preview" });

  // The tree's moves (ADR 0067): a folder or a file is one level down, recorded as `from`, so the
  // way up steps back onto the folder it came from and replaces otherwise; a crumb is sideways.
  const treeAt: FilesAt | null = treeFile !== null ? { path: treeFile } : treeDir !== null && treeDir !== "" ? { dir: treeDir } : null;
  const treeParent = treeAt === null ? null : filesParent(treeAt);
  const upTree = (parent: FilesAt) => nav.upExact(filesPathTo(parent));
  const openEntry = (entry: FileEntry) => {
    const rel = entryPath(treeDir ?? "", entry);
    nav.down(filesPathTo(entry.kind === "dir" ? { dir: rel } : { path: rel }), entry.kind === "link" ? { viaLink: true } : undefined);
  };
  // A link in a Markdown file opens another file or folder, one level down like a row does. The name
  // may be a folder written without its slash, so the read is allowed to fall back (`viaLink`).
  const fileLinks: FileLinks = {
    hrefFor: (to) => filesPathTo(to),
    onOpen: (to) => nav.down(filesPathTo(to), { viaLink: true }),
  };
  const openCrumb = (to: string) => nav.side(filesPathTo(to === "" ? undefined : { dir: to }));
  const pair = () => nav.down(pairedDevicesPath(scope));
  // The Changes segment is one control under the header on every level of the tree. The list is the root's body, so
  // turning it on from a folder or a file also goes up to the root, the way back from there does.
  const changeChangesOnly = (on: boolean) => {
    setChangesOnly(on);
    if (on && treeAt !== null) nav.upExact(filesPathTo());
  };
  const changesOnlyNow = () => changeChangesOnly(true);
  // Up from the commit to the list: a step back onto it, or a replace when opened cold.
  const upToList = () => nav.up(pathTo());
  // Previous / Next REPLACE the entry, so browser back from any file lands on the list.
  const stepTo = (ref: ChangeRef) => navigate(filePathTo(ref), { replace: true, state: location.state });
  const backToList = () => {
    // SAFETY: `location.state` is only ever written by `openFile` above, as `FromList`.
    const fromList = (location.state as FromList | null)?.fromList === true;
    if (fromList) navigate(-1);
    else navigate(commitRepo !== null ? commitPathTo(commitRepo) : pathTo(), { replace: true });
  };
  // Up one level (ADR 0067): a step back to the dashboard, space or pane this list was opened from,
  // else a replace onto the pane or the space, never a push that leaves the list behind it.
  const backFallback = target.kind === "pane" ? panePath(paneId, scope) : spacePath(spaceId, scope);
  // The arrow's accessible name says where it actually lands, not a fixed guess: the same
  // resolution `nav.up()` itself runs (`upTarget`), read without moving anything.
  const backDestination = upTarget(location.pathname, readFrom(location.state), backFallback, canStepBack());
  // The way back to the dashboard's Changes tab glides the header's label and count line back down
  // into the tab row this list was opened from (lib/glide.ts, the `changes` pair, rule 1). Only from
  // a workspace's list (the one screen that calls `backOut`), only when the arrow lands on the
  // dashboard, and only when the dashboard will show the Changes tab, which is where the row lives.
  const glidesHome =
    target.kind === "space" && GLIDE_PAIRS.changes.origin(backDestination) && prefs.dashView === "changes";
  const backOut = () => {
    if (glidesHome) glideBack("changes", spaceChangesPath(spaceId, scope), () => nav.up(backFallback));
    else nav.up(backFallback);
  };
  const backAriaKey: MessageKey = backDestination.startsWith("/pane/")
    ? "changes.backAria.pane"
    : backDestination.startsWith("/space/")
      ? "changes.backAria.workspace"
      : "changes.backAria.dashboard";

  // The header names the scope: the workspace, then its folder. The list's own answer wins, because
  // the bridge resolved the root; before it arrives the snapshot's label stands in.
  const ready = list.phase === "ready" ? list.data : null;
  const workspaceLabel = ready?.workspaceLabel ?? space?.label ?? pane?.workspaceLabel ?? (target.kind === "space" ? spaceId : paneId);
  // A folder or a file of the tree names the root its own read answered; the root screen, the list's.
  // Both are the same folder (ADR 0083), so this only decides which answer speaks first.
  const listRoot = ready?.available ? ready.root : null;
  const rootFolder = treeFile !== null || (treeDir !== null && treeDir !== "") ? (filesRoot.current ?? listRoot) : (listRoot ?? filesRoot.current);
  const rootName = rootFolder === null ? null : baseName(rootFolder.replace(/[\\/]+$/, ""));

  // The header's count line: the tab's kept answer until this visit's first read, then what the
  // list sums to, which the tab keeps in turn so the way back shows it at once.
  const workspaceId = target.kind === "space" ? spaceId : pane?.workspaceId;
  const [seedCount] = useState(() => (workspaceId === undefined ? undefined : keptChangeCount({ scope, workspaceId }, lookup)));
  const listCount = useMemo(() => (list.phase === "ready" ? summarizeChanges(list.data) : null), [list]);
  let headerCount: WorkspaceChangeCount;
  if (listCount !== null && (answered || seedCount === undefined)) headerCount = listCount;
  else if (seedCount !== undefined) headerCount = seedCount;
  else headerCount = list.phase === "error" ? COUNT_UNAVAILABLE : COUNT_LOADING;
  useEffect(() => {
    if (answered && listCount !== null && workspaceId !== undefined) keepChangeCount({ scope, workspaceId }, lookup, listCount);
  }, [answered, listCount, workspaceId, scope, lookup]);
  // The rows fade in once, on the list screen; any other screen ends that for good.
  if (listArrive && !showList) setListArrive(false);

  const fileState = file && file.key === openKey ? file : null;
  const plainRef = open ?? treeDiffRef;
  const listedFile = plainRef
    ? list.phase === "ready" && list.data.available
      ? list.data.repos.find((r) => r.relPath === plainRef.repo)?.files.find((f) => f.path === plainRef.path)
      : undefined
    : commitOpen
      ? commitData?.files.find((f) => f.path === commitOpen.path)
      : undefined;
  const shownDiff = fileState?.phase === "ready" && fileState.data.available ? fileState.data : undefined;
  // Gone: the diff read says so, or the list no longer names a file whose diff we hold. A commit's
  // files never leave it, so the commit view has no gone.
  const gone =
    !commitView &&
    fileState?.phase === "ready" &&
    (fileState.gone === true ||
      (shownDiff !== undefined && list.phase === "ready" && list.data.available && listedFile === undefined));

  const at = current ? order.findIndex((r) => r.repo === current.repo && r.path === current.path) : -1;
  // Where the open file last sat in the order, so a file that leaves keeps its neighbours: Previous
  // is the one before it, Next the one that slid into its place.
  const lastAt = useRef<{ key: string; at: number } | null>(null);
  useEffect(() => {
    if (openKey !== null && at >= 0) lastAt.current = { key: openKey, at };
  }, [openKey, at]);
  const slot = at < 0 && gone && lastAt.current?.key === openKey ? lastAt.current.at : -1;
  const prev = at > 0 ? order[at - 1] : slot > 0 ? order[slot - 1] : undefined;
  const next = at >= 0 && at < order.length - 1 ? order[at + 1] : slot >= 0 ? order[slot] : undefined;

  // The root, list or tree: the header the dashboard's tab row glides into.
  const rootScreen = atRoot;
  const previewOf = open === null ? null : previewPath(open);
  const changedFiles = countFiles(listRepos);
  const folderLine = <RootSegment folder={rootFolder} label={workspaceLabel} />;
  // Quiet, on a line that is already there, so it moves nothing.
  const staleNote = (
    <span role="status" className="shrink-0">
      {stale ? t("changes.stale") : ""}
    </span>
  );

  return (
    // The pane's own column, like History: this view is one hop from the pane and keeps its edges.
    <div className="mx-auto flex min-h-0 w-full min-w-0 max-w-[100dvw] flex-1 flex-col md:max-w-screen-md lg:max-w-screen-lg xl:max-w-screen-xl 2xl:max-w-[1400px]">
      {/* `relative`, wrapping ONLY the header slot: `<RouteHeader/>` portals its content elsewhere
          and renders nothing here, so this box is zero-height, and the filter overlay's `top-full`
          below lands exactly on the header's own bottom edge, whatever height it is. Scoping the
          `relative` to this small box (rather than the whole column) matters: the whole column also
          contains `<main/>`, which would make it the overlay's containing block and put `top-full`
          near the BOTTOM of the screen instead. */}
      <div className="relative">
        <RouteHeader
          width="wide"
          override={
            <>
              <Button
                variant="ghost"
                size="icon"
                className="size-11 shrink-0"
                onClick={
                  current ? backToList : commitView ? upToList : treeParent !== null ? () => upTree(treeParent) : backOut
                }
                aria-label={
                  commitOpen
                    ? t("changes.commit.backAria")
                    : open || commitView
                      ? t("changes.listBackAria")
                      : treeParent !== null
                        ? t(treeFile !== null ? "files.backAria.folder" : "files.backAria.parent")
                        : t(backAriaKey)
                }
              >
                <ArrowLeft className="size-5" />
              </Button>
              {/* ONE header on every level of the screen (2026-10-06): the title "Files", and under it
                  the workspace's label and the root folder's last name. The totals `+12 −4` left it
                  for the head of the Changes list. At the root this column is still the tab row's
                  destination, and the workspace label is the one part that glides into it. */}
              <div className="min-w-0 flex-1" data-glide-destination={rootScreen ? "changes" : undefined}>
                <h1 className="truncate text-lg font-semibold leading-tight tracking-tight">
                  {commitView ? t("changes.commit.title") : t("files.title")}
                </h1>
                {/* The workspace label, plus the root folder's last name when it differs: the same
                    RootSegment on every screen. Icon buttons leave no room for more. */}
                <div className="flex min-w-0 items-baseline gap-1.5 text-xs leading-tight text-muted-foreground">
                  <div className={`${LABEL_LINE} h-[0.9375rem]`}>
                    <span data-glide={rootScreen ? "label" : undefined} className="max-w-full shrink-0 truncate">
                      {workspaceLabel}
                    </span>
                    {folderLine}
                  </div>
                  {staleNote}
                </div>
              </div>
              {/* The header's buttons hold their place in both bodies and in every folder: Filter once
                  a folder has rows to filter, then Refresh. The Tree toggle joins them in the list.
                  The mode control (All files | Changes) is not here: it sits under the header. */}
              {(showList || commitView) && !current && (
                <>
                  <ChangesLayoutToggle layout={layout} onChange={setChangesLayout} />
                  <ChangesFilterButton
                    open={filterOpen}
                    active={filtering}
                    shown={shown}
                    total={total}
                    onClick={() => setFilterOpen((o) => !o)}
                  />
                </>
              )}
              {treeDir !== null && counted !== null && (
                <ChangesFilterButton
                  open={filesFilter.open}
                  active={isNameFilterOn(filesFilter.query)}
                  shown={counted.rows.length}
                  total={counted.pool}
                  onClick={() => filesFilter.setOpen(!filesFilter.open)}
                />
              )}
              <Button
                variant="ghost"
                size="icon"
                className="size-11 shrink-0"
                onClick={() => void reread("manual")}
                aria-label={t("changes.refreshAria")}
                disabled={refreshing}
              >
                <RefreshCw className={cn("size-5", refreshing && "animate-spin")} />
              </Button>
            </>
          }
        />

        {/* Floats over the list, anchored under the header: opening and closing move neither by a
            pixel. Tapping outside it or Escape closes it; the filter itself stays applied. */}
        {(showList || commitView) && !current && (
          <ChangesFilterOverlay open={filterOpen} onClose={() => setFilterOpen(false)}>
            <ChangesFilterBar
              filter={activeFilter}
              onChange={setActiveFilter}
              onClear={clearFilter}
              shown={shown}
              total={total}
              focusOnMount
            />
          </ChangesFilterOverlay>
        )}
        {treeDir !== null && counted !== null && (
          <ChangesFilterOverlay open={filesFilter.open} onClose={() => filesFilter.setOpen(false)}>
            <FilesFilterBar
              query={filesFilter.query}
              onQuery={filesFilter.setQuery}
              showIgnored={prefs.filesShowIgnored}
              onShowIgnored={setFilesShowIgnored}
              shown={counted.rows.length}
              total={counted.pool}
              focusOnMount
            />
          </ChangesFilterOverlay>
        )}
      </div>

      {/* Not while a file is open (2026-10-06): the control swaps the LIST's body, and a reader of
          one file wants the screen for the file. It is back the moment the file closes. */}
      {treeFile === null && (rootScreen || treeAt !== null) && (
        <FilesModeControl changesOnly={prefs.changesOnly} count={changedFiles} onChange={changeChangesOnly} />
      )}

      <main ref={mainRef} className="relative flex min-h-0 flex-1 flex-col overflow-y-auto">
        {current ? (
          <FileScreen
            path={current.path}
            // The diff carries both too, so a file that has left keeps its letter and its line.
            oldPath={listedFile ? listedFile.oldPath : shownDiff?.oldPath}
            status={listedFile?.status ?? shownDiff?.status}
            gone={gone}
            onPreview={previewOf === null ? undefined : () => previewInFiles(previewOf)}
            state={fileState}
            prev={prev}
            next={next}
            onStep={stepTo}
          />
        ) : commitView ? (
          <div className="p-4">
            <CommitBody
              state={commitState}
              repos={shownRepos}
              layout={layout}
              collapsed={commitCollapsed}
              onToggle={toggleCommitFolder}
              onClearFilter={clearFilter}
              onOpen={openFile}
              uncommitted={
                commitRepo !== null &&
                list.phase === "ready" &&
                list.data.available &&
                list.data.repos.some((r) => r.relPath === commitRepo)
              }
              onLoadNewer={loadNewer}
              onShowUncommitted={upToList}
            />
          </div>
        ) : treeFile !== null ? (
          <TreeFileScreen
            path={treeFile}
            change={treeChange}
            gone={gone}
            waiting={list.phase === "loading"}
            views={treeViews}
            view={treeView}
            onView={(view) => setViewChoice({ path: treeFile, view })}
            diff={fileState}
            read={filesState}
            links={fileLinks}
            onPair={pair}
          />
        ) : treeDir !== null ? (
          <div className="flex flex-col gap-3 p-4">
            <FilesBreadcrumb
              dir={treeDir}
              rootName={rootName}
              hrefFor={(to) => filesPathTo(to === "" ? undefined : { dir: to })}
              onOpen={openCrumb}
            />
            <TreeFolderBody
              state={filesState}
              folder={markedFolder}
              truncated={listing?.truncated === true}
              listAvailable={list.phase === "ready" && list.data.available}
              query={filesFilter.query}
              showIgnored={prefs.filesShowIgnored}
              onShowIgnored={setFilesShowIgnored}
              onClearQuery={filesFilter.clear}
              onOpen={openEntry}
              onPair={pair}
              onChangesOnly={changesOnlyNow}
            />
          </div>
        ) : (
          <div className="flex flex-col gap-4 p-4">
            <ChangesListHead count={headerCount} />
            <ListBody
              state={list}
              arrive={listArrive}
              repos={shownRepos}
              paneRepo={target.kind === "pane" && list.phase === "ready" ? list.data.paneRepo : undefined}
              depth={lookup.depth}
              onLookDeeper={() => nav.down(changesSettingsPath(scope))}
              layout={layout}
              collapsed={collapsed}
              onToggle={toggleFolder}
              onClearFilter={clearFilter}
              onOpen={openFile}
              onShowCommit={showCommit}
            />
          </div>
        )}
      </main>
    </div>
  );
}

function Quiet({ children }: { children: React.ReactNode }) {
  return <p className="px-2 py-16 text-center text-sm leading-relaxed text-muted-foreground">{children}</p>;
}

function ListBody({
  state,
  arrive,
  repos,
  paneRepo,
  depth,
  onLookDeeper,
  layout,
  collapsed,
  onToggle,
  onClearFilter,
  onOpen,
  onShowCommit,
}: {
  state: ListState;
  /** The first answer after the skeleton: the rows fade in and settle. */
  arrive: boolean;
  /** The repos after the filter. */
  repos: readonly ChangedRepo[];
  /** The repo holding the asking pane's folder, marked "This pane" (pane route only). */
  paneRepo: string | undefined;
  /** The depth the list was read at, for the depth note. */
  depth: number;
  /** Open Settings at the Changes card, for the depth note. */
  onLookDeeper: () => void;
  layout: ChangesLayout;
  collapsed: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onClearFilter: () => void;
  onOpen: (ref: ChangeRef) => void;
  /** Open a clean repo's last commit. */
  onShowCommit: (repo: string) => void;
}) {
  if (state.phase === "loading") return <ChangesListSkeleton label={t("changes.loading")} />;
  if (state.phase === "error") {
    return (
      <Notice variant="box" tone="danger" announce="alert">
        {t("changes.error")}
      </Notice>
    );
  }
  const data = state.data;
  if (!data.available) return <Quiet>{t(unavailableKey(data.reason))}</Quiet>;
  const clean: readonly CleanRepo[] = data.clean ?? [];
  let body: React.ReactNode;
  if (data.repos.length === 0) {
    body = (
      <div className="flex flex-col gap-4 py-16">
        <p className="px-2 text-center text-sm leading-relaxed text-muted-foreground">{t("changes.empty")}</p>
        <CleanRepos repos={clean} onShow={onShowCommit} />
      </div>
    );
  } else if (repos.length === 0)
    body = <ChangesNoMatch onClear={onClearFilter} />;
  else if (layout === "tree")
    body = <ChangesTree repos={repos} paneRepo={paneRepo} collapsed={collapsed} onToggle={onToggle} onOpen={onOpen} />;
  else body = <ChangesList repos={repos} paneRepo={paneRepo} onOpen={onOpen} />;
  // One quiet note at the end when a bound was hit. A cut list says so first, since it is missing
  // things for sure; otherwise a repo past the depth offers the setting that would reach it.
  let bound: React.ReactNode = null;
  if (data.truncated) bound = <p className="text-xs text-muted-foreground">{t("changes.truncated")}</p>;
  else if (data.depthLimited === true) {
    bound = (
      <p className="text-xs text-muted-foreground">
        {tn("changes.bound.depth", depth)}{" "}
        <button type="button" onClick={onLookDeeper} className="underline underline-offset-2 active:text-foreground">
          {t("changes.bound.settings")}
        </button>
      </p>
    );
  }
  return (
    <div className={cn("flex flex-col gap-4", arrive && "count-arrive")}>
      {body}
      {/* Beside other repos' changes, the clean ones still offer their last commit, named. */}
      {data.repos.length > 0 && clean.length > 0 && (
        <section aria-label={t("changes.commit.cleanHeading")} className="flex flex-col">
          <SectionLabel className="mb-1.5 normal-case">{t("changes.commit.cleanHeading")}</SectionLabel>
          <CleanRepos repos={clean} onShow={onShowCommit} rows />
        </section>
      )}
      {bound}
    </div>
  );
}

function Loading({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
      {label}
    </div>
  );
}

function commitUnavailableKey(reason: Extract<ChangeCommitResponse, { available: false }>["reason"]): MessageKey {
  if (reason === "no-commit") return "changes.commit.noCommit";
  if (reason === "unknown-repo") return "changes.commit.unknown";
  return unavailableKey(reason);
}

/** The commit view's list screen: the commit's head, then its files, drawn like the Changes list. */
function CommitBody({
  state,
  repos,
  layout,
  collapsed,
  onToggle,
  onClearFilter,
  onOpen,
  uncommitted,
  onLoadNewer,
  onShowUncommitted,
}: {
  state: CommitState | null;
  /** The commit's one repo, after the filter. */
  repos: readonly ChangedRepo[];
  layout: ChangesLayout;
  collapsed: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onClearFilter: () => void;
  onOpen: (ref: ChangeRef) => void;
  /** The repo now has uncommitted changes. */
  uncommitted: boolean;
  onLoadNewer: () => void;
  onShowUncommitted: () => void;
}) {
  if (state === null) return <Quiet>{t("changes.commit.unknown")}</Quiet>;
  if (state.phase === "loading") return <Loading label={t("changes.commit.loading")} />;
  if (state.phase === "error") {
    return (
      <Notice variant="box" tone="danger" announce="alert">
        {t("changes.commit.error")}
      </Notice>
    );
  }
  const data = state.data;
  if (!data.available) return <Quiet>{t(commitUnavailableKey(data.reason))}</Quiet>;
  let body: React.ReactNode;
  if (data.files.length === 0) body = <Quiet>{t("changes.commit.empty")}</Quiet>;
  else if (repos.length === 0) body = <ChangesNoMatch onClear={onClearFilter} />;
  else if (layout === "tree") body = <ChangesTree repos={repos} collapsed={collapsed} onToggle={onToggle} onOpen={onOpen} />;
  else body = <ChangesList repos={repos} onOpen={onOpen} />;
  return (
    <div className="flex flex-col gap-4">
      <CommitHead
        commit={data.commit}
        newer={state.newer !== undefined}
        uncommitted={uncommitted}
        onLoadNewer={onLoadNewer}
        onShowUncommitted={onShowUncommitted}
      />
      {body}
      {data.truncated && <p className="text-xs text-muted-foreground">{t("changes.truncated")}</p>}
    </div>
  );
}

function FileScreen({
  path,
  oldPath,
  status,
  gone,
  onPreview,
  state,
  prev,
  next,
  onStep,
}: {
  path: string;
  oldPath: string | undefined;
  status: ChangeStatus | undefined;
  /** A re-read found the file no longer changed; the diff below is the last one there was. */
  gone: boolean;
  /** Open this file in Files. Set for every file; the header offers it for a previewable one that is not deleted. */
  onPreview: (() => void) | undefined;
  state: FileState | null;
  prev: ChangeRef | undefined;
  next: ChangeRef | undefined;
  onStep: (ref: ChangeRef) => void;
}) {
  return (
    <>
      {/* Sticky, so the reader always knows which file this is, however far down the diff. */}
      <div className="sticky top-0 z-10 flex min-h-11 items-center gap-3 border-b border-rule bg-background px-4 py-2">
        {status && <StatusLetter status={status} />}
        <div className="min-w-0 flex-1">
          <ChangePath path={path} />
          {oldPath && (
            <div className="truncate font-mono text-xs text-muted-foreground">
              {t("changes.file.renamedFrom", { path: oldPath })}
            </div>
          )}
        </div>
        {/* In the row that is already there, so the diff under it does not move. */}
        <span role="status" className="shrink-0 text-xs text-muted-foreground">
          {gone ? t("changes.file.gone") : ""}
        </span>
        {/* A file Files can draw as a page, and that still exists. Its type is known from the path
            before any read, so the button is there from the first frame. */}
        {onPreview && status !== "D" && previewKindFor(path) !== null && (
          <Button variant="outline" size="sm" className={cn("shrink-0", STRIP_TAP_TARGET)} onClick={onPreview} aria-label={t("changes.file.previewAria")}>
            {t("changes.file.preview")}
          </Button>
        )}
      </div>

      <div className="flex-1 py-2">
        <FileBody state={state} />
      </div>

      {/* Across what the list shows, repos included: the filtered files, in the layout's order.
          Disabled rather than hidden at either end, so the pair never moves. */}
      <div className="sticky bottom-0 grid grid-cols-2 gap-2 border-t border-rule bg-background p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <Button variant="outline" className={cn("h-11", STEP_OFF)} disabled={!prev} onClick={() => prev && onStep(prev)}>
          <ChevronLeft className="size-4" />
          {t("changes.file.prev")}
        </Button>
        <Button variant="outline" className={cn("h-11", STEP_OFF)} disabled={!next} onClick={() => next && onStep(next)}>
          {t("changes.file.next")}
          <ChevronRight className="size-4" />
        </Button>
      </div>
    </>
  );
}

function FileBody({ state }: { state: FileState | null }) {
  if (state === null || state.phase === "loading") return <Loading label={t("changes.loading")} />;
  if (state.phase === "error") {
    return (
      <div className="px-4">
        <Notice variant="box" tone="danger" announce="alert">
          {t("changes.file.error")}
        </Notice>
      </div>
    );
  }
  if (state.moved) return <Quiet>{t("changes.commit.fileNewer")}</Quiet>;
  const data = state.data;
  if (!data.available) {
    const reason = data.reason;
    return (
      <Quiet>
        {reason === "unknown-repo" || reason === "unknown-path" || reason === "no-commit"
          ? t("changes.file.unknown")
          : t(unavailableKey(reason))}
      </Quiet>
    );
  }
  if (data.binary) return <Quiet>{t("changes.file.binary")}</Quiet>;
  if (data.directory) return <Quiet>{t("changes.file.directory")}</Quiet>;
  if (data.diff.trim() === "" || !data.diff.includes("@@")) return <Quiet>{t("changes.file.noLines")}</Quiet>;
  return (
    <>
      <DiffView diff={data.diff} path={data.path} />
      {data.truncated && <p className="px-4 pt-3 text-xs text-muted-foreground">{t("changes.file.truncated")}</p>}
    </>
  );
}

/**
 * One file of the tree: its path and change under a sticky bar, the Diff | Source | Preview choice,
 * and the body the choice draws. Diff is offered only for a changed file and reads through the list's
 * own diff machinery (`FileBody`); Source and Preview read the file itself. Until the list answers,
 * the screen cannot know whether the file changed, so it waits rather than open on Source and jump.
 */
function TreeFileScreen({
  path,
  change,
  gone,
  waiting,
  views,
  view,
  onView,
  diff,
  read,
  links,
  onPair,
}: {
  path: string;
  change: RootChange | undefined;
  /** A re-read found the file no longer changed; the diff below is the last one there was. */
  gone: boolean;
  /** The list has not answered yet. */
  waiting: boolean;
  views: readonly TreeView[];
  view: TreeView;
  onView: (view: TreeView) => void;
  diff: FileState | null;
  read: FilesReadState<TreeRead>;
  links: FileLinks;
  onPair: () => void;
}) {
  useLocale();
  const size = read.phase === "ready" && read.data.available && "size" in read.data ? read.data.size : null;
  let body: React.ReactNode;
  if (waiting) body = <FilesLoading />;
  else if (view === "diff") body = <FileBody state={diff} />;
  else if (read.phase === "loading") body = <FilesLoading />;
  else if (read.phase === "error") {
    body = (
      <div className="px-4">
        <Notice variant="box" tone="danger" announce="alert">
          {t("files.file.error")}
        </Notice>
      </div>
    );
  } else if (read.phase === "refused") body = <RefusedBody why={read.why} subject="file" onPair={onPair} />;
  else if (!read.data.available) body = <Quiet>{t(unavailableKey(read.data.reason))}</Quiet>;
  // A link that led to a folder: the screen is moving there on its own.
  else if ("entries" in read.data) body = <FilesLoading />;
  else body = <FileContent file={read.data} view={view} links={links} />;
  return (
    <>
      {/* Sticky, so the reader always knows which file this is, however far down the page. ONE ROW
          (2026-10-06): the path, its size, and the view control at the right, each segment as wide as
          its word. Two rows and the mode control above them held 166 px of a phone's 844 before the
          first line of the file; this row holds 60. The name keeps its middle truncation and the
          folder gives way first, so the control never pushes the file's name off the row. */}
      <div className="sticky top-0 z-10 border-b border-rule bg-background">
        <div className="flex min-h-11 items-center gap-3 px-4 py-2">
          {change && <StatusLetter status={change.status} />}
          <div className="min-w-0 flex-1">
            <ChangePath path={path} />
            {change?.oldPath && (
              <div className="truncate font-mono text-xs text-muted-foreground">
                {t("changes.file.renamedFrom", { path: change.oldPath })}
              </div>
            )}
          </div>
          {/* In the row that is already there, so the page under it does not move. */}
          <span role="status" className="shrink-0 text-xs text-muted-foreground">
            {gone ? t("changes.file.gone") : ""}
          </span>
          {/* Three segments and the size would leave the name about 60 px at 390: the size, the least
              needed word on the row, waits for a wider screen. */}
          <span className={cn("shrink-0 text-xs text-muted-foreground tabular-nums", views.length >= 3 && "hidden sm:inline")}>
            {size === null ? "" : formatBytes(size)}
          </span>
          {!waiting && views.length > 1 && (
            <Segmented
              label={t("files.view.aria")}
              value={view}
              onChange={onView}
              className="shrink-0 [&>button]:flex-none [&>button]:px-3"
              options={views.map((value) => ({ value, label: t(TREE_VIEW_LABEL[value]), icon: TREE_VIEW_ICON[value] }))}
            />
          )}
        </div>
        <FilePathRow path={path} />
      </div>
      <div className="flex-1 py-2">{body}</div>
    </>
  );
}
