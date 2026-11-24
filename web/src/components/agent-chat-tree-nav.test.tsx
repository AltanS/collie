import { type ComponentProps } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";

// THE PANE HEADER'S TREE BUTTON (components/tree-nav.tsx): drawn only on a pane that sits in a tree with a
// relative to move to, and its sheet moves sideways to that relative, as the switcher does.
const liveness = vi.hoisted(() => ({ live: true }));
vi.mock("@/lib/liveness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/liveness")>()),
  isLive: () => liveness.live,
  useLive: () => liveness.live,
}));

import { clearStatus } from "@/lib/status";
import { ROOT_ROUTE_ID } from "@/lib/loaders";
import { fixtureAgents, paneTextWithDraft } from "@/test/handlers";
import { withHeaderHost } from "@/test/header-host";
import type { AgentView } from "@/lib/types";
import { isShortcutActionAvailable, runShortcutAction } from "@/lib/shortcuts/registry";
import { AgentChat } from "./agent-chat";

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => clearStatus());

function Where() {
  const { pathname } = useLocation();
  return <p data-testid="where">{pathname}</p>;
}

function renderPane(agents: AgentView[], here: AgentView) {
  const props: ComponentProps<typeof AgentChat> = {
    paneId: here.paneId,
    agent: here,
    agents,
    shellPanes: [],
    tabs: [],
    text: paneTextWithDraft("recent pane output"),
    onBack: vi.fn(),
    onSelect: vi.fn(),
  };
  const element = withHeaderHost(
    <>
      <AgentChat {...props} />
      <Where />
    </>,
  );
  const router = createMemoryRouter([{ id: ROOT_ROUTE_ID, path: "*", loader: () => null, element }], {
    initialEntries: [`/pane/${encodeURIComponent(here.paneId)}`],
    hydrationData: { loaderData: { [ROOT_ROUTE_ID]: { workspaces: [], stale: false } } },
  });
  render(<RouterProvider router={router} />);
}

describe("the pane header's tree button", () => {
  const [a, b] = fixtureAgents;
  const coord: AgentView = { ...a!, tree: { id: "c1", role: "coordinator" } };
  const worker: AgentView = { ...b!, tree: { id: "w1", parent: "c1", role: "worker" } };

  it("is absent on a pane in no tree", () => {
    renderPane(fixtureAgents, fixtureAgents[0]!);
    expect(screen.queryByRole("button", { name: "Move in the tree" })).toBeNull();
  });

  it("opens the tree sheet and moves up to the parent", async () => {
    const user = userEvent.setup();
    renderPane([coord, worker, ...fixtureAgents.slice(2)], worker);
    await user.click(screen.getByRole("button", { name: "Move in the tree" }));
    await user.click(await screen.findByRole("button", { name: /Up to / }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(`/pane/${encodeURIComponent(coord.paneId)}`));
  });

  it("the tree moves are shortcut actions: up to the parent, and none where a pane has no such relative", async () => {
    renderPane([coord, worker, ...fixtureAgents.slice(2)], worker);
    expect(isShortcutActionAvailable("tree_parent")).toBe(true);
    expect(isShortcutActionAvailable("tree_first_child")).toBe(false);
    act(() => {
      runShortcutAction("tree_parent");
    });
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(`/pane/${encodeURIComponent(coord.paneId)}`));
  });
});
