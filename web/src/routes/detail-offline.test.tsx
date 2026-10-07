import { act, render, screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";

import { paneName } from "@/lib/pane-name";
import { FakeIDBFactory, uninstallFakeIndexedDB } from "@/test/fake-indexeddb";
import { fixtureAgents } from "@/test/handlers";
import { server } from "@/test/setup";
import type { AgentView } from "@/lib/types";

// THE PANE PAGE WHILE THE BRIDGE IS AWAY (M46 specs 10 and 11, ADR 0087), wired end to end: the real
// root and pane loaders, the real DetailRoute, the real AgentChat.
//
// The repro (Pixel, airplane mode with the tunnel up, 2026-10-07): the dashboard on the WIDENED view
// (`?all=1`) drew the saved herd, and the pane opened from it said "(agent gone)", "(no recent
// output)" and "Pane is gone". A pane URL never carries the breadth, so the root loader re-ran at the
// pane's narrow address, found no narrow herd kept, and handed the pane page an empty herd. The pane
// page looked its row up in that herd alone, and called a missing row "gone". "Gone" is a fact only a
// live answer can state.
//
// Each case is a fresh page: the loaders keep module caches, so every module is imported after
// `vi.resetModules()` and every case gets an empty store.

beforeAll(() => {
  // jsdom doesn't implement scrollTo; the terminal mirror's auto-scroll calls it.
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});

beforeEach(() => {
  vi.resetModules();
  new FakeIDBFactory().install();
});

afterEach(async () => {
  // Every write a case queued lands before the fake database goes away.
  await (await import("@/lib/store")).__storeIdle();
  uninstallFakeIndexedDB();
});

const PANE = fixtureAgents[0]!; // a claude pane in "webapp"

async function mountApp(initialPath: string) {
  const loaders = await import("@/lib/loaders");
  const { DetailRoute } = await import("./detail");
  const { withHeaderHost } = await import("@/test/header-host");
  const health = await import("@/lib/connection-health");
  health.__resetConnectionHealth();
  const router = createMemoryRouter(
    [
      {
        id: loaders.ROOT_ROUTE_ID,
        path: "/",
        loader: loaders.rootLoader,
        element: withHeaderHost(<Outlet />),
        children: [
          { index: true, element: <div data-testid="home">HOME</div> },
          { id: loaders.PANE_ROUTE_ID, path: "pane/:paneId", loader: loaders.paneLoader, element: <DetailRoute /> },
        ],
      },
    ],
    { initialEntries: [initialPath] },
  );
  render(<RouterProvider router={router} />);
  return { router, health, loaders };
}

/** The header names the pane (its name line) and its place (line 2), as on a live render. */
async function expectHeaderNames(pane: AgentView): Promise<void> {
  expect(await screen.findByRole("button", { name: `Pane settings for ${paneName(pane)}` })).toBeInTheDocument();
  expect(document.querySelector('[data-slot="pane-place"]')).toHaveTextContent(pane.workspaceLabel);
}

/** The bridge stops answering: every read gets no answer at all, as over a dead tunnel. */
function bridgeAway(): void {
  server.use(
    http.get("/api/snapshot", () => HttpResponse.error()),
    http.get(/\/api\/pane\/[^/]+$/, () => HttpResponse.error()),
    http.get(/\/api\/pane\/[^/]+\/chat/, () => HttpResponse.error()),
  );
}

describe("the pane page with the bridge away", () => {
  it("opened from the widened dashboard, draws the pane's saved row and saved text, and never says gone", async () => {
    // A warm page: the widened dashboard answered live, and the pane was read live once.
    const { router, health, loaders } = await mountApp("/?all=1");
    await screen.findByTestId("home");
    await loaders.paneLoader({ params: { paneId: PANE.paneId }, request: new Request("http://localhost/pane/w1:p1") });

    // The tunnel drops and the outage latches; the operator taps the row.
    bridgeAway();
    health.latchLost();
    await act(async () => {
      await router.navigate(`/pane/${encodeURIComponent(PANE.paneId)}`);
    });

    // The header names the pane from the herd the phone kept…
    await expectHeaderNames(PANE);
    // …the body is the saved text, dated…
    expect(screen.getByText(/hello from the pane/)).toBeInTheDocument();
    expect(screen.getByText(/^Saved copy from /)).toBeInTheDocument();
    // …and nothing on the screen states a fact only a live answer can.
    expect(screen.queryByText("(agent gone)")).toBeNull();
    expect(screen.queryByPlaceholderText("Pane is gone")).toBeNull();
    expect(screen.queryByText("(no recent output)")).toBeNull();
  });

  it("with no saved text for the pane, says so, keeps the pane's name, and keeps Send off", async () => {
    // The widened dashboard answered live; this pane was never read on this phone.
    const { router, health } = await mountApp("/?all=1");
    await screen.findByTestId("home");

    bridgeAway();
    health.latchLost();
    await act(async () => {
      await router.navigate(`/pane/${encodeURIComponent(PANE.paneId)}`);
    });

    await expectHeaderNames(PANE);
    expect(screen.getByText("No saved copy of this pane on this phone.")).toBeInTheDocument();
    expect(screen.queryByText("(agent gone)")).toBeNull();
    expect(screen.queryByText("(no recent output)")).toBeNull();
    expect(screen.queryByPlaceholderText("Pane is gone")).toBeNull();
    // Typing stays open for the draft; the send waits for the bridge (spec 11).
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  });

  it("a cold page opened straight on the pane draws the saved row from the widened herd it kept", async () => {
    // The page before: the widened dashboard and the pane, both answered live, written to the store.
    {
      const warm = await import("@/lib/loaders");
      await warm.rootLoader({ request: new Request("http://localhost/?all=1") });
      await warm.paneLoader({ params: { paneId: PANE.paneId }, request: new Request("http://localhost/pane/w1:p1") });
      await (await import("@/lib/store")).__storeIdle();
    }
    // The PWA is killed and reopened on the pane, with the bridge away.
    vi.resetModules();
    bridgeAway();
    const loaders = await import("@/lib/loaders");
    loaders.__setColdOpenWait(10);
    await mountApp(`/pane/${encodeURIComponent(PANE.paneId)}`);

    await expectHeaderNames(PANE);
    expect(screen.getByText(/hello from the pane/)).toBeInTheDocument();
    expect(screen.queryByText("(agent gone)")).toBeNull();
    expect(screen.queryByPlaceholderText("Pane is gone")).toBeNull();
  });

  it("with no saved herd and no saved text at all, names the pane by its id and never says gone", async () => {
    const { router, health } = await mountApp("/");
    await screen.findByTestId("home");

    bridgeAway();
    health.latchLost();
    // A pane on another session: no herd was ever kept for its address.
    await act(async () => {
      await router.navigate("/pane/w9%3Ap9?s=elsewhere");
    });

    expect(await screen.findByText("No saved copy of this pane on this phone.")).toBeInTheDocument();
    expect(screen.getByText("w9:p9")).toBeInTheDocument();
    expect(screen.queryByText("(agent gone)")).toBeNull();
    expect(screen.queryByPlaceholderText("Pane is gone")).toBeNull();
  });
});
