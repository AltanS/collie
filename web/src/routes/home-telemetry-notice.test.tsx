import { render, screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CrewProvider } from "@/components/crew-provider";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { __resetTelemetryNotice } from "@/lib/telemetry-notice";
import { fixtureAgents, fixtureShellPanes, fixtureTabs, fixtureWorkspaces } from "@/test/handlers";
import { withHeaderHost } from "@/test/header-host";
import { server } from "@/test/setup";
import { HomeRoute } from "./home";

// The install-count notice stands on the dashboard (M86 spec 02), through the real home route. Its
// rule and its dismissal are in components/telemetry-notice.test.tsx.

vi.mock("@/hooks/use-loading-stalled", () => ({ useLoadingStalled: () => false }));

const BODY = "Collie 1.27.0 sends anonymous telemetry once a day. Turn it off in Settings.";

function renderHome() {
  const data: HomeData = {
    bridge: "connected",
    device: undefined,
    agents: fixtureAgents,
    shellPanes: fixtureShellPanes,
    workspaces: fixtureWorkspaces,
    tabs: fixtureTabs,
    sessions: [],
    servers: [],
    ts: 0,
    scope: {},
    viewAll: false,
    snoozedUntil: null,
    update: undefined,
    error: false,
    authError: false,
  };
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => data,
        element: withHeaderHost(
          <CrewProvider servers={data.servers} sessions={data.sessions} ts={data.ts} pollMs={1500}>
            <HomeRoute />
          </CrewProvider>,
        ),
      },
    ],
    { initialEntries: ["/"] },
  );
  render(<RouterProvider router={router} />);
}

beforeEach(() => {
  __resetTelemetryNotice();
});

describe("the dashboard and the install-count notice", () => {
  it("shows the notice while the count is on by default", async () => {
    server.use(http.get("/api/telemetry", () => HttpResponse.json({ on: true, decidedBy: "default", setting: null, next: null })));
    renderHome();
    expect(await screen.findByText(BODY)).toBeInTheDocument();
  });

  it("shows nothing when the count is already off", async () => {
    renderHome();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText(BODY)).toBeNull();
  });
});
