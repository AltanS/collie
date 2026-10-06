// The Changes screen's drawings (ADR 0065): the list of changed files grouped by repo, the same files
// as a folder tree, one file's diff, the commit's head and the filter. Port of
// web/src/components/{changes-view,changes-commit}.tsx. Presentational: the route owns every state and
// hands these what to draw and what to call.
//
// Paths and diff lines are machine-authored content: `font-mono`, rendered as text nodes (a coloured
// token is a span around a text node), never as markup. Stateless drawings are plain functions that
// return nodes; only the diff (it colours itself once the highlighter loads) is a component.
import { on, ref, type Handle, type RemixNode } from "remix/component";
import { ChevronRight, GitCommitHorizontal, ListFilter, ListTree, Search, X } from "lucide";

import { timeAgo } from "@web/lib/format";
import { t, tn, type MessageKey } from "@web/lib/i18n";
import {
  buildChangeTree,
  FILTER_STATUSES,
  isFilterActive,
  visibleTreeRows,
  type ChangesFilter,
  type ChangesLayout,
  type FilterStatus,
  type TreeNode,
} from "@web/lib/changes-tree";
import {
  HIGHLIGHT_MAX_LINES,
  highlightDiff,
  highlightDiffNow,
  languageForPath,
  type RowTokens,
  type SyntaxToken,
} from "@web/lib/diff-highlight";
import type { ChangedFile, ChangedRepo, ChangeStatus, CleanRepo, CommitInfo } from "@web/lib/types";
import { parseUnifiedDiff, type DiffRow, type ParsedDiff } from "@web/lib/unified-diff";
import { cn } from "@web/lib/utils";

import { scheduleUpdate } from "../../lib/store";
import { Button } from "../../ui/button";
import { Icon } from "../../ui/icon";
import { ListGroup } from "../../ui/list-group";
import { SectionLabel } from "../../ui/section-label";
import type { ChangeRef } from "./api";

/** What a status letter says to a screen reader. Shared with the folder tree's marks. */
export const STATUS_WORD = {
  M: "changes.status.M",
  A: "changes.status.A",
  D: "changes.status.D",
  R: "changes.status.R",
  "?": "changes.status.untracked",
} satisfies Record<ChangeStatus, MessageKey>;

/**
 * The ink of a status letter on the Changes screen: the list's rows, the file header and the folder
 * tree's icons all wear it. Untracked takes the added ink, so `U` is one colour on one screen
 * (ADR 0083, 2026-10-06).
 */
export const STATUS_TONE = {
  M: "text-status-working",
  A: "text-status-done",
  D: "text-status-blocked",
  R: "text-status-info",
  "?": "text-status-done",
} satisfies Record<ChangeStatus, string>;

/** The same five colours as a fill, for the folder tree's dot and the Changes segment's badge. */
export const STATUS_FILL = {
  M: "bg-status-working",
  A: "bg-status-done",
  D: "bg-status-blocked",
  R: "bg-status-info",
  "?": "bg-status-done",
} satisfies Record<ChangeStatus, string>;

function splitPath(path: string) {
  const bare = path.endsWith("/") ? path.slice(0, -1) : path;
  const at = bare.lastIndexOf("/");
  return { dir: at < 0 ? "" : path.slice(0, at + 1), name: path.slice(at + 1) };
}

/** The status letter, coloured, with its word for a screen reader. */
export function statusLetter(status: ChangeStatus): RemixNode {
  return (
    <>
      <span aria-hidden="true" class={cn("w-3 shrink-0 text-center font-mono text-xs font-semibold", STATUS_TONE[status])}>
        {status === "?" ? "U" : status}
      </span>
      <span class="sr-only">{t(STATUS_WORD[status])}</span>
    </>
  );
}

/** `+N −M`, or "binary". An untracked folder has neither and shows nothing. */
function counts(file: ChangedFile): RemixNode {
  if (file.binary) return <span class="shrink-0 text-xs text-muted-foreground">{t("changes.binaryShort")}</span>;
  if (file.path.endsWith("/")) return null;
  return (
    <span class="shrink-0 font-mono text-xs tabular-nums">
      <span class="text-status-done">+{file.added}</span> <span class="text-status-blocked">−{file.removed}</span>
    </span>
  );
}

