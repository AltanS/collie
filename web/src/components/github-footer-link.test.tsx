import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { server } from "@/test/setup";
import { fixtureGithubOk } from "@/test/github-fixtures";
import type { GithubWorkResponse } from "@/lib/types";
import { GithubFooterLink } from "./github-footer-link";

// The dashboard's line into /github (ADR 0091). What is pinned: it only ever PEEKS (so drawing it
// never makes the host run `gh`), it is absent while the feature is off, and its counts are the
// cached answer's stuck PRs of mine and review requests.

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

function renderFooter() {
  const router = createMemoryRouter(
    [
      { path: "/", element: <GithubFooterLink /> },
      { path: "/github", element: <div data-testid="github" /> },
    ],
    { initialEntries: ["/"] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe("GithubFooterLink", () => {
  it("peeks, and shows the cached answer's stuck and review counts", async () => {
    const asked = serve(fixtureGithubOk(Date.now()));
    const router = renderFooter();
    const line = await screen.findByRole("button", { name: "Open GitHub work" });
    expect(line.textContent).toBe("GitHub · 2 stuck · 2 to review");
    expect(asked.every((url) => url.searchParams.get("peek") === "1")).toBe(true);
    await userEvent.click(line);
    expect(router.state.location.pathname).toBe("/github");
  });

  it("shows the bare word while nothing is cached, and still only peeks", async () => {
    const asked = serve({ state: "cold", machine: "desk" });
    renderFooter();
    expect((await screen.findByRole("button", { name: "Open GitHub work" })).textContent).toBe("GitHub");
    expect(asked.map((url) => url.searchParams.get("peek"))).toEqual(["1"]);
  });

  it("draws nothing while the feature is off, or on a machine that predates it", async () => {
    for (const body of [{ state: "off", machine: "desk" } as const, "not-found" as const]) {
      const asked = serve(body);
      const { unmount } = render(
        <RouterProvider router={createMemoryRouter([{ path: "/", element: <GithubFooterLink /> }])} />,
      );
      await waitFor(() => expect(asked).toHaveLength(1));
      expect(screen.queryByRole("button", { name: "Open GitHub work" })).toBeNull();
      unmount();
    }
  });
});
