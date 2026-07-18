import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";

import { OfflineBanner } from "@/components/offline-banner";
import { RootLayout } from "@/routes/root";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";

// RootLayout drives polling / notifications / push — none of which this layout test cares about, and
// they'd leave pending timers or poke jsdom's missing serviceWorker. Pin them to no-ops.
vi.mock("@/hooks/use-polling", () => ({ usePolling: () => {} }));
vi.mock("@/hooks/use-transitions", () => ({ useAgentTransitions: () => {} }));
vi.mock("@/hooks/use-push", () => ({ usePushSetup: () => {} }));

function setOnline(value: boolean) {
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => value });
}

afterEach(() => {
  setOnline(true);
});

describe("OfflineBanner", () => {
  it("renders nothing while online", () => {
    setOnline(true);
    const { container } = render(<OfflineBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a disconnected banner while offline", () => {
    setOnline(false);
    render(<OfflineBanner />);
    expect(screen.getByText(/disconnected/i)).toBeInTheDocument();
  });

  it("is in-flow, not a fixed overlay (so it can't cover the header)", () => {
    setOnline(false);
    render(<OfflineBanner />);
    const banner = screen.getByRole("status");
    // The overlap bug was the banner being `position: fixed` over the sticky header. It must now take
    // layout space instead — no `fixed`, and a `shrink-0` flex row so it keeps its height.
    expect(banner.className).not.toMatch(/(^|\s)fixed(\s|$)/);
    expect(banner.className).toMatch(/shrink-0/);
  });
});

const homeData: HomeData = {
  bridge: "connected",
  device: undefined,
  agents: [],
  shellPanes: [],
  workspaces: [],
  tabs: [],
  sessions: [],
  session: undefined,
  snoozedUntil: null,
  update: undefined,
  error: false,
};

function renderRoot() {
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => homeData,
        element: <RootLayout />,
        children: [{ index: true, element: <div data-testid="route-body">body</div> }],
      },
    ],
    { initialEntries: ["/"] },
  );
  return render(<RouterProvider router={router} />);
}

describe("RootLayout — offline banner takes layout space above the route", () => {
  it("stacks the banner in-flow before the route body when offline", async () => {
    setOnline(false);
    renderRoot();
    const banner = await screen.findByRole("status");
    const body = screen.getByTestId("route-body");
    // In-flow and ordered above the route: the banner precedes the route body in the document, so it
    // reserves space rather than overlaying the route's sticky header.
    expect(banner.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders no banner when online", async () => {
    setOnline(true);
    renderRoot();
    await screen.findByTestId("route-body");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
