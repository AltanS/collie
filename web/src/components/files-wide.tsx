import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { Icon } from "@/components/icons/icon";
import type { IconKey } from "@/components/icons/keys";
import { STATUS_FILL, TREE_TONE } from "@/components/changes-view";
import { Button, FOCUS_RING_INSET, HOVER_FILL } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { NAV_EDGE } from "@/components/ui/nav-edge";
import { NAV_ROW_HEIGHT } from "@/components/ui/nav-row";
import { useLocale } from "@/hooks/use-locale";
import type { FilesAnswer } from "@/lib/api";
import type { DiffLayout } from "@/lib/diff-layout";
import { isAbortError } from "@/lib/loaders";
import { folderView } from "@/lib/files-filter";
import { markFolder, type ChangeIndex, type EntryMark } from "@/lib/files-marks";
import { formatBytes, joinRel } from "@/lib/files-view";
import { t, tn } from "@/lib/i18n";
import type { ChangeStatus, FileEntry, FileEntryKind } from "@/lib/types";
import type { WorkspaceChangeCount } from "@/lib/workspace-changes";
import type { FilesReadState, TreeRead } from "@/routes/changes-files";
import { cn } from "@/lib/utils";

// FILES AND CHANGES ON A LARGE SCREEN (ADR 0173). The parts the Changes screen
// draws only in the `expanded` width class: the two columns (the tree or the list of changes at the left on the
// navigation's recess, the chosen file at the right on the page), the folder reads the left column needs, the tree that
// opens folders in place, and the calm right column while nothing is chosen. The screen's state stays in `ChangesScreen`:
// these parts are drawn by it and own no route state.

/** The folder a root-relative path sits in: "" for a name at the root. */
function parentDir(path: string): string {
  const at = path.lastIndexOf("/");
  return at === -1 ? "" : path.slice(0, at);
}

/** Every folder above `path`, from the root down, the root ("") first. */
export function foldersAbove(path: string): string[] {
  const out = [""];
  const parts = path.split("/").filter((p) => p !== "");
  for (let i = 1; i < parts.length; i += 1) out.push(parts.slice(0, i).join("/"));
  return out;
}

const NO_READS: ReadonlyMap<string, FilesReadState<TreeRead>> = new Map();

/**
 * Several folders of the root read at once, each once, keyed by `base` (the machine, the target): a new base starts
 * clean. A folder asked for again keeps its answer; `reload` asks every folder held again without clearing it.
 */
export function useFolderReads(
  base: string | null,
  dirs: readonly string[],
  load: (dir: string, signal: AbortSignal) => Promise<FilesAnswer<TreeRead>>,
) {
  const [held, setHeld] = useState<{ base: string | null; reads: ReadonlyMap<string, FilesReadState<TreeRead>> }>({ base, reads: new Map() });
  const loadRef = useRef(load);
  loadRef.current = load;
  const flying = useRef(new Map<string, AbortController>());
  const reads = held.base === base ? held.reads : NO_READS;

  const run = useCallback(
    async (forBase: string, dir: string, quiet: boolean) => {
      const key = `${forBase}\n${dir}`;
      flying.current.get(key)?.abort();
      const ctl = new AbortController();
      flying.current.set(key, ctl);
      const put = (state: FilesReadState<TreeRead>) =>
        setHeld((prev) => {
          const map = new Map(prev.base === forBase ? prev.reads : []);
          map.set(dir, state);
          return { base: forBase, reads: map };
        });
      if (!quiet) put({ key: dir, phase: "loading" });
      try {
        const answer = await loadRef.current(dir, ctl.signal);
        if (ctl.signal.aborted) return;
        put(answer.outcome === "body" ? { key: dir, phase: "ready", data: answer.body } : { key: dir, phase: "refused", why: answer.outcome });
      } catch (e) {
        if (isAbortError(e) || ctl.signal.aborted) return;
        put({ key: dir, phase: "error" });
      } finally {
        if (flying.current.get(key) === ctl) flying.current.delete(key);
      }
    },
    [],
  );

  // What is held already, read through a ref: a new answer must not start another read.
  const readsNow = useRef(reads);
  readsNow.current = reads;
  const wanted = dirs.join("\n");
  useEffect(() => {
    if (base === null) return;
    for (const dir of wanted.split("\n")) {
      if (readsNow.current.has(dir) || flying.current.has(`${base}\n${dir}`)) continue;
      void run(base, dir, false);
    }
  }, [base, wanted, run]);

  useEffect(
    () => () => {
      for (const ctl of flying.current.values()) ctl.abort();
      flying.current.clear();
    },
    [base],
  );

  const reload = useCallback(async () => {
    if (base === null) return;
    await Promise.all([...reads.keys()].map((dir) => run(base, dir, true)));
  }, [base, reads, run]);

  return { reads, reload };
}

