// The Changes screen's folder tree, drawn (ADR 0083): the mode control, the head of the Changes list,
// the path's breadcrumb, one folder's rows with their change marks, and what stands in for a folder
// or a file the bridge refused. Port of web/src/components/files-view.tsx and the drawing half of
// web/src/routes/changes-files.tsx. Stateless functions; the route owns every state.
//
// A name is a machine-authored identifier read character by character, so it is mono (DESIGN.md §5),
// and every string from the disk reaches the DOM as a text node.
import { on } from "remix/component";
import type { RemixNode } from "remix/component";
import { Eye, EyeOff, File, FileInput, FileMinus, FilePen, FilePlus, Folder, FolderPlus, Link2, LoaderCircle } from "lucide";
import type { IconNode } from "lucide";

import { unavailableKey } from "@web/lib/changes-reason";
import { folderView, isNameFilterOn } from "@web/lib/files-filter";
import type { EntryMark, MarkedFolder } from "@web/lib/files-marks";
import { formatBytes, joinRel } from "@web/lib/files-view";
import { t, tn, type MessageKey } from "@web/lib/i18n";
import type { ChangeStatus, ChangesUnavailableReason, FileEntry, FileEntryKind, FileReadResponse, FilesListResponse } from "@web/lib/types";
import type { WorkspaceChangeCount } from "@web/lib/workspace-changes";
import { cn } from "@web/lib/utils";

import { Button } from "../../ui/button";
import { Icon } from "../../ui/icon";
import { ListGroup } from "../../ui/list-group";
import { Notice } from "../../ui/notice";
import { Segmented } from "../../ui/segmented";
import type { Refusal } from "./api";
import { changesNoMatch, filterRow, STATUS_FILL, STATUS_TONE, STATUS_WORD } from "./parts";

/** A folder listing or a file read, as the tree asks for them. */
export type TreeRead = FilesListResponse | FileReadResponse;

/** What one folder or file read holds now. A different key is a fresh read (the screen is loading). */
export type FilesReadState =
  | { key: string; phase: "loading" }
  | { key: string; phase: "error" }
  | { key: string; phase: "refused"; why: Refusal }
  | { key: string; phase: "ready"; data: TreeRead };

/**
 * The Files screen's two-segment control, directly under the header: "All files" or "Changes". It
 * writes the device's `changesOnly` pref: "Changes" shows the changed files alone (the flat list or
 * its tree), "All files" the folder with each change marked on its row. The number of changed files
 * rides the Changes segment as a small amber badge and is said in the segment's name too.
 */
export function filesModeControl(changesOnly: boolean, count: number, onChange: (changesOnly: boolean) => void): RemixNode {
  return (
    <div data-slot="files-mode" class="shrink-0 border-b px-4 py-3">
      <Segmented
        label={t("files.mode.aria")}
        value={changesOnly ? "changes" : "all"}
        onChange={(mode) => onChange(mode === "changes")}
        badgeClass={cn(STATUS_FILL.M, "text-background")}
        options={[
          { value: "all", label: t("files.mode.all") },
          { value: "changes", label: t("files.mode.changes"), badge: count, badgeLabel: tn("files.changed", count) },
        ]}
      />
    </div>
  );
}

/**
 * The line at the head of the Changes list: the changed-file count at the left, the workspace's
 * totals `+12 −4` at the right in the diff's inks. One line tall in every state, so numbers arriving
 * move nothing; while the first read is out it shows two bars in the same box (a skeleton).
 */
export function changesListHead(count: WorkspaceChangeCount): RemixNode {
  const loading = count.kind === "loading";
  return (
    <div class="flex min-h-6 items-baseline justify-between gap-3 font-mono text-xs leading-6 text-muted-foreground" data-slot="changes-head">
      <span data-slot="changes-files" class="min-w-0">
        {count.kind === "changed" ? tn("files.changed", count.files) : null}
        {loading ? <span aria-hidden="true" class="count-skeleton inline-block h-2.5 w-16 rounded-full bg-muted align-middle" /> : null}
      </span>
      {count.kind === "changed" ? (
        <span data-slot="changes-totals" class="shrink-0 tabular-nums">
          <span class="text-status-done">+{count.added}</span> <span class="text-status-blocked">−{count.removed}</span>
        </span>
      ) : loading ? (
        <span aria-hidden="true" class="count-skeleton h-2.5 w-12 shrink-0 rounded-full bg-muted" />
      ) : null}
    </div>
  );
}

/**
 * The folder path as links, each crumb one level up the tree: the root first, then every folder. The
 * last crumb is where the operator is, so it is text. A long path wraps rather than scrolls.
 */
