import type { ComponentProps } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";

import { server } from "@/test/setup";
import { clearStatus } from "@/lib/status";
import { fixtureAgents } from "@/test/handlers";
import { AgentChat } from "./agent-chat";

// The detail view's core job: type a reply and submit it to the bridge. This drives the whole wired
// path (composer → api.sendReply → MSW → optimistic clear / error surfacing) end-to-end, which no
// other test covers. AgentChat uses useRevalidator, so it needs a data router (createMemoryRouter).

beforeAll(() => {
  // jsdom doesn't implement scrollTo; the terminal mirror's auto-scroll calls it.
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => clearStatus());

function renderChat(overrides: Partial<ComponentProps<typeof AgentChat>> = {}) {
  const agent = fixtureAgents[0]!; // a blocked claude agent
  const props: ComponentProps<typeof AgentChat> = {
    paneId: agent.paneId,
    agent,
    agents: fixtureAgents,
    shellPanes: [],
    tabs: [],
    text: "recent pane output",
    onBack: vi.fn(),
    onSelect: vi.fn(),
    ...overrides,
  };
  const router = createMemoryRouter([{ path: "/", element: <AgentChat {...props} /> }]);
  render(<RouterProvider router={router} />);
  return props;
}

describe("AgentChat — reply flow", () => {
  it("sends a typed reply and clears the composer on success", async () => {
    const user = userEvent.setup();
    renderChat();
    const box = screen.getByPlaceholderText(/type or dictate a reply/i);

    await user.type(box, "looks good");
    expect(box).toHaveValue("looks good");

    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(box).toHaveValue(""));
  });

  it("keeps the draft and surfaces the error when the bridge rejects the send", async () => {
    server.use(
      http.post(/\/api\/pane\/[^/]+\/reply$/, () =>
        HttpResponse.json({ ok: false, error: "agent busy" }),
      ),
    );
    const user = userEvent.setup();
    renderChat();
    const box = screen.getByPlaceholderText(/type or dictate a reply/i);

    await user.type(box, "retry this");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("agent busy")).toBeInTheDocument();
    expect(box).toHaveValue("retry this"); // not cleared on failure
  });
});

// Echoes the space passed via navigation state, so a test can assert the header lands on the space
// overview ("/") for the right workspace.
function SpaceOverviewSentinel() {
  const space = (useLocation().state as { space?: string } | null)?.space;
  return <div>overview:{space ?? "none"}</div>;
}

describe("AgentChat — header title block", () => {
  it("leads with the space, puts the directory on the subline, and drops the redundant agent name", () => {
    renderChat(); // claude @ /home/you/webapp → ~/webapp
    expect(screen.getByText("webapp")).toBeInTheDocument(); // space leads
    expect(screen.getByText("~/webapp")).toBeInTheDocument(); // directory on the subline
    // The agent is conveyed by its icon (aria-label only), so its name isn't repeated as text.
    expect(screen.queryByText(/claude/i)).toBeNull();
    expect(screen.getByRole("button", { name: /open webapp overview/i })).toBeInTheDocument();
  });

  it("opens the space overview (all tabs + panes) when the title block is tapped", async () => {
    const user = userEvent.setup();
    const agent = fixtureAgents[0]!; // workspaceId w1
    const router = createMemoryRouter(
      [
        { path: "/", element: <SpaceOverviewSentinel /> },
        {
          path: "/pane/:paneId",
          element: (
            <AgentChat
              paneId={agent.paneId}
              agent={agent}
              agents={fixtureAgents}
              shellPanes={[]}
              tabs={[]}
              text="out"
              onBack={vi.fn()}
              onSelect={vi.fn()}
            />
          ),
        },
      ],
      { initialEntries: ["/pane/w1:p1"] },
    );
    render(<RouterProvider router={router} />);

    await user.click(screen.getByRole("button", { name: /open webapp overview/i }));
    expect(await screen.findByText("overview:w1")).toBeInTheDocument();
  });
});

describe("AgentChat — read-only device", () => {
  it("disables the composer and shows the banner when the device isn't authorised", () => {
    renderChat({ device: { enforced: true, device: "spare-phone", authorized: false } });

    // The banner names the read-only state (and the device id), and the composer is locked.
    expect(screen.getByText(/read-only/i)).toBeInTheDocument();
    expect(screen.getByText(/spare-phone/)).toBeInTheDocument();
    const box = screen.getByPlaceholderText(/read-only — device not authorised/i);
    expect(box).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    // The terminal mirror still renders — reading is always allowed.
    expect(screen.getByText("recent pane output")).toBeInTheDocument();
  });

  it("keeps the composer live for an authorised device", () => {
    renderChat({ device: { enforced: true, device: "my-phone", authorized: true } });
    expect(screen.queryByText(/read-only/i)).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(/type or dictate a reply/i)).not.toBeDisabled();
  });
});
