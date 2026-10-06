import { useCallback, useState } from "react";
import { Eye, EyeOff, File, FileInput, FileMinus, FilePen, FilePlus, Folder, FolderPlus, Link2 } from "lucide-react";

import { ChangesNoMatch, FilterRow, STATUS_FILL, STATUS_WORD, TREE_TONE } from "@/components/changes-view";
import { ListGroup } from "@/components/ui/list-group";
import { Segmented } from "@/components/ui/segmented";
import { ToggleButton } from "@/components/ui/toggle-button";
import { useLocale } from "@/hooks/use-locale";
import { folderView, isNameFilterOn } from "@/lib/files-filter";
import type { EntryMark } from "@/lib/files-marks";
import { formatBytes, joinRel } from "@/lib/files-view";
import { t, tn, type MessageKey } from "@/lib/i18n";
import type { ChangeStatus, FileEntry, FileEntryKind } from "@/lib/types";
import type { WorkspaceChangeCount } from "@/lib/workspace-changes";
import { cn } from "@/lib/utils";

// The Changes screen's folder tree, drawn (ADR 0083): the path's breadcrumb, one folder's rows with
// their change marks, and the mode control that swaps the tree for the list of changes.
// Presentational only, so the route and the playground mount the same markup. A name is a
// machine-authored identifier read character by character, so it is mono (DESIGN.md §5), and every
// string from the disk reaches the DOM as a text node.

/**
 * The Files screen's two-segment control, directly under the header: "All files" or "Changes". It is
 * the file screen's own `Diff | Source | Preview` control (`ui/segmented.tsx`), so the two read as
 * one family, and it writes the device's `changesOnly` pref: "Changes" shows the changed files alone
 * (the flat list or its tree), "All files" the folder with each change marked on its row. The number
 * of changed files rides the Changes segment as the small amber badge the old icon toggle drew, and
 * is said in the segment's name too.
 */
export function FilesModeControl({
  changesOnly,
  count,
  onChange,
}: {
  changesOnly: boolean;
  count: number;
  /** `true` for the Changes segment, the value the `changesOnly` pref holds. */
  onChange: (changesOnly: boolean) => void;
}) {
  useLocale();
  return (
    <div data-slot="files-mode" className="shrink-0 border-b px-4 py-3">
      <Segmented
        label={t("files.mode.aria")}
        value={changesOnly ? "changes" : "all"}
        onChange={(mode) => onChange(mode === "changes")}
        badgeClassName={cn(STATUS_FILL.M, "text-background")}
        options={[
          { value: "all", label: t("files.mode.all") },
          { value: "changes", label: t("files.mode.changes"), badge: count, badgeLabel: tn("files.changed", count) },
        ]}
      />
    </div>
  );
}

/**
 * The line at the head of the Changes list: the root folder's name at the left, as the tree's
 * breadcrumb names it, and the workspace's totals `+12 −4` at the right in the diff's own inks. The
 * totals once stood on the header's second line; they moved here with the mode control (2026-10-06).
 * One line tall in every state, so the numbers arriving move nothing, and they show only once a
 * read has said there is something changed.
 */
