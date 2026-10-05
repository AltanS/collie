import { useCallback, useState } from "react";
import { File, Folder, Link2 } from "lucide-react";

import { ChangesNoMatch, FilterRow } from "@/components/changes-view";
import { Segmented } from "@/components/ui/segmented";
import { ListGroup } from "@/components/ui/list-group";
import { useLocale } from "@/hooks/use-locale";
import { folderView, isNameFilterOn } from "@/lib/files-filter";
import { formatBytes, joinRel } from "@/lib/files-view";
import { t, type MessageKey } from "@/lib/i18n";
import type { FileEntry, FileEntryKind } from "@/lib/types";
import { cn } from "@/lib/utils";

// The Files view's drawings (ADR 0083): the Changes | Files switch, the path's breadcrumb and one
// folder's rows. Presentational only, so the route and the playground mount the same markup. A name
// is a machine-authored identifier read character by character, so it is mono (DESIGN.md §5), and
// every string from the disk reaches the DOM as a text node.

export type ChangesTab = "changes" | "files";

/** The two-segment control at the top of the Changes screen: Changes | Files. */
export function ChangesTabs({ active, onChange }: { active: ChangesTab; onChange: (tab: ChangesTab) => void }) {
  useLocale();
  return (
    <Segmented
      semantics="tabs"
      label={t("changes.tabs.aria")}
      value={active}
      onChange={onChange}
      options={[
        { value: "changes", label: t("changes.tabs.changes") },
        { value: "files", label: t("changes.tabs.files") },
      ]}
    />
  );
}

/**
 * The folder path as links, each crumb one level up the tree: the root first, then every folder. The
 * last crumb is where the operator is, so it is text and not a link. A long path wraps rather than
 * scrolls: a phone cannot find a scroller inside a list.
 */
