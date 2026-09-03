import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { server } from "@/test/setup";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import type { UpdateInfo, UpdatePackMember, UpdateRun } from "@/lib/types";
import { UpdatesSettingsCard, updatesStatusLine } from "./updates-settings-card";

// The one row Settings keeps for the whole update subject. Three cards used to stand here.

function info(over: Partial<UpdateInfo> = {}): UpdateInfo {
  return {
    current: "1.3.0",
    latest: "1.3.0",
    latestUrl: null,
    releaseAvailable: false,
    majorAvailable: null,
    majorUrl: null,
    bridgeStale: false,
    checkedAt: 1_700_000_000_000,
    ...over,
  };
}

function run(state: UpdateRun["state"]): UpdateRun {
  return { schema: 1, state, from: "1.3.0", to: "1.4.0", startedAt: 1, updatedAt: 2, pid: 1, attempt: 1 };
}

function homeData(update: UpdateInfo | undefined): HomeData {
  return {
    bridge: "connected",
    device: undefined,
    agents: [],
    shellPanes: [],
    workspaces: [],
    tabs: [],
    sessions: [],
    servers: [],
    ts: 0,
    scope: {},
    viewAll: false,
    snoozedUntil: null,
    update,
    error: false,
    authError: false,
  };
}

function renderRow(update: UpdateInfo | undefined) {
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => homeData(update),
        children: [
          { path: "settings", element: <UpdatesSettingsCard /> },
          { path: "settings/updates", element: <div data-testid="updates" /> },
        ],
      },
    ],
    { initialEntries: ["/settings"] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

beforeEach(() => {
  server.use(http.get("/api/update/check", () => HttpResponse.json({ ...info(), preflight: null })));
});

describe("updates settings row", () => {
  it("is one row with a title, a status line and a chevron, and it opens the page", async () => {
    const user = userEvent.setup();
    const router = renderRow(info());
    const row = await screen.findByRole("button", { name: /Updates/ });
    expect(screen.getByText("Updates")).toBeInTheDocument();
    // The chevron is the affordance the pack row does not have — this row hides a whole page.
    expect(row.querySelector("svg.lucide-chevron-right")).not.toBeNull();
    await user.click(row);
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/updates"));
  });
});

describe("updates row status line", () => {
  const behindNone = { behind: 0 };

  it("a run in flight outranks everything", () => {
    const update = info({ releaseAvailable: true, latest: "1.4.0", run: run("staging") });
    expect(updatesStatusLine({ update, running: true, behind: 3 })).toBe("Updating…");
  });

  it("a peer behind outranks an available release", () => {
    const update = info({ releaseAvailable: true, latest: "1.4.0" });
    expect(updatesStatusLine({ update, running: false, behind: 1 })).toBe("1 peer behind");
    expect(updatesStatusLine({ update, running: false, behind: 2 })).toBe("2 peers behind");
  });

  it("an available release names the version", () => {
    const update = info({ releaseAvailable: true, latest: "1.4.1" });
    expect(updatesStatusLine({ update, running: false, ...behindNone })).toBe("1.4.1 available");
  });

  it("a stale process keeps the banner's own sentence — a restart is a different remedy", () => {
    const update = info({ bridgeStale: true, releaseAvailable: true, latest: "1.4.1" });
    expect(updatesStatusLine({ update, running: false, ...behindNone })).toBe("Bridge restart needed");
  });

  it("otherwise it says up to date — including on a bridge that reports nothing", () => {
    expect(updatesStatusLine({ update: info(), running: false, ...behindNone })).toBe("Up to date");
    expect(updatesStatusLine({ update: undefined, running: false, ...behindNone })).toBe("Up to date");
  });

  it("counts a peer behind off the check's census", async () => {
    const pack: UpdatePackMember[] = [
      { name: "minibuch", version: "1.2.0", verdict: "green", reasons: [], asOf: 1 },
    ];
    server.use(
      http.get("/api/update/check", () => HttpResponse.json({ ...info(), preflight: null, pack })),
    );
    renderRow(info());
    expect(await screen.findByText("1 peer behind")).toBeInTheDocument();
  });

  it("a failed census read costs the row nothing — it falls back to the snapshot", async () => {
    server.use(http.get("/api/update/check", () => HttpResponse.error()));
    renderRow(info({ releaseAvailable: true, latest: "1.4.0" }));
    expect(await screen.findByText("1.4.0 available")).toBeInTheDocument();
  });
});
