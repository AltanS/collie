import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, List, ListFilter, ListTree, Search, X } from "lucide-react";

import { ListGroup } from "@/components/ui/list-group";
import { SectionLabel } from "@/components/ui/section-label";
import { useLocale } from "@/hooks/use-locale";
import {
  buildChangeTree,
  FILTER_STATUSES,
  isFilterActive,
  visibleTreeRows,
  type ChangesFilter,
  type ChangesLayout,
  type FilterStatus,
  type TreeNode,
} from "@/lib/changes-tree";
import { t, tn, type MessageKey } from "@/lib/i18n";
import type { ChangedFile, ChangedRepo, ChangeStatus } from "@/lib/types";
import {
  HIGHLIGHT_MAX_LINES,
  highlightDiff,
  highlightDiffNow,
  languageForPath,
  type RowTokens,
  type SyntaxToken,
} from "@/lib/diff-highlight";
import { parseUnifiedDiff, type DiffRow } from "@/lib/unified-diff";
import { cn } from "@/lib/utils";

// The Changes view's two drawings (ADR 0065): the list of changed files, grouped by repo, and one
// file's diff as monospace rows, syntax-coloured once sugar-high loads. Presentational only, so the
// route and the playground mount the same markup. Paths and diff lines are machine-authored
// content: `font-mono`, rendered as text nodes (a coloured token is a span around a text node),
// never as markup.

const STATUS_WORD = {
  M: "changes.status.M",
  A: "changes.status.A",
  D: "changes.status.D",
  R: "changes.status.R",
  "?": "changes.status.untracked",
} satisfies Record<ChangeStatus, MessageKey>;

const STATUS_TONE = {
  M: "text-status-working",
  A: "text-status-done",
  D: "text-status-blocked",
  R: "text-status-info",
  "?": "text-muted-foreground",
} satisfies Record<ChangeStatus, string>;

/** A file's place in the whole list, across repos: what Previous / Next walk. */
export interface ChangeRef {
  repo: string;
  path: string;
}

function splitPath(path: string) {
  const bare = path.endsWith("/") ? path.slice(0, -1) : path;
  const at = bare.lastIndexOf("/");
  return { dir: at < 0 ? "" : path.slice(0, at + 1), name: path.slice(at + 1) };
}

/** The status letter, coloured, with its word for a screen reader. */
export function StatusLetter({ status }: { status: ChangeStatus }) {
  return (
    <>
      <span aria-hidden className={cn("w-3 shrink-0 text-center font-mono text-xs font-semibold", STATUS_TONE[status])}>
        {status === "?" ? "U" : status}
      </span>
      <span className="sr-only">{t(STATUS_WORD[status])}</span>
    </>
  );
}

/** `+N −M`, or "binary". An untracked folder has neither and shows nothing. */
function Counts({ file }: { file: ChangedFile }) {
  if (file.binary) return <span className="shrink-0 text-xs text-muted-foreground">{t("changes.binaryShort")}</span>;
  if (file.path.endsWith("/")) return null;
  return (
    <span className="shrink-0 font-mono text-xs tabular-nums">
      <span className="text-status-done">+{file.added}</span>{" "}
      <span className="text-status-blocked">−{file.removed}</span>
    </span>
  );
}

/** The path, the folder dimmed and the file name emphasised. The folder truncates first. */
export function ChangePath({ path, className }: { path: string; className?: string }) {
  const { dir, name } = splitPath(path);
  return (
    <span className={cn("flex min-w-0 font-mono text-[13px]", className)}>
      {dir && <span className="min-w-0 truncate text-muted-foreground">{dir}</span>}
      <span className="max-w-full shrink-0 truncate font-medium text-foreground">{name}</span>
    </span>
  );
}

