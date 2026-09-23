import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { ArrowLeft, ChevronLeft, ChevronRight, Loader2, RefreshCw } from "lucide-react";

import { RouteHeader } from "@/components/app-header";
import { ChangePath, ChangesList, DiffView, flattenChanges, StatusLetter, type ChangeRef } from "@/components/changes-view";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { useDashPrefs } from "@/hooks/use-dash-prefs";
import { useLocale } from "@/hooks/use-locale";
import { fetchChangeDiff, fetchChanges, type ChangesLookup } from "@/lib/api";
import { isAbortError } from "@/lib/loaders";
import { t, type MessageKey } from "@/lib/i18n";
import { changesPath, panePath } from "@/lib/nav";
import { useRootData } from "@/lib/route-data";
import { useScope } from "@/lib/session";
import type {
  ChangeStatus,
  ChangesUnavailableReason,
  PaneChangeDiffResponse,
  PaneChangesResponse,
} from "@/lib/types";
import { cn } from "@/lib/utils";

// The Changes view (ADR 0065): what changed under a pane's folder since the last commit, read-only.
// One route, two screens: the list, and with `?repo=&path=` one file's diff. Both live in this one
// component so the list survives the hop to a file and back, and Previous / Next can walk it.
//
// NOT ON THE POLL LOOP. The list is read when the view opens and when the operator taps refresh,
// never on a timer: git status over a big tree is not a 1.5 s question, and a list that reshuffled
// under a thumb would be the layout shift DESIGN.md §2 forbids. The route has no loader for the same
// reason (router.tsx), so the root poll re-renders this screen and fetches nothing for it.

type ListState =
  | { phase: "loading" }
  | { phase: "error" }
  | { phase: "ready"; data: PaneChangesResponse };

type FileState =
  | { phase: "loading"; key: string }
  | { phase: "error"; key: string }
  | { phase: "ready"; key: string; data: PaneChangeDiffResponse };

function unavailableKey(reason: ChangesUnavailableReason): MessageKey {
  if (reason === "no-git") return "changes.unavailable.noGit";
  if (reason === "no-pane") return "changes.unavailable.noPane";
  return "changes.unavailable.noFolder";
}

/** Where the back arrow of a file view goes: the list entry it came from, when there is one. */
interface FromList {
  fromList: true;
}

export function ChangesRoute() {
  useLocale();
  const { paneId = "" } = useParams();
  const scope = useScope();
  const navigate = useNavigate();
  const location = useLocation();
  const [search] = useSearchParams();
  const root = useRootData();
  const { prefs } = useDashPrefs();
  const lookup: ChangesLookup = useMemo(
    () => ({ depth: prefs.changesDepth, nested: prefs.changesNested }),
    [prefs.changesDepth, prefs.changesNested],
  );

  const repoParam = search.get("repo");
  const pathParam = search.get("path");
  const open: ChangeRef | null = repoParam !== null && pathParam !== null ? { repo: repoParam, path: pathParam } : null;

  const pane =
    root.agents.find((a) => a.paneId === paneId) ?? root.shellPanes.find((p) => p.paneId === paneId);
  const subtitle = pane?.paneLabel ?? pane?.sessionName ?? pane?.cwd ?? paneId;

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
      const data = await fetchChanges(paneId, lookup, scope, ctl.signal);
      setList({ phase: "ready", data });
    } catch (e) {
      if (isAbortError(e)) return;
      setList({ phase: "error" });
    } finally {
      if (listAbort.current === ctl) setRefreshing(false);
    }
  }, [paneId, lookup, scope]);

  useEffect(() => {
    void loadList();
    return () => listAbort.current?.abort();
  }, [loadList]);

  const order = useMemo(
    () => (list.phase === "ready" && list.data.available ? flattenChanges(list.data.repos) : []),
    [list],
  );

  // ── One file ──────────────────────────────────────────────────────────────
  const openKey = open ? `${open.repo}\n${open.path}` : null;
  const [file, setFile] = useState<FileState | null>(null);
  // Keyed on the joined string, not on `open`, so a re-render (every root poll) never refetches.
  useEffect(() => {
    if (openKey === null) return;
    const [repo = "", path = ""] = openKey.split("\n");
    const ctl = new AbortController();
    setFile({ phase: "loading", key: openKey });
    fetchChangeDiff(paneId, lookup, { repo, path }, scope, ctl.signal)
      .then((data) => setFile({ phase: "ready", key: openKey, data }))
      .catch((e) => {
        if (!isAbortError(e)) setFile({ phase: "error", key: openKey });
      });
    return () => ctl.abort();
  }, [openKey, paneId, lookup, scope]);

  const openFile = (ref: ChangeRef) => {
    const state: FromList = { fromList: true };
    navigate(changesPath(paneId, scope, ref), { state });
  };
  // Previous / Next REPLACE the entry, so browser back from any file lands on the list.
  const stepTo = (ref: ChangeRef) => navigate(changesPath(paneId, scope, ref), { replace: true, state: location.state });
  const backToList = () => {
    // SAFETY: `location.state` is only ever written by `openFile` above, as `FromList`.
    const fromList = (location.state as FromList | null)?.fromList === true;
    if (fromList) navigate(-1);
    else navigate(changesPath(paneId, scope), { replace: true });
  };

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
      <RouteHeader
        width="wide"
        override={
          <>
            <Button
              variant="ghost"
              size="icon"
              className="size-11 shrink-0"
              onClick={open ? backToList : () => navigate(panePath(paneId, scope))}
              aria-label={open ? t("changes.listBackAria") : t("changes.backAria")}
            >
              <ArrowLeft className="size-5" />
            </Button>
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-lg font-semibold leading-tight tracking-tight">{t("changes.title")}</h1>
              <div className="truncate text-xs leading-tight text-muted-foreground">{subtitle}</div>
            </div>
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
            <ListBody state={list} onOpen={openFile} />
          </div>
        )}
      </main>
    </div>
  );
}

function Quiet({ children }: { children: React.ReactNode }) {
  return <p className="px-2 py-16 text-center text-sm leading-relaxed text-muted-foreground">{children}</p>;
}

function ListBody({ state, onOpen }: { state: ListState; onOpen: (ref: ChangeRef) => void }) {
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
  return (
    <div className="flex flex-col gap-4">
      {data.repos.length === 0 ? <Quiet>{t("changes.empty")}</Quiet> : <ChangesList repos={data.repos} onOpen={onOpen} />}
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

      {/* Across the WHOLE list, repos included. Disabled rather than hidden at either end, so the
          pair never moves. */}
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
      <DiffView diff={data.diff} />
      {data.truncated && <p className="px-4 pt-3 text-xs text-muted-foreground">{t("changes.file.truncated")}</p>}
    </>
  );
}
