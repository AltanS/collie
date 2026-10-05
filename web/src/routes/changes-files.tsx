import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useParams, useSearchParams } from "react-router";
import { ArrowLeft, Loader2, RefreshCw } from "lucide-react";

import { RouteHeader } from "@/components/app-header";
import { ChangePath, ChangesFilterButton, ChangesFilterOverlay } from "@/components/changes-view";
import { FileContent, defaultView, type FileLinks, type FileView } from "@/components/file-preview";
import { ChangesTabs, FilesBreadcrumb, FilesFilterBar, FilesFolderBody, IgnoredToggle, entryPath, useFilesFilter } from "@/components/files-view";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { Segmented } from "@/components/ui/segmented";
import { useDashPrefs } from "@/hooks/use-dash-prefs";
import { useLocale } from "@/hooks/use-locale";
import { useNav } from "@/hooks/use-nav";
import { fetchFileText, fetchFilesDir, type ChangesTarget, type FilesAnswer } from "@/lib/api";
import { unavailableKey } from "@/lib/changes-reason";
import { folderView, isNameFilterOn } from "@/lib/files-filter";
import { baseName, formatBytes, headerFolder, previewKindFor } from "@/lib/files-view";
import { t, type MessageKey } from "@/lib/i18n";
import { isAbortError } from "@/lib/loaders";
import {
  canStepBack,
  changesPath,
  filesParent,
  filesPath,
  pairedDevicesPath,
  panePath,
  readFrom,
  readViaLink,
  spaceChangesPath,
  spaceFilesPath,
  spacePath,
  upTarget,
  type FilesAt,
} from "@/lib/nav";
import { useRootData } from "@/lib/route-data";
import { useScope } from "@/lib/session";
import type { FileEntry, FileReadResponse, FilesListResponse } from "@/lib/types";
import { cn } from "@/lib/utils";

// The Files tab of the Changes screen (ADR 0083): browse the Changes root folder by folder, and open
// a file as highlighted source, or as a Preview when it is Markdown, JSON or HTML. It is the same
// route as the Changes list, one segment below it (`…/changes/files`), with `?dir=` naming a folder
// and `?path=` a file, both relative to the root.
//
// NOT POLLED. The bridge's answer is asked for when a folder or a file opens, and again on the
// refresh button, never on a timer: there is no change feed under a folder, and a list that
// re-sorts under a thumb is the fault DESIGN.md §2 names. A refresh keeps what is on screen until
// the new answer replaces it.
//
// BACK GOES UP ONE LEVEL (ADR 0067). A file goes up to its folder, a folder to its parent, the first
// folder to the Files root, and the root to wherever Changes goes today. Opening a folder or a file
// is a push that records where it came from, so an up steps back when the entry behind IS the parent
// and replaces otherwise, and a swipe does what the arrow does.

type Refusal = Exclude<FilesAnswer<never>["outcome"], "body">;

type ReadState<T> =
  | { key: string; phase: "loading" }
  | { key: string; phase: "error" }
  | { key: string; phase: "refused"; why: Refusal }
  | { key: string; phase: "ready"; data: T };

/**
 * One read of the bridge, keyed: a different key starts a fresh read and shows loading, the same key
 * keeps its answer. `reload` asks again WITHOUT clearing, so a refresh never blanks the screen.
 */