/** The repos one under another, each named only when there is more than one. */
function RepoSections({
  repos,
  paneRepo,
  children,
}: {
  repos: readonly ChangedRepo[];
  /** The repo holding the asking pane's folder (the pane route only), marked "This pane". */
  paneRepo?: string;
  children: (repo: ChangedRepo) => React.ReactNode;
}) {
  useLocale();
  // One repo needs no heading: the header already names the folder.
  const headed = repos.length > 1;
  return (
    <div className="flex flex-col gap-4">
      {repos.map((repo) => {
        const mine = headed && repo.relPath === paneRepo;
        return (
          <section
            key={repo.relPath}
            aria-label={repo.name}
            data-pane-repo={mine ? "" : undefined}
            className="flex scroll-mt-4 flex-col"
          >
            {headed && (
              <SectionLabel className="mb-1.5 flex min-w-0 items-baseline gap-2 normal-case">
                <span className="min-w-0 truncate">{tn("changes.repoFiles", repo.files.length, { name: repo.name })}</span>
                {mine && <span className="shrink-0 text-primary">{t("changes.thisPane")}</span>}
              </SectionLabel>
            )}
            {children(repo)}
          </section>
        );
      })}
    </div>
  );
}

export function ChangesList({
  repos,
  paneRepo,
  onOpen,
}: {
  repos: readonly ChangedRepo[];
  paneRepo?: string;
  onOpen: (ref: ChangeRef) => void;
}) {
  return (
    <RepoSections repos={repos} paneRepo={paneRepo}>
      {(repo) => (
        <ListGroup as="ul">
          {repo.files.map((file) => (
            <li key={file.path}>
              <button
                type="button"
                onClick={() => onOpen({ repo: repo.relPath, path: file.path })}
                className="flex min-h-11 w-full items-center gap-3 px-3.5 py-2 text-left transition-colors active:bg-muted"
              >
                <StatusLetter status={file.status} />
                <ChangePath path={file.path} className="flex-1" />
                <Counts file={file} />
              </button>
            </li>
          ))}
        </ListGroup>
      )}
    </RepoSections>
  );
}

/** How wide each skeleton row's path bar is, so the rows read as a list and not as one block. */
const SKELETON_PATHS = ["68%", "52%", "80%", "44%", "60%"] as const;

/**
 * The list before its first answer: five rows in the real rows' own box (the 44px row, the status
 * letter's 12px slot, the path, the counts), each part a muted bar breathing like the Changes tab's
 * count line (`.count-skeleton` in index.css, still under reduced motion). The route shows it only
 * on a first read with nothing kept; a re-read never comes back here. `label` is announced once.
 */
export function ChangesListSkeleton({ label }: { label: string }) {
  return (
    <div role="status" data-slot="changes-skeleton">
      <span className="sr-only">{label}</span>
      <ListGroup as="ul" aria-hidden>
        {SKELETON_PATHS.map((width) => (
          <li key={width} className="flex min-h-11 w-full items-center gap-3 px-3.5 py-2">
            <span className="count-skeleton h-3 w-3 shrink-0 rounded-sm bg-muted" />
            <span className="flex min-w-0 flex-1">
              <span className="count-skeleton h-2.5 rounded-full bg-muted" style={{ width }} />
            </span>
            <span className="count-skeleton h-2.5 w-10 shrink-0 rounded-full bg-muted" />
          </li>
        ))}
      </ListGroup>
    </div>
  );
}

/** The collapse key of one folder: repo and folder path, so two repos' `src/` stay apart. */
export function folderKey(repo: string, folder: string): string {
  return `${repo}\n${folder}`;
}

/** 12px a level, and no deeper than eight levels, so a 375px row keeps room for the name. */
const INDENT_STEP = 12;
const INDENT_MAX_LEVELS = 8;
function indent(depth: number) {
  return { paddingLeft: 14 + Math.min(depth, INDENT_MAX_LEVELS) * INDENT_STEP };
}

