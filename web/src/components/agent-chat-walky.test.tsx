import { useState, type ComponentProps } from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";

// The pane's Messages row and sheet inside the real pane view (M62): where the row is offered, and
// when the sheet's Reply is. Sends never go out here, so the pane is pinned live as the other
// AgentChat suites pin it (lib/liveness.ts).
const liveness = vi.hoisted(() => ({ live: true }));
vi.mock("@/lib/liveness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/liveness")>()),
  isLive: () => liveness.live,
  useLive: () => liveness.live,
}));

import { fixtureAgents, fixtureWalkyAgent, paneTextWithDraft } from "@/test/handlers";
import { withHeaderHost } from "@/test/header-host";
import type { AgentView } from "@/lib/types";
import { AgentChat } from "./agent-chat";
import { WalkyLogProvider } from "./walky-log";

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});

const agent = fixtureAgents[0]!;

/** The pane view under the pane's walky list, with a handle that takes the agent away (the pane is gone). */
function renderPane(overrides: Partial<ComponentProps<typeof AgentChat>> = {}) {
  let setAgent: (next: AgentView | undefined) => void = () => {};
  function Harness() {
    const [shown, set] = useState<AgentView | undefined>(overrides.agent ?? agent);
    setAgent = set;
    return (
      <WalkyLogProvider rows={[fixtureWalkyAgent]} reads={1}>
        <AgentChat
          paneId={agent.paneId}
          agents={shown === undefined ? [] : [shown]}
          shellPanes={[]}
          tabs={[]}
          text={paneTextWithDraft("recent pane output")}
          onBack={vi.fn()}
          onSelect={vi.fn()}
          {...overrides}
          agent={shown}
        />
      </WalkyLogProvider>
    );
  }
  const router = createMemoryRouter([{ path: "/", element: withHeaderHost(<Harness />) }]);
  render(<RouterProvider router={router} />);
  return { goGone: () => act(() => setAgent(undefined)) };
}

async function openMessages(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Pane actions" }));
  await user.click(await screen.findByRole("button", { name: "Messages" }));
}

describe("the pane's Messages row and sheet", () => {
  it("offers the row on the lead's own pane, with Reply on an agent message", async () => {
    const user = userEvent.setup();
    renderPane();
    await openMessages(user);
    expect(await screen.findByRole("button", { name: "Reply to collie-workspace#fix-465" })).toBeInTheDocument();
  });

  it("offers no Messages row on a pane on a crew member: the lead cannot read that member's list in 1.23.0", async () => {
    const user = userEvent.setup();
    const host = "workshop";
    renderPane({ scope: { host }, agent: { ...agent, host } });
    await user.click(screen.getByRole("button", { name: "Pane actions" }));
    expect(await screen.findByRole("button", { name: "Find in output" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Messages" })).toBeNull();
  });

  it("takes Reply away once the pane is gone, while the sheet stands open", async () => {
    const user = userEvent.setup();
    const { goGone } = renderPane();
    await openMessages(user);
    expect(await screen.findByRole("button", { name: "Reply to collie-workspace#fix-465" })).toBeInTheDocument();
    goGone();
    expect(screen.getByText("Tests are green on fix-465. You can merge.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Reply to/ })).toBeNull();
  });
});
