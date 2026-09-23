import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { ArrowLeft, ChevronLeft, ChevronRight, Loader2, RefreshCw } from "lucide-react";

import { RouteHeader } from "@/components/app-header";
import {
  ChangePath,
  ChangesFilterButton,
  ChangesFilterOverlay,
  ChangesLayoutToggle,
  ChangesList,
  ChangesNoMatch,
  ChangesTree,
  DiffView,
  StatusLetter,
  type ChangeRef,
} from "@/components/changes-view";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { useDashPrefs } from "@/hooks/use-dash-prefs";
import { useLocale } from "@/hooks/use-locale";
import { fetchChangeDiff, fetchChanges, type ChangesLookup, type ChangesTarget } from "@/lib/api";
import {
  countFiles,
  EMPTY_FILTER,
  filterRepos,
  isFilterActive,
  layoutOrder,
  type ChangesFilter,
  type ChangesLayout,
} from "@/lib/changes-tree";
import { isAbortError } from "@/lib/loaders";
import { t, type MessageKey } from "@/lib/i18n";
import { changesPath, panePath, spaceChangesPath, spacePath } from "@/lib/nav";
import { useRootData } from "@/lib/route-data";
import { useScope } from "@/lib/session";
import type {
  ChangedRepo,
  ChangeDiffResponse,
  ChangesResponse,
  ChangeStatus,
  ChangesUnavailableReason,
} from "@/lib/types";
import { cn } from "@/lib/utils";

// The Changes view (ADR 0065): what changed under a WORKSPACE's folder since the last commit,
// read-only. Two routes share it: `/pane/:paneId/changes` (the bridge resolves the pane's workspace)
// and `/space/:spaceId/changes` (the workspace asked directly). Every pane of a workspace shows the
// same list, and the header names the workspace and its folder so the scope is never a guess.
// Two screens: the list, and with `?repo=&path=` one file's diff. Both live in this one component
// so the list survives the hop to a file and back, and Previous / Next can walk it.
//
// NOT ON THE POLL LOOP. The list is read when the view opens and when the operator taps refresh,
// never on a timer: git status over a big tree is not a 1.5 s question, and a list that reshuffled
// under a thumb would be the layout shift DESIGN.md §2 forbids. The route has no loader for the same
// reason (router.tsx), so the root poll re-renders this screen and fetches nothing for it.

type ListState =
  | { phase: "loading" }
  | { phase: "error" }
  | { phase: "ready"; data: ChangesResponse };