/** How many characters of the END a name never gives up (an extension plus one word of the stem). */
const TAIL_CHARS = 14;
const SPLIT_MIN = TAIL_CHARS * 2;

/**
 * A name that keeps BOTH ends and drops the MIDDLE, in pure CSS: the head is an ordinary truncating
 * box, the tail refuses to shrink and sits against it. Nothing is measured, so there is no layout
 * pass and the split point is the same on every device.
 */
function middleTruncate(text: string, className?: string): RemixNode {
  if (text.length <= SPLIT_MIN) return <span class={cn("min-w-0 truncate", className)}>{text}</span>;
  const cut = text.length - TAIL_CHARS;
  return (
    <span class={cn("flex min-w-0", className)}>
      <span class="truncate">{text.slice(0, cut)}</span>
      <span class="shrink-0 whitespace-pre">{text.slice(cut)}</span>
    </span>
  );
}

/** The path: the folder dimmed, the file name emphasised. The folder truncates first. */
export function changePath(path: string, className?: string): RemixNode {
  const { dir, name } = splitPath(path);
  return (
    <span class={cn("flex min-w-0 font-mono text-[13px]", className)}>
      {dir === "" ? null : <span class="min-w-0 truncate text-muted-foreground">{dir}</span>}
      {middleTruncate(name, "max-w-full shrink-0 font-medium text-foreground")}
    </span>
  );
}

/** The collapse key of one folder: repo and folder path, so two repos' `src/` stay apart. */
export function folderKey(repo: string, folder: string): string {
  return `${repo}\n${folder}`;
}

const INDENT_STEP = 12;
const INDENT_MAX_LEVELS = 8;
const indent = (depth: number): string => `padding-left: ${String(14 + Math.min(depth, INDENT_MAX_LEVELS) * INDENT_STEP)}px`;

/** The repos one under another, each named only when there is more than one. */
function repoSections(repos: readonly ChangedRepo[], paneRepo: string | undefined, body: (repo: ChangedRepo) => RemixNode): RemixNode {
  const headed = repos.length > 1;
  return (
    <div class="flex flex-col gap-4">
      {repos.map((repo) => {
        const mine = headed && repo.relPath === paneRepo;
        return (
          <section key={repo.relPath} aria-label={repo.name} data-pane-repo={mine ? "" : undefined} class="flex scroll-mt-4 flex-col">
            {headed ? (
              <SectionLabel class="mb-1.5 flex min-w-0 items-baseline gap-2 normal-case">
                <span class="min-w-0 truncate">{tn("changes.repoFiles", repo.files.length, { name: repo.name })}</span>
                {mine ? <span class="shrink-0 text-primary">{t("changes.thisPane")}</span> : null}
              </SectionLabel>
            ) : null}
            {body(repo)}
          </section>
        );
      })}
    </div>
  );
}

export function changesList(repos: readonly ChangedRepo[], paneRepo: string | undefined, onOpen: (ref: ChangeRef) => void): RemixNode {
  return repoSections(repos, paneRepo, (repo) => (
    <ListGroup as="ul">
      {repo.files.map((file) => (
        <li key={file.path}>
          <button
            type="button"
            mix={on("click", () => onOpen({ repo: repo.relPath, path: file.path }))}
            class="flex min-h-11 w-full items-center gap-3 px-3.5 py-2 text-left transition-colors active:bg-muted"
          >
            {statusLetter(file.status)}
            {changePath(file.path, "flex-1")}
            {counts(file)}
          </button>
        </li>
      ))}
    </ListGroup>
  ));
}

/** How wide each skeleton row's path bar is, so the rows read as a list and not as one block. */
const SKELETON_PATHS = ["68%", "52%", "80%", "44%", "60%"] as const;

/**
 * The list before its first answer: five rows in the real rows' own box, each part a muted bar
 * breathing like the Changes tab's count line (`.count-skeleton`). Shown on a first read with nothing
 * kept only; a re-read never comes back here.
 */
