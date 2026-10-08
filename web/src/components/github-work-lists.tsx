import { useId, type ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";

import { SectionHeader } from "@/components/section-header";
import { StatusChip } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { ListGroup } from "@/components/ui/list-group";
import { useLocale } from "@/hooks/use-locale";
import { timeAgoShort } from "@/lib/format";
import { byStanding, issuesByRepo, prChips, searchUrl, type GithubListName, type GithubWorkOk } from "@/lib/github";
import { t } from "@/lib/i18n";
import type { GithubIssue, GithubList, GithubPr } from "@/lib/types";

// The three lists of the GitHub screen (routes/github.tsx, ADR 0091), in their fixed order: my pull
// requests, stuck first; the ones waiting on my review; and the issues assigned to me, grouped by
// repo. Every row is a link to GitHub in a new tab and nothing else: the screen is read-only, so no
// row carries an act.
//
// WHO WROTE WHAT, which decides the face (DESIGN.md §5): a title is a person's words, so it wears
// `font-content`; `owner/repo #123`, a login and a label are identifiers GitHub hands back, compared
// character by character, so they are `font-mono`; the chips, the ages and the counts are the app
// talking, in its own face.

/** Every row's link: a new tab, and no opener handed to GitHub. One spelling for the three lists. */
const EXTERNAL = { target: "_blank", rel: "noopener noreferrer" } as const;

/**
 * A row's box. `min-h-11` is the 44px tap floor (§6); the 14px inset puts the text on the same x as a
 * Card's content (ui/list-group.tsx). The press tint is paint only, so a tap moves nothing (§2).
 */
const ROW =
  "flex min-h-11 flex-col gap-1 px-3.5 py-2.5 transition-colors active:bg-muted/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export function GithubWorkLists({ work, now }: { work: GithubWorkOk; now: number }): ReactNode {
  useLocale();
  return (
    <div className="flex flex-col gap-6">
      <ListSection
        label={t("github.section.mine")}
        list={work.mine}
        search="mine"
        empty={t("github.empty.mine")}
      >
        {byStanding(work.mine.items).map((pr) => (
          <PrRow key={pr.url} pr={pr} now={now} showAuthor={false} />
        ))}
      </ListSection>
      <ListSection
        label={t("github.section.review")}
        list={work.review}
        search="review"
        empty={t("github.empty.review")}
      >
        {work.review.items.map((pr) => (
          <PrRow key={pr.url} pr={pr} now={now} showAuthor />
        ))}
      </ListSection>
      <IssuesSection list={work.issues} now={now} />
    </div>
  );
}

/**
 * One list: its heading with the whole count GitHub reported, its rows in one framed group (or a
 * sentence saying it is empty, inside the same frame, so an empty list is still a list), and the
 * overflow line when GitHub has more than the 30 the bridge asked for.
 */
function ListSection<T extends { url: string }>({
  label,
  list,
  search,
  empty,
  children,
}: {
  label: string;
  list: GithubList<T>;
  search: GithubListName;
  empty: string;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <SectionHeader id={headingId} label={label} count={list.total} />
      <ListGroup as="ul">
        {list.items.length === 0 ? <li className="px-3.5 py-3 text-sm text-muted-foreground">{empty}</li> : children}
      </ListGroup>
      <Overflow list={list} search={search} />
    </section>
  );
}

/**
 * "30 of 86 · See all on GitHub": the list is GitHub's first 30, and the rest are one tap away on
 * GitHub's own search for the same query. Drawn only when GitHub has more; a short list says nothing.
 */
function Overflow<T extends { url: string }>({
  list,
  search,
}: {
  list: GithubList<T>;
  search: GithubListName;
}) {
  if (list.total <= list.items.length) return null;
  return (
    <a
      href={searchUrl(search, list.items[0]?.url)}
      {...EXTERNAL}
      className="flex min-h-11 items-center justify-between gap-3 text-xs text-muted-foreground active:text-foreground"
    >
      <span className="tabular-nums">{t("github.overflow", { shown: list.items.length, total: list.total })}</span>
      <span className="flex items-center gap-1">
        {t("github.overflow.link")}
        <ArrowUpRight className="size-3.5" aria-hidden />
      </span>
    </a>
  );
}

/** One pull request: title and age, `owner/repo #123` (and its author, for someone else's), its chips. */
function PrRow({ pr, now, showAuthor }: { pr: GithubPr; now: number; showAuthor: boolean }) {
  return (
    <li>
      <a href={pr.url} {...EXTERNAL} className={ROW}>
        <RowHead title={pr.title} updatedAt={pr.updatedAt} now={now} />
        <span className="truncate font-mono text-[11px] text-muted-foreground">
          {pr.repo} #{pr.number}
          {showAuthor && pr.author !== null && ` · @${pr.author}`}
        </span>
        <span className="flex flex-wrap gap-1">
          {prChips(pr).map((chip) => (
            <StatusChip key={chip.key} status={chip.tone}>
              {chip.word}
            </StatusChip>
          ))}
        </span>
        <span className="sr-only">{t("github.row.newTab")}</span>
      </a>
    </li>
  );
}

/** A row's first line: the title, two lines at most, and how long ago GitHub saw it move. */
function RowHead({ title, updatedAt, now }: { title: string; updatedAt: string; now: number }) {
  const ms = Date.parse(updatedAt);
  return (
    <span className="flex items-baseline gap-3">
      <span className="line-clamp-2 min-w-0 flex-1 font-content text-sm leading-snug text-foreground">{title}</span>
      {!Number.isNaN(ms) && (
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{timeAgoShort(ms, now)}</span>
      )}
    </span>
  );
}

/** Assigned issues, one framed group per repo under the repo's slug, the most recently moved repo first. */
function IssuesSection({ list, now }: { list: GithubList<GithubIssue>; now: number }) {
  const headingId = useId();
  const groups = issuesByRepo(list.items);
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <SectionHeader id={headingId} label={t("github.section.issues")} count={list.total} />
      {groups.length === 0 ? (
        <ListGroup as="ul">
          <li className="px-3.5 py-3 text-sm text-muted-foreground">{t("github.empty.issues")}</li>
        </ListGroup>
      ) : (
        groups.map((group) => (
          <div key={group.repo} className="flex flex-col gap-1.5">
            <h3 className="truncate font-mono text-[11px] text-muted-foreground">{group.repo}</h3>
            <ListGroup as="ul">
              {group.issues.map((issue) => (
                <IssueRow key={issue.url} issue={issue} now={now} />
              ))}
            </ListGroup>
          </div>
        ))
      )}
      <Overflow list={list} search="issues" />
    </section>
  );
}

/**
 * One issue: title and age, its number, and its labels by NAME. A label's colour is the repo's
 * choice and could be any red, and red on this screen is kept for what is stuck (DESIGN.md §4), so
 * the colour stays on GitHub.
 */
function IssueRow({ issue, now }: { issue: GithubIssue; now: number }) {
  return (
    <li>
      <a href={issue.url} {...EXTERNAL} className={ROW}>
        <RowHead title={issue.title} updatedAt={issue.updatedAt} now={now} />
        <span className="flex flex-wrap items-center gap-1">
          <span className="mr-1 font-mono text-[11px] text-muted-foreground">#{issue.number}</span>
          {issue.labels.map((label) => (
            <Badge key={label.name} variant="outline" className="font-content font-normal text-muted-foreground">
              {label.name}
            </Badge>
          ))}
        </span>
        <span className="sr-only">{t("github.row.newTab")}</span>
      </a>
    </li>
  );
}
