import type { ComponentProps } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";

import { server } from "@/test/setup";
import { fixtureAgents } from "@/test/handlers";
import { __resetOperatorCommands } from "@/lib/operator-config";
import type { MuxCapability, MuxConfig } from "@/lib/types";
import { AgentChat } from "./agent-chat";
import { AgentList } from "./agent-list";
import { NavTray } from "./nav-tray";
import { PaneActionsSheet } from "./pane-actions-sheet";
import { SpaceOverview } from "./space-overview";
import { SpaceStrip } from "./space-strip";
import { TabActionsSheet } from "./tab-actions-sheet";
import { TabStrip } from "./tab-strip";

// EVERY CAPABILITY-GATED CONTROL, IN BOTH STATES (M10/06). One file rather than a case bolted onto
// each component's own suite, because the thing under test is a RULE that spans them — hide what is
// meaningless, explain what is expected — and a rule applied eight different ways is exactly what
// this file exists to catch.
//
// The declaration is fabricated and its name is not a real multiplexer's, on purpose: if any of
// these controls could be made to appear or disappear by the NAME, every assertion below would still
// pass while the app had quietly re-welded itself to one multiplexer. The name is inert here because
// it is inert in the app.
//
// The capable state is asserted every time too, and it is not padding: it is the standing proof that
// a Herdr operator — whose adapter declares all fourteen — sees exactly the app they saw before.

beforeAll(() => {
  // jsdom implements no scrollTo, and the terminal mirror's auto-scroll calls it on mount. Same
  // polyfill agent-chat.test.tsx installs, for the same reason.
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});

/** The store caches one successful read for the life of the page; each case gets its own page. */
afterEach(() => __resetOperatorCommands());

/** Serve an `/api/config` whose mux block declares exactly `capabilities`, with `notes`. */
function declares(
  capabilities: Partial<Record<MuxCapability, boolean>>,
  notes: Partial<Record<MuxCapability, string>> = {},
  unsupportedKeys: string[] = [],
): void {
  const mux: MuxConfig = { name: "reference", capabilities, unsupportedKeys, notes };
  server.use(http.get("/api/config", () => HttpResponse.json({ push: false, vapidPublicKey: "", mux })));
}

/** Serve a bridge that publishes no mux block at all — the older-bridge case. */
function saysNothing(): void {
  server.use(http.get("/api/config", () => HttpResponse.json({ push: false, vapidPublicKey: "" })));
}

// ── Space creation → createSpace ─────────────────────────────────────────────

const workspace = {
  workspaceId: "w1",
  number: 1,
  label: "webapp",
  focused: false,
  activeTabId: "w1:t1",
  tabCount: 1,
  paneCount: 1,
};

function overview() {
  render(
    <SpaceOverview
      workspaces={[workspace]}
      agents={[]}
      onOpen={vi.fn()}
      onNewSpace={vi.fn()}
      open
      onOpenChange={vi.fn()}
    />,
  );
}

describe("New space — createSpace", () => {
  it("is offered when the multiplexer can create one", async () => {
    declares({ createSpace: true });
    overview();
    expect(await screen.findByRole("button", { name: "New space" })).toBeInTheDocument();
  });

  it("is offered on a bridge that says nothing at all — an older bridge hides no control", async () => {
    saysNothing();
    overview();
    expect(await screen.findByRole("button", { name: "New space" })).toBeInTheDocument();
    // Nothing is asserted about a note here on purpose: there is no absence to explain.
    expect(screen.queryByText(/would not appear/i)).toBeNull();
  });

  it("is withdrawn when it cannot, and the adapter's reason takes its place", async () => {
    declares(
      { createSpace: false },
      { createSpace: "One collie drives exactly one session here, so a new space would not appear." },
    );
    overview();
    await waitFor(() => expect(screen.queryByRole("button", { name: "New space" })).toBeNull());
    expect(screen.getByText(/would not appear/i)).toBeInTheDocument();
  });

  it("the strip's own '+' goes with it, and stays silent — the reason is said once", async () => {
    declares({ createSpace: false }, { createSpace: "no spaces here." });
    render(
      <SpaceStrip
        workspaces={[workspace]}
        agents={[]}
        selected={null}
        onSelect={vi.fn()}
        onNewSpace={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.queryByRole("button", { name: "New space" })).toBeNull());
    expect(screen.queryByText("no spaces here.")).toBeNull();
  });

  it("the strip keeps its '+' when the capability is there", async () => {
    declares({ createSpace: true });
    render(
      <SpaceStrip
        workspaces={[workspace]}
        agents={[]}
        selected={null}
        onSelect={vi.fn()}
        onNewSpace={vi.fn()}
      />,
    );
    expect(await screen.findByRole("button", { name: "New space" })).toBeInTheDocument();
  });
});