const KIND_ICON = { dir: "folder", file: "file", link: "link" } satisfies Record<FileEntryKind, IconKey>;
const CHANGED_ICON = { M: "file-modified", A: "file-added", "?": "file-added", D: "file-deleted", R: "file-renamed" } satisfies Record<ChangeStatus, IconKey>;

function iconOf(entry: FileEntry, mark: EntryMark | undefined): IconKey {
  if (mark?.kind !== "change") return KIND_ICON[entry.kind];
  if (entry.kind === "dir") return mark.status === "?" || mark.status === "A" ? "folder-added" : "folder";
  if (entry.kind === "link") return "link";
  return CHANGED_ICON[mark.status];
}

/** One drawn row of the tree: an entry of a read folder, a folder still loading, or a folder that could not be read. */
type ExplorerRow =
  | { kind: "entry"; path: string; depth: number; entry: FileEntry; mark: EntryMark | undefined; open: boolean }
  | { kind: "loading" | "failed"; path: string; depth: number };

/** The tree as drawn, and the counts its filter says: files shown, and files before the name filter. */
export interface ExplorerView {
  rows: ExplorerRow[];
  shown: number;
  pool: number;
}

/** The rows of the tree as drawn: each open folder's rows under it, in the bridge's order, filtered like one folder is. */
export function explorerRows(args: {
  reads: ReadonlyMap<string, FilesReadState<TreeRead>>;
  expanded: ReadonlySet<string>;
  index: ChangeIndex;
  query: string;
  showIgnored: boolean;
}): ExplorerView {
  const rows: ExplorerRow[] = [];
  let shown = 0;
  let pool = 0;
  const walk = (dir: string, depth: number) => {
    const read = args.reads.get(dir);
    if (read === undefined || read.phase === "loading") {
      rows.push({ kind: "loading", path: dir, depth });
      return;
    }
    if (read.phase !== "ready" || !read.data.available || !("entries" in read.data)) {
      rows.push({ kind: "failed", path: dir, depth });
      return;
    }
    const marked = markFolder(read.data.entries, dir, args.index);
    // A folder stays drawn while the name filter is on, so what matches inside an open one can show.
    const view = folderView(marked.entries, args.query, args.showIgnored);
    const keep = new Set(view.rows.map((e) => e.name));
    const files = folderView(marked.entries, "", args.showIgnored).rows.filter((e) => e.kind !== "dir");
    pool += files.length;
    for (const entry of folderView(marked.entries, "", args.showIgnored).rows) {
      if (entry.kind !== "dir" && !keep.has(entry.name)) continue;
      const path = joinRel(dir, entry.name);
      const open = entry.kind === "dir" && args.expanded.has(path);
      rows.push({ kind: "entry", path, depth, entry, mark: marked.marks.get(entry.name), open });
      if (entry.kind !== "dir") shown += 1;
      if (open) walk(path, depth + 1);
    }
  };
  walk("", 0);
  return { rows, shown, pool };
}

/** The mark at a row's end: a changed row's letter in its ink, or a folder's dot and the count of changes below it. */
function ExplorerMark({ mark }: { mark: EntryMark | undefined }) {
  if (mark?.kind === "change") {
    return (
      <span aria-hidden className={cn("w-3 shrink-0 text-center font-mono text-xs font-semibold", TREE_TONE[mark.status])}>
        {mark.status === "?" ? "U" : mark.status}
      </span>
    );
  }
  if (mark?.kind === "folder") {
    return (
      <span aria-hidden className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground tabular-nums">
        <span className={cn("size-1.5 rounded-full", STATUS_FILL[mark.mark.status])} />
        {mark.mark.count}
      </span>
    );
  }
  return <span aria-hidden className="w-3 shrink-0" />;
}

/** The step a level of the tree indents, in px. */
const INDENT_PX = 14;

/**
 * The root's folders as a tree that opens in place: a folder row opens and closes its rows under it,
 * a file row opens the file in the right column. The arrows walk the rows (Up, Down, Home, End), Right opens a folder and
 * Left closes it or steps to its parent; one tab stop for the whole tree, on the chosen row.
 */
