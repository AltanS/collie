import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { server } from "@/test/setup";
import { withHeaderHost } from "@/test/header-host";
import { fixtureGithubOk } from "@/test/github-fixtures";
import type { GithubWorkResponse } from "@/lib/types";
import { GithubRoute } from "./github";

// ── THE GITHUB WORK SCREEN (ADR 0091) ────────────────────────────────────────────────────────────
//
// The screen reads `/api/github` itself (no loader), so these cases answer that route through MSW and
// assert what the screen SAYS: the three lists in their order, stuck before ready, a merge state
// GitHub has not computed never shown as a clean one, the "4 of 86" line, and each state's sentence.

const TS = Date.now();

/**
 * Answer `/api/github` with `body`, or with a 404 for `"not-found"` (a crew member whose Collie
 * predates the route), and record every URL the screen asked.
 */
function serve(body: GithubWorkResponse | "not-found"): URL[] {
  const asked: URL[] = [];
  server.use(
    http.get("/api/github", ({ request }) => {
      asked.push(new URL(request.url));
      return body === "not-found" ? HttpResponse.json({ error: "not found" }, { status: 404 }) : HttpResponse.json(body);
    }),
  );
  return asked;
}

function renderGithub(entry = "/github") {
  const router = createMemoryRouter(
    [
      { path: "/github", element: withHeaderHost(<GithubRoute />) },
      { path: "/", element: <div data-testid="home" /> },
    ],
    { initialEntries: [entry] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

/** One list, by its section's name. */
async function section(name: RegExp): Promise<HTMLElement> {
  return screen.findByRole("region", { name });
}

/** The titles of a list's rows, in screen order. */
function titles(region: HTMLElement): string[] {
  return within(region)
    .getAllByRole("listitem")
    .map((item) => item.querySelector(".font-content")?.textContent ?? "");
}

describe("the GitHub work screen", () => {
  it("draws the three lists in their fixed order, each with GitHub's own count", async () => {
    serve(fixtureGithubOk(TS));
    renderGithub();
    const headings = await screen.findAllByRole("heading", { level: 2 });
    expect(headings.map((h) => h.textContent)).toEqual([
      "My pull requests(5)",
      "Review requested(2)",
      "Issues assigned to me(86)",
    ]);
    expect(screen.getByText(/^aryrabelo · workshop · updated /)).toBeInTheDocument();
  });

  it("puts my stuck pull requests first and the ready one last, whatever order GitHub sent", async () => {
    serve(fixtureGithubOk(TS));
    renderGithub();
    const mine = await section(/^My pull requests/);
    // GitHub sent them newest first: ready #412, waiting #415, stuck #398, stuck #57, draft #420.
    expect(titles(mine)).toEqual([
      "Group assigned issues by repo, newest first",
      "Redraw the mark at 2px corners",
      "Read the host's gh with a 20 s deadline",
      "Draft: a second look at the stale notice copy",
      "Teach the dashboard footer to peek at GitHub work",
    ]);
    const stuck = within(mine).getByRole("link", { name: /Group assigned issues by repo/ });
    expect(within(stuck).getByText("2 failing")).toBeInTheDocument();
    const conflicted = within(mine).getByRole("link", { name: /Redraw the mark/ });
    expect(within(conflicted).getByText("changes requested")).toBeInTheDocument();
    expect(within(conflicted).getByText("conflict")).toBeInTheDocument();
  });

  it("never shows a merge state GitHub has not computed as a clean merge", async () => {
    serve(fixtureGithubOk(TS));
    renderGithub();
    const mine = await section(/^My pull requests/);
    const unknown = within(mine).getByRole("link", { name: /Read the host's gh/ });
    expect(within(unknown).getByText("mergeable unknown")).toBeInTheDocument();
    expect(unknown.textContent).not.toMatch(/no conflict/i);
    // No chip anywhere says a bare "mergeable": a clean merge is not announced, and unknown is not clean.
    expect(screen.queryByText(/^mergeable$/)).toBeNull();
    // And it is not ranked with the ready one: it sits above it, among the waiting.
    expect(titles(mine).indexOf("Read the host's gh with a 20 s deadline")).toBeLessThan(
      titles(mine).indexOf("Teach the dashboard footer to peek at GitHub work"),
    );
  });

  it("says when a list is GitHub's first slice, and links to the rest on GitHub", async () => {
    serve(fixtureGithubOk(TS));
    renderGithub();
    const issues = await section(/^Issues assigned to me/);
    expect(within(issues).getByText("4 of 86")).toBeInTheDocument();
    const all = within(issues).getByRole("link", { name: /See all on GitHub/ });
    expect(all.getAttribute("href")).toBe(
      `https://github.com/issues?q=${encodeURIComponent("is:open is:issue assignee:@me archived:false sort:updated-desc")}`,
    );
    // The two short lists say nothing of the kind.
    expect(within(await section(/^My pull requests/)).queryByText(/ of /)).toBeNull();
  });

  it("groups assigned issues by repo, the repo with the newest issue first", async () => {
    serve(fixtureGithubOk(TS));
    renderGithub();
    const issues = await section(/^Issues assigned to me/);
    expect(within(issues).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      "aryrabelo/collie",
      "herdr/herdr",
    ]);
  });

  it("opens every row on GitHub in a new tab, with no opener", async () => {
    serve(fixtureGithubOk(TS));
    renderGithub();
    const row = await screen.findByRole("link", { name: /Crew forward: carry \?host=/ });
    expect(row.getAttribute("href")).toBe("https://github.com/aryrabelo/collie/pull/418");
    expect(row.getAttribute("target")).toBe("_blank");
    expect(row.getAttribute("rel")).toBe("noopener noreferrer");
    // Someone else's PR names its author.
    expect(within(row).getByText(/@altan/)).toBeInTheDocument();
  });

  it("names the remedy when gh is signed out on that machine", async () => {
    serve({
      state: "unavailable",
      machine: "workshop",
      reason: "gh-unauthenticated",
      message: "To get started with GitHub CLI, please run:  gh auth login",
    });
    renderGithub();
    expect(await screen.findByText("gh is not signed in on workshop")).toBeInTheDocument();
    expect(screen.getByText("gh auth login")).toBeInTheDocument();
    expect(screen.getByText("To get started with GitHub CLI, please run: gh auth login")).toBeInTheDocument();
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("names the switch when the feature is off", async () => {
    serve({ state: "off", machine: "workshop" });
    renderGithub();
    expect(await screen.findByText("GitHub work is off on workshop")).toBeInTheDocument();
    expect(screen.getByText("COLLIE_GITHUB=1")).toBeInTheDocument();
  });

  it("reads a 404 from an older machine as 'not available there', not as a failure", async () => {
    serve("not-found");
    renderGithub("/github?h=attic");
    expect(await screen.findByText("Not available on attic")).toBeInTheDocument();
    expect(screen.queryByText(/Could not reach/)).toBeNull();
  });

  it("keeps the last lists under a notice when the bridge's refresh failed", async () => {
    serve(fixtureGithubOk(TS, { stale: true, error: "HTTP 502: Bad Gateway" }));
    renderGithub();
    expect(await screen.findByText("HTTP 502: Bad Gateway")).toBeInTheDocument();
    expect(screen.getByText(/The last refresh failed/)).toBeInTheDocument();
    expect(await section(/^My pull requests/)).toBeInTheDocument();
  });

  it("asks the scoped machine, and asks past the cache only on the refresh button", async () => {
    const asked = serve(fixtureGithubOk(TS));
    renderGithub("/github?h=workshop");
    await section(/^My pull requests/);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.searchParams.get("host")).toBe("workshop");
    expect(asked[0]!.searchParams.has("fresh")).toBe(false);
    expect(asked[0]!.searchParams.has("peek")).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: "Refresh GitHub work" }));
    await waitFor(() => expect(asked).toHaveLength(2));
    expect(asked[1]!.searchParams.get("fresh")).toBe("1");
    expect(asked[1]!.searchParams.get("host")).toBe("workshop");
  });

  it("goes back up to the dashboard of the same machine", async () => {
    serve(fixtureGithubOk(TS));
    const router = renderGithub("/github?h=workshop");
    await userEvent.click(await screen.findByRole("button", { name: "Back to the dashboard" }));
    expect(router.state.location.pathname).toBe("/");
    expect(router.state.location.search).toBe("?h=workshop");
  });
});