function useFilesRead<T>(key: string, load: (signal: AbortSignal) => Promise<FilesAnswer<T>>) {
  const [state, setState] = useState<ReadState<T>>({ key, phase: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const loadRef = useRef(load);
  loadRef.current = load;
  const ctl = useRef<AbortController | null>(null);

  const run = useCallback(async (forKey: string, quiet: boolean) => {
    ctl.current?.abort();
    const mine = new AbortController();
    ctl.current = mine;
    if (!quiet) setState({ key: forKey, phase: "loading" });
    try {
      const answer = await loadRef.current(mine.signal);
      if (mine.signal.aborted) return;
      setState(answer.outcome === "body" ? { key: forKey, phase: "ready", data: answer.body } : { key: forKey, phase: "refused", why: answer.outcome });
    } catch (e) {
      if (isAbortError(e) || mine.signal.aborted) return;
      setState({ key: forKey, phase: "error" });
    }
  }, []);

  useEffect(() => {
    void run(key, false);
    return () => ctl.current?.abort();
  }, [key, run]);

  const reload = async () => {
    setRefreshing(true);
    await run(key, true);
    setRefreshing(false);
  };
  // An answer for another key is not this screen's: until its own arrives the screen is loading.
  const shown: ReadState<T> = state.key === key ? state : { key, phase: "loading" };
  return { state: shown, reload, refreshing };
}

function Quiet({ children }: { children: React.ReactNode }) {
  return <p className="px-2 py-16 text-center text-sm leading-relaxed text-muted-foreground">{children}</p>;
}

function Loading({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
      {label}
    </div>
  );
}

/** Why a read was refused, in words. The unpaired device also gets the way to pair. */
function RefusedBody({ why, subject, onPair }: { why: Refusal; subject: "file" | "folder"; onPair: () => void }) {
  if (why === "unknown-path") return <Quiet>{t(subject === "file" ? "files.unknown.file" : "files.unknown.folder")}</Quiet>;
  if (why === "stale") return <Quiet>{t("files.stale.member")}</Quiet>;
  if (why === "not-authorised") return <Quiet>{t("files.notAuthorised")}</Quiet>;
  return (
    <div className="flex flex-col items-center gap-3">
      <Quiet>{t("files.notPaired")}</Quiet>
      <Button variant="outline" className="h-11" onClick={onPair}>
        {t("files.pairLink")}
      </Button>
    </div>
  );
}

export function FilesRoute() {
  useLocale();
  const { paneId = "", spaceId = "" } = useParams();
  const target: ChangesTarget = useMemo(
    () => (spaceId !== "" ? { kind: "space", spaceId } : { kind: "pane", paneId }),
    [paneId, spaceId],
  );
  const scope = useScope();
  const nav = useNav();
  const location = useLocation();
  const [search] = useSearchParams();
  const root = useRootData();
  const { prefs, setFilesShowIgnored } = useDashPrefs();

  const pathParam = search.get("path") ?? "";
  const dirParam = search.get("dir") ?? "";
  const at: FilesAt = pathParam !== "" ? { path: pathParam } : { dir: dirParam };
  const filePath = at.path ?? null;
  const dir = at.dir ?? "";
  // The name filter is one folder's: another folder, or a file, starts it blank and closed.
  const filter = useFilesFilter(filePath !== null ? `file\n${filePath}` : `dir\n${dir}`);

  const pane =
    target.kind === "pane"
      ? (root.agents.find((a) => a.paneId === paneId) ?? root.shellPanes.find((p) => p.paneId === paneId))
      : undefined;
  const space = root.workspaces.find((w) => w.workspaceId === (target.kind === "space" ? spaceId : pane?.workspaceId));
  const workspaceLabel = space?.label ?? pane?.workspaceLabel ?? (target.kind === "space" ? spaceId : paneId);

  const pathTo = (to?: FilesAt) => (target.kind === "pane" ? filesPath(paneId, scope, to) : spaceFilesPath(spaceId, scope, to));
  const changesTo = () => (target.kind === "pane" ? changesPath(paneId, scope) : spaceChangesPath(spaceId, scope));

  // ── The read ──────────────────────────────────────────────────────────────
  // One key per (machine, target, folder or file), so a move to another level starts clean.
  const readKey = `${scope.host ?? ""}\n${scope.session ?? ""}\n${target.kind}:${paneId}${spaceId}\n${filePath !== null ? `file\n${filePath}` : `dir\n${dir}`}`;
  // A `link` row opened as a file that turns out to be a folder: the file read answers `unknown-path`,
  // the one answer for "not a file". Ask once more as a folder, and if it lists, replace this entry
  // with the folder's own address, so a reload and the back arrow agree with what is on screen. If it
  // does not list, the first answer stands and says "This file is not available".
  const viaLink = readViaLink(location.state);
  const { state, reload, refreshing } = useFilesRead<FilesListResponse | FileReadResponse>(readKey, async (signal) => {
    if (filePath === null) return fetchFilesDir(target, dir, scope, signal);
    const file = await fetchFileText(target, filePath, scope, signal);
    if (file.outcome !== "unknown-path" || !viaLink) return file;
    const folder = await fetchFilesDir(target, filePath, scope, signal);
    if (folder.outcome === "body" && folder.body.available && !signal.aborted) nav.side(pathTo({ dir: filePath }));
    return folder.outcome === "body" && folder.body.available ? folder : file;
  });

  // The root folder, as the last answer named it, so the header does not lose it between levels.
  const rootFolder = useRef<string | null>(null);
  if (state.phase === "ready" && state.data.available) rootFolder.current = state.data.root;
  const folderName = rootFolder.current === null ? null : baseName(rootFolder.current.replace(/\/+$/, ""));

  // ── Moves ─────────────────────────────────────────────────────────────────
  const backFallback = target.kind === "pane" ? panePath(paneId, scope) : spacePath(spaceId, scope);
  const parent = filesParent(at);
  const backDestination = upTarget(location.pathname, readFrom(location.state), backFallback, canStepBack());
  const back = () => (parent === null ? nav.up(backFallback) : nav.upExact(pathTo(parent)));
  const backAriaKey: MessageKey =
    parent !== null
      ? filePath !== null
        ? "files.backAria.folder"
        : "files.backAria.parent"
      : backDestination.startsWith("/pane/")
        ? "changes.backAria.pane"
        : backDestination.startsWith("/space/")
          ? "changes.backAria.workspace"
          : "changes.backAria.dashboard";

  const openEntry = (entry: FileEntry) => {
    const rel = entryPath(dir, entry);
    nav.down(
      pathTo(entry.kind === "dir" ? { dir: rel } : { path: rel }),
      entry.kind === "link" ? { viaLink: true } : undefined,
    );
  };
  // A link in a Markdown file opens another file or folder, one level down like a row does. The name
  // may be a folder written without its slash, so the read is allowed to fall back (`viaLink`).
  const fileLinks: FileLinks = {
    hrefFor: (to) => pathTo(to),
    onOpen: (to) => nav.down(pathTo(to), { viaLink: true }),
  };
  const openCrumb = (to: string) => nav.side(pathTo(to === "" ? undefined : { dir: to }));
  const pair = () => nav.down(pairedDevicesPath(scope));

  // The Source | Preview choice belongs to one file; another file starts on its own default.
  const [choice, setChoice] = useState<{ path: string; view: FileView } | null>(null);
  const view: FileView = filePath !== null && choice?.path === filePath ? choice.view : defaultView(filePath ?? "");

  // ── Body ──────────────────────────────────────────────────────────────────
  let body: React.ReactNode;
  if (state.phase === "loading") body = <Loading label={t("files.loading")} />;
  else if (state.phase === "error") {
    body = (
      <Notice variant="box" tone="danger" announce="alert">
        {t(filePath !== null ? "files.file.error" : "files.error")}
      </Notice>
    );
  } else if (state.phase === "refused") {
    body = <RefusedBody why={state.why} subject={filePath !== null ? "file" : "folder"} onPair={pair} />;
  } else if (!state.data.available) body = <Quiet>{t(unavailableKey(state.data.reason))}</Quiet>;
  else if ("entries" in state.data) {
    const data = state.data;
    body = (
      <FilesFolderBody
        entries={data.entries}
        truncated={data.truncated}
        query={filter.query}
        showIgnored={prefs.filesShowIgnored}
        onShowIgnored={setFilesShowIgnored}
        onClearQuery={filter.clear}
        onOpen={openEntry}
      />
    );
  } else body = <FileContent file={state.data} view={view} links={fileLinks} />;

  const listed = state.phase === "ready" && state.data.available && "entries" in state.data ? state.data.entries : null;
  const counted = listed === null || listed.length === 0 ? null : folderView(listed, filter.query, prefs.filesShowIgnored);

  const size = state.phase === "ready" && state.data.available && "size" in state.data ? state.data.size : null;
  const hasPreview = filePath !== null && previewKindFor(filePath) !== null;

  return (
    <div className="mx-auto flex min-h-0 w-full min-w-0 max-w-[100dvw] flex-1 flex-col md:max-w-screen-md lg:max-w-screen-lg xl:max-w-screen-xl 2xl:max-w-[1400px]">
      <div className="relative">
        <RouteHeader
          width="wide"
          override={
            <>
              <Button variant="ghost" size="icon" className="size-11 shrink-0" onClick={back} aria-label={t(backAriaKey)}>
                <ArrowLeft className="size-5" />
              </Button>
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-lg font-semibold leading-tight tracking-tight">{t("files.title")}</h1>
                <div className="flex min-w-0 items-baseline gap-1.5 text-xs leading-tight text-muted-foreground">
                  <span className="max-w-[45%] shrink-0 truncate">{workspaceLabel}</span>
                  {rootFolder.current !== null && (
                    // Cut from the LEFT: `direction: rtl` puts the ellipsis at the start, and the
                    // `bdi` keeps the slashes in reading order. The last folders always stay.
                    <span
                      className="min-w-0 flex-1 truncate font-mono [direction:rtl] text-left"
                      data-slot="files-root-folder"
                      title={rootFolder.current}
                    >
                      <bdi>{headerFolder(rootFolder.current, workspaceLabel)}</bdi>
                    </span>
                  )}
                </div>
              </div>
              {counted !== null && (
                <IgnoredToggle showIgnored={prefs.filesShowIgnored} onShowIgnored={setFilesShowIgnored} />
              )}
              {counted !== null && (
                <ChangesFilterButton
                  open={filter.open}
                  active={isNameFilterOn(filter.query)}
                  shown={counted.rows.length}
                  total={counted.pool}
                  onClick={() => filter.setOpen(!filter.open)}
                />
              )}
              <Button
                variant="ghost"
                size="icon"
                className="size-11 shrink-0"
                onClick={() => void reload()}
                aria-label={t("files.refreshAria")}
                disabled={refreshing}
              >
                <RefreshCw className={cn("size-5", refreshing && "animate-spin")} />
              </Button>
            </>
          }
        />
        {counted !== null && (
          <ChangesFilterOverlay open={filter.open} onClose={() => filter.setOpen(false)}>
            <FilesFilterBar
              query={filter.query}
              onQuery={filter.setQuery}
              showIgnored={prefs.filesShowIgnored}
              onShowIgnored={setFilesShowIgnored}
              shown={counted.rows.length}
              total={counted.pool}
              focusOnMount
            />
          </ChangesFilterOverlay>
        )}
      </div>

      <main className="relative flex min-h-0 flex-1 flex-col overflow-y-auto">
        {filePath !== null ? (
          <>
            {/* Sticky, so the reader always knows which file this is, however far down the source. */}
            <div className="sticky top-0 z-10 flex flex-col gap-2 border-b border-rule bg-background px-4 py-2">
              <div className="flex min-h-7 items-center gap-3">
                <ChangePath path={filePath} className="flex-1" />
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{size === null ? "" : formatBytes(size)}</span>
              </div>
              {hasPreview && (
                <Segmented
                  label={t("files.view.aria")}
                  value={view}
                  onChange={(next) => setChoice({ path: filePath, view: next })}
                  options={[
                    { value: "source", label: t("files.view.source") },
                    { value: "preview", label: t("files.view.preview") },
                  ]}
                />
              )}
            </div>
            <div className="flex-1 py-2">{body}</div>
          </>
        ) : (
          <div className="flex flex-col gap-3 p-4">
            <ChangesTabs active="files" onChange={(tab) => tab === "changes" && nav.side(changesTo())} />
            <FilesBreadcrumb
              dir={dir}
              rootName={folderName}
              hrefFor={(to) => pathTo(to === "" ? undefined : { dir: to })}
              onOpen={openCrumb}
            />
            {body}
          </div>
        )}
      </main>
    </div>
  );
}