export function FilesExplorer({
  rows,
  current,
  rootName,
  onToggle,
  onOpen,
}: {
  rows: readonly ExplorerRow[];
  /** The open file's path, or the folder the address names. */
  current: string | null;
  rootName: string | null;
  onToggle: (dir: string) => void;
  onOpen: (path: string, entry: FileEntry) => void;
}) {
  useLocale();
  const listRef = useRef<HTMLUListElement>(null);
  const [stop, setStop] = useState<string | null>(current);
  useEffect(() => setStop(current), [current]);
  const stopPath = rows.some((r) => r.kind === "entry" && r.path === stop) ? stop : (rows.find((r) => r.kind === "entry")?.path ?? null);

  // The chosen row stays in view when the address names it (a deep link, Back).
  useEffect(() => {
    if (current === null) return;
    listRef.current?.querySelector<HTMLElement>(`[data-tree-path="${CSS.escape(current)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, row: Extract<ExplorerRow, { kind: "entry" }>) => {
    const items = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-tree-path]") ?? [])];
    const at = items.findIndex((item) => item === document.activeElement);
    const last = items.length - 1;
    let next: number | null = null;
    if (event.key === "ArrowDown") next = Math.min(at + 1, last);
    else if (event.key === "ArrowUp") next = Math.max(at - 1, 0);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    else if (event.key === "ArrowRight" && row.entry.kind === "dir") {
      if (!row.open) onToggle(row.path);
      else next = Math.min(at + 1, last);
    } else if (event.key === "ArrowLeft") {
      if (row.open) onToggle(row.path);
      else {
        const parent = parentDir(row.path);
        const up = parent === "" ? -1 : items.findIndex((item) => item.dataset.treePath === parent);
        if (up >= 0) next = up;
      }
    } else return;
    event.preventDefault();
    if (next !== null && at !== -1) items[next]?.focus();
  };

  return (
    <div data-slot="files-explorer" className="flex flex-col">
      {rootName !== null && (
        <p className="truncate px-2 pb-1 font-mono text-xs leading-6 text-muted-foreground" title={rootName}>
          {rootName}
        </p>
      )}
      <ul ref={listRef} role="tree" aria-label={t("files.title")} className="flex flex-col">
        {rows.map((row) => {
          const pad = { paddingLeft: 8 + row.depth * INDENT_PX };
          if (row.kind !== "entry") {
            return (
              <li key={`${row.kind}:${row.path}`} role="none" style={pad} className={cn("flex items-center gap-2 text-xs text-muted-foreground", NAV_ROW_HEIGHT)}>
                {row.kind === "loading" ? <Icon name="busy" className="size-3.5 animate-spin" /> : t("files.error")}
              </li>
            );
          }
          const { entry, mark } = row;
          const here = row.path === current;
          const tone = mark?.kind === "change" ? TREE_TONE[mark.status] : undefined;
          const deleted = mark?.kind === "change" && mark.deleted === true;
          const dir = entry.kind === "dir";
          return (
            <li key={row.path} role="none">
              <button
                type="button"
                role="treeitem"
                aria-level={row.depth + 1}
                aria-expanded={dir ? row.open : undefined}
                aria-current={here ? "page" : undefined}
                aria-selected={here}
                data-tree-path={row.path}
                tabIndex={row.path === stopPath ? 0 : -1}
                onFocus={() => setStop(row.path)}
                onKeyDown={(e) => onKeyDown(e, row)}
                onClick={() => (dir ? onToggle(row.path) : onOpen(row.path, entry))}
                style={pad}
                className={cn(
                  "flex w-full min-w-0 items-center gap-2 rounded-md pr-2 text-left transition-colors",
                  NAV_ROW_HEIGHT,
                  FOCUS_RING_INSET,
                  here ? "bg-accent text-accent-foreground" : HOVER_FILL,
                )}
              >
                <Icon
                  name="disclosure"
                  aria-hidden
                  className={cn("size-3 shrink-0 text-muted-foreground transition-transform", !dir && "invisible", row.open && "rotate-90")}
                />
                <Icon
                  name={iconOf(entry, mark)}
                  aria-hidden
                  className={cn("size-4 shrink-0", tone ?? (dir && entry.ignored !== true ? "text-foreground" : "text-muted-foreground"))}
                />
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate font-mono text-[13px]",
                    (entry.ignored === true || deleted) && "text-muted-foreground",
                    deleted && "line-through",
                  )}
                  title={entry.name}
                >
                  {entry.name}
                </span>
                {entry.kind === "file" && entry.size !== undefined && (
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatBytes(entry.size)}</span>
                )}
                <ExplorerMark mark={mark} />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * The two columns under the one header: the left column on the navigation's recess with its own scroll and the faint
 * edge of the sidebar, the right on the page. `leftTop` stands above the left column's scroll (the mode control).
 */
export function FilesColumns({
  leftWidth,
  leftTop,
  left,
  leftRef,
  right,
  rightRef,
}: {
  leftWidth: number;
  leftTop?: ReactNode;
  left: ReactNode;
  leftRef?: React.Ref<HTMLElement>;
  right: ReactNode;
  rightRef?: React.Ref<HTMLElement>;
}) {
  return (
    <div data-slot="files-wide" className="flex min-h-0 flex-1">
      <aside
        data-slot="files-left"
        className={cn("relative flex min-h-0 shrink-0 flex-col border-r bg-surface-recess [--accent:var(--surface-paper)]", NAV_EDGE)}
        style={{ width: leftWidth }}
      >
        {leftTop}
        <nav ref={leftRef} aria-label={t("files.title")} className="relative min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {left}
        </nav>
      </aside>
      <main ref={rightRef} data-slot="files-right" className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-background">
        {right}
      </main>
    </div>
  );
}

/**
 * The right column while no file is chosen: the files glyph, the folder's name, the count of changed files when there
 * are any, and the one sentence that says what the column is for.
 */
export function FilesNothingChosen({ name, count }: { name: string; count: WorkspaceChangeCount }) {
  useLocale();
  return (
    <div data-slot="files-nothing-chosen" className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-muted-foreground">
      <Icon name="files" className="size-8" aria-hidden />
      <p className="max-w-full truncate font-mono text-sm">{name}</p>
      <p className="h-4 text-xs leading-4 tabular-nums">
        {count.kind === "changed" && (
          <>
            {tn("files.changed", count.files)} <span className="text-status-done">+{count.added}</span>{" "}
            <span className="text-status-blocked">−{count.removed}</span>
          </>
        )}
      </p>
      <p className="pt-2 text-sm">{t("files.nothingChosen")}</p>
    </div>
  );
}

/**
 * One column or side by side, in the file's header row: the compact segmented control with two glyphs, named in words.
 * Disabled for a new or a deleted file, whose diff has one side only and stays in one column.
 */
export function DiffLayoutControl({ value, onChange, disabled }: { value: DiffLayout; onChange: (layout: DiffLayout) => void; disabled: boolean }) {
  useLocale();
  return (
    <Segmented<DiffLayout>
      label={t("files.view.aria")}
      value={value}
      onChange={onChange}
      disabled={disabled}
      compact
      className="shrink-0 [&>button]:w-9 [&>button]:flex-none"
      options={[
        { value: "unified", label: t("changes.diffLayout.unified"), icon: <Icon name="diff-unified" /> },
        { value: "split", label: t("changes.diffLayout.split"), icon: <Icon name="diff-split" /> },
      ]}
    />
  );
}

/** A step that has nowhere to go: no box, muted ink, its 1px border kept so the pair never moves (as in the foot bar). */
const STEP_OFF = "disabled:border-transparent disabled:bg-transparent disabled:shadow-none disabled:text-muted-foreground disabled:opacity-40";

/** Previous file and Next file in the file's header row on a large screen: two small buttons, the foot bar's names and its disabled rule. */
export function FileSteps({ onPrev, onNext }: { onPrev: (() => void) | undefined; onNext: (() => void) | undefined }) {
  useLocale();
  return (
    <div className="flex shrink-0 items-center gap-1" data-slot="file-steps">
      <Button variant="outline" size="icon" className={cn("size-9", STEP_OFF)} disabled={onPrev === undefined} onClick={onPrev} aria-label={t("changes.file.prev")} title={t("changes.file.prev")}>
        <Icon name="file-prev" className="size-4" />
      </Button>
      <Button variant="outline" size="icon" className={cn("size-9", STEP_OFF)} disabled={onNext === undefined} onClick={onNext} aria-label={t("changes.file.next")} title={t("changes.file.next")}>
        <Icon name="file-next" className="size-4" />
      </Button>
    </div>
  );
}