/**
 * A name that truncates from the LEFT, so the end of a deep path (the part that tells two rows
 * apart) stays readable. The outer box runs right to left only to put the ellipsis on the left;
 * the text inside is isolated left to right, so `src/lib` never reads `lib/src`.
 */
function LeftTruncate({ text, className }: { text: string; className?: string }) {
  return (
    <span dir="rtl" className={cn("min-w-0 truncate text-left", className)}>
      <bdi dir="ltr">{text}</bdi>
    </span>
  );
}

function SumCounts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="shrink-0 font-mono text-xs tabular-nums">
      <span className="text-status-done">+{added}</span> <span className="text-status-blocked">−{removed}</span>
    </span>
  );
}

function TreeRows({
  repo,
  nodes,
  collapsed,
  onToggle,
  onOpen,
}: {
  repo: ChangedRepo;
  nodes: TreeNode[];
  collapsed: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onOpen: (ref: ChangeRef) => void;
}) {
  // The tree's own keys are bare folder paths; the shared set keys them by repo too.
  const closed = useMemo(() => {
    const prefix = folderKey(repo.relPath, "");
    return new Set([...collapsed].flatMap((k) => (k.startsWith(prefix) ? [k.slice(prefix.length)] : [])));
  }, [collapsed, repo.relPath]);
  const rows = visibleTreeRows(nodes, closed);
  return (
    <ListGroup as="ul">
      {rows.map((node) => {
        if (node.kind === "folder") {
          const open = !closed.has(node.key);
          return (
            <li key={`d:${node.key}`}>
              <button
                type="button"
                aria-expanded={open}
                aria-label={tn("changes.tree.folderAria", node.fileCount, { name: node.label })}
                onClick={() => onToggle(folderKey(repo.relPath, node.key))}
                style={indent(node.depth)}
                className="flex min-h-11 w-full items-center gap-3 py-2 pr-3.5 text-left transition-colors active:bg-muted"
              >
                <ChevronRight
                  aria-hidden
                  className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
                />
                <LeftTruncate text={`${node.label}/`} className="font-mono text-[13px] text-muted-foreground" />
                <span aria-hidden className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {node.fileCount}
                </span>
                <span className="flex-1" />
                {/* A folder of binaries or new folders has no line counts, and shows none. */}
                {(node.added > 0 || node.removed > 0) && <SumCounts added={node.added} removed={node.removed} />}
              </button>
            </li>
          );
        }
        return (
          <li key={`f:${node.key}`}>
            <button
              type="button"
              onClick={() => onOpen({ repo: repo.relPath, path: node.file.path })}
              style={indent(node.depth)}
              className="flex min-h-11 w-full items-center gap-3 py-2 pr-3.5 text-left transition-colors active:bg-muted"
            >
              <StatusLetter status={node.file.status} />
              <LeftTruncate text={node.name} className="flex-1 font-mono text-[13px] font-medium text-foreground" />
              <Counts file={node.file} />
            </button>
          </li>
        );
      })}
    </ListGroup>
  );
}

/**
 * The same files as a folder tree, per repo: folders first, single-folder chains compacted into one
 * row (`src/lib/`), every folder open unless its key is in `collapsed`.
 */
export function ChangesTree({
  repos,
  paneRepo,
  collapsed,
  onToggle,
  onOpen,
}: {
  repos: readonly ChangedRepo[];
  paneRepo?: string;
  collapsed: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onOpen: (ref: ChangeRef) => void;
}) {
  const trees = useMemo(() => new Map(repos.map((r) => [r.relPath, buildChangeTree(r.files)])), [repos]);
  return (
    <RepoSections repos={repos} paneRepo={paneRepo}>
      {(repo) => (
        <TreeRows
          repo={repo}
          nodes={trees.get(repo.relPath) ?? []}
          collapsed={collapsed}
          onToggle={onToggle}
          onOpen={onOpen}
        />
      )}
    </RepoSections>
  );
}