export function ChangesListHead({ root, count }: { root: string; count: WorkspaceChangeCount }) {
  return (
    <div className="flex min-h-6 items-baseline justify-between gap-3 font-mono text-xs leading-6 text-muted-foreground" data-slot="changes-head">
      <span className="min-w-0 wrap-anywhere text-foreground">{root}</span>
      {count.kind === "changed" && (
        <span data-slot="changes-totals" className="shrink-0 tabular-nums">
          <span className="text-status-done">+{count.added}</span> <span className="text-status-blocked">−{count.removed}</span>
        </span>
      )}
    </div>
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
 * What a row is called to a screen reader: the name, its kind and a file's size, then its change,
 * spelled out. An `aria-label` and not a hidden span, because engines disagree on the space between
 * a name and a visually hidden word beside it, and a name a test and a reader both depend on should
 * not.
 */
function rowLabel(entry: FileEntry, mark: EntryMark | undefined): string {
  const parts = [entry.name, t(KIND_WORD[entry.kind])];
  if (entry.kind === "file" && entry.size !== undefined) parts.push(formatBytes(entry.size));
  if (mark?.kind === "change") parts.push(t(STATUS_WORD[mark.status]));
  if (mark?.kind === "folder") parts.push(tn("files.changed", mark.mark.count));
  if (entry.ignored === true) parts.push(t("files.ignored.word"));
  return parts.join(", ");
}

/**
 * The slot at a row's end: a changed row's status letter, in the Changes list's colour, or a folder's
 * dot and the count of changed files below it. Every row of a marked folder reserves the letter's
 * width, so a mark that arrives on a re-read moves no size and no name (DESIGN.md §2).
 */
// A changed row's icon SWITCHES as well as taking the status ink, so a change reads by shape too,
// in the dim light of a phone and for an eye that does not tell the inks apart: a pen for modified,
// a plus for new (added or untracked), a minus for deleted, an arrow in for renamed. A new folder
// git lists whole is a folder with a plus. A link keeps its own glyph.
const CHANGED_FILE_ICON = {
  M: FilePen,
  A: FilePlus,
  "?": FilePlus,
  D: FileMinus,
  R: FileInput,
} satisfies Record<ChangeStatus, typeof File>;

function changedIcon(kind: FileEntryKind, status: ChangeStatus): typeof File {
  if (kind === "dir") return status === "?" || status === "A" ? FolderPlus : Folder;
  if (kind === "link") return Link2;
  return CHANGED_FILE_ICON[status];
}

function MarkSlot({ mark }: { mark: EntryMark | undefined }) {
  if (mark?.kind === "change") {
    return (
      <span aria-hidden className={cn("w-3 shrink-0 text-center font-mono text-xs font-semibold", TREE_TONE[mark.status])}>
        {mark.status === "?" ? "U" : mark.status}
      </span>
    );
  }
  if (mark?.kind === "folder") {
    return (
      <span aria-hidden data-slot="folder-mark" className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground tabular-nums">
        <span className={cn("size-1.5 rounded-full", STATUS_FILL[mark.mark.status])} />
        {mark.mark.count}
      </span>
    );
  }
  return <span aria-hidden className="w-3 shrink-0" />;
}

/**
 * One folder's rows: an icon per kind, the name, and a size for files. A row git ignores (shown only
 * when the operator asked for them) is dimmed to the muted ink and still opens. A link row opens like a file;
 * the bridge decides what it points at. Every row is a 44px button; the kind and the size are said to a
 * screen reader after the name, since the icon alone is `aria-hidden`.
 *
 * With `marks` (the Changes screen's tree), a changed row carries its status letter, and its icon
 * switches to the status's shape (`changedIcon`) in the same ink as the letter, a folder with changes below it carries a dot and their count, and a deleted file,
 * which only the change set still names, is struck through.
 */
export function FileRows({
  entries,
  marks,
  onOpen,
}: {
  entries: readonly FileEntry[];
  marks?: ReadonlyMap<string, EntryMark>;
  onOpen: (entry: FileEntry) => void;
}) {
  useLocale();
  return (
    <ListGroup as="ul" data-slot="file-rows">
      {entries.map((entry) => {
        const mark = marks?.get(entry.name);
        const Icon = mark?.kind === "change" ? changedIcon(entry.kind, mark.status) : KIND_ICON[entry.kind];
        const tone = mark?.kind === "change" ? TREE_TONE[mark.status] : undefined;
        const deleted = mark?.kind === "change" && mark.deleted === true;
        return (
          <li key={entry.name}>
            <button
              type="button"
              onClick={() => onOpen(entry)}
              aria-label={rowLabel(entry, mark)}
              className="flex min-h-11 w-full items-center gap-3 px-3.5 py-2 text-left active:bg-muted/50"
            >
              <Icon
                aria-hidden
                className={cn(
                  "size-4 shrink-0",
                  tone ?? (entry.kind === "dir" && entry.ignored !== true ? "text-foreground" : "text-muted-foreground"),
                )}
              />
              <span
                className={cn(
                  "min-w-0 flex-1 font-mono text-sm wrap-anywhere",
                  (entry.ignored === true || deleted) && "text-muted-foreground",
                  deleted && "line-through",
                )}
              >
                {entry.name}
              </span>
              {entry.kind === "file" && entry.size !== undefined && (
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatBytes(entry.size)}</span>
              )}
              {marks !== undefined && <MarkSlot mark={mark} />}
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
// Files gets the filter control Changes has, drawn by the same `FilterRow`: a name field, the Ignored
// toggle, and the "3 of 12" count. The name filter belongs to one folder and resets when the folder
// changes; the Ignored toggle is the device's `filesShowIgnored` pref and outlives it.

/**
 * The Ignored toggle: whether entries git ignores are listed. It is a setting, so it is drawn as an
 * icon toggle button (`ui/toggle-button.tsx`, the look of the dashboard's "needs you" switch) and not
 * as a chip, and it says its own state: `EyeOff` and "Ignored hidden" when off, `Eye` and "Ignored
 * shown" when on. `labelled` adds that word beside the glyph, for the filter row; the icon alone
 * stood in the header until 2026-10-06, when the footer line's Show and Hide took over as the
 * screen's switch. Every form writes the same pref.
 */
export function IgnoredToggle({
  showIgnored,
  onShowIgnored,
  labelled = false,
}: {
  showIgnored: boolean;
  onShowIgnored: (show: boolean) => void;
  labelled?: boolean;
}) {
  useLocale();
  const state = t(showIgnored ? "files.ignored.stateShown" : "files.ignored.stateHidden");
  const Icon = showIgnored ? Eye : EyeOff;
  return (
    <ToggleButton
      pressed={showIgnored}
      onPressedChange={onShowIgnored}
      label={t("files.ignored.toggleAria")}
      icon={<Icon className={labelled ? "size-4" : "size-5"} />}
      text={labelled ? state : undefined}
      title={labelled ? undefined : state}
    />
  );
}

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

/** The row inside the overlay: the name field, the Ignored toggle, and the count with its Clear. */
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
      chips={<IgnoredToggle showIgnored={showIgnored} onShowIgnored={onShowIgnored} labelled />}
    />
  );
}

/**
 * The quiet line under a folder's rows that says how many ignored entries are hidden or shown, with
 * the one action that flips it. With the header's eye button gone (2026-10-06), this line is the
 * Files screen's switch for ignored entries, so each state offers the other.
 */
function IgnoredFooter({
  label,
  action,
  actionAria,
  onAction,
}: {
  label: string;
  action: string;
  actionAria: string;
  onAction: () => void;
}) {
  return (
    <div data-slot="files-ignored-hidden" className="flex items-center justify-between gap-2 pt-1 text-xs text-muted-foreground">
      <span>{label}</span>
      <button
        type="button"
        aria-label={actionAria}
        onClick={onAction}
        className="flex min-h-11 items-center rounded-md px-3 text-sm font-medium text-primary active:bg-muted"
      >
        {action}
      </button>
    </div>
  );
}

/**
 * One folder's body: the rows the filter leaves, the quiet "{count} ignored hidden" line with its
 * Show action, and the sentence and way out when nothing is left. A folder that is empty on disk
 * says so; a folder whose every entry is ignored says that instead.
 */
export function FilesFolderBody({
  entries,
  marks,
  truncated,
  query,
  showIgnored,
  onShowIgnored,
  onClearQuery,
  onOpen,
}: {
  entries: readonly FileEntry[];
  /** The change marks of these rows, on the Changes screen's tree. */
  marks?: ReadonlyMap<string, EntryMark>;
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
  // Ignored rows on screen, so the footer can say so and offer the way back.
  const ignoredShown = showIgnored ? view.rows.filter((e) => e.ignored === true).length : 0;
  return (
    <>
      {view.rows.length > 0 ? (
        <FileRows entries={view.rows} marks={marks} onOpen={onOpen} />
      ) : isNameFilterOn(query) ? (
        <ChangesNoMatch onClear={onClearQuery} />
      ) : (
        <p className="px-2 py-12 text-center text-sm leading-relaxed text-muted-foreground">{t("files.ignored.allHidden")}</p>
      )}
      {view.hiddenIgnored > 0 && (
        <IgnoredFooter
          label={t("files.ignored.hidden", { count: view.hiddenIgnored })}
          action={t("files.ignored.show")}
          actionAria={t("files.ignored.showAria")}
          onAction={() => onShowIgnored(true)}
        />
      )}
      {ignoredShown > 0 && (
        <IgnoredFooter
          label={t("files.ignored.shown", { count: ignoredShown })}
          action={t("files.ignored.hide")}
          actionAria={t("files.ignored.hideAria")}
          onAction={() => onShowIgnored(false)}
        />
      )}
      {truncated && <p className="pt-3 text-xs text-muted-foreground">{t("files.truncated")}</p>}
    </>
  );
}
