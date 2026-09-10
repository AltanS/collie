import { act, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";

import { BootSplash, RootLayout, shownLastSeenAt } from "./root";
import { RouteHeader } from "@/components/app-header";
import { server } from "@/test/setup";
import { __resetOperatorCommands } from "@/lib/operator-config";
import { CONNECTION_LOST_MS } from "@/hooks/use-connection-lost";
import { __resetConnectionHealth } from "@/lib/connection-health";
import { collieMark, markIsLive, markPaper } from "@/test/collie-mark";
import { ROOT_ROUTE_ID, type HomeData, type PaneData } from "@/lib/loaders";

// BootSplash is the router's HydrateFallback: it stays mounted until the FIRST loader run settles, so
// over a dead tailnet (a hanging initial fetch) it can otherwise bloom the mark forever with no way
// out. It must escalate to an actionable "Not connected" state once stuck past CONNECTION_LOST_MS.
// Fake timers drive the wall-clock hook (Vitest advances Date.now with them).
describe("BootSplash — escalates a stuck cold start", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetConnectionHealth(); // module-load anchor == frozen clock: a dead cold start escalates ~15s in
  });
  afterEach(() => vi.useRealTimers());

  it("blooms the mark on the connecting splash before the threshold", () => {
    const { container } = render(<BootSplash />);
    expect(screen.getByText("Connecting to the herd…")).toBeInTheDocument();
    // The bloom is a colour as well as turning — a reduced-motion reader gets the accents only.
    expect(markIsLive(container)).toBe(true);
    expect(markPaper(container)).toBe("var(--background)");
    // still the plain splash a beat before the threshold
    act(() => vi.advanceTimersByTime(CONNECTION_LOST_MS - 1));
    expect(screen.getByText("Connecting to the herd…")).toBeInTheDocument();
    expect(markIsLive(container)).toBe(true);
    expect(screen.queryByText("Not connected")).not.toBeInTheDocument();
  });

  it("escalates to 'Not connected' with a Retry once stuck past the threshold", () => {
    const { container } = render(<BootSplash />);
    act(() => vi.advanceTimersByTime(CONNECTION_LOST_MS));
    expect(screen.queryByText("Connecting to the herd…")).not.toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(screen.getByText(/Can.t reach Collie/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    // Same mark throughout — it is never swapped for a second drawing, it only stops blooming: the
    // rest state is that mark still, muted. No bloom, because we have stopped trying, and a
    // blooming mark would say otherwise. No gallop sprite on this screen either (the app mounts one
    // animal).
    expect(container.querySelector(".dog-gallop")).toBeNull();
    const mark = collieMark(container);
    expect(markIsLive(container)).toBe(false);
    expect(mark?.getAttribute("class")).toMatch(/grayscale/);
  });
});

// The one connection surface is mounted in RootLayout and dates what is on screen. On the dashboard
// that is the herd; inside a pane it is the mirror, and after a cold boot the two stamps can be hours
// apart — the operator opened the pane at 12:05 and left the dashboard polling until 14:32.

const NOON = new Date(2026, 0, 2, 12, 5).getTime();
const AFTERNOON = new Date(2026, 0, 2, 14, 32).getTime();

function home(lastSeenAt?: number): HomeData {
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
    update: undefined,
    error: true,
    authError: false,
    lastSeenAt,
  };
}

function pane(overrides: Partial<PaneData>): PaneData {
  return {
    paneId: "w1:p1",
    scope: {},
    text: "old terminal text",
    truncated: false,
    requestedLines: 600,
    revision: 0,
    error: true,
    authError: false,
    ...overrides,
  };
}

describe("which 'last seen' the connection bar shows", () => {
  it("uses the snapshot's stamp on the dashboard (no pane route active)", () => {
    expect(shownLastSeenAt(home(AFTERNOON), undefined)).toBe(AFTERNOON);
  });

  it("uses the PANE's own stamp while a stale mirror is what's being read", () => {
    expect(shownLastSeenAt(home(AFTERNOON), pane({ lastSeenAt: NOON }))).toBe(NOON);
  });

  it("says nothing rather than borrowing the herd's stamp for an undatable mirror", () => {
    expect(shownLastSeenAt(home(AFTERNOON), pane({ lastSeenAt: undefined }))).toBeUndefined();
  });

  it("falls back to the snapshot when the stale pane has no text to date", () => {
    expect(shownLastSeenAt(home(AFTERNOON), pane({ text: "", lastSeenAt: undefined }))).toBe(
      AFTERNOON,
    );
  });

  it("falls back to the snapshot when the pane itself is live", () => {
    expect(shownLastSeenAt(home(AFTERNOON), pane({ error: false, lastSeenAt: NOON }))).toBe(
      AFTERNOON,
    );
  });
});

