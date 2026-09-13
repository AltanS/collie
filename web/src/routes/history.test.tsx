import { render, screen } from "@testing-library/react";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { ROOT_ROUTE_ID, type HistoryData, type HomeData } from "@/lib/loaders";
import { withHeaderHost } from "@/test/header-host";
import { HistoryRoute } from "./history";

const STORAGE_KEY = "collie:display-prefs:v4";

beforeAll(() => {
  // jsdom doesn't implement scrollTo; ChatMessageList's auto-scroll calls it on mount.
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});

const connected = (): HomeData => ({
  bridge: "connected",
  agents: [],
  shellPanes: [],
  workspaces: [],
  tabs: [],
  device: undefined,
  sessions: [],
  servers: [],
  ts: 0,
  scope: {},
  viewAll: false,
  snoozedUntil: null,
  update: undefined,
  error: false,
  authError: false,
});

function emptyHistory(): HistoryData {
  return { paneId: "p1", scope: {}, entries: [], hasMore: false, total: 0, fileTruncated: false };
}

function makeRouter() {
  return createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => connected(),
        element: withHeaderHost(<Outlet />),
        children: [
          { index: true, element: <div /> },
          {
            path: "pane/:paneId/history",
            loader: () => emptyHistory(),
            element: <HistoryRoute />,
          },
        ],
      },
    ],
    { initialEntries: ["/pane/p1/history"] },
  );
}

// The route mirrors the terminal — same font source, same idiom (components/agent-chat.tsx) — as
// the live pane view, applied to the div wrapping ChatMessageList. Reached via the scroll
// container's own known class rather than a test id, matching how agent-chat.test.tsx locates the
// mirror by adjacency instead of inventing a selector nothing else needs.
function mirrorWrapper(container: HTMLElement): HTMLElement {
  const scrollDiv = container.querySelector<HTMLElement>(".overflow-y-auto");
  if (!scrollDiv?.parentElement?.parentElement) throw new Error("mirror wrapper not found");
  return scrollDiv.parentElement.parentElement;
}

describe("HistoryRoute — terminal font", () => {
  afterEach(() => localStorage.clear());

  it("renders the system default face untouched", async () => {
    const { container } = render(<RouterProvider router={makeRouter()} />);
    await screen.findByText(/No transcript file was found/);

    const wrapper = mirrorWrapper(container);
    expect(wrapper.className).not.toMatch(/font-family:inherit/);
    expect(wrapper.getAttribute("style")).toBeNull();
  });

  it("applies the chosen terminal font to the transcript, same as the live mirror", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ fontFamily: "courier" }));
    const { container } = render(<RouterProvider router={makeRouter()} />);
    await screen.findByText(/No transcript file was found/);

    const wrapper = mirrorWrapper(container);
    expect(wrapper.className).toMatch(/\[font-family:inherit\]/);
    expect(wrapper.getAttribute("style")).toMatch(/Courier/);
    // The layout classes stay put — the font is added, not swapped in for them.
    expect(wrapper.className).toMatch(/(?:^|\s)flex-1(?=\s|$)/);
  });
});
