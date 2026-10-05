import { File, Folder, Link2 } from "lucide-react";

import { Segmented } from "@/components/ui/segmented";
import { ListGroup } from "@/components/ui/list-group";
import { useLocale } from "@/hooks/use-locale";
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
  return parts.join(", ");
}

/**
 * One folder's rows: an icon per kind, the name, and a size for files. A link row opens like a file;
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
              <Icon aria-hidden className={cn("size-4 shrink-0", entry.kind === "dir" ? "text-foreground" : "text-muted-foreground")} />
              <span className="min-w-0 flex-1 font-mono text-sm wrap-anywhere">
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
