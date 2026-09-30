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

function makeRouter(history: () => HistoryData = emptyHistory) {
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
            loader: history,
            element: <HistoryRoute />,
          },
        ],
      },
    ],
    { initialEntries: ["/pane/p1/history"] },
  );
}

const said = (uuid: string, role: "user" | "assistant", text: string) => ({
  uuid,
  ts: "",
  role,
  parts: [{ kind: "text" as const, text }],
});

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

// pi keeps every branch in ONE append-only log, so a rewound session's log holds the path the agent
// left as well as the one it is on. Its reader marks the turns that left rather than dropping them,
// because a `?before=` cursor still has to resolve their uuid on the bridge, so HIDING them is this
// side's job (bridge/journal/types.ts § `abandoned`, ADR 0073's addendum).
describe("HistoryRoute — a rewound branch", () => {
  afterEach(() => localStorage.clear());

  it("draws the turns on the branch and not the turns that left it", async () => {
    const withBranch = (): HistoryData => ({
      ...emptyHistory(),
      total: 3,
      entries: [
        said("m1", "user", "on the branch"),
        { ...said("m2", "assistant", "from the path it left"), abandoned: true },
        said("m3", "user", "still on the branch"),
      ],
    });
    render(<RouterProvider router={makeRouter(withBranch)} />);
    expect(await screen.findByText("on the branch")).toBeInTheDocument();
    expect(screen.getByText("still on the branch")).toBeInTheDocument();
    expect(screen.queryByText("from the path it left")).not.toBeInTheDocument();
  });

  it("leaves a session that never forked exactly as it was", async () => {
    const plain = (): HistoryData => ({
      ...emptyHistory(),
      total: 2,
      entries: [said("m1", "user", "a question"), said("m2", "assistant", "an answer")],
    });
    render(<RouterProvider router={makeRouter(plain)} />);
    expect(await screen.findByText("a question")).toBeInTheDocument();
    expect(screen.getByText("an answer")).toBeInTheDocument();
  });
});