// ── How many spaces the multiplexer can hold → `spaces` ──────────────────────
//
// NOT a capability — a declared fact about the multiplexer's shape — but the same rule applies to it
// and for the same reason: the UI reacts to the DECLARATION and never to a name, and an absent
// answer fails OPEN so a level that exists is never hidden.

/** Serve an `/api/config` whose mux block declares how many spaces the multiplexer can hold. */
function declaresSpaces(spaces: "one" | "many"): void {
  const mux: MuxConfig = { name: "reference", capabilities: {}, unsupportedKeys: [], notes: {}, spaces };
  server.use(http.get("/api/config", () => HttpResponse.json({ push: false, vapidPublicKey: "", mux })));
}

describe("The space strip — `spaces`", () => {
  function strip(onBack?: () => void) {
    render(
      <SpaceStrip
        workspaces={[workspace]}
        agents={[]}
        selected={null}
        onSelect={vi.fn()}
        onNewSpace={vi.fn()}
        {...(onBack ? { onBack } : {})}
      />,
    );
  }

  it("drops the space chips where the multiplexer can only ever have one", async () => {
    declaresSpaces("one");
    strip();
    await waitFor(() => expect(screen.queryByText("webapp")).toBeNull());
    expect(screen.queryByText("Spaces")).toBeNull();
  });

  it("keeps the way back even with the chips gone", async () => {
    declaresSpaces("one");
    strip(vi.fn());
    expect(await screen.findByText("Back")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("webapp")).toBeNull());
  });

  it("keeps the chips where the multiplexer can hold several", async () => {
    declaresSpaces("many");
    strip();
    expect(await screen.findByText("webapp")).toBeInTheDocument();
  });

  it("a bridge that says nothing keeps them too — absent reads as many", async () => {
    saysNothing();
    strip();
    expect(await screen.findByText("webapp")).toBeInTheDocument();
  });
});

// ── Tab creation → createTab ─────────────────────────────────────────────────

function tabStrip() {
  render(
    <TabStrip
      workspaceId="w1"
      tabs={[{ tabId: "w1:t1", workspaceId: "w1", number: 1, label: "1", focused: true, paneCount: 1 }]}
      agents={[]}
      selected={null}
      onSelect={vi.fn()}
      onNewTab={vi.fn()}
    />,
  );
}

describe("New tab — createTab", () => {
  it("is offered when the multiplexer can open one", async () => {
    declares({ createTab: true });
    tabStrip();
    expect(await screen.findByRole("button", { name: "New tab" })).toBeInTheDocument();
  });

  it("is hidden when it cannot — an affordance nobody comes looking for needs no eulogy", async () => {
    declares({ createTab: false }, { createTab: "no tabs here." });
    tabStrip();
    await waitFor(() => expect(screen.queryByRole("button", { name: "New tab" })).toBeNull());
    expect(screen.queryByText("no tabs here.")).toBeNull();
  });
});

// ── Pane rename / close → renamePane, closePane ──────────────────────────────

