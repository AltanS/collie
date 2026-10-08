import { t, tn } from "@/lib/i18n";
import type { AgentStatus, GithubIssue, GithubPr, GithubWorkResponse } from "@/lib/types";

// What the GitHub screen (routes/github.tsx) and its footer line (components/github-footer-link.tsx)
// make of the bridge's answer (ADR 0091). Pure: no fetch, no React. The words come from the
// dictionary; the PR titles, repo slugs and labels are GitHub's and are never translated.

/** The answer once it is `ok`: the only state with lists in it. */
export type GithubWorkOk = Extract<GithubWorkResponse, { state: "ok" }>;

/**
 * Where one of MY pull requests stands, which decides its place in the list and nothing else:
 *  - stuck: something has to change before it can land: checks failing, changes requested, or a
 *    conflict;
 *  - ready: approved, its checks green (or it has none), and GitHub says it merges cleanly;
 *  - waiting: everything else: checks running, a review not given yet, a draft, or a merge state
 *    GitHub has not computed. `unknown` is never read as "no conflict" (ADR 0091), so a PR whose
 *    merge state is unknown is waiting, never ready.
 */
export type PrStanding = "stuck" | "waiting" | "ready";

export function prStanding(pr: GithubPr): PrStanding {
  if (pr.checks === "failure" || pr.review === "changes-requested" || pr.mergeable === "conflicting") return "stuck";
  const greenChecks = pr.checks === "success" || pr.checks === "none";
  if (!pr.draft && pr.review === "approved" && greenChecks && pr.mergeable === "mergeable") return "ready";
  return "waiting";
}

const STANDING_RANK = { stuck: 0, waiting: 1, ready: 2 } as const satisfies Record<PrStanding, number>;

/**
 * My pull requests, stuck first, then waiting, then ready. The sort is stable, so inside one standing
 * the order stays GitHub's own (most recently updated first, from the search's `sort:updated-desc`).
 */
export function byStanding(prs: readonly GithubPr[]): GithubPr[] {
  return prs.toSorted((a, b) => STANDING_RANK[prStanding(a)] - STANDING_RANK[prStanding(b)]);
}

/** How many of my pull requests are stuck: the footer line's first count. */
export function stuckCount(prs: readonly GithubPr[]): number {
  return prs.filter((pr) => prStanding(pr) === "stuck").length;
}

/** One repo's assigned issues, as the screen groups them. */
export interface RepoIssues {
  repo: string;
  issues: GithubIssue[];
}

/** An ISO stamp as epoch ms, with an unreadable one sorting last rather than throwing. */
function stampOf(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/**
 * Assigned issues grouped by repo. The repo whose newest issue was updated most recently comes
 * first, and inside a repo the issues run newest first: the order the operator would scan for "what
 * moved".
 */
export function issuesByRepo(issues: readonly GithubIssue[]): RepoIssues[] {
  const groups = new Map<string, GithubIssue[]>();
  for (const issue of issues.toSorted((a, b) => stampOf(b.updatedAt) - stampOf(a.updatedAt))) {
    const group = groups.get(issue.repo);
    if (group === undefined) groups.set(issue.repo, [issue]);
    else group.push(issue);
  }
  // A Map iterates in insertion order, and the input was sorted newest first, so the repos are
  // already in the order of their newest issue.
  return [...groups].map(([repo, list]) => ({ repo, issues: list }));
}

/**
 * One status chip on a PR row: a status-palette tone and the WORD that says it (status is never
 * colour alone, DESIGN.md §4). The tone is a palette key, not an agent's status: stuck is `blocked`,
 * waiting is `working` (something is running) or `idle` (someone else's move), ready is `done`, and a
 * merge state GitHub has not computed is `unknown`. Never `destructive`: nothing here is an act.
 */
export interface PrChip {
  key: "checks" | "review" | "merge" | "draft";
  tone: AgentStatus;
  word: string;
}

function checksChip(pr: GithubPr): PrChip {
  const { failing, pending } = pr.checkCounts;
  switch (pr.checks) {
    case "failure":
      return {
        key: "checks",
        tone: "blocked",
        word: failing > 0 ? tn("github.chip.failingCount", failing) : t("github.chip.failing"),
      };
    case "pending":
      return {
        key: "checks",
        tone: "working",
        word: pending > 0 ? tn("github.chip.pendingCount", pending) : t("github.chip.pending"),
      };
    case "success":
      return { key: "checks", tone: "done", word: t("github.chip.passing") };
    case "none":
      return { key: "checks", tone: "idle", word: t("github.chip.noChecks") };
  }
}

function reviewChip(pr: GithubPr): PrChip | null {
  switch (pr.review) {
    case "changes-requested":
      return { key: "review", tone: "blocked", word: t("github.chip.changesRequested") };
    case "approved":
      return { key: "review", tone: "done", word: t("github.chip.approved") };
    case "required":
      return { key: "review", tone: "idle", word: t("github.chip.reviewRequired") };
    case "none":
      return null;
  }
}

function mergeChip(pr: GithubPr): PrChip | null {
  switch (pr.mergeable) {
    case "conflicting":
      return { key: "merge", tone: "blocked", word: t("github.chip.conflict") };
    case "unknown":
      return { key: "merge", tone: "unknown", word: t("github.chip.mergeUnknown") };
    // A clean merge says nothing: "ready" already holds it, and a chip on every row would bury the
    // ones that matter.
    case "mergeable":
      return null;
  }
}

/** A PR row's chips, in reading order: draft, checks, review, merge. */
export function prChips(pr: GithubPr): PrChip[] {
  const chips: PrChip[] = [];
  if (pr.draft) chips.push({ key: "draft", tone: "idle", word: t("github.chip.draft") });
  chips.push(checksChip(pr));
  const review = reviewChip(pr);
  if (review !== null) chips.push(review);
  const merge = mergeChip(pr);
  if (merge !== null) chips.push(merge);
  return chips;
}

/**
 * The three searches the bridge runs (ADR 0091), spelled for GitHub's own web search, so a list cut
 * at 30 can say "see all" and land on the rest. `@me` there is whoever the browser is signed in as,
 * which may not be the host's `gh` account; the screen names that account in its header.
 */
export const GITHUB_SEARCH = {
  mine: { page: "pulls", query: "is:open is:pr author:@me archived:false sort:updated-desc" },
  review: { page: "pulls", query: "is:open is:pr review-requested:@me archived:false sort:updated-desc" },
  issues: { page: "issues", query: "is:open is:issue assignee:@me archived:false sort:updated-desc" },
} as const;

/** Which of the three lists: the key the screen and the web search share. */
export type GithubListName = keyof typeof GITHUB_SEARCH;

/**
 * The web search for one list, on the GitHub the items came from: the first item's origin, so a GitHub
 * Enterprise host is kept, and github.com when the list carries no item to read it from.
 */
export function searchUrl(list: GithubListName, sampleUrl: string | undefined): string {
  let origin = "https://github.com";
  try {
    if (sampleUrl !== undefined) origin = new URL(sampleUrl).origin;
  } catch {
    // Not a URL: GitHub always sends one, so this is a fixture's typo, and github.com is the answer.
  }
  const { page, query } = GITHUB_SEARCH[list];
  return `${origin}/${page}?q=${encodeURIComponent(query)}`;
}