type FileState =
  | { phase: "loading"; key: string }
  | { phase: "error"; key: string }
  | { phase: "ready"; key: string; data: ChangeDiffResponse };

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
const collapsedByPane = new Map<string, Set<string>>();

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
  const { paneId = "", spaceId = "" } = useParams();
  // Which route this is: the pane form or the space form. Both read the same list.
  const target: ChangesTarget = useMemo(
    () => (spaceId !== "" ? { kind: "space", spaceId } : { kind: "pane", paneId }),
    [paneId, spaceId],
  );
  const targetKey = target.kind === "pane" ? `pane:${paneId}` : `space:${spaceId}`;
  const scope = useScope();
  const navigate = useNavigate();
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
  const open: ChangeRef | null = repoParam !== null && pathParam !== null ? { repo: repoParam, path: pathParam } : null;

  const pane =
    target.kind === "pane"
      ? (root.agents.find((a) => a.paneId === paneId) ?? root.shellPanes.find((p) => p.paneId === paneId))
      : undefined;
  const space = root.workspaces.find((w) => w.workspaceId === (target.kind === "space" ? spaceId : pane?.workspaceId));

  // ── The list ──────────────────────────────────────────────────────────────
  const [list, setList] = useState<ListState>({ phase: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const listAbort = useRef<AbortController | null>(null);

  const loadList = useCallback(async () => {
    listAbort.current?.abort();
    const ctl = new AbortController();
    listAbort.current = ctl;
    setRefreshing(true);
    try {
      const data = await fetchChanges(target, lookup, scope, ctl.signal);
      setList({ phase: "ready", data });
    } catch (e) {
      if (isAbortError(e)) return;
      setList({ phase: "error" });
    } finally {
      if (listAbort.current === ctl) setRefreshing(false);
    }
  }, [target, lookup, scope]);

  useEffect(() => {
    void loadList();
    return () => listAbort.current?.abort();
  }, [loadList]);

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

  const allRepos = useMemo<readonly ChangedRepo[]>(
    () => (list.phase === "ready" && list.data.available ? list.data.repos : []),
    [list],
  );
  const shownRepos = useMemo(() => filterRepos(allRepos, filter), [allRepos, filter]);
  const total = countFiles(allRepos);
  const shown = countFiles(shownRepos);
  const filtering = isFilterActive(filter);
  const clearFilter = () => setFilter(EMPTY_FILTER);

  // Previous / Next walk what the list shows: the filtered files, in the layout's order.
  const order = useMemo(() => layoutOrder(shownRepos, layout), [shownRepos, layout]);

  // ── One file ──────────────────────────────────────────────────────────────
  const openKey = open ? `${open.repo}\n${open.path}` : null;
  const [file, setFile] = useState<FileState | null>(null);
  // Keyed on the joined string, not on `open`, so a re-render (every root poll) never refetches.
  useEffect(() => {
    if (openKey === null) return;
    const [repo = "", path = ""] = openKey.split("\n");
    const ctl = new AbortController();
    setFile({ phase: "loading", key: openKey });
    fetchChangeDiff(target, lookup, { repo, path }, scope, ctl.signal)
      .then((data) => setFile({ phase: "ready", key: openKey, data }))
      .catch((e) => {
        if (!isAbortError(e)) setFile({ phase: "error", key: openKey });
      });
    return () => ctl.abort();
  }, [openKey, target, lookup, scope]);

  const pathTo = (ref?: ChangeRef) =>
    target.kind === "pane" ? changesPath(paneId, scope, ref) : spaceChangesPath(spaceId, scope, ref);
  const openFile = (ref: ChangeRef) => {
    const state: FromList = { fromList: true };
    navigate(pathTo(ref), { state });
  };
  // Previous / Next REPLACE the entry, so browser back from any file lands on the list.
  const stepTo = (ref: ChangeRef) => navigate(pathTo(ref), { replace: true, state: location.state });
  const backToList = () => {
    // SAFETY: `location.state` is only ever written by `openFile` above, as `FromList`.
    const fromList = (location.state as FromList | null)?.fromList === true;
    if (fromList) navigate(-1);
    else navigate(pathTo(), { replace: true });
  };
  const backOut = () => navigate(target.kind === "pane" ? panePath(paneId, scope) : spacePath(spaceId, scope));

  // The header names the scope: the workspace, then its folder. The list's own answer wins, because
  // the bridge resolved the root; before it arrives the snapshot's label stands in.
  const ready = list.phase === "ready" ? list.data : null;
  const workspaceLabel = ready?.workspaceLabel ?? space?.label ?? pane?.workspaceLabel ?? (target.kind === "space" ? spaceId : paneId);
  const rootFolder = ready?.available ? ready.root : null;

  const at = open ? order.findIndex((r) => r.repo === open.repo && r.path === open.path) : -1;
  const prev = at > 0 ? order[at - 1] : undefined;
  const next = at >= 0 && at < order.length - 1 ? order[at + 1] : undefined;

  const fileState = file && file.key === openKey ? file : null;
  const listedFile =
    open && list.phase === "ready" && list.data.available
      ? list.data.repos.find((r) => r.relPath === open.repo)?.files.find((f) => f.path === open.path)
      : undefined;

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
                onClick={open ? backToList : backOut}
                aria-label={
                  open ? t("changes.listBackAria") : target.kind === "pane" ? t("changes.backAria") : t("changes.backSpaceAria")
                }
              >
                <ArrowLeft className="size-5" />
              </Button>
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-lg font-semibold leading-tight tracking-tight">{t("changes.title")}</h1>
                <div className="flex min-w-0 items-baseline gap-1.5 text-xs leading-tight text-muted-foreground">
                  <span className="shrink-0 truncate">{workspaceLabel}</span>
                  {rootFolder && (
                    <span className="min-w-0 truncate font-mono" title={rootFolder}>
                      {shortFolder(rootFolder)}
                    </span>
                  )}
                </div>
              </div>
              {!open && (
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
                onClick={() => void loadList()}
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
        {!open && (
          <ChangesFilterOverlay
            open={filterOpen}
            onClose={() => setFilterOpen(false)}
            filter={filter}
            onChange={setFilter}
            onClear={clearFilter}
            shown={shown}
            total={total}
          />
        )}
      </div>

      <main className="relative flex min-h-0 flex-1 flex-col overflow-y-auto">
        {open ? (
          <FileScreen
            path={open.path}
            oldPath={listedFile?.oldPath}
            status={listedFile?.status}
            state={fileState}
            prev={prev}
            next={next}
            onStep={stepTo}
          />
        ) : (
          <div className="p-4">
            <ListBody
              state={list}
              repos={shownRepos}
              layout={layout}
              collapsed={collapsed}
              onToggle={toggleFolder}
              onClearFilter={clearFilter}
              onOpen={openFile}
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
  repos,
  layout,
  collapsed,
  onToggle,
  onClearFilter,
  onOpen,
}: {
  state: ListState;
  /** The repos after the filter. */
  repos: readonly ChangedRepo[];
  layout: ChangesLayout;
  collapsed: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onClearFilter: () => void;
  onOpen: (ref: ChangeRef) => void;
}) {
  if (state.phase === "loading") {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {t("changes.loading")}
      </div>
    );
  }
  if (state.phase === "error") {
    return (
      <Notice variant="box" tone="danger" announce="alert">
        {t("changes.error")}
      </Notice>
    );
  }
  const data = state.data;
  if (!data.available) return <Quiet>{t(unavailableKey(data.reason))}</Quiet>;
  let body: React.ReactNode;
  if (data.repos.length === 0) body = <Quiet>{t("changes.empty")}</Quiet>;
  else if (repos.length === 0)
    body = <ChangesNoMatch onClear={onClearFilter} />;
  else if (layout === "tree")
    body = <ChangesTree repos={repos} collapsed={collapsed} onToggle={onToggle} onOpen={onOpen} />;
  else body = <ChangesList repos={repos} onOpen={onOpen} />;
  return (
    <div className="flex flex-col gap-4">
      {body}
      {data.truncated && <p className="text-xs text-muted-foreground">{t("changes.truncated")}</p>}
    </div>
  );
}

function FileScreen({
  path,
  oldPath,
  status,
  state,
  prev,
  next,
  onStep,
}: {
  path: string;
  oldPath: string | undefined;
  status: ChangeStatus | undefined;
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
  if (state === null || state.phase === "loading") {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {t("changes.loading")}
      </div>
    );
  }
  if (state.phase === "error") {
    return (
      <div className="px-4">
        <Notice variant="box" tone="danger" announce="alert">
          {t("changes.file.error")}
        </Notice>
      </div>
    );
  }
  const data = state.data;
  if (!data.available) {
    const reason = data.reason;
    return (
      <Quiet>
        {reason === "unknown-repo" || reason === "unknown-path" ? t("changes.file.unknown") : t(unavailableKey(reason))}
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