function paneSheet() {
  render(
    <PaneActionsSheet
      open
      onClose={vi.fn()}
      pane={{
        paneId: "w1:p1",
        workspaceId: "w1",
        workspaceLabel: "webapp",
        workspaceNumber: 1,
        tabId: "w1:t1",
        agent: "claude",
        status: "idle",
        cwd: "/home/you/webapp",
        focused: false,
      }}
      onRenamed={vi.fn()}
      onClosed={vi.fn()}
    />,
  );
}

describe("Pane actions — renamePane and closePane", () => {
  it("offers both rows when both are declared", async () => {
    declares({ renamePane: true, closePane: true });
    paneSheet();
    expect(await screen.findByText("Rename")).toBeInTheDocument();
    expect(screen.getByText("Close pane")).toBeInTheDocument();
  });

  it("offers 'Show in terminal' only where the multiplexer can move focus", async () => {
    declares({ renamePane: true, closePane: true, setFocus: true });
    paneSheet();
    expect(await screen.findByText("Show in terminal")).toBeInTheDocument();
  });

  it("drops 'Show in terminal' where it is declared absent — the other rows stay", async () => {
    declares({ renamePane: true, closePane: true, setFocus: false });
    paneSheet();
    await waitFor(() => expect(screen.queryByText("Show in terminal")).toBeNull());
    expect(screen.getByText("Rename")).toBeInTheDocument();
    expect(screen.getByText("Close pane")).toBeInTheDocument();
  });

  it("drops ONLY the row whose capability is missing", async () => {
    declares({ renamePane: false, closePane: true });
    paneSheet();
    await waitFor(() => expect(screen.queryByText("Rename")).toBeNull());
    expect(screen.getByText("Close pane")).toBeInTheDocument();
  });

  it("explains rather than handing back an empty sheet when nothing is left", async () => {
    declares(
      { renamePane: false, closePane: false, setFocus: false },
      { renamePane: "this multiplexer will not label or kill a pane from outside." },
    );
    paneSheet();
    expect(await screen.findByText(/will not label or kill a pane/i)).toBeInTheDocument();
    expect(screen.queryByText("Rename")).toBeNull();
    expect(screen.queryByText("Close pane")).toBeNull();
  });
});

