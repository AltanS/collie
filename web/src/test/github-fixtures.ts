import type { GithubCheckCounts, GithubIssue, GithubPr, GithubWorkResponse } from "@/lib/types";

// GitHub work fixtures (ADR 0091), shared by the unit suite (routes/github.test.tsx), the playground
// (playground/fixtures.ts) and any browser case. Every stamp is an offset from the `ts` handed in, so
// the unit suite pins a clock and the playground passes its one frozen `TS`.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** The answer once it is `ok`. */
export type GithubWorkOkFixture = Extract<GithubWorkResponse, { state: "ok" }>;

const NO_CHECKS: GithubCheckCounts = { failing: 0, pending: 0, passing: 0, total: 0 };

function pr(ts: number, over: Partial<GithubPr> & Pick<GithubPr, "number" | "title">, ageMs: number): GithubPr {
  const repo = over.repo ?? "aryrabelo/collie";
  return {
    repo,
    url: `https://github.com/${repo}/pull/${over.number}`,
    author: "aryrabelo",
    draft: false,
    updatedAt: new Date(ts - ageMs).toISOString(),
    checks: "success",
    checkCounts: { failing: 0, pending: 0, passing: 9, total: 9 },
    review: "approved",
    mergeable: "mergeable",
    ...over,
  };
}

function issue(
  ts: number,
  over: Partial<GithubIssue> & Pick<GithubIssue, "repo" | "number" | "title">,
  ageMs: number,
): GithubIssue {
  return {
    url: `https://github.com/${over.repo}/issues/${over.number}`,
    author: "aryrabelo",
    updatedAt: new Date(ts - ageMs).toISOString(),
    labels: [],
    ...over,
  };
}

/**
 * My pull requests as GitHub sends them, most recently updated first: one READY at the top, then one
 * waiting with a merge state GitHub has not computed, two STUCK (failing checks; changes requested
 * on a conflict), and a draft. The screen must reorder them stuck first.
 */
export function fixtureGithubMine(ts: number): GithubPr[] {
  return [
    pr(ts, { number: 412, title: "Teach the dashboard footer to peek at GitHub work" }, 5 * MIN),
    pr(
      ts,
      {
        number: 415,
        title: "Read the host's gh with a 20 s deadline",
        checks: "pending",
        checkCounts: { failing: 0, pending: 3, passing: 6, total: 9 },
        review: "required",
        mergeable: "unknown",
      },
      12 * MIN,
    ),
    pr(
      ts,
      {
        number: 398,
        title: "Group assigned issues by repo, newest first",
        checks: "failure",
        checkCounts: { failing: 2, pending: 0, passing: 7, total: 9 },
        review: "required",
      },
      HOUR,
    ),
    pr(
      ts,
      {
        repo: "aryrabelo/collie-brand",
        number: 57,
        title: "Redraw the mark at 2px corners",
        checkCounts: { failing: 0, pending: 0, passing: 3, total: 3 },
        review: "changes-requested",
        mergeable: "conflicting",
      },
      3 * HOUR,
    ),
    pr(
      ts,
      {
        number: 420,
        title: "Draft: a second look at the stale notice copy",
        draft: true,
        checks: "none",
        checkCounts: NO_CHECKS,
        review: "none",
      },
      2 * DAY,
    ),
  ];
}

/** Pull requests waiting on my review: someone else's, so each row names its author. */
export function fixtureGithubReview(ts: number): GithubPr[] {
  return [
    pr(
      ts,
      {
        number: 418,
        title: "Crew forward: carry ?host= to the GitHub route",
        author: "altan",
        review: "required",
      },
      40 * MIN,
    ),
    pr(
      ts,
      {
        repo: "herdr/herdr",
        number: 1290,
        title: "Expose the pane's cwd on the socket API",
        author: "mira",
        checks: "pending",
        checkCounts: { failing: 0, pending: 1, passing: 14, total: 15 },
        review: "required",
        mergeable: "mergeable",
      },
      5 * HOUR,
    ),
  ];
}

/**
 * Issues assigned to me across two repos, deliberately interleaved by update time, so grouping by
 * repo has to move one: `collie` holds the newest, so it comes first.
 */
export function fixtureGithubIssues(ts: number): GithubIssue[] {
  return [
    issue(
      ts,
      {
        repo: "aryrabelo/collie",
        number: 431,
        title: "GitHub screen: say which account the lists belong to",
        labels: [
          { name: "ux", color: "1d76db" },
          { name: "good first issue", color: "7057ff" },
        ],
      },
      20 * MIN,
    ),
    issue(ts, { repo: "herdr/herdr", number: 1277, title: "Socket API drops the session name on reconnect" }, 2 * HOUR),
    issue(
      ts,
      { repo: "aryrabelo/collie", number: 402, title: "Footer line overlaps the build stamp at 320px", labels: [{ name: "bug", color: "d73a4a" }] },
      6 * HOUR,
    ),
    issue(ts, { repo: "herdr/herdr", number: 1201, title: "Document the plugin manifest's `actions` table" }, 3 * DAY),
  ];
}

/**
 * The whole `ok` answer: my five PRs, two review requests, and four issues out of 86 (so the issues
 * list shows its "4 of 86" line). `over` replaces any top-level field, for the stale and empty cases.
 */
export function fixtureGithubOk(ts: number, over: Partial<GithubWorkOkFixture> = {}): GithubWorkOkFixture {
  const mine = fixtureGithubMine(ts);
  const review = fixtureGithubReview(ts);
  return {
    state: "ok",
    machine: "workshop",
    login: "aryrabelo",
    fetchedAt: new Date(ts - 2 * MIN).toISOString(),
    stale: false,
    mine: { items: mine, total: mine.length },
    review: { items: review, total: review.length },
    issues: { items: fixtureGithubIssues(ts), total: 86 },
    ...over,
  };
}