/** List or Tree: a two-way segmented choice of 44px squares, for the header. */
export function ChangesLayoutToggle({
  layout,
  onChange,
}: {
  layout: ChangesLayout;
  onChange: (layout: ChangesLayout) => void;
}) {
  useLocale();
  const options = [
    { value: "list", label: t("changes.layout.list"), Icon: List },
    { value: "tree", label: t("changes.layout.tree"), Icon: ListTree },
  ] as const;
  return (
    <div role="radiogroup" aria-label={t("changes.layout.aria")} className="flex shrink-0 rounded-md">
      {options.map(({ value, label, Icon }) => {
        const selected = value === layout;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={label}
            onClick={() => onChange(value)}
            className={cn(
              "flex size-11 items-center justify-center rounded-md transition-colors",
              selected ? "bg-muted text-foreground" : "text-muted-foreground active:bg-muted",
            )}
          >
            <Icon className="size-5" />
          </button>
        );
      })}
    </div>
  );
}

/**
 * The header's Filter button. While a filter is on it takes the primary tint and a small count of
 * the files still shown, drawn over its corner so the header never re-lays-out.
 */
export function ChangesFilterButton({
  open,
  active,
  shown,
  total,
  onClick,
}: {
  open: boolean;
  active: boolean;
  shown: number;
  total: number;
  onClick: () => void;
}) {
  useLocale();
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={active ? t("changes.filter.buttonActive", { shown, total }) : t("changes.filter.button")}
      onClick={onClick}
      className={cn(
        "relative flex size-11 shrink-0 items-center justify-center rounded-md transition-colors",
        active ? "bg-primary/10 text-primary" : open ? "bg-muted text-foreground" : "text-muted-foreground active:bg-muted",
      )}
    >
      <ListFilter className="size-5" />
      {active && (
        <span
          aria-hidden
          className="absolute right-0.5 top-0.5 min-w-4 rounded-full bg-primary px-1 text-center text-[10px] font-semibold leading-4 tabular-nums text-primary-foreground"
        >
          {shown}
        </span>
      )}
    </button>
  );
}

/** What the list shows when the filter leaves nothing: the sentence and the way out. */
export function ChangesNoMatch({ onClear }: { onClear: () => void }) {
  useLocale();
  return (
    <div className="flex flex-col items-center gap-2 py-12">
      <p className="text-sm text-muted-foreground">{t("changes.filter.none")}</p>
      <button
        type="button"
        onClick={onClear}
        className="flex min-h-11 items-center rounded-md px-4 text-sm font-medium text-primary active:bg-muted"
      >
        {t("changes.filter.clear")}
      </button>
    </div>
  );
}

const CHIP_STATUS = { M: "M", A: "A", D: "D", R: "R", U: "?" } as const satisfies Record<FilterStatus, ChangeStatus>;

/**
 * The filter row: a path field with a clear button, the status chips, and the "3 of 12" count with
 * its own Clear action. The trailing group is always there, only hidden (not removed) while no
 * filter is on, so typing the first letter moves nothing. Drawn inside `ChangesFilterOverlay`,
 * which supplies the card's border, shadow and background.
 */