export function filesBreadcrumb(
  dir: string,
  rootName: string | null,
  hrefFor: (dir: string) => string,
  onOpen: (dir: string) => void,
): RemixNode {
  const folders = dir === "" ? [] : dir.split("/");
  const crumbs = [
    { name: rootName ?? t("files.root"), dir: "" },
    ...folders.map((name, i) => ({ name, dir: folders.slice(0, i + 1).join("/") })),
  ];
  return (
    <nav aria-label={t("files.breadcrumb.aria")} data-slot="files-breadcrumb">
      <ol class="flex flex-wrap items-center gap-x-1 font-mono text-xs leading-6 text-muted-foreground">
        {crumbs.map((crumb, i) => {
          const here = i === crumbs.length - 1;
          return (
            <li key={crumb.dir} class="flex min-w-0 items-center gap-x-1">
              {i > 0 ? <span aria-hidden="true">/</span> : null}
              {here ? (
                <span aria-current="page" class="min-w-0 wrap-anywhere text-foreground">
                  {crumb.name}
                </span>
              ) : (
                <a
                  href={hrefFor(crumb.dir)}
                  mix={on("click", (event) => {
                    // A plain tap navigates through the app's own history rules; a modified click
                    // keeps the browser's meaning.
                    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
                    event.preventDefault();
                    onOpen(crumb.dir);
                  })}
                  class="inline-flex min-h-11 min-w-0 items-center underline underline-offset-2 wrap-anywhere active:text-foreground"
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

const KIND_ICON = { dir: Folder, file: File, link: Link2 } satisfies Record<FileEntryKind, IconNode>;
const KIND_WORD = { dir: "files.kind.dir", file: "files.kind.file", link: "files.kind.link" } satisfies Record<FileEntryKind, MessageKey>;

/**
 * What a row is called to a screen reader: the name, its kind and a file's size, then its change,
 * spelled out. An `aria-label`, because engines disagree on the space between a name and a visually
 * hidden word beside it.
 */
function rowLabel(entry: FileEntry, mark: EntryMark | undefined): string {
  const parts = [entry.name, t(KIND_WORD[entry.kind])];
  if (entry.kind === "file" && entry.size !== undefined) parts.push(formatBytes(entry.size));
  if (mark?.kind === "change") parts.push(t(STATUS_WORD[mark.status]));
  if (mark?.kind === "folder") parts.push(tn("files.changed", mark.mark.count));
  if (entry.ignored === true) parts.push(t("files.ignored.word"));
  return parts.join(", ");
}

// A changed row's icon SWITCHES as well as taking the status ink, so a change reads by shape too: a
// pen for modified, a plus for new, a minus for deleted, an arrow in for renamed.
const CHANGED_FILE_ICON = { M: FilePen, A: FilePlus, "?": FilePlus, D: FileMinus, R: FileInput } satisfies Record<ChangeStatus, IconNode>;

function changedIcon(kind: FileEntryKind, status: ChangeStatus): IconNode {
  if (kind === "dir") return status === "?" || status === "A" ? FolderPlus : Folder;
  if (kind === "link") return Link2;
  return CHANGED_FILE_ICON[status];
}

/**
 * The slot at a row's end: a changed row's status letter, or a folder's dot and the count of changed
 * files below it. Every row of a marked folder reserves the letter's width, so a mark that arrives on
 * a re-read moves no size and no name (DESIGN.md §2).
 */
function markSlot(mark: EntryMark | undefined): RemixNode {
  if (mark?.kind === "change") {
    return (
      <span aria-hidden="true" class={cn("w-3 shrink-0 text-center font-mono text-xs font-semibold", STATUS_TONE[mark.status])}>
        {mark.status === "?" ? "U" : mark.status}
      </span>
    );
  }
  if (mark?.kind === "folder") {
    return (
      <span aria-hidden="true" data-slot="folder-mark" class="flex shrink-0 items-center gap-1 text-xs text-muted-foreground tabular-nums">
        <span class={cn("size-1.5 rounded-full", STATUS_FILL[mark.mark.status])} />
        {mark.mark.count}
      </span>
    );
  }
  return <span aria-hidden="true" class="w-3 shrink-0" />;
}

/**
 * One folder's rows: an icon per kind, the name, and a size for files. A row git ignores (shown only
 * when asked for) is dimmed and still opens. Every row is a 44px button; the kind and the size are
 * said to a screen reader after the name. With `marks`, a changed row carries its status letter and
 * the status's icon in the same ink, a folder with changes below it carries a dot and their count,
 * and a deleted file, which only the change set still names, is struck through.
 */
export function fileRows(
  entries: readonly FileEntry[],
  marks: ReadonlyMap<string, EntryMark> | undefined,
  onOpen: (entry: FileEntry) => void,
): RemixNode {
  return (
    <ListGroup as="ul" data-slot="file-rows">
      {entries.map((entry) => {
        const mark = marks?.get(entry.name);
        const icon = mark?.kind === "change" ? changedIcon(entry.kind, mark.status) : KIND_ICON[entry.kind];
        const tone = mark?.kind === "change" ? STATUS_TONE[mark.status] : undefined;
        const deleted = mark?.kind === "change" && mark.deleted === true;
        return (
          <li key={entry.name}>
            <button
              type="button"
              data-entry={entry.name}
              mix={on("click", () => onOpen(entry))}
              aria-label={rowLabel(entry, mark)}
              class="flex min-h-11 w-full items-center gap-3 px-3.5 py-2 text-left active:bg-muted/50"
            >
              <Icon
                icon={icon}
                class={cn("size-4 shrink-0", tone ?? (entry.kind === "dir" && entry.ignored !== true ? "text-foreground" : "text-muted-foreground"))}
              />
              <span class={cn("min-w-0 flex-1 font-mono text-sm wrap-anywhere", (entry.ignored === true || deleted) && "text-muted-foreground", deleted && "line-through")}>
                {entry.name}
              </span>
              {entry.kind === "file" && entry.size !== undefined ? (
                <span class="shrink-0 text-xs text-muted-foreground tabular-nums">{formatBytes(entry.size)}</span>
              ) : null}
              {marks !== undefined ? markSlot(mark) : null}
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

/**
 * The Ignored toggle: whether entries git ignores are listed. It says its own state: `EyeOff` and
 * "Ignored hidden" when off, `Eye` and "Ignored shown" when on. A 44px target with its word.
 */
function ignoredToggle(showIgnored: boolean, onShowIgnored: (show: boolean) => void): RemixNode {
  const state = t(showIgnored ? "files.ignored.stateShown" : "files.ignored.stateHidden");
  return (
    <button
      type="button"
      data-slot="toggle-button"
      aria-pressed={showIgnored ? "true" : "false"}
      aria-label={t("files.ignored.toggleAria")}
      mix={on("click", () => onShowIgnored(!showIgnored))}
      class={cn(
        "relative flex h-11 shrink-0 items-center justify-center gap-2 rounded-md px-3 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        showIgnored ? "bg-primary/10 text-primary ring-1 ring-primary/40 ring-inset" : "text-muted-foreground active:bg-muted",
      )}
    >
      <Icon icon={showIgnored ? Eye : EyeOff} class="size-4" />
      {state}
    </button>
  );
}

/** The row inside the overlay: the name field, the Ignored toggle, and the count with its Clear. */
export function filesFilterBar(
  query: string,
  onQuery: (query: string) => void,
  showIgnored: boolean,
  onShowIgnored: (show: boolean) => void,
  shown: number,
  total: number,
): RemixNode {
  return filterRow({
    slot: "files-filter",
    query,
    onQuery,
    placeholder: t("files.filter.placeholder"),
    active: isNameFilterOn(query),
    count: t("files.filter.shown", { shown, total }),
    // Clear resets the name only: the Ignored choice is the device's, not this folder's.
    onClear: () => onQuery(""),
    focusOnMount: true,
    chips: ignoredToggle(showIgnored, onShowIgnored),
  });
}

function ignoredFooter(label: string, action: string, actionAria: string, onAction: () => void): RemixNode {
  return (
    <div data-slot="files-ignored-hidden" class="flex items-center justify-between gap-2 pt-1 text-xs text-muted-foreground">
      <span>{label}</span>
      <button
        type="button"
        aria-label={actionAria}
        mix={on("click", onAction)}
        class="flex min-h-11 items-center rounded-md px-3 text-sm font-medium text-primary active:bg-muted"
      >
        {action}
      </button>
    </div>
  );
}

export interface FolderBodyArgs {
  entries: readonly FileEntry[];
  marks: ReadonlyMap<string, EntryMark> | undefined;
  truncated: boolean;
  query: string;
  showIgnored: boolean;
  onShowIgnored: (show: boolean) => void;
  onClearQuery: () => void;
  onOpen: (entry: FileEntry) => void;
}

/**
 * One folder's body: the rows the filter leaves, the quiet "{count} ignored hidden" line with its
 * Show action, and the sentence and way out when nothing is left.
 */
export function filesFolderBody(args: FolderBodyArgs): RemixNode {
  const { entries, marks, truncated, query, showIgnored, onShowIgnored, onClearQuery, onOpen } = args;
  if (entries.length === 0) return <p class="px-2 py-16 text-center text-sm leading-relaxed text-muted-foreground">{t("files.empty")}</p>;
  const view = folderView(entries, query, showIgnored);
  const ignoredShown = showIgnored ? view.rows.filter((e) => e.ignored === true).length : 0;
  return (
    <>
      {view.rows.length > 0
        ? fileRows(view.rows, marks, onOpen)
        : isNameFilterOn(query)
          ? changesNoMatch(onClearQuery)
          : <p class="px-2 py-12 text-center text-sm leading-relaxed text-muted-foreground">{t("files.ignored.allHidden")}</p>}
      {view.hiddenIgnored > 0
        ? ignoredFooter(t("files.ignored.hidden", { count: view.hiddenIgnored }), t("files.ignored.show"), t("files.ignored.showAria"), () => onShowIgnored(true))
        : null}
      {ignoredShown > 0
        ? ignoredFooter(t("files.ignored.shown", { count: ignoredShown }), t("files.ignored.hide"), t("files.ignored.hideAria"), () => onShowIgnored(false))
        : null}
      {truncated ? <p class="pt-3 text-xs text-muted-foreground">{t("files.truncated")}</p> : null}
    </>
  );
}

export function quiet(children: RemixNode): RemixNode {
  return <p class="px-2 py-16 text-center text-sm leading-relaxed text-muted-foreground">{children}</p>;
}

export function filesLoading(): RemixNode {
  return (
    <div role="status" class="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
      <Icon icon={LoaderCircle} class="size-4 animate-spin" />
      {t("files.loading")}
    </div>
  );
}

function changesOnlyOffer(onChangesOnly: (() => void) | undefined): RemixNode {
  if (onChangesOnly === undefined) return null;
  return (
    <Button variant="outline" class="h-11" mix={on("click", onChangesOnly)}>
      {t("files.showChangesOnly")}
    </Button>
  );
}

/** Why a read was refused, in words. The unpaired device also gets the way to pair. */
export function refusedBody(why: Refusal, subject: "file" | "folder", onPair: () => void, onChangesOnly?: () => void): RemixNode {
  let sentence: string;
  if (why === "unknown-path") sentence = t(subject === "file" ? "files.unknown.file" : "files.unknown.folder");
  else if (why === "stale") sentence = t("files.stale.member");
  else if (why === "not-authorised") sentence = t("files.notAuthorised");
  else sentence = t("files.notPaired");
  return (
    <div class="flex flex-col items-center gap-3">
      {quiet(sentence)}
      {why === "not-paired" ? (
        <Button variant="outline" class="h-11" mix={on("click", onPair)}>
          {t("files.pairLink")}
        </Button>
      ) : null}
      {changesOnlyOffer(onChangesOnly)}
    </div>
  );
}

export interface TreeFolderArgs extends Omit<FolderBodyArgs, "entries" | "marks"> {
  state: FilesReadState;
  folder: MarkedFolder | null;
  /** The Changes list answered for this root, so a folder Files cannot open still has its changes. */
  listAvailable: boolean;
  onPair: () => void;
  onChangesOnly: (() => void) | undefined;
}

/**
 * One folder of the tree: its rows with their change marks, or the sentence that stands in for them.
 * `folder` is the listing joined to the change set; it is also set when the bridge no longer has the
 * folder and the change set names deleted files in it, so a deleted folder's diffs stay reachable.
 */
export function treeFolderBody(args: TreeFolderArgs): RemixNode {
  const { state, folder, listAvailable, onPair, onChangesOnly } = args;
  if (folder !== null) return filesFolderBody({ ...args, entries: folder.entries, marks: folder.marks });
  if (state.phase === "loading") return filesLoading();
  if (state.phase === "error") {
    return (
      <Notice variant="box" tone="danger" announce="alert">
        {t("files.error")}
      </Notice>
    );
  }
  if (state.phase === "refused") return refusedBody(state.why, "folder", onPair, onChangesOnly);
  if (!state.data.available) {
    // Files is bounded tighter than Changes (ADR 0083 rule 1): a pane parked in the home folder has a
    // Changes list and no Files. Say which half is missing, and offer the half that is there.
    const reason: ChangesUnavailableReason = state.data.reason;
    const ownWords = reason === "no-folder" && listAvailable;
    return (
      <div class="flex flex-col items-center gap-3">
        {quiet(t(ownWords ? "files.noFolder" : unavailableKey(reason)))}
        {ownWords ? changesOnlyOffer(onChangesOnly) : null}
      </div>
    );
  }
  // A file answered where a folder was asked for: the screen moves to the file on its own.
  return filesLoading();
}
