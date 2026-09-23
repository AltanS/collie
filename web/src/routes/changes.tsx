import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { ArrowLeft, ChevronLeft, ChevronRight, Loader2, RefreshCw } from "lucide-react";

import { RouteHeader } from "@/components/app-header";
import { ChangeCountSlot } from "@/components/change-count";
import { CleanRepos, CommitHead } from "@/components/changes-commit";
import {
  ChangePath,
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
import { Notice } from "@/components/ui/notice";
import { SectionLabel } from "@/components/ui/section-label";
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
import { GLIDE_PAIRS, glideBack } from "@/lib/glide";
import { isAbortError } from "@/lib/loaders";
import { t, tn, type MessageKey } from "@/lib/i18n";
import {
  canStepBack,
  changesCommitPath,
  changesPath,
  changesSettingsPath,
  panePath,
  readFrom,
  spaceChangesCommitPath,
  spaceChangesPath,
  spacePath,
  upTarget,
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
  ChangesUnavailableReason,
  CleanRepo,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { summarizeChanges, type WorkspaceChangeCount } from "@/lib/workspace-changes";

// The Changes view (ADR 0065): what changed under a WORKSPACE's folder since the last commit,
// read-only. Two routes share it: `/pane/:paneId/changes` (the bridge resolves the pane's workspace)
// and `/space/:spaceId/changes` (the workspace asked directly). Every pane of a workspace shows the
// same list, and the header names the workspace and its folder so the scope is never a guess.
// Two screens: the list, and with `?repo=&path=` one file's diff. Both live in this one component
// so the list survives the hop to a file and back, and Previous / Next can walk it.
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
// THE FIRST FRAME. The header carries the workspace's count line (`3 files +12 −4`), the same line
// the dashboard's Changes tab draws on the row that was tapped, seeded from the tab's kept answer so
// it is right before any read; the tab row's label and count glide into it, and back down into the
// row on the back arrow (lib/glide.ts).
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

function unavailableKey(reason: ChangesUnavailableReason): MessageKey {
  if (reason === "no-git") return "changes.unavailable.noGit";
  if (reason === "no-pane") return "changes.unavailable.noPane";
  if (reason === "no-workspace") return "changes.unavailable.noWorkspace";
  return "changes.unavailable.noFolder";
}

/**
 * Collapsed tree folders, per route target (a pane or a space), for this session: in memory, so
 * leaving the view and coming back keeps them, and a reload opens every folder again.
 */
const collapsedByPane = new Map<string, ReadonlySet<string>>();

/**
 * The last two segments of a folder, for the header: `…/projects/collie-workspace`. The full path
 * rides in the `title`, so a long-press or hover still shows it whole.
 */
function shortFolder(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 2) return path;
  return `…/${parts.slice(-2).join("/")}`;
}

/** Where the back arrow of a file view goes: the list entry it came from, when there is one. */
interface FromList {
  fromList: true;
}

export function ChangesRoute() {
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
  const { prefs, setChangesLayout } = useDashPrefs();
  const layout = prefs.changesLayout;
  const lookup: ChangesLookup = useMemo(
    () => ({ depth: prefs.changesDepth, nested: prefs.changesNested }),
    [prefs.changesDepth, prefs.changesNested],
  );

  const repoParam = search.get("repo");
  const pathParam = search.get("path");
  // `…/changes/commit`: the commit view. Its repo and file ride the same two query names.
  const commitView = splat === "commit";
  const fileRef: ChangeRef | null = repoParam !== null && pathParam !== null ? { repo: repoParam, path: pathParam } : null;
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
  // The bridge names the repo that holds the pane's folder (`paneRepo`). On the FIRST answer only,
  // its folder chain is opened in the tree and its group is scrolled into view; a 5 s re-read
  // never moves the list, and a folder the operator closes afterwards stays closed.
  const mainRef = useRef<HTMLElement>(null);
  const markedFor = useRef<string | null>(null);
  const paneCwd = pane?.cwd ?? "";
  useEffect(() => {
    if (list.phase !== "ready" || markedFor.current === targetKey) return;
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
  }, [list, target.kind, targetKey, paneCwd]);

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
  useEffect(() => setFilterOpen(false), [commitView]);

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

  // ── One file ──────────────────────────────────────────────────────────────
  // Keyed with the screen it belongs to, so a commit's file and the same uncommitted file differ.
  const current = open ?? commitOpen;
  const openKey = current ? `${commitView ? "commit" : "changes"}\n${current.repo}\n${current.path}` : null;
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
    const ok = (await Promise.all(reads)).every(Boolean);
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
  const rootFolder = ready?.available ? ready.root : null;

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
  // The rows fade in once, on the list screen; a file or the commit view ends that for good.
  if (listArrive && (current !== null || commitView)) setListArrive(false);

  const fileState = file && file.key === openKey ? file : null;
  const listedFile = open
    ? list.phase === "ready" && list.data.available
      ? list.data.repos.find((r) => r.relPath === open.repo)?.files.find((f) => f.path === open.path)
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

  const listScreen = current === null && !commitView;
  const folderLine = rootFolder && (
    <span className="min-w-0 truncate font-mono text-xs leading-tight text-muted-foreground" title={rootFolder}>
      {shortFolder(rootFolder)}
    </span>
  );
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
                onClick={current ? backToList : commitView ? upToList : backOut}
                aria-label={
                  commitOpen
                    ? t("changes.commit.backAria")
                    : open || commitView
                      ? t("changes.listBackAria")
                      : t(backAriaKey)
                }
              >
                <ArrowLeft className="size-5" />
              </Button>
              {/* The list screen's header is the tab row it was opened from, larger: the workspace
                  on the first line (the heading still says "Changes" to a screen reader), its count
                  line under it, so the row's two lines glide straight into these two
                  (lib/glide.ts). A file and the commit view keep the screen's title with
                  the workspace under it. At 375px the column is about 105px wide, too narrow for a
                  title, a label and a count side by side. */}
              <div className="min-w-0 flex-1" data-glide-destination={listScreen ? "changes" : undefined}>
                {listScreen ? (
                  <>
                    <div className="flex min-w-0 items-baseline gap-1.5">
                      <h1
                        data-glide="label"
                        className="max-w-full shrink-0 truncate text-lg font-semibold leading-tight tracking-tight"
                      >
                        <span className="sr-only">{t("changes.title")} </span>
                        {workspaceLabel}
                      </h1>
                      {folderLine}
                    </div>
                    {/* A fixed 16px count line, so a skeleton, a value or a change of value moves
                        nothing; the stale note shares it, as it shared the folder's line before. */}
                    <div className="flex h-4 min-w-0 items-center gap-1.5 text-xs leading-4 text-muted-foreground tabular-nums">
                      <ChangeCountSlot count={headerCount} glide="count" className="shrink-0" />
                      {staleNote}
                    </div>
                  </>
                ) : (
                  <>
                    <h1 className="truncate text-lg font-semibold leading-tight tracking-tight">
                      {commitView ? t("changes.commit.title") : t("changes.title")}
                    </h1>
                    <div className="flex min-w-0 items-baseline gap-1.5 text-xs leading-tight text-muted-foreground">
                      <span className="shrink-0 truncate">{workspaceLabel}</span>
                      {folderLine}
                      {staleNote}
                    </div>
                  </>
                )}
              </div>
              {!current && (
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
        {!current && (
          <ChangesFilterOverlay
            open={filterOpen}
            onClose={() => setFilterOpen(false)}
            filter={activeFilter}
            onChange={setActiveFilter}
            onClear={clearFilter}
            shown={shown}
            total={total}
          />
        )}
      </div>

      <main ref={mainRef} className="relative flex min-h-0 flex-1 flex-col overflow-y-auto">
        {current ? (
          <FileScreen
            path={current.path}
            // The diff carries both too, so a file that has left keeps its letter and its line.
            oldPath={listedFile ? listedFile.oldPath : shownDiff?.oldPath}
            status={listedFile?.status ?? shownDiff?.status}
            gone={gone}
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
        ) : (
          <div className="p-4">
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
      </div>

      <div className="flex-1 py-2">
        <FileBody state={state} />
      </div>

      {/* Across what the list shows, repos included: the filtered files, in the layout's order.
          Disabled rather than hidden at either end, so the pair never moves. */}
      <div className="sticky bottom-0 grid grid-cols-2 gap-2 border-t border-rule bg-background p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <Button variant="outline" className="h-11" disabled={!prev} onClick={() => prev && onStep(prev)}>
          <ChevronLeft className="size-4" />
          {t("changes.file.prev")}
        </Button>
        <Button variant="outline" className="h-11" disabled={!next} onClick={() => next && onStep(next)}>
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