export function changesListSkeleton(label: string): RemixNode {
  return (
    <div role="status" data-slot="changes-skeleton">
      <span class="sr-only">{label}</span>
      <ListGroup as="ul">
        {SKELETON_PATHS.map((width) => (
          <li key={width} aria-hidden="true" class="flex min-h-11 w-full items-center gap-3 px-3.5 py-2">
            <span class="count-skeleton h-3 w-3 shrink-0 rounded-sm bg-muted" />
            <span class="flex min-w-0 flex-1">
              <span class="count-skeleton h-2.5 rounded-full bg-muted" style={{ width }} />
            </span>
            <span class="count-skeleton h-2.5 w-10 shrink-0 rounded-full bg-muted" />
          </li>
        ))}
      </ListGroup>
    </div>
  );
}

function sumCounts(added: number, removed: number): RemixNode {
  return (
    <span class="shrink-0 font-mono text-xs tabular-nums">
      <span class="text-status-done">+{added}</span> <span class="text-status-blocked">−{removed}</span>
    </span>
  );
}

// One tree per repo per `files` identity: a re-render that changes nothing about the files builds
// nothing (the list answer keeps identity through `shareEqual`).
const trees = new WeakMap<readonly ChangedFile[], TreeNode[]>();
function treeOf(files: readonly ChangedFile[]): TreeNode[] {
  let built = trees.get(files);
  if (built === undefined) {
    built = buildChangeTree(files);
    trees.set(files, built);
  }
  return built;
}

