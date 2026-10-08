import { GitBranch, GitCommitHorizontal } from "lucide-react";

import { t } from "@/lib/i18n";
import { shortSha } from "@/lib/git-head";
import type { GitHead } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useLocale } from "@/hooks/use-locale";

/** The characters of a long name that never give way: the tail tells two siblings apart. */
const TAIL = 8;
/** A name this short or shorter is never split, so a short name truncates the ordinary way. */
const SPLIT_FROM = TAIL + 6;

/**
 * THE BRANCH, on one line: a branch glyph and the name, or a commit glyph and `detached @abc1234`.
 *
 * A long name gives way IN THE MIDDLE and keeps its tail, because the tail is what tells
 * `perf/dashboard-poll-cadence-and-backoff` from `perf/dashboard-poll-cadence-and-jitter`: two spans,
 * the head truncates and the last {@link TAIL} characters never do. The name is mono, because a branch
 * is a machine identifier read character by character (DESIGN.md §5, mono vs sans), at 11px with a
 * 16px line box, the size it takes on every surface. The caller sets the line box on a surface whose
 * line is shorter (`leading-3` in the pane header) and the width it may take.
 *
 * The drawn text is hidden from a screen reader, which reads the whole name in words instead
 * ("Branch fix-login"), since the eye's version may be cut. Owns no tap: a caller that wants one
 * wraps it.
 */
export function BranchLabel({ head, className }: { head: GitHead; className?: string }) {
  useLocale();
  const branch = head.kind === "branch";
  const words = branch ? t("branch.aria", { name: head.name }) : t("branch.detachedAria", { sha: shortSha(head.sha) });
  const split = branch && head.name.length > SPLIT_FROM;
  return (
    <span
      data-slot="branch-label"
      title={branch ? head.name : head.sha}
      className={cn("flex min-w-0 items-center gap-1 font-mono text-[11px] leading-4", className)}
    >
      {branch ? (
        <GitBranch aria-hidden className="size-3 shrink-0" />
      ) : (
        <GitCommitHorizontal aria-hidden className="size-3 shrink-0" />
      )}
      <span aria-hidden className="flex min-w-0">
        {branch ? (
          <>
            <span className="min-w-0 truncate">{split ? head.name.slice(0, -TAIL) : head.name}</span>
            {split && <span className="shrink-0">{head.name.slice(-TAIL)}</span>}
          </>
        ) : (
          <span className="min-w-0 truncate">{t("branch.detached", { sha: shortSha(head.sha) })}</span>
        )}
      </span>
      <span className="sr-only">{words}</span>
    </span>
  );
}