describe("Tab actions — renameTab and closeTab", () => {
  const tab = { tabId: "w1:t1", workspaceId: "w1", number: 1, label: "1", focused: true, paneCount: 2 };

  function tabSheet() {
    render(
      <TabActionsSheet open onClose={vi.fn()} tab={tab} onRenamed={vi.fn()} onClosed={vi.fn()} />,
    );
  }

  it("offers both rows when both are declared", async () => {
    declares({ renameTab: true, closeTab: true });
    tabSheet();
    expect(await screen.findByText("Rename")).toBeInTheDocument();
    expect(screen.getByText("Close tab")).toBeInTheDocument();
  });

  it("explains when neither is", async () => {
    declares({ renameTab: false, closeTab: false }, { closeTab: "tabs are not Collie's to change here." });
    tabSheet();
    expect(await screen.findByText(/not Collie's to change here/i)).toBeInTheDocument();
    expect(screen.queryByText("Close tab")).toBeNull();
  });
});

// ── Key sequences → sendKeys and the refused-key list ────────────────────────

describe("The Keys tray — sendKeys and unsupportedKeys", () => {
  it("greys exactly the buttons whose chord this multiplexer refuses", async () => {
    declares({ sendKeys: true }, {}, ["Enter"]);
    render(<NavTray onSend={vi.fn(async () => true)} unsupportedKeys={["Enter"]} />);
    expect(screen.getByRole("button", { name: "⏎ Enter" })).toBeDisabled();
    // …and nothing else: the door is open, one key is simply not behind it.
    expect(screen.getByRole("button", { name: "Tab" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Esc" })).toBeEnabled();
  });

  it("greys a chord whose BASE key is refused, modifier and all", () => {
    render(<NavTray onSend={vi.fn(async () => true)} unsupportedKeys={["c"]} />);
    expect(screen.getByRole("button", { name: "Ctrl+C" })).toBeDisabled();
  });

  it("leaves every key live when the multiplexer refuses none", () => {
    render(<NavTray onSend={vi.fn(async () => true)} unsupportedKeys={[]} />);
    expect(screen.getByRole("button", { name: "⏎ Enter" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Ctrl+C" })).toBeEnabled();
  });
});

// ── Pane history → agentSessionRef ───────────────────────────────────────────

function chat(agentOver: Partial<(typeof fixtureAgents)[number]> = {}) {
  const agent = { ...fixtureAgents[0]!, hasSession: true, ...agentOver };
  const props: ComponentProps<typeof AgentChat> = {
    paneId: agent.paneId,
    agent,
    agents: [agent],
    shellPanes: [],
    tabs: [],
    text: "recent pane output",
    onBack: vi.fn(),
    onSelect: vi.fn(),
  };
  const router = createMemoryRouter([{ path: "/", element: <AgentChat {...props} /> }]);
  render(<RouterProvider router={router} />);
}

describe("Pane history — agentSessionRef", () => {
  it("is reachable when the multiplexer can name an agent's session", async () => {
    declares({ agentSessionRef: true });
    chat();
    expect(await screen.findByRole("button", { name: "Conversation history" })).toBeInTheDocument();
  });

  it("is withdrawn when it cannot — and SAYS SO, in the adapter's words", async () => {
    declares(
      { agentSessionRef: false },
      { agentSessionRef: "This multiplexer keeps no agent session log for Collie to read." },
    );
    chat();
    expect(await screen.findByText(/keeps no agent session log/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Conversation history" })).toBeNull();
  });

  it("says nothing when the capability is there — no Herdr operator gains an explanation", async () => {
    declares({ agentSessionRef: true });
    chat();
    await screen.findByRole("button", { name: "Conversation history" });
    expect(screen.queryByText(/keeps no agent session log/i)).toBeNull();
  });
});

// ── Typing into a pane → typeText / sendKeys ─────────────────────────────────

describe("The composer — typeText and sendKeys", () => {
  it("takes a reply when the multiplexer can type", async () => {
    declares({ typeText: true, sendKeys: true });
    chat();
    expect(await screen.findByPlaceholderText(/type a reply/i)).toBeEnabled();
  });

  it("locks, and names the reason, when it cannot type at all", async () => {
    declares({ typeText: false }, { typeText: "This multiplexer will not accept typed text." });
    chat();
    const box = await screen.findByPlaceholderText(/will not accept typed text/i);
    expect(box).toBeDisabled();
  });

  it("locks on a missing submit key too — half a reply is not a feature", async () => {
    declares({ typeText: true, sendKeys: false }, { sendKeys: "No key can be sent to this pane." });
    chat();
    expect(await screen.findByPlaceholderText(/no key can be sent/i)).toBeDisabled();
  });
});

// ── Agent detection → presentation, not a gate ───────────────────────────────

describe("An empty herd — agentDetection", () => {
  it("says only 'No agents running.' when the multiplexer reports agents", async () => {
    declares({ agentDetection: true });
    render(<AgentList agents={[]} bridge="connected" onOpen={vi.fn()} />);
    expect(await screen.findByText("No agents running.")).toBeInTheDocument();
    expect(screen.queryByText(/does not know what an agent is/i)).toBeNull();
  });

  it("explains where the panes went when it cannot", async () => {
    declares(
      { agentDetection: false },
      { agentDetection: "This multiplexer does not know what an agent is." },
    );
    render(<AgentList agents={[]} bridge="connected" onOpen={vi.fn()} />);
    expect(await screen.findByText(/does not know what an agent is/i)).toBeInTheDocument();
    expect(screen.getByText(/under Spaces/i)).toBeInTheDocument();
  });

  it("stays quiet while the bridge is unreachable — an outage is not a capability", async () => {
    declares({ agentDetection: false }, { agentDetection: "does not know what an agent is." });
    render(<AgentList agents={[]} bridge="disconnected" onOpen={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText(/does not know what an agent is/i)).toBeNull());
  });
});
