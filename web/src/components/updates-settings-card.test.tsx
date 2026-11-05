import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { server } from "@/test/setup";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import type { UpdateInfo, UpdateCrewMember, UpdateRun } from "@/lib/types";
import { updatesStatus, updatesStatusLine, useUpdatesStatus } from "./updates-settings-card";

// What the Updates row on the Settings index says. The row itself is drawn by routes/settings.tsx
// (see settings.test.tsx); this file pins the words and where they come from.

function Probe() {
  const status = useUpdatesStatus();
  return <p data-testid="status" data-available={String(status.available)}>{status.line}</p>;
}

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

function homeData(update: UpdateInfo | undefined, over: Partial<HomeData> = {}): HomeData {
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
    ...over,
  };
}

function renderRow(update: UpdateInfo | undefined, over: Partial<HomeData> = {}) {
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => homeData(update, over),
        children: [
          { path: "settings", element: <Probe /> },
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
    expect(updatesStatusLine({ update: info(), running: false, ...behindNone })).toBe("Up to date · 1.3.0");
    expect(updatesStatusLine({ update: undefined, running: false, ...behindNone })).toBe("Up to date");
  });

  it("counts a peer behind off the check's census", async () => {
    const crew: UpdateCrewMember[] = [
      { name: "minibuch", version: "1.2.0", verdict: "green", reasons: [], asOf: 1 },
    ];
    server.use(
      http.get("/api/update/check", () => HttpResponse.json({ ...info(), preflight: null, crew })),
    );
    renderRow(info());
    expect(await screen.findByText("1 peer behind")).toBeInTheDocument();
  });

  it("unknown outranks every fact a stale snapshot names (#512)", () => {
    const update = info({ releaseAvailable: true, latest: "1.4.0", run: run("staging") });
    expect(updatesStatusLine({ update, running: true, behind: 3, unknown: true })).toBe(
      "Unknown, can’t reach Collie",
    );
  });

  it("a failed root load renders unknown, never the stale snapshot's release (#512)", async () => {
    renderRow(info({ releaseAvailable: true, latest: "1.4.0" }), { error: true });
    expect(await screen.findByText("Unknown, can’t reach Collie")).toBeInTheDocument();
    expect(screen.queryByText("1.4.0 available")).not.toBeInTheDocument();
    expect(screen.queryByText(/Up to date/)).not.toBeInTheDocument();
  });

  it("a failed census read costs the row nothing — it falls back to the snapshot", async () => {
    server.use(http.get("/api/update/check", () => HttpResponse.error()));
    renderRow(info({ releaseAvailable: true, latest: "1.4.0" }));
    expect(await screen.findByText("1.4.0 available")).toBeInTheDocument();
  });

  it("only an available release is flagged for the dot", () => {
    const base = { running: false, behind: 0 };
    expect(updatesStatus({ update: info({ releaseAvailable: true, latest: "1.4.0" }), ...base }).available).toBe(true);
    expect(updatesStatus({ update: info(), ...base }).available).toBe(false);
    expect(updatesStatus({ update: info({ bridgeStale: true, releaseAvailable: true, latest: "1.4.1" }), ...base }).available).toBe(false);
    expect(updatesStatus({ update: info({ releaseAvailable: true, latest: "1.4.0" }), running: true, behind: 0 }).available).toBe(false);
    expect(updatesStatus({ update: info({ releaseAvailable: true, latest: "1.4.0" }), running: false, behind: 2 }).available).toBe(false);
    expect(updatesStatus({ update: info({ releaseAvailable: true, latest: "1.4.0" }), ...base, unknown: true }).available).toBe(false);
  });
});