export function ChangesFilterBar({
  filter,
  onChange,
  onClear,
  shown,
  total,
  focusOnMount = false,
}: {
  filter: ChangesFilter;
  onChange: (filter: ChangesFilter) => void;
  /** Resets the whole filter — query and status chips — from a control that lives IN the row, so
   *  it stays reachable while the overlay covers the "no match" screen's own Clear button below it. */
  onClear: () => void;
  shown: number;
  total: number;
  /** Put the caret in the path field when the row appears: the operator opened it to type. */
  focusOnMount?: boolean;
}) {
  useLocale();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusOnMount) input.current?.focus();
  }, [focusOnMount]);
  const active = isFilterActive(filter);
  const toggle = (s: FilterStatus) =>
    onChange({
      ...filter,
      statuses: filter.statuses.includes(s) ? filter.statuses.filter((x) => x !== s) : [...filter.statuses, s],
    });
  return (
    <div className="flex flex-col gap-1 px-4 pt-2 pb-1" data-slot="changes-filter">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          inputMode="search"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          ref={input}
          value={filter.query}
          onChange={(e) => onChange({ ...filter, query: e.target.value })}
          placeholder={t("changes.filter.placeholder")}
          aria-label={t("changes.filter.placeholder")}
          className="h-11 w-full rounded-md border border-input bg-transparent pl-9 pr-11 font-mono text-base placeholder:font-sans placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        />
        {filter.query !== "" && (
          <button
            type="button"
            aria-label={t("changes.filter.clearText")}
            onClick={() => onChange({ ...filter, query: "" })}
            className="absolute right-0 top-0 flex size-11 items-center justify-center text-muted-foreground"
          >
            <X className="size-4" />
          </button>
        )}
      </div>
      <div className="flex items-center">
        <div role="group" aria-label={t("changes.filter.statusAria")} className="-ml-1.5 flex">
          {FILTER_STATUSES.map((s) => {
            const on = filter.statuses.includes(s);
            return (
              <button
                key={s}
                type="button"
                aria-pressed={on}
                aria-label={t(STATUS_WORD[CHIP_STATUS[s]])}
                onClick={() => toggle(s)}
                className="flex h-11 min-w-11 items-center justify-center"
              >
                <span
                  aria-hidden
                  className={cn(
                    "flex size-8 items-center justify-center rounded-full border font-mono text-xs font-semibold transition-colors",
                    on ? "border-primary bg-primary text-primary-foreground" : cn("border-border", STATUS_TONE[CHIP_STATUS[s]]),
                  )}
                >
                  {s}
                </span>
              </button>
            );
          })}
        </div>
        <div className={cn("ml-auto flex shrink-0 items-center gap-1 pl-2", !active && "invisible")}>
          <span aria-live="polite" className="truncate text-xs tabular-nums text-muted-foreground">
            {t("changes.filter.shown", { shown, total })}
          </span>
          <button
            type="button"
            onClick={onClear}
            className="flex h-8 shrink-0 items-center rounded-md px-2 text-xs font-medium text-primary active:bg-muted"
          >
            {t("changes.filter.clear")}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The filter row as a floating card, drawn OVER the list rather than pushing it down. The caller
 * wraps its header slot in a `relative` box and renders this right after it — `top-full` then lands
 * on that box's own bottom edge, whatever height it is (zero, when the header itself is a portal
 * target elsewhere and contributes none). Opening and closing move nothing: this is `absolute`, out
 * of flow, and never touches the header's or the list's own box.
 *
 * A tap outside the card, or Escape, closes it; the filter itself stays applied — the dismiss
 * surface only ever calls `onClose`. It is a plain `fixed` button, not a scrim (no dimming: this is
 * a quick, reversible narrowing of a list, not a blocking question), and it sits BELOW the header's
 * own stacking (`z-10` under the header's `z-20`) on purpose: a tap on the Filter button that opened
 * this always reaches the button itself, never the dismiss surface, so it is the button's own toggle
 * that closes it in that case, not this one.
 *
 * The text field autofocuses itself (`focusOnMount` below); this only RESTORES focus on close, to
 * whatever held it before the field took it. It reads that target in a LAYOUT effect, which runs
 * before the field's own (passive) focus effect app-wide, so it can never read the field itself back
 * as "the thing to give focus to" — the ordinary case is the Filter button, which gets its focus
 * back on Escape or an outside tap exactly as it would from a second tap on itself.
 *
 * DESIGN.md's corner rule: rounded corners take a uniform 1px border on all four sides plus a soft
 * shadow, never a thick left accent.
 */
export function ChangesFilterOverlay({
  open,
  onClose,
  filter,
  onChange,
  onClear,
  shown,
  total,
}: {
  open: boolean;
  onClose: () => void;
  filter: ChangesFilter;
  onChange: (filter: ChangesFilter) => void;
  onClear: () => void;
  shown: number;
  total: number;
}) {
  useLocale();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useLayoutEffect(() => {
    if (!open) return;
    // SAFETY: `document.activeElement` is typed `Element | null`; the only thing read off it below
    // is the optional `focus()`, which is what makes it an HTMLElement in practice. The optional
    // call is what covers the case where it isn't one (an SVG element, say) — same reasoning as
    // `ui/sheet.tsx`'s `useDialogFocus`, which this mirrors for the restore half only.
    const previouslyFocused = document.activeElement as HTMLElement | null;
    return () => previouslyFocused?.focus?.();
  }, [open]);

  if (!open) return null;

  return (
    <>
      {/* The dismiss surface: hidden from assistive tech (the dialog below is the one accessible
          name, so nothing announces "Filter files" twice), but still dismisses on tap — the same
          rule the sheet's own backdrop follows. Press and release must both land here, so the
          release of the tap that OPENED this card never closes it again in the same gesture. */}
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        className="fixed inset-0 z-10 cursor-default"
        onPointerDown={(e) => {
          e.currentTarget.dataset.armed = "1";
        }}
        onClick={(e) => {
          if (e.currentTarget.dataset.armed === "1") onClose();
        }}
      />
      <div role="dialog" aria-label={t("changes.filter.button")} className="absolute inset-x-0 top-full z-20 px-4 pt-2">
        <div className="overflow-hidden rounded-md border border-border bg-card shadow-lg">
          <ChangesFilterBar filter={filter} onChange={onChange} onClear={onClear} shown={shown} total={total} focusOnMount />
        </div>
      </div>
    </>
  );
}

const ROW_TONE = {
  add: "bg-status-done/12",
  del: "bg-status-blocked/12",
  context: "",
} as const;

const SIGN = { add: "+", del: "−", context: " " } as const;
const SIGN_TONE = { add: "text-status-done", del: "text-status-blocked", context: "" } as const;

/**
 * The ink per token kind (`--syntax-*` in index.css, AA on plain and tinted rows in both themes).
 * Colour only: no weight and no italic, so a coloured line has the same glyphs and the same line
 * boxes as the plain one it replaces. Kinds with no entry keep the row's own ink.
 */
const TOKEN_TONE = new Map<SyntaxToken["type"], string>([
  ["keyword", "text-syntax-keyword"],
  ["string", "text-syntax-string"],
  ["class", "text-syntax-constant"],
  ["property", "text-syntax-property"],
  ["entity", "text-syntax-entity"],
  ["comment", "text-syntax-comment"],
]);

/** A line's tokens as spans, neighbours of the same ink merged into one. Text nodes only. */
function TokenLine({ tokens }: { tokens: readonly SyntaxToken[] }) {
  const runs: { tone: string | undefined; text: string }[] = [];
  for (const token of tokens) {
    const tone = TOKEN_TONE.get(token.type);
    const last = runs.at(-1);
    if (last && last.tone === tone) last.text += token.value;
    else runs.push({ tone, text: token.value });
  }
  return runs.map((run, i) => (
    <span key={i} className={run.tone}>
      {run.text}
    </span>
  ));
}

/**
 * The rows' syntax tokens, once sugar-high has loaded, or null until then and for a file with no
 * known language or a diff too long to colour. The first diff of a language draws plain first and
 * takes colour when the highlighter arrives. After that the colour is computed in the same render as
 * the rows, so a diff that changes under the open view (the 5 s re-read) never flashes plain: its
 * unchanged lines come out with the same tokens, and React leaves their spans alone.
 */
function useSyntaxTokens(rows: readonly DiffRow[], path: string | undefined) {
  const lang = path === undefined ? null : languageForPath(path);
  const lines = useMemo(() => rows.filter((r) => r.kind !== "hunk" && r.kind !== "note").length, [rows]);
  const colourable = lang !== null && lines <= HIGHLIGHT_MAX_LINES;
  const now = useMemo(
    () => (colourable && lang !== null ? highlightDiffNow(rows, lang) : null),
    [colourable, rows, lang],
  );
  const [done, setDone] = useState<{ rows: readonly DiffRow[]; tokens: RowTokens } | null>(null);
  useEffect(() => {
    if (!colourable || lang === null || now !== null) return;
    let live = true;
    const colour = async () => {
      try {
        const tokens = await highlightDiff(rows, lang);
        if (live) setDone({ rows, tokens });
      } catch {
        // No highlighter (offline, a stale chunk): the plain rows are the whole answer.
      }
    };
    void colour();
    return () => {
      live = false;
    };
  }, [colourable, now, rows, lang]);
  return now ?? (done?.rows === rows ? done.tokens : null);
}

/**
 * A key per row that follows the row's content, not its index: a line added above keeps every row
 * below on its own element, so React moves nothing but the new row in and the line numbers that
 * really changed. The nth repeat of the same line gets its own key.
 */
export function diffRowKeys(rows: readonly DiffRow[]): string[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const base = row.kind === "hunk" ? `h\u0000${row.header}` : `${row.kind}\u0000${row.text}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return `${base}\u0000${n}`;
  });
}

/**
 * One file's diff: two line-number gutters, a sign, the line. Long lines WRAP (a phone cannot
 * scroll sideways through code comfortably), anywhere, so a minified line cannot push the page wide.
 * With `path` naming a language sugar-high knows, the lines take syntax colour once it loads.
 */
export function DiffView({ diff, path }: { diff: string; path?: string }) {
  const parsed = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const keys = useMemo(() => diffRowKeys(parsed.rows), [parsed]);
  const syntax = useSyntaxTokens(parsed.rows, path);
  // Both gutters sized once, by the widest number, so no row's text starts at a different x.
  const gutter = { width: `calc(${Math.max(String(parsed.maxLineNo).length, 2)}ch + 0.5rem)` };
  return (
    // Ligatures off: a diff is read character by character, and `=>` drawn as one arrow hides what
    // the file holds.
    <div
      className="font-mono text-xs leading-5 [font-variant-ligatures:none]"
      data-slot="diff"
      data-highlighted={syntax ? "" : undefined}
    >
      {parsed.rows.map((row, i) => {
        if (row.kind === "hunk") {
          return (
            <div
              key={keys[i]}
              className="border-y border-border px-3 py-1 text-muted-foreground wrap-anywhere whitespace-pre-wrap first:border-t-0"
            >
              {row.header}
            </div>
          );
        }
        if (row.kind === "note") {
          return (
            <div key={keys[i]} className="px-3 text-muted-foreground italic">
              {row.text}
            </div>
          );
        }
        return (
          <div key={keys[i]} className={cn("flex pl-1", ROW_TONE[row.kind])}>
            <span aria-hidden className="shrink-0 select-none pr-2 text-right text-muted-foreground tabular-nums" style={gutter}>
              {row.oldNo ?? ""}
            </span>
            <span aria-hidden className="shrink-0 select-none pr-2 text-right text-muted-foreground tabular-nums" style={gutter}>
              {row.newNo ?? ""}
            </span>
            <span aria-hidden className={cn("w-[2ch] shrink-0 select-none text-center", SIGN_TONE[row.kind])}>
              {SIGN[row.kind]}
            </span>
            <span className="min-w-0 flex-1 pr-3 wrap-anywhere whitespace-pre-wrap">
              {row.kind === "add" && <span className="sr-only">+ </span>}
              {row.kind === "del" && <span className="sr-only">− </span>}
              {syntax?.[i] ? <TokenLine tokens={syntax[i]} /> : row.text}
            </span>
          </div>
        );
      })}
    </div>
  );
}