function treeRows(
  repo: ChangedRepo,
  collapsed: ReadonlySet<string>,
  onToggle: (key: string) => void,
  onOpen: (ref: ChangeRef) => void,
): RemixNode {
  // The tree's own keys are bare folder paths; the shared set keys them by repo too.
  const prefix = folderKey(repo.relPath, "");
  const closed = new Set([...collapsed].flatMap((k) => (k.startsWith(prefix) ? [k.slice(prefix.length)] : [])));
  const rows = visibleTreeRows(treeOf(repo.files), closed);
  return (
    <ListGroup as="ul">
      {rows.map((node) => {
        if (node.kind === "folder") {
          const open = !closed.has(node.key);
          return (
            <li key={`d:${node.key}`}>
              <button
                type="button"
                aria-expanded={open ? "true" : "false"}
                aria-label={tn("changes.tree.folderAria", node.fileCount, { name: node.label })}
                mix={on("click", () => onToggle(folderKey(repo.relPath, node.key)))}
                style={indent(node.depth)}
                class="flex min-h-11 w-full items-center gap-3 py-2 pr-3.5 text-left transition-colors active:bg-muted"
              >
                <Icon icon={ChevronRight} class={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
                <span class="flex min-w-0 items-baseline gap-3">
                  {middleTruncate(`${node.label}/`, "font-mono text-[13px] text-muted-foreground")}
                  <span aria-hidden="true" data-slot="tree-folder-count" class="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {node.fileCount}
                  </span>
                </span>
                <span class="flex-1" />
                {node.added > 0 || node.removed > 0 ? sumCounts(node.added, node.removed) : null}
              </button>
            </li>
          );
        }
        return (
          <li key={`f:${node.key}`}>
            <button
              type="button"
              mix={on("click", () => onOpen({ repo: repo.relPath, path: node.file.path }))}
              style={indent(node.depth)}
              class="flex min-h-11 w-full items-center gap-3 py-2 pr-3.5 text-left transition-colors active:bg-muted"
            >
              {statusLetter(node.file.status)}
              {middleTruncate(node.name, "flex-1 font-mono text-[13px] font-medium text-foreground")}
              {counts(node.file)}
            </button>
          </li>
        );
      })}
    </ListGroup>
  );
}

/** The same files as a folder tree, per repo: folders first, single-folder chains compacted. */
export function changesTree(
  repos: readonly ChangedRepo[],
  paneRepo: string | undefined,
  collapsed: ReadonlySet<string>,
  onToggle: (key: string) => void,
  onOpen: (ref: ChangeRef) => void,
): RemixNode {
  return repoSections(repos, paneRepo, (repo) => treeRows(repo, collapsed, onToggle, onOpen));
}

/** What the list shows when the filter leaves nothing: the sentence and the way out. */
export function changesNoMatch(onClear: () => void): RemixNode {
  return (
    <div class="flex flex-col items-center gap-2 py-12">
      <p class="text-sm text-muted-foreground">{t("changes.filter.none")}</p>
      <button type="button" mix={on("click", onClear)} class="flex min-h-11 items-center rounded-md px-4 text-sm font-medium text-primary active:bg-muted">
        {t("changes.filter.clear")}
      </button>
    </div>
  );
}

// ── The header's controls ───────────────────────────────────────────────────────────────────────

/** List or Tree: ONE 44px icon toggle, pressed while the changes draw as a tree. */
export function layoutToggle(layout: ChangesLayout, onChange: (layout: ChangesLayout) => void): RemixNode {
  const tree = layout === "tree";
  return (
    <button
      type="button"
      data-testid="layout-toggle"
      aria-pressed={tree ? "true" : "false"}
      aria-label={t("changes.layout.tree")}
      title={t("changes.layout.tree")}
      mix={on("click", () => onChange(tree ? "list" : "tree"))}
      class={cn(
        "flex size-11 shrink-0 items-center justify-center rounded-md transition-colors",
        tree ? "bg-primary/10 text-primary" : "text-muted-foreground active:bg-muted",
      )}
    >
      <Icon icon={ListTree} class="size-5" />
    </button>
  );
}

/**
 * The header's Filter button. While a filter is on it takes the primary tint and a small count of the
 * files still shown, drawn over its corner so the header never re-lays-out.
 */
export function filterButton(open: boolean, active: boolean, shown: number, total: number, onClick: () => void): RemixNode {
  return (
    <button
      type="button"
      data-testid="filter-button"
      aria-expanded={open ? "true" : "false"}
      aria-label={active ? t("changes.filter.buttonActive", { shown, total }) : t("changes.filter.button")}
      mix={on("click", onClick)}
      class={cn(
        "relative flex size-11 shrink-0 items-center justify-center rounded-md transition-colors",
        active ? "bg-primary/10 text-primary" : open ? "bg-muted text-foreground" : "text-muted-foreground active:bg-muted",
      )}
    >
      <Icon icon={ListFilter} class="size-5" />
      {active ? (
        <span
          aria-hidden="true"
          class="absolute top-0.5 right-0.5 min-w-4 rounded-full bg-primary px-1 text-center text-[10px] leading-4 font-semibold tabular-nums text-primary-foreground"
        >
          {shown}
        </span>
      ) : null}
    </button>
  );
}

const CHIP_STATUS = { M: "M", A: "A", D: "D", R: "R", U: "?" } as const satisfies Record<FilterStatus, ChangeStatus>;

export interface FilterRowProps {
  query: string;
  onQuery: (query: string) => void;
  placeholder: string;
  /** The chips under the field, at the row's left. */
  chips: RemixNode;
  /** A filter is on: the count and Clear show. */
  active: boolean;
  /** The "3 of 12" text. */
  count: string;
  onClear: () => void;
  /** Put the caret in the field when the row appears: the operator opened it to type. */
  focusOnMount?: boolean;
  slot?: string;
}

/**
 * The filter row's drawing, with nothing Changes-specific in it: a text field with a clear button, a
 * slot for the chips, and the "3 of 12" count with its own Clear. The trailing group is always
 * there, only invisible while no filter is on, so typing the first letter moves nothing.
 */
export function filterRow(props: FilterRowProps): RemixNode {
  const { query, onQuery, placeholder, chips, active, count, onClear, focusOnMount = false, slot = "changes-filter" } = props;
  return (
    <div class="flex flex-col gap-1 px-4 pt-2 pb-1" data-slot={slot}>
      <div class="relative">
        <Icon icon={Search} class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          inputMode="search"
          autocomplete="off"
          autocapitalize="off"
          spellcheck={false}
          value={query}
          placeholder={placeholder}
          aria-label={placeholder}
          data-testid="filter-input"
          mix={[
            ref((node: HTMLInputElement) => {
              if (focusOnMount) node.focus();
            }),
            on("input", (event) => onQuery(event.currentTarget.value)),
          ]}
          class="h-11 w-full rounded-md border border-input bg-transparent pr-11 pl-9 font-mono text-base placeholder:font-sans placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        />
        {query !== "" ? (
          <button
            type="button"
            aria-label={t("changes.filter.clearText")}
            mix={on("click", () => onQuery(""))}
            class="absolute top-0 right-0 flex size-11 items-center justify-center text-muted-foreground"
          >
            <Icon icon={X} class="size-4" />
          </button>
        ) : null}
      </div>
      <div class="flex flex-wrap items-center gap-y-1">
        {chips}
        <div class={cn("ml-auto flex max-w-full min-w-0 items-center gap-1 pl-2", !active && "invisible")}>
          <span aria-live="polite" class="min-w-0 truncate text-xs tabular-nums text-muted-foreground">
            {count}
          </span>
          <button
            type="button"
            mix={on("click", onClear)}
            class="flex h-8 shrink-0 items-center rounded-md px-2 text-xs font-medium text-primary active:bg-muted"
          >
            {t("changes.filter.clear")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The Changes filter row: a path field, the status chips, and the count. */
export function changesFilterBar(
  filter: ChangesFilter,
  onChange: (filter: ChangesFilter) => void,
  onClear: () => void,
  shown: number,
  total: number,
): RemixNode {
  const toggle = (s: FilterStatus): void =>
    onChange({
      ...filter,
      statuses: filter.statuses.includes(s) ? filter.statuses.filter((x) => x !== s) : [...filter.statuses, s],
    });
  return filterRow({
    query: filter.query,
    onQuery: (query) => onChange({ ...filter, query }),
    placeholder: t("changes.filter.placeholder"),
    active: isFilterActive(filter),
    count: t("changes.filter.shown", { shown, total }),
    onClear,
    focusOnMount: true,
    chips: (
      <div role="group" aria-label={t("changes.filter.statusAria")} class="-ml-1.5 flex">
        {FILTER_STATUSES.map((s) => {
          const pressed = filter.statuses.includes(s);
          return (
            <button
              key={s}
              type="button"
              aria-pressed={pressed ? "true" : "false"}
              aria-label={t(STATUS_WORD[CHIP_STATUS[s]])}
              mix={on("click", () => toggle(s))}
              class="flex h-11 min-w-11 items-center justify-center"
            >
              <span
                aria-hidden="true"
                class={cn(
                  "flex size-8 items-center justify-center rounded-full border font-mono text-xs font-semibold transition-colors",
                  pressed ? "border-primary bg-primary text-primary-foreground" : cn("border-border", STATUS_TONE[CHIP_STATUS[s]]),
                )}
              >
                {s}
              </span>
            </button>
          );
        })}
      </div>
    ),
  });
}

export interface FilterOverlayProps {
  onClose: () => void;
  children?: RemixNode;
}

/**
 * The filter row as a floating card, drawn OVER the list under the header rather than pushing it
 * down: opening and closing move neither by a pixel. It is mounted only while open (the caller's
 * conditional), so its setup is the open: Escape and a tap outside close it (the filter itself stays
 * applied), and the focus it took goes back to whatever held it before.
 */
export function FilterOverlay(handle: Handle<FilterOverlayProps>) {
  const before = document.activeElement;
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape") handle.props.onClose();
    },
    { signal: handle.signal },
  );
  handle.signal.addEventListener(
    "abort",
    () => {
      if (before instanceof HTMLElement) before.focus();
    },
    { once: true },
  );
  let armed = false;
  return () => (
    <>
      {/* The dismiss surface: hidden from assistive tech, still dismisses on tap. Press and release
          must both land here, so the release of the tap that OPENED the card never closes it. */}
      <button
        type="button"
        aria-hidden="true"
        tabindex={-1}
        class="fixed inset-0 z-10 cursor-default"
        mix={[
          on("pointerdown", () => {
            armed = true;
          }),
          on("click", () => {
            if (armed) handle.props.onClose();
          }),
        ]}
      />
      <div role="dialog" aria-label={t("changes.filter.button")} class="absolute inset-x-0 top-0 z-20 px-4 pt-2">
        <div class="overflow-hidden rounded-md border border-border bg-card shadow-lg">{handle.props.children}</div>
      </div>
    </>
  );
}

// ── The commit view ─────────────────────────────────────────────────────────────────────────────

/**
 * "Show last commit" per clean repo. One repo gets one button under the empty sentence; several get a
 * compact list, one row a repo, each with its own button named for that repo.
 */
export function cleanRepos(repos: readonly CleanRepo[], onShow: (repo: string) => void, rows = false): RemixNode {
  const [only] = repos;
  if (only === undefined) return null;
  if (repos.length === 1 && !rows) {
    return (
      <div class="flex justify-center">
        <Button variant="outline" class="h-11" mix={on("click", () => onShow(only.relPath))} data-testid="show-commit">
          <Icon icon={GitCommitHorizontal} class="size-4" />
          {t("changes.commit.show")}
        </Button>
      </div>
    );
  }
  return (
    <ListGroup as="ul">
      {repos.map((repo) => (
        <li key={repo.relPath} class="flex min-h-11 items-center gap-3 py-1 pr-1.5 pl-3.5">
          <span class="min-w-0 flex-1 truncate font-mono text-[13px]">{repo.name}</span>
          <Button
            variant="ghost"
            class="h-11 shrink-0 text-primary"
            aria-label={t("changes.commit.showFor", { name: repo.name })}
            mix={on("click", () => onShow(repo.relPath))}
          >
            {t("changes.commit.show")}
          </Button>
        </li>
      ))}
    </ListGroup>
  );
}

/**
 * The commit above its files: the subject (two lines at most), then the short hash, the author and how
 * long ago. Under it, two quiet lines that each appear only when true, in a slot that is always there,
 * so one appearing moves nothing below it.
 */
export function commitHead(
  commit: CommitInfo,
  newer: boolean,
  uncommitted: boolean,
  onLoadNewer: () => void,
  onShowUncommitted: () => void,
): RemixNode {
  return (
    <div class="flex flex-col gap-1" data-slot="commit-head">
      <p class="line-clamp-2 text-base leading-snug font-medium wrap-anywhere">{commit.subject}</p>
      <p class="flex min-w-0 items-baseline gap-1.5 text-xs text-muted-foreground">
        <span class="shrink-0 font-mono">{commit.shortHash}</span>
        <span aria-hidden="true">·</span>
        <span class="min-w-0 truncate">{commit.author}</span>
        <span aria-hidden="true">·</span>
        <time class="shrink-0" dateTime={new Date(commit.time * 1000).toISOString()}>
          {timeAgo(commit.time * 1000)}
        </time>
      </p>
      <div role="status" class="flex min-h-5 flex-wrap gap-x-4 text-xs">
        {newer ? (
          <button type="button" mix={on("click", onLoadNewer)} class="text-primary underline underline-offset-2">
            {t("changes.commit.newer")}
          </button>
        ) : null}
        {uncommitted ? (
          <button type="button" mix={on("click", onShowUncommitted)} class="text-primary underline underline-offset-2">
            {t("changes.commit.uncommitted")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

// ── One file's diff ─────────────────────────────────────────────────────────────────────────────

const ROW_TONE = { add: "bg-status-done/12", del: "bg-status-blocked/12", context: "" } as const;
const SIGN = { add: "+", del: "−", context: " " } as const;
const SIGN_TONE = { add: "text-status-done", del: "text-status-blocked", context: "" } as const;

/** The ink per token kind (`--syntax-*` in the stylesheet). Kinds with no entry keep the row's ink. */
const TOKEN_TONE = new Map<SyntaxToken["type"], string>([
  ["keyword", "text-syntax-keyword"],
  ["string", "text-syntax-string"],
  ["class", "text-syntax-constant"],
  ["property", "text-syntax-property"],
  ["entity", "text-syntax-entity"],
  ["comment", "text-syntax-comment"],
]);

/** A line's tokens as spans, neighbours of the same ink merged into one. Text nodes only. */
export function tokenLine(tokens: readonly SyntaxToken[]): RemixNode {
  const runs: { tone: string | undefined; text: string }[] = [];
  for (const token of tokens) {
    const tone = TOKEN_TONE.get(token.type);
    const last = runs.at(-1);
    if (last && last.tone === tone) last.text += token.value;
    else runs.push({ tone, text: token.value });
  }
  return runs.map((run, i) => (
    <span key={String(i)} class={run.tone}>
      {run.text}
    </span>
  ));
}

/**
 * A key per row that follows the row's content, not its index: a line added above keeps every row
 * below on its own element. The nth repeat of the same line gets its own key.
 */
export function diffRowKeys(rows: readonly DiffRow[]): string[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const base = row.kind === "hunk" ? `h\u0000${row.header}` : `${row.kind}\u0000${row.text}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return `${base}\u0000${String(n)}`;
  });
}

export interface DiffViewProps {
  diff: string;
  path?: string;
}

/**
 * One file's diff: two line-number gutters, a sign, the line. Long lines WRAP, anywhere, so a minified
 * line cannot push the page wide. With `path` naming a language the highlighter knows, the lines take
 * syntax colour once it loads; the parse and the keys are made once per diff text, and a diff that
 * changes under the open view (the 5 s re-read) colours its unchanged lines the same.
 */
export function DiffView(handle: Handle<DiffViewProps>) {
  let parsedFor = "";
  let parsed: ParsedDiff = { rows: [], added: 0, removed: 0, maxLineNo: 0 };
  let keys: string[] = [];
  let done: { rows: readonly DiffRow[]; tokens: RowTokens } | null = null;
  let asked: readonly DiffRow[] | null = null;

  const colour = (rows: readonly DiffRow[], lang: NonNullable<ReturnType<typeof languageForPath>>): void => {
    if (asked === rows) return;
    asked = rows;
    void (async () => {
      try {
        const tokens = await highlightDiff(rows, lang);
        if (handle.signal.aborted || asked !== rows) return;
        done = { rows, tokens };
        scheduleUpdate(handle);
      } catch {
        // No highlighter (offline, a stale chunk): the plain rows are the whole answer.
      }
    })();
  };

  return () => {
    const { diff, path } = handle.props;
    if (diff !== parsedFor || keys.length === 0) {
      parsedFor = diff;
      parsed = parseUnifiedDiff(diff);
      keys = diffRowKeys(parsed.rows);
    }
    const rows = parsed.rows;
    const lang = path === undefined ? null : languageForPath(path);
    const lines = rows.filter((r) => r.kind !== "hunk" && r.kind !== "note").length;
    const colourable = lang !== null && lines <= HIGHLIGHT_MAX_LINES;
    const now = colourable ? highlightDiffNow(rows, lang) : null;
    if (colourable && now === null) handle.queueTask(() => colour(rows, lang));
    const syntax = now ?? (done?.rows === rows ? done.tokens : null);
    const gutter = { width: `calc(${String(Math.max(String(parsed.maxLineNo).length, 2))}ch + 0.5rem)` };
    return (
      <div class="font-mono text-xs leading-5 [font-variant-ligatures:none]" data-slot="diff" data-highlighted={syntax ? "" : undefined}>
        {rows.map((row, i) => {
          if (row.kind === "hunk") {
            return (
              <div key={keys[i]} class="border-y border-border px-3 py-1 wrap-anywhere whitespace-pre-wrap text-muted-foreground first:border-t-0">
                {row.header}
              </div>
            );
          }
          if (row.kind === "note") {
            return (
              <div key={keys[i]} class="px-3 text-muted-foreground italic">
                {row.text}
              </div>
            );
          }
          const tokens = syntax?.[i];
          return (
            <div key={keys[i]} class={cn("flex pl-1", ROW_TONE[row.kind])} data-row={row.kind}>
              <span aria-hidden="true" class="shrink-0 pr-2 text-right text-muted-foreground tabular-nums select-none" style={gutter}>
                {row.oldNo ?? ""}
              </span>
              <span aria-hidden="true" class="shrink-0 pr-2 text-right text-muted-foreground tabular-nums select-none" style={gutter}>
                {row.newNo ?? ""}
              </span>
              <span aria-hidden="true" class={cn("w-[2ch] shrink-0 text-center select-none", SIGN_TONE[row.kind])}>
                {SIGN[row.kind]}
              </span>
              <span class="min-w-0 flex-1 pr-3 wrap-anywhere whitespace-pre-wrap">
                {row.kind === "add" ? <span class="sr-only">+ </span> : null}
                {row.kind === "del" ? <span class="sr-only">− </span> : null}
                {tokens ? tokenLine(tokens) : row.text}
              </span>
            </div>
          );
        })}
      </div>
    );
  };
}
