import { GitCommitHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ListGroup } from "@/components/ui/list-group";
import { useLocale } from "@/hooks/use-locale";
import { timeAgo } from "@/lib/format";
import { t } from "@/lib/i18n";
import type { CleanRepo, CommitInfo } from "@/lib/types";

// The commit view's two drawings (ADR 0065, the commit view). Agents commit their own work, so the
// Changes list goes empty right after the change the operator most wants to read: `CleanRepos`
// offers each clean repo's last commit, and `CommitHead` names that commit above its file list.
// Presentational only. The subject and the author are machine-authored text, drawn as text nodes.

/**
 * "Show last commit" per clean repo. One repo gets one button under the empty sentence; several get
 * a compact list, one row a repo, each with its own button named for that repo. Only repos with at
 * least one commit are ever passed in (the bridge's `clean`).
 */
export function CleanRepos({
  repos,
  onShow,
  rows = false,
}: {
  repos: readonly CleanRepo[];
  onShow: (repo: string) => void;
  /** Always the named rows, even for one repo: under a list of other repos' changes, a bare
   *  button would not say which repo it opens. */
  rows?: boolean;
}) {
  useLocale();
  if (repos.length === 0) return null;
  if (repos.length === 1 && !rows) {
    return (
      <div className="flex justify-center">
        <Button variant="outline" className="h-11" onClick={() => onShow(repos[0]!.relPath)}>
          <GitCommitHorizontal className="size-4" />
          {t("changes.commit.show")}
        </Button>
      </div>
    );
  }
  return (
    <ListGroup as="ul">
      {repos.map((repo) => (
        <li key={repo.relPath} className="flex min-h-11 items-center gap-3 py-1 pl-3.5 pr-1.5">
          <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{repo.name}</span>
          <Button
            variant="ghost"
            className="h-11 shrink-0 text-primary"
            aria-label={t("changes.commit.showFor", { name: repo.name })}
            onClick={() => onShow(repo.relPath)}
          >
            {t("changes.commit.show")}
          </Button>
        </li>
      ))}
    </ListGroup>
  );
}

/**
 * The commit above its files: the subject (two lines at most), then the short hash, the author and
 * how long ago. Under it, two quiet lines that each appear only when true: a newer commit exists
 * (a tap loads it; the files on screen never change under the reader), and the repo has new
 * uncommitted changes (a tap goes back to the list). Both sit in a slot that is always there, so
 * one appearing moves nothing below it.
 */
export function CommitHead({
  commit,
  newer,
  uncommitted,
  onLoadNewer,
  onShowUncommitted,
  now,
}: {
  commit: CommitInfo;
  newer: boolean;
  uncommitted: boolean;
  onLoadNewer: () => void;
  onShowUncommitted: () => void;
  /** The clock for the relative time, for a test. */
  now?: number;
}) {
  useLocale();
  return (
    <div className="flex flex-col gap-1">
      <p className="line-clamp-2 text-base font-medium leading-snug wrap-anywhere">{commit.subject}</p>
      <p className="flex min-w-0 items-baseline gap-1.5 text-xs text-muted-foreground">
        <span className="shrink-0 font-mono">{commit.shortHash}</span>
        <span aria-hidden>·</span>
        <span className="min-w-0 truncate">{commit.author}</span>
        <span aria-hidden>·</span>
        <time className="shrink-0" dateTime={new Date(commit.time * 1000).toISOString()}>
          {timeAgo(commit.time * 1000, now)}
        </time>
      </p>
      <div role="status" className="flex min-h-5 flex-wrap gap-x-4 text-xs">
        {newer && (
          <button type="button" onClick={onLoadNewer} className="text-primary underline underline-offset-2">
            {t("changes.commit.newer")}
          </button>
        )}
        {uncommitted && (
          <button type="button" onClick={onShowUncommitted} className="text-primary underline underline-offset-2">
            {t("changes.commit.uncommitted")}
          </button>
        )}
      </div>
    </div>
  );
}
