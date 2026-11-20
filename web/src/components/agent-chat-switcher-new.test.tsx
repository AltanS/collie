import { type ComponentProps } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";

// THE SWITCH PANE SHEET'S NEW BUTTON: the dashboard's own New button, in the sheet's title row, before the
// close button. Drawn on the dashboard's terms (a device that may write), except on the saved copy of the herd, where
// the dashboard keeps its button and refuses on the tap but the sheet draws none; and going where the dashboard's tap goes, the New page on this pane's machine and session.
const liveness = vi.hoisted(() => ({ live: true }));
vi.mock("@/lib/liveness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/liveness")>()),
  isLive: () => liveness.live,
  useLive: () => liveness.live,
}));

import { clearStatus, useStatus } from "@/lib/status";
import { ROOT_ROUTE_ID } from "@/lib/loaders";
import { fixtureAgents, paneTextWithDraft } from "@/test/handlers";
import { withHeaderHost } from "@/test/header-host";
import { runShortcutAction } from "@/lib/shortcuts/registry";
import { AgentChat } from "./agent-chat";

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => {
  clearStatus();
  liveness.live = true;
});

function Where() {
  const { pathname, search } = useLocation();
  return <p data-testid="where">{`${pathname}${search}`}</p>;
}
function Notice() {
  const status = useStatus();
  return <p data-testid="notice">{status?.text ?? ""}</p>;
}

function renderPane(overrides: Partial<ComponentProps<typeof AgentChat>> = {}, rootStale = false) {
  const agent = fixtureAgents[0]!;
  const props: ComponentProps<typeof AgentChat> = {
    paneId: agent.paneId,
    agent,
    agents: fixtureAgents,
    shellPanes: [],
    tabs: [],
    text: paneTextWithDraft("recent pane output"),
    onBack: vi.fn(),
    onSelect: vi.fn(),
    ...overrides,
  };
  const element = withHeaderHost(
    <>
      <AgentChat {...props} />
      <Where />
      <Notice />
    </>,
  );
  const router = createMemoryRouter(
    [{ id: ROOT_ROUTE_ID, path: "*", loader: () => null, element }],
    { hydrationData: { loaderData: { [ROOT_ROUTE_ID]: { workspaces: [], stale: rootStale } } } },
  );
  render(<RouterProvider router={router} />);
  return router;
}

const titleRow = () => document.querySelector<HTMLElement>('[data-slot="sheet-title-row"]')!;


// The Belt's pill opens Actions since ADR 0165; the pane list keeps its drag, its handle and its action.
function openSwitcher(): void {
  act(() => {
    runShortcutAction("switch_pane");
  });
}

describe("the Switch pane sheet's New button", () => {
  it("stands in the title row, directly before the close button", async () => {
    renderPane();
    openSwitcher();
    const sheet = await screen.findByRole("dialog");
    const news = within(titleRow()).getByRole("button", { name: "New" });
    expect(sheet).toContainElement(news);
    expect(news.closest('[data-slot="sheet-action"]')!.nextElementSibling).toBe(within(sheet).getByRole("button", { name: "Close" }));
  });

  it("is absent on a device that may not write, and the row is as it was", async () => {
    renderPane({ device: { enforced: true, device: "phone", authorized: false } });
    openSwitcher();
    await screen.findByRole("dialog");
    expect(within(titleRow()).queryByRole("button", { name: "New" })).toBeNull();
    expect(titleRow().children).toHaveLength(2);
  });

  it("closes the sheet and opens the New page on this machine, a level below the pane", async () => {
    const user = userEvent.setup();
    const router = renderPane();
    openSwitcher();
    await user.click(within(titleRow()).getByRole("button", { name: "New" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The dashboard's tap gives `newPath({ machine, session })`, and the fixture pane names neither.
    // The router commits a navigation after the root loader settles, which is later than the sheet closing.
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/new$/u));
    // A push, so Back returns to the pane.
    expect(router.state.historyAction).toBe("PUSH");
  });

  it("is not drawn while the herd is a saved copy, so a tap can never read as a mis-tap on Close", async () => {
    renderPane({}, true);
    openSwitcher();
    await screen.findByRole("dialog");
    expect(within(titleRow()).queryByRole("button", { name: "New" })).toBeNull();
    expect(titleRow().children).toHaveLength(2);
  });
});