export function FilesBreadcrumb({
  dir,
  rootName,
  hrefFor,
  onOpen,
}: {
  dir: string;
  /** The root's own folder name, or null before the first answer names it. */
  rootName: string | null;
  /** Where a crumb goes, as an href, so a long-press or a middle-click still means something. */
  hrefFor: (dir: string) => string;
  onOpen: (dir: string) => void;
}) {
  useLocale();
  const folders = dir === "" ? [] : dir.split("/");
  const crumbs = [
    { name: rootName ?? t("files.root"), dir: "" },
    ...folders.map((name, i) => ({ name, dir: folders.slice(0, i + 1).join("/") })),
  ];
  return (
    <nav aria-label={t("files.breadcrumb.aria")} data-slot="files-breadcrumb">
      <ol className="flex flex-wrap items-center gap-x-1 font-mono text-xs leading-6 text-muted-foreground">
        {crumbs.map((crumb, i) => {
          const here = i === crumbs.length - 1;
          return (
            <li key={crumb.dir} className="flex min-w-0 items-center gap-x-1">
              {i > 0 && <span aria-hidden>/</span>}
              {here ? (
                <span aria-current="page" className="min-w-0 wrap-anywhere text-foreground">
                  {crumb.name}
                </span>
              ) : (
                <a
                  href={hrefFor(crumb.dir)}
                  onClick={(e) => {
                    // A plain tap navigates through the app's own history rules; a modified click
                    // keeps the browser's meaning.
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                    e.preventDefault();
                    onOpen(crumb.dir);
                  }}
                  className="inline-flex min-h-11 min-w-0 items-center wrap-anywhere underline underline-offset-2 active:text-foreground"
                >
                  {crumb.name}
                </a>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

const KIND_ICON = { dir: Folder, file: File, link: Link2 } satisfies Record<FileEntryKind, typeof Folder>;
const KIND_WORD = {
  dir: "files.kind.dir",
  file: "files.kind.file",
  link: "files.kind.link",
} satisfies Record<FileEntryKind, MessageKey>;

/**
 * What a row is called to a screen reader: the name, its kind and a file's size, spelled out. An
 * `aria-label` and not a hidden span, because engines disagree on the space between a name and a
 * visually hidden word beside it, and a name a test and a reader both depend on should not.
 */
function rowLabel(entry: FileEntry): string {
  const parts = [entry.name, t(KIND_WORD[entry.kind])];
  if (entry.kind === "file" && entry.size !== undefined) parts.push(formatBytes(entry.size));
  if (entry.ignored === true) parts.push(t("files.ignored.word"));
  return parts.join(", ");
}

/**
 * One folder's rows: an icon per kind, the name, and a size for files. A row git ignores (shown only
 * when the operator asked for them) is dimmed to the muted ink and still opens. A link row opens like a file;
 * the bridge decides what it points at. Every row is a 44px button; the kind and the size are said to a
 * screen reader after the name, since the icon alone is `aria-hidden`.
 */
export function FileRows({ entries, onOpen }: { entries: readonly FileEntry[]; onOpen: (entry: FileEntry) => void }) {
  useLocale();
  return (
    <ListGroup as="ul" data-slot="file-rows">
      {entries.map((entry) => {
        const Icon = KIND_ICON[entry.kind];
        return (
          <li key={entry.name}>
            <button
              type="button"
              onClick={() => onOpen(entry)}
              aria-label={rowLabel(entry)}
              className="flex min-h-11 w-full items-center gap-3 px-3.5 py-2 text-left active:bg-muted/50"
            >
              <Icon
                aria-hidden
                className={cn("size-4 shrink-0", entry.kind === "dir" && entry.ignored !== true ? "text-foreground" : "text-muted-foreground")}
              />
              <span className={cn("min-w-0 flex-1 font-mono text-sm wrap-anywhere", entry.ignored === true && "text-muted-foreground")}>
                {entry.name}
              </span>
              {entry.kind === "file" && entry.size !== undefined && (
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatBytes(entry.size)}</span>
              )}
            </button>
          </li>
        );
      })}
    </ListGroup>
  );
}

/** The root-relative path a row opens: this folder joined with the row's name. */
export function entryPath(dir: string, entry: FileEntry): string {
  return joinRel(dir, entry.name);
}

// ── The filter (ADR 0083) ───────────────────────────────────────────────────────────────────────
// Files gets the filter control Changes has, drawn by the same `FilterRow`: a name field, one chip,
// and the "3 of 12" count. The name filter belongs to one folder and resets when the folder changes;
// the Ignored chip is the device's `filesShowIgnored` pref and outlives it.

/** The name filter and whether its overlay is open, both keyed to one folder or file. */
export function useFilesFilter(folderKey: string) {
  const [state, setState] = useState({ key: folderKey, query: "", open: false });
  // Another folder is a fresh filter, closed and blank, without an effect that flashes the old one.
  const mine = state.key === folderKey ? state : { key: folderKey, query: "", open: false };
  const patch = useCallback(
    (change: { query?: string; open?: boolean }) =>
      setState((prev) => ({ ...(prev.key === folderKey ? prev : { key: folderKey, query: "", open: false }), ...change })),
    [folderKey],
  );
  const setQuery = useCallback((query: string) => patch({ query }), [patch]);
  const setOpen = useCallback((open: boolean) => patch({ open }), [patch]);
  const clear = useCallback(() => patch({ query: "" }), [patch]);
  return { query: mine.query, open: mine.open, setQuery, setOpen, clear };
}

/** The row inside the overlay: the name field, the Ignored chip, and the count with its Clear. */
export function FilesFilterBar({
  query,
  onQuery,
  showIgnored,
  onShowIgnored,
  shown,
  total,
  focusOnMount = false,
}: {
  query: string;
  onQuery: (query: string) => void;
  showIgnored: boolean;
  onShowIgnored: (show: boolean) => void;
  shown: number;
  total: number;
  focusOnMount?: boolean;
}) {
  useLocale();
  return (
    <FilterRow
      slot="files-filter"
      query={query}
      onQuery={onQuery}
      placeholder={t("files.filter.placeholder")}
      active={isNameFilterOn(query)}
      count={t("files.filter.shown", { shown, total })}
      // Clear resets the name only: the Ignored choice is the device's, not this folder's.
      onClear={() => onQuery("")}
      focusOnMount={focusOnMount}
      chips={
        <div role="group" aria-label={t("files.filter.ignoredAria")} className="-ml-1.5 flex">
          <button
            type="button"
            aria-pressed={showIgnored}
            onClick={() => onShowIgnored(!showIgnored)}
            className="flex h-11 min-w-11 items-center justify-center px-1.5"
          >
            <span
              className={cn(
                "flex h-8 items-center rounded-full border px-3 text-xs font-medium transition-colors",
                showIgnored ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground",
              )}
            >
              {t("files.filter.ignored")}
            </span>
          </button>
        </div>
      }
    />
  );
}

/**
 * One folder's body: the rows the filter leaves, the quiet "{count} ignored hidden" line with its
 * Show action, and the sentence and way out when nothing is left. A folder that is empty on disk
 * says so; a folder whose every entry is ignored says that instead.
 */
export function FilesFolderBody({
  entries,
  truncated,
  query,
  showIgnored,
  onShowIgnored,
  onClearQuery,
  onOpen,
}: {
  entries: readonly FileEntry[];
  truncated: boolean;
  query: string;
  showIgnored: boolean;
  onShowIgnored: (show: boolean) => void;
  onClearQuery: () => void;
  onOpen: (entry: FileEntry) => void;
}) {
  useLocale();
  if (entries.length === 0) {
    return <p className="px-2 py-16 text-center text-sm leading-relaxed text-muted-foreground">{t("files.empty")}</p>;
  }
  const view = folderView(entries, query, showIgnored);
  return (
    <>
      {view.rows.length > 0 ? (
        <FileRows entries={view.rows} onOpen={onOpen} />
      ) : isNameFilterOn(query) ? (
        <ChangesNoMatch onClear={onClearQuery} />
      ) : (
        <p className="px-2 py-12 text-center text-sm leading-relaxed text-muted-foreground">{t("files.ignored.allHidden")}</p>
      )}
      {view.hiddenIgnored > 0 && (
        <div data-slot="files-ignored-hidden" className="flex items-center justify-between gap-2 pt-1 text-xs text-muted-foreground">
          <span>{t("files.ignored.hidden", { count: view.hiddenIgnored })}</span>
          <button
            type="button"
            aria-label={t("files.ignored.showAria")}
            onClick={() => onShowIgnored(true)}
            className="flex min-h-11 items-center rounded-md px-3 text-sm font-medium text-primary active:bg-muted"
          >
            {t("files.ignored.show")}
          </button>
        </div>
      )}
      {truncated && <p className="pt-3 text-xs text-muted-foreground">{t("files.truncated")}</p>}
    </>
  );
}
