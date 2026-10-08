import type { ReactNode } from "react";
import { ChevronRight, GitPullRequest } from "lucide-react";

import { Collapse } from "@/components/ui/collapse";
import { useGithubPeek } from "@/hooks/use-github-work";
import { useLocale } from "@/hooks/use-locale";
import { useNav } from "@/hooks/use-nav";
import type { GithubWorkAnswer } from "@/lib/api";
import { stuckCount } from "@/lib/github";
import { t, tn } from "@/lib/i18n";
import { githubPath } from "@/lib/nav";
import { scopeKey, type Scope } from "@/lib/scope";
import { cn } from "@/lib/utils";

/**
 * The dashboard's way into /github (ADR 0091): a muted line in the meta footer, beside the crew line.
 *
 * ── WHY THE FOOTER AND NOT A TAB ─────────────────────────────────────────────
 * ADR 0085 fixes the dashboard's tabs, and GitHub work is not the herd: it is a report one level out,
 * the same kind of question as "how is my crew doing", which is why it sits beside CrewFooterLink.
 *
 * ── IT ONLY PEEKS ────────────────────────────────────────────────────────────
 * `?peek=1` never makes the bridge run `gh`. So the line is drawn only when the machine says the
 * feature is on (anything but `off`, and not a machine whose Collie predates it), and its counts are
 * whatever the bridge last fetched for the screen: stuck PRs of mine and reviews waiting on me. A
 * dashboard that has never opened the screen shows the bare word, and opening it is what fetches.
 *
 * It arrives through `Collapse` (DESIGN.md §11), so the update banner and the build stamp under it
 * slide rather than jump when the peek answers. Keyed by scope: another machine's line starts closed.
 */
export function GithubFooterLink({ scope, className }: { scope?: Scope; className?: string }): ReactNode {
  return <GithubFooterLine key={scopeKey(scope)} scope={scope} className={className} />;
}

function GithubFooterLine({ scope, className }: { scope: Scope | undefined; className: string | undefined }) {
  const answer = useGithubPeek(scope);
  const shown = answer !== null && answer.state !== "off" && answer.state !== "absent";
  return <Collapse open={shown}>{shown && <Line answer={answer} scope={scope} className={className} />}</Collapse>;
}

function Line({
  answer,
  scope,
  className,
}: {
  answer: GithubWorkAnswer;
  scope: Scope | undefined;
  className: string | undefined;
}) {
  const nav = useNav();
  useLocale();
  const label =
    answer.state === "ok"
      ? t("github.footer.counts", {
          stuck: tn("github.footer.stuck", stuckCount(answer.mine.items)),
          review: tn("github.footer.review", answer.review.total),
        })
      : t("github.title");
  return (
    // The padding lives on the line, inside the Collapse, so the air above it closes with it.
    <button
      type="button"
      onClick={() => nav.down(githubPath(scope))}
      aria-label={t("github.footer.aria")}
      className={cn(
        "flex w-full items-center justify-center gap-1.5 text-[11px] leading-relaxed text-muted-foreground active:text-foreground",
        className,
      )}
    >
      <GitPullRequest className="size-3 shrink-0" aria-hidden />
      <span className="tabular-nums">{label}</span>
      <ChevronRight className="size-3 shrink-0" aria-hidden />
    </button>
  );
}
