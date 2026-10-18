import { useState, type ComponentProps } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

import { fixtureAgents, fixtureWalkyAgent, paneTextWithDraft, recordedWalkyPosts } from "@/test/handlers";
import { withHeaderHost } from "@/test/header-host";
import { server } from "@/test/msw";
import type { AgentView } from "@/lib/types";
import type { WalkyRow } from "@/lib/walky";
import { AgentChat } from "./agent-chat";
import { WalkyLogProvider } from "./walky-log";

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});

const agent = fixtureAgents[0]!;

/** The pane view under the pane's walky list, with a handle that takes the agent away (the pane is gone). */
function renderPane(overrides: Partial<ComponentProps<typeof AgentChat>> = {}, rows: readonly WalkyRow[] = [fixtureWalkyAgent]) {
  let setAgent: (next: AgentView | undefined) => void = () => {};
  function Harness() {
    const [shown, set] = useState<AgentView | undefined>(overrides.agent ?? agent);
    setAgent = set;
    return (
      <WalkyLogProvider rows={rows} reads={1}>
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

  it("offers the row on a pane on a crew member too, and its Reply goes to the lead's route by the sender's address", async () => {
    // The lead forwards the member's own list (CREW_PROTOCOL.md §21), and a reply carries no host: the
    // address names the machine, and the lead routes it there.
    const user = userEvent.setup();
    const host = "workshop";
    const row = { ...fixtureWalkyAgent, from: { ...fixtureWalkyAgent.from, memberId: host, address: `${host}/w2:p4#m7q2` } };
    const urls: string[] = [];
    const listen = ({ request }: { request: Request }) => {
      if (request.method === "POST" && new URL(request.url).pathname === "/api/walky") urls.push(request.url);
    };
    server.events.on("request:start", listen);
    try {
      renderPane({ scope: { host }, agent: { ...agent, host } }, [row]);
      await openMessages(user);
      await user.click(await screen.findByRole("button", { name: "Reply to collie-workspace#fix-465" }));
      await user.type(await screen.findByPlaceholderText(/type a reply/i), "Seen it");
      await user.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(recordedWalkyPosts()).toHaveLength(1));
    } finally {
      server.events.removeListener("request:start", listen);
    }
    expect(recordedWalkyPosts()[0]).toMatchObject({ to: `${host}/w2:p4#m7q2`, replyTo: row.id, body: "Seen it" });
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0]!).search).toBe("");
  });

  it("shows a member pane's sheet as unavailable when its list could not be read", async () => {
    const user = userEvent.setup();
    const host = "workshop";
    function Unread() {
      return (
        <WalkyLogProvider rows={null} reads={2}>
          <AgentChat paneId={agent.paneId} agents={[{ ...agent, host }]} shellPanes={[]} tabs={[]} text={paneTextWithDraft("out")} onBack={vi.fn()} onSelect={vi.fn()} scope={{ host }} agent={{ ...agent, host }} />
        </WalkyLogProvider>
      );
    }
    render(<RouterProvider router={createMemoryRouter([{ path: "/", element: withHeaderHost(<Unread />) }])} />);
    await openMessages(user);
    expect(await screen.findByText("This machine does not keep messages yet.")).toBeInTheDocument();
  });

  it("sends a Reply to the sender's address as it stands, token included", async () => {
    const user = userEvent.setup();
    const row = { ...fixtureWalkyAgent, from: { ...fixtureWalkyAgent.from, address: "bluefin/w6:p3#k3f9" } };
    renderPane({}, [row]);
    await openMessages(user);
    await user.click(await screen.findByRole("button", { name: "Reply to collie-workspace#fix-465" }));
    await user.type(await screen.findByPlaceholderText(/type a reply/i), "Merge it");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(recordedWalkyPosts()).toHaveLength(1));
    expect(recordedWalkyPosts()[0]).toMatchObject({ to: "bluefin/w6:p3#k3f9", replyTo: row.id, body: "Merge it" });
  });

  it("addresses a message from the pane to its own session instance", async () => {
    const user = userEvent.setup();
    renderPane({ agent: { ...agent, instance: "k3f9" } });
    await user.type(await screen.findByPlaceholderText(/type a reply/i), "Stop and report");
    fireEvent.contextMenu(screen.getByRole("button", { name: "Send" }));
    await user.click(await screen.findByRole("button", { name: "Send as message" }));
    await waitFor(() => expect(recordedWalkyPosts()).toHaveLength(1));
    expect(recordedWalkyPosts()[0]?.to).toBe(`local/${agent.paneId}#k3f9`);
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
