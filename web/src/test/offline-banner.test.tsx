import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";

import { OfflineBanner } from "@/components/offline-banner";
import { RootLayout } from "@/routes/root";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";

// RootLayout drives polling / notifications / push — none of which this layout test cares about, and
// they'd leave pending timers or poke jsdom's missing serviceWorker. Pin them to no-ops.
vi.mock("@/hooks/use-polling", () => ({ usePolling: () => {} }));
vi.mock("@/hooks/use-transitions", () => ({ useAgentTransitions: () => {} }));
vi.mock("@/hooks/use-push", () => ({ usePushSetup: () => {} }));

// Drive the escalation directly (the wall-clock threshold itself is covered in
// use-connection-lost.test.ts) so the two stages — the quiet drop vs the escalated "not connected"
// row — can be asserted without advancing 15s of fake time. The banner passes `!online` to the hook;
// the mock ignores the arg and returns the staged value. Safe for the RootLayout cases below:
// ConnectionLostPrompt is gated on being online, so it stays hidden there regardless of this value.
const h = vi.hoisted(() => ({ lost: false }));
vi.mock("@/hooks/use-connection-lost", () => ({ useConnectionLost: () => h.lost }));

function setOnline(value: boolean) {
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => value });
}

afterEach(() => {
  setOnline(true);
  h.lost = false;
});

// OfflineBanner now uses useRevalidator (its escalated Retry), so a router context is required. A
// counting loader lets the Retry test observe the revalidation it kicks.
async function renderBanner() {
  let loaderCalls = 0;
  const router = createMemoryRouter([
    {
      id: "root",
      path: "/",
      loader: () => {
        loaderCalls += 1;
        return null;
      },
      element: (
        <>
          <div data-testid="mounted" />
          <OfflineBanner />
        </>
      ),
    },
  ]);
  render(<RouterProvider router={router} />);
  await screen.findByTestId("mounted"); // the data router mounts the element after its loader settles
  return { loaderCalls: () => loaderCalls };
}

describe("OfflineBanner", () => {
  it("renders nothing while online", async () => {
    setOnline(true);
    await renderBanner();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the quiet disconnected row on a fresh offline drop (below the threshold)", async () => {
    setOnline(false);
    h.lost = false;
    await renderBanner();
    expect(screen.getByText(/disconnected/i)).toBeInTheDocument();
    // Not yet escalated — no actionable buttons.
    expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
  });

  it("is in-flow, not a fixed overlay (so it can't cover the header)", async () => {
    setOnline(false);
    h.lost = false;
    await renderBanner();
    const banner = screen.getByRole("status");
    // The overlap bug was the banner being `position: fixed` over the sticky header. It must now take
    // layout space instead — no `fixed`, and a `shrink-0` flex row so it keeps its height.
    expect(banner.className).not.toMatch(/(^|\s)fixed(\s|$)/);
    expect(banner.className).toMatch(/shrink-0/);
  });

  it("escalates to 'not connected' with Retry + Reload once offline past the threshold", async () => {
    setOnline(false);
    h.lost = true;
    await renderBanner();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(/not connected/i)).toBeInTheDocument();
    expect(screen.queryByText(/waiting for connection/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reload/i })).toBeInTheDocument();
  });

  it("Retry revalidates the snapshot (recovers the instant connectivity returns)", async () => {
    setOnline(false);
    h.lost = true;
    const user = userEvent.setup();
    const { loaderCalls } = await renderBanner();
    const before = loaderCalls();
    await user.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() => expect(loaderCalls()).toBeGreaterThan(before));
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
