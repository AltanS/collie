import { render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CrewProvider } from "@/components/crew-provider";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { __resetTelemetryRead } from "@/hooks/use-telemetry-notice";
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
  __resetTelemetryRead();
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

// CALM LOAD (row 16): the list is unseen for at most 400 ms while the one read answers, and the notice is
// already open when it is shown, so it never opens above a list that has painted.
describe("the dashboard while the install-count read is on its way", () => {
  it("keeps the list unseen, then shows the notice above the list in the same frame as the list", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    server.use(
      http.get("/api/telemetry", async () => {
        await gate;
        return HttpResponse.json({ on: true, decidedBy: "default", setting: null, next: null });
      }),
    );
    renderHome();
    const main = await screen.findByRole("main", { hidden: true });
    const scroller = main.parentElement!;
    expect(scroller).toHaveClass("invisible");
    expect(screen.queryByText(BODY)).toBeNull();
    release();
    const notice = await screen.findByText(BODY);
    expect(scroller).not.toHaveClass("invisible");
    // The notice is before the list in the scroller, where it always stood.
    expect(notice.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows the list when the answer is that there is no notice", async () => {
    server.use(http.get("/api/telemetry", () => HttpResponse.json({ on: false, decidedBy: "settings", setting: "off", next: null })));
    renderHome();
    const main = await screen.findByRole("main", { hidden: true });
    await waitFor(() => expect(main.parentElement).not.toHaveClass("invisible"));
    expect(screen.queryByText(BODY)).toBeNull();
  });
});