// The root wrapper is the ONE flex column the whole app renders inside (banners + header + outlet, all
// in-flow). It must never itself become a scrolling element: a scrollport nested inside it that hits
// its own bound (the statusline strip, the mirror) would otherwise chain an over-drag into the
// document, dragging the banners and header off screen with it and leaving no scroll position to
// snap back from. `overflow-hidden` here is what forces every scroll to stay inside a scrollport that
// actually declares one.
describe("RootLayout — the document itself never scrolls", () => {
  it("renders its flex column with overflow-hidden", async () => {
    const router = createMemoryRouter(
      [{ id: ROOT_ROUTE_ID, path: "/", loader: () => home(AFTERNOON), element: <RootLayout /> }],
      { initialEntries: ["/"] },
    );
    const { container } = render(<RouterProvider router={router} />);
    // The loader resolves on a microtask even though it's synchronous — the route isn't hydrated yet
    // on the first render.
    const column = await waitFor(() => {
      const el = container.querySelector(".flex.h-\\[100dvh\\].flex-col");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(column.className).toMatch(/(?:^|\s)overflow-hidden(?=\s|$)/);
  });
});

// THE NOTCH IS PAID FOR ONCE, IN BOTH STATES, AND THIS IS THE REPORTED BUG.
//
// Three rows at the top of this app each set `env(safe-area-inset-top)` for themselves — the update
// ribbon, the connection bar and the header — every one of them written when it was, or might have
// been, the first thing on the screen. Any two of them showing at once therefore reserved the notch
// twice, and on an iPhone that is a tall dead band above the notice. Ribbon + header is the everyday
// case and the one that was reported.
//
// It is asserted HERE, on the whole layout, and not in the three components' own files, because it
// is exactly the kind of fault that hides from per-component tests: each row was individually
// correct, and the total was wrong. So the assertion is a count over the rendered tree.
describe("RootLayout — the safe-area inset is reserved exactly once", () => {
  function renderLayout(data: HomeData) {
    const router = createMemoryRouter(
      [{ id: ROOT_ROUTE_ID, path: "/", loader: () => data, element: <RootLayout /> }],
      { initialEntries: ["/"] },
    );
    return render(<RouterProvider router={router} />);
  }

  const offered: HomeData = {
    ...home(AFTERNOON),
    error: false,
    update: {
      current: "1.4.1",
      latest: "1.5.0",
      latestUrl: null,
      releaseAvailable: true,
      majorAvailable: null,
      majorUrl: null,
      bridgeStale: false,
      checkedAt: 0,
    },
  };

  /** Every element reserving the top inset, anywhere in the app's column. */
  function reservations(container: HTMLElement) {
    return container.querySelectorAll("[class*='safe-area-inset-top']");
  }

  it("gives it to the band while a strip is showing, and not to the header as well", async () => {
    const { container } = renderLayout(offered);
    await waitFor(() => expect(screen.getByText(/Collie 1.5.0 available/)).toBeInTheDocument());

    expect(reservations(container)).toHaveLength(1);
    // And it is the band's, above the header — not the header's.
    const reserved = reservations(container)[0]!;
    expect(container.querySelector("header")?.contains(reserved)).toBe(false);
    expect(container.querySelector("header")?.className).not.toMatch(/safe-area/);
  });

  it("gives it to the header while the band is empty", async () => {
    const { container } = renderLayout({ ...home(AFTERNOON), error: false });
    await waitFor(() => expect(container.querySelector("header")).not.toBeNull());

    expect(reservations(container)).toHaveLength(1);
    expect(container.querySelector("header")?.className).toMatch(/safe-area-inset-top/);
  });
});

// NOTHING ABOVE THE OUTLET MAY REMOUNT ON A NAVIGATION, and the screen transition is the change
// that could break it: it keys the outlet region on the pathname so the arriving screen's entrance
// replays. A key placed one level too high would take the header shell with it, which is the fault
// `AppHeaderHost` was hoisted out of the routes to end — the Collie mark's 37 CSS animations
// restarting at zero on every tap — and it would take the band's two permanent live regions with it
// as well, which is how a strip stops being announced. So the assertion is element IDENTITY across
// a real dashboard → pane navigation, not a class or a count.
describe("RootLayout — the shell survives a navigation", () => {
  it("keeps the header and the band's live regions as the same DOM nodes", async () => {
    // Counted, because the OTHER half of the claim is that the key remounts a React subtree and
    // nothing more: a key is a reconciliation hint, and loaders belong to the router, which never
    // sees it. A root loader that ran twice here would mean the navigation had reloaded the app's
    // whole snapshot to slide one screen in.
    let rootLoads = 0;
    const router = createMemoryRouter(
      [
        {
          id: ROOT_ROUTE_ID,
          path: "/",
          loader: () => {
            rootLoads += 1;
            return home(AFTERNOON);
          },
          element: <RootLayout />,
          children: [
            { index: true, element: <div>dashboard</div> },
            { path: "pane/:paneId", element: <div>pane</div> },
          ],
        },
      ],
      { initialEntries: ["/"] },
    );
    const { container } = render(<RouterProvider router={router} />);
    await waitFor(() => expect(screen.getByText("dashboard")).toBeInTheDocument());

    const header = container.querySelector("header");
    const polite = container.querySelector("[data-slot='strip-live-polite']");
    const assertive = container.querySelector("[data-slot='strip-live-assertive']");
    expect(header).not.toBeNull();
    expect(polite).not.toBeNull();
    expect(assertive).not.toBeNull();

    await act(() => router.navigate("/pane/w1%3Ap1"));
    await waitFor(() => expect(screen.getByText("pane")).toBeInTheDocument());

    expect(container.querySelector("header")).toBe(header);
    expect(container.querySelector("[data-slot='strip-live-polite']")).toBe(polite);
    expect(container.querySelector("[data-slot='strip-live-assertive']")).toBe(assertive);
    // …while the region that DOES remount is the one holding the route.
    expect(container.querySelector("[data-slot='screen-transition']")).not.toBeNull();
    expect(rootLoads).toBe(1);
  });
});

// THE IDENTITY BLOCK IS MOUNTED ONCE AND HIDDEN, NEVER UNMOUNTED — the same claim as the one above,
// one level deeper, and a reported bug rather than a theory. "Collie on <mux>" rides the wordmark
// claim, which the dashboard makes and a pane does not. Rendered ON that claim, the block left the
// DOM on every dashboard → pane move and came back new, and with it a NEW mux-logo `<img>`. The
// bridge serves that logo with `Cache-Control: no-cache` plus an ETag, so every dashboard open cost
// a conditional request before the picture could paint: on a phone over Tailscale that is a blank
// logo box for a round trip, which is what the operator saw glitch (reproduced 2026-09-10). So the
// assertion is element IDENTITY over a round trip, on the block AND on the image inside it.
describe("RootLayout — the header identity survives a round trip to a pane", () => {
  beforeEach(() => {
    __resetOperatorCommands(); // the mux block is cached for the life of the page; re-read it here
    server.use(
      http.get("/api/config", () =>
        HttpResponse.json({
          push: false,
          vapidPublicKey: "",
          mux: {
            name: "reference",
            capabilities: {},
            unsupportedKeys: [],
            notes: {},
            logoUrl: "/api/mux/logo.svg",
          },
        }),
      ),
    );
  });

  it("keeps the block and its mux logo as the same DOM nodes, hidden inside the pane", async () => {
    const router = createMemoryRouter(
      [
        {
          id: ROOT_ROUTE_ID,
          path: "/",
          loader: () => ({ ...home(AFTERNOON), error: false }),
          element: <RootLayout />,
          children: [
            {
              index: true,
              element: (
                <>
                  <RouteHeader wordmark />
                  <div>dashboard</div>
                </>
              ),
            },
            {
              path: "pane/:paneId",
              element: (
                <>
                  <RouteHeader>
                    <span>webapp › main</span>
                  </RouteHeader>
                  <div>pane</div>
                </>
              ),
            },
          ],
        },
      ],
      { initialEntries: ["/"] },
    );
    const { container } = render(<RouterProvider router={router} />);
    await waitFor(() => expect(screen.getByText("on reference")).toBeInTheDocument());

    const identity = container.querySelector('[data-slot="header-identity"]');
    const logo = container.querySelector('[data-slot="header-identity"] img');
    expect(identity).toBeVisible();
    expect(logo).not.toBeNull();
    expect(logo).toHaveAttribute("src", "/api/mux/logo.svg");

    // Into the pane: the block yields the width, so it must not be SEEN…
    await act(() => router.navigate("/pane/w1%3Ap1"));
    await waitFor(() => expect(screen.getByText("webapp › main")).toBeInTheDocument());
    expect(container.querySelector('[data-slot="header-identity"]')).toBe(identity);
    expect(identity).not.toBeVisible();
    // …and it is still the same two nodes, so nothing re-requests the logo on the way back.
    expect(container.querySelector('[data-slot="header-identity"] img')).toBe(logo);

    await act(() => router.navigate("/"));
    await waitFor(() => expect(screen.getByText("dashboard")).toBeInTheDocument());
    expect(container.querySelector('[data-slot="header-identity"]')).toBe(identity);
    expect(container.querySelector('[data-slot="header-identity"] img')).toBe(logo);
    expect(identity).toBeVisible();
  });
});
