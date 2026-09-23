import { useMemo } from "react";

import { ListGroup } from "@/components/ui/list-group";
import { SectionLabel } from "@/components/ui/section-label";
import { useLocale } from "@/hooks/use-locale";
import { t, tn, type MessageKey } from "@/lib/i18n";
import type { ChangedFile, ChangedRepo, ChangeStatus } from "@/lib/types";
import { parseUnifiedDiff } from "@/lib/unified-diff";
import { cn } from "@/lib/utils";

// The Changes view's two drawings (ADR 0065): the list of changed files, grouped by repo, and one
// file's diff as plain monospace rows. Presentational only, so the route and the playground mount
// the same markup. Paths and diff lines are machine-authored content: `font-mono`, rendered as text
// nodes, never as markup.

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

/** Every file of every repo, in the order the list draws them. */
export function flattenChanges(repos: readonly ChangedRepo[]): ChangeRef[] {
  return repos.flatMap((r) => r.files.map((f) => ({ repo: r.relPath, path: f.path })));
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

export function ChangesList({
  repos,
  onOpen,
}: {
  repos: readonly ChangedRepo[];
  onOpen: (ref: ChangeRef) => void;
}) {
  useLocale();
  // One repo needs no heading: the header already names the folder.
  const headed = repos.length > 1;
  return (
    <div className="flex flex-col gap-4">
      {repos.map((repo) => (
        <section key={repo.relPath} aria-label={repo.name} className="flex flex-col">
          {headed && (
            <SectionLabel className="mb-1.5 truncate normal-case">
              {tn("changes.repoFiles", repo.files.length, { name: repo.name })}
            </SectionLabel>
          )}
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
        </section>
      ))}
    </div>
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
 * One file's diff: two line-number gutters, a sign, the line. Long lines WRAP (a phone cannot
 * scroll sideways through code comfortably), anywhere, so a minified line cannot push the page wide.
 */
export function DiffView({ diff }: { diff: string }) {
  const parsed = useMemo(() => parseUnifiedDiff(diff), [diff]);
  // Both gutters sized once, by the widest number, so no row's text starts at a different x.
  const gutter = { width: `calc(${Math.max(String(parsed.maxLineNo).length, 2)}ch + 0.5rem)` };
  return (
    // Ligatures off: a diff is read character by character, and `=>` drawn as one arrow hides what
    // the file holds.
    <div className="font-mono text-xs leading-5 [font-variant-ligatures:none]" data-slot="diff">
      {parsed.rows.map((row, i) => {
        if (row.kind === "hunk") {
          return (
            <div
              key={i}
              className="border-y border-border px-3 py-1 text-muted-foreground wrap-anywhere whitespace-pre-wrap first:border-t-0"
            >
              {row.header}
            </div>
          );
        }
        if (row.kind === "note") {
          return (
            <div key={i} className="px-3 text-muted-foreground italic">
              {row.text}
            </div>
          );
        }
        return (
          <div key={i} className={cn("flex pl-1", ROW_TONE[row.kind])}>
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
              {row.text}
            </span>
          </div>
        );
      })}
    </div>
  );
}
