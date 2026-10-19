import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PANE_ROUTE_ID, ROOT_ROUTE_ID, type HomeData, type PaneData } from "@/lib/loaders";
import { panePath, zoomPath } from "@/lib/nav";
import { fixtureAgents, paneTextWithDraft } from "@/test/handlers";
import { withHeaderHost } from "@/test/header-host";
import { server } from "@/test/setup";
import { DetailRoute } from "./detail";

// THE OUTPUT, ZOOMED, through the real pane route: the belt's pill beside the switcher opens
// `/pane/:id/zoom`, a child of the pane route, the view reads the pane loader live, and the ✕ and the
// phone's back both close it. Nothing on the way asks the bridge to move the pane (ADR 0008).

vi.mock("@/hooks/use-loading-stalled", () => ({ useLoadingStalled: () => false }));

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});

const agent = fixtureAgents[0]!;
let paneText = paneTextWithDraft("recent pane output");

const home = (): HomeData => ({
  bridge: "connected",
  agents: fixtureAgents,
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

function makeRouter() {
  return createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: home,
        element: withHeaderHost(<Outlet />),
        children: [
          { index: true, element: <div>HOME</div> },
          {
            id: PANE_ROUTE_ID,
            path: "pane/:paneId",
            loader: ({ params }): PaneData => ({
              paneId: params.paneId ?? "",
              scope: {},
              text: paneText,
              truncated: false,
              requestedLines: 600,
              revision: 0,
              error: false,
              authError: false,
            }),
            element: <DetailRoute />,
            // The same shape router.tsx gives it.
            children: [{ path: "zoom", element: null }],
          },
        ],
      },
    ],
    { initialEntries: ["/", panePath(agent.paneId)], initialIndex: 1 },
  );
}

// Every request the page makes while the view is in play, as "METHOD /path".
let requests: string[] = [];
const record = ({ request }: { request: Request }) => {
  requests.push(`${request.method} ${new URL(request.url).pathname}`);
};
beforeEach(() => {
  paneText = paneTextWithDraft("recent pane output");
  requests = [];
  server.events.on("request:start", record);
});
afterEach(() => {
  server.events.removeListener("request:start", record);
});

const zoomDialog = () => screen.queryByRole("dialog", { name: "Zoomed output" });

describe("the pane's output, zoomed", () => {
  it("puts the Zoom pill directly beside the switcher, and opens a level below the pane", async () => {
    const user = userEvent.setup();
    const router = makeRouter();
    render(<RouterProvider router={router} />);
    const pill = await screen.findByRole("button", { name: "Zoom output" });
    expect(pill.nextElementSibling).toBe(screen.getByRole("button", { name: "Switch pane" }));
    expect(zoomDialog()).toBeNull();

    await user.click(pill);
    expect(router.state.location.pathname).toBe(zoomPath(agent.paneId));
    const dialog = await screen.findByRole("dialog", { name: "Zoomed output" });
    expect(dialog).toHaveTextContent("recent pane output");
    // The output alone: no composer field inside the view.
    expect(within(dialog).queryByRole("textbox")).toBeNull();
    // The pane under it stays mounted, composer and all.
    expect(screen.getAllByRole("textbox").length).toBeGreaterThan(0);
  });

  it("keeps reading the pane loader while open", async () => {
    const user = userEvent.setup();
    const router = makeRouter();
    render(<RouterProvider router={router} />);
    await user.click(await screen.findByRole("button", { name: "Zoom output" }));
    const dialog = await screen.findByRole("dialog", { name: "Zoomed output" });

    paneText = paneTextWithDraft("a line the next poll brought");
    await act(async () => {
      await router.revalidate();
    });
    expect(dialog).toHaveTextContent("a line the next poll brought");
    expect(router.state.location.pathname).toBe(zoomPath(agent.paneId));
  });

  it("closes on the ✕, stepping back onto the pane", async () => {
    const user = userEvent.setup();
    const router = makeRouter();
    render(<RouterProvider router={router} />);
    await user.click(await screen.findByRole("button", { name: "Zoom output" }));
    const dialog = await screen.findByRole("dialog", { name: "Zoomed output" });
    const opened = router.state.historyAction;

    await user.click(within(dialog).getByRole("button", { name: "Back to the pane" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(panePath(agent.paneId)));
    // An up that steps back, never a push: the view is not left behind for the next swipe.
    expect(router.state.historyAction).toBe("POP");
    expect(opened).toBe("PUSH");
    expect(zoomDialog()).toBeNull();
    expect(screen.getByRole("button", { name: "Zoom output" })).toBeInTheDocument();
  });

  it("closes on the phone's back", async () => {
    const user = userEvent.setup();
    const router = makeRouter();
    render(<RouterProvider router={router} />);
    await user.click(await screen.findByRole("button", { name: "Zoom output" }));
    await screen.findByRole("dialog", { name: "Zoomed output" });

    await act(async () => {
      await router.navigate(-1);
    });
    expect(router.state.location.pathname).toBe(panePath(agent.paneId));
    expect(zoomDialog()).toBeNull();
  });

  it("never asks the bridge to zoom, resize or otherwise write to the pane", async () => {
    const user = userEvent.setup();
    const router = makeRouter();
    render(<RouterProvider router={router} />);
    await user.click(await screen.findByRole("button", { name: "Zoom output" }));
    const dialog = await screen.findByRole("dialog", { name: "Zoomed output" });
    await user.click(within(dialog).getByRole("button", { name: "Zoom in" }));
    await user.click(within(dialog).getByRole("button", { name: /^Reset zoom/ }));
    await act(async () => {
      await router.revalidate();
    });
    await user.click(within(dialog).getByRole("button", { name: "Back to the pane" }));
    await waitFor(() => expect(zoomDialog()).toBeNull());

    expect(requests.filter((r) => !r.startsWith("GET "))).toEqual([]);
    expect(requests.filter((r) => /zoom|resize|focus|layout/i.test(r))).toEqual([]);
  });
});
