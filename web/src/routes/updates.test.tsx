import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { server } from "@/test/setup";
import { withHeaderHost } from "@/test/header-host";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import type { PreflightReport, UpdateInfo, UpdatePackMember } from "@/lib/types";
import { UpdatesRoute } from "./updates";

// ── THE UPDATES PAGE ────────────────────────────────────────────────────────────────────────────
//
// One route for the whole subject. What is pinned here is the SHAPE the spec fixed: the check
// control and one card, the peer lines inside that card rather than in a table beside it, no button
// on any peer line, and exactly one action button carrying one of three labels.

const GREEN: PreflightReport = {
  schema: 1,
  verdict: "green",
  checks: [{ id: "disk", verdict: "green", reason: "4.2 GB free" }],
};

function info(over: Partial<UpdateInfo> = {}): UpdateInfo {
  return {
    current: "1.3.0",
    latest: "1.4.0",
    latestUrl: null,
    releaseAvailable: true,
    majorAvailable: null,
    majorUrl: null,
    bridgeStale: false,
    checkedAt: 1_700_000_000_000,
    newerVersions: ["1.4.0"],
    ...over,
  };
}

const PACK: UpdatePackMember[] = [
  {
    name: "attic",
    version: "1.3.0",
    verdict: "red",
    reasons: ["working tree has tracked changes: bridge/server.ts"],
    asOf: 1_700_000_000_000,
  },
  { name: "minibuch", version: "1.3.0", verdict: "green", reasons: [], asOf: 1_700_000_000_000 },
];

const LEAD_ROSTER: HomeData["servers"] = [
  { id: "desk", name: "desk", isLead: true, reachable: true, protocol: "ok", lastSeenAt: 1 },
  { id: "minibuch", name: "minibuch", isLead: false, reachable: true, protocol: "ok", lastSeenAt: 1 },
];

function homeData(update: UpdateInfo | undefined, servers: HomeData["servers"]): HomeData {
  return {
    bridge: "connected",
    device: undefined,
    agents: [],
    shellPanes: [],
    workspaces: [],
    tabs: [],
    sessions: [],
    servers,
    ts: 0,
    scope: {},
    viewAll: false,
    snoozedUntil: null,
    update,
    error: false,
    authError: false,
  };
}

function renderUpdates(update: UpdateInfo | undefined, servers: HomeData["servers"] = []) {
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => homeData(update, servers),
        children: [
          { path: "settings/updates", element: withHeaderHost(<UpdatesRoute />) },
          { path: "settings", element: <div data-testid="settings" /> },
        ],
      },
    ],
    { initialEntries: ["/settings/updates"] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

function serveCheck(update: UpdateInfo, pack?: UpdatePackMember[]) {
  server.use(
    http.get("/api/update/check", () =>
      HttpResponse.json(
        pack === undefined ? { ...update, preflight: GREEN } : { ...update, preflight: GREEN, pack },
      ),
    ),
  );
}

beforeEach(() => {
  serveCheck(info());
  server.use(http.post("/api/update/snooze", () => HttpResponse.json(info())));
});

describe("updates page", () => {
  it("holds the check control and one card, in that order", async () => {
    renderUpdates(info());
    expect(await screen.findByRole("heading", { name: "Updates" })).toBeInTheDocument();
    // The question…
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeInTheDocument();
    // …and the answer, which is where every actionable line lives.
    expect(await screen.findByText("Update Collie")).toBeInTheDocument();
  });

  it("leads with a 44px back button that returns to Settings, not home", async () => {
    const user = userEvent.setup();
    const router = renderUpdates(info());
    const back = await screen.findByRole("button", { name: "Back" });
    expect(back.className).toContain("size-11");
    await user.click(back);
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings"));
  });

  it("mounts exactly one header — the shell's, filled", async () => {
    renderUpdates(info());
    await screen.findByRole("heading", { name: "Updates" });
    expect(document.querySelectorAll("header")).toHaveLength(1);
  });

  it("puts the peer rows in the card, with no table beside it", async () => {
    serveCheck(info(), PACK);
    renderUpdates(info(), LEAD_ROSTER);
    const list = await screen.findByRole("list", { name: "Pack members" });
    // The list is INSIDE the card that carries the button — the thing that blocks the confirm has
    // to be readable without moving your eyes to a second surface.
    const card = screen.getByText("Update Collie").closest("[data-slot='card']");
    expect(card).not.toBeNull();
    expect(card?.contains(list)).toBe(true);
    expect(within(list).queryAllByRole("button")).toHaveLength(0);
  });

  it("offers exactly one action button on the page", async () => {
    serveCheck(info(), PACK);
    renderUpdates(info(), LEAD_ROSTER);
    expect(await screen.findByRole("button", { name: "Update pack to 1.4.0" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Update to/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry pack update" })).not.toBeInTheDocument();
  });
});
