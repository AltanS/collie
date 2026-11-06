import { type ComponentProps } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";

// Pinned messages inside the real pane view (M90 specs 02 and 03): where the way in to Pin is offered and where it
// is not, what a pin does to the Chat blocks and, with spec 03, to the belt. The pane is pinned live as the other
// AgentChat suites pin it (lib/liveness.ts).
const liveness = vi.hoisted(() => ({ live: true }));
vi.mock("@/lib/liveness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/liveness")>()),
  isLive: () => liveness.live,
  useLive: () => liveness.live,
}));

import { clearStatus, useStatus } from "@/lib/status";
import { fixtureAgents, fixtureCrewStatus, fixturePin, fixtureServers, fixtureShellPanes, heldMessagePins, messagePinItemIds, paneTextWithDraft, setMessagePins } from "@/test/handlers";
import { forgetHostVersions } from "@/hooks/use-host-version";
import { resetPinsForTests } from "@/lib/loaders";
import { saveChatTail } from "@/lib/chat-tail";
import { withHeaderHost } from "@/test/header-host";
import { server } from "@/test/msw";
import type { AgentView } from "@/lib/types";
import { AgentChat } from "./agent-chat";
import { CrewProvider } from "./crew-provider";

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => {
  clearStatus();
  forgetHostVersions();
  // The list each pane last answered outlives a pane view (lib/loaders.ts), so one case's pins would mark the next case's blocks.
  resetPinsForTests();
  liveness.live = true;
  localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ paneView: "chat", showToolCalls: true }));
});

// The fixture session's own turns (test/handlers.ts): the person's line, a `Bash` step and the agent's answer, which
// are three blocks with the item ids `t1:0`, `t2:0` and `t2:1`.
const ASKED = "what changed today?";
const ANSWERED = "One commit: abc1234.";

const journalAgent = (): AgentView => ({ ...fixtureAgents[0]!, hasSession: true });

function Notice() {
  const status = useStatus();
  return <p data-testid="notice">{status?.text ?? ""}</p>;
}

function renderPane(overrides: Partial<ComponentProps<typeof AgentChat>> = {}, host?: string) {
  const agent = overrides.agent ?? journalAgent();
  const props: ComponentProps<typeof AgentChat> = {
    paneId: agent.paneId,
    agent,
    agents: [agent],
    shellPanes: [],
    tabs: [],
    text: paneTextWithDraft("recent pane output"),
    onBack: vi.fn(),
    onSelect: vi.fn(),
    ...overrides,
  };
  const pane = (
    <>
      <AgentChat {...props} />
      <Notice />
    </>
  );
  const element = withHeaderHost(host === undefined ? pane : <CrewProvider servers={fixtureServers} ts={1_000} pollMs={1_500}>{pane}</CrewProvider>);
  render(<RouterProvider router={createMemoryRouter([{ path: "/", element }])} />);
}

const pinsRequests = (log: string[]) =>
  server.use(
    http.all(/\/api\/pane\/[^/]+\/pins/, ({ request }) => {
      log.push(request.method);
      return undefined;
    }),
  );

const moreButtons = () => screen.queryAllByRole("button", { name: "Message actions" });

describe("AgentChat — a hold or the ⋯ on a Chat block (M90 spec 02)", () => {
  it("offers the ⋯ on each block of the session, and Pin from it", async () => {
    const user = userEvent.setup();
    renderPane();
    await screen.findByText(ANSWERED);
    expect(moreButtons()).toHaveLength(3);
    await user.click(moreButtons()[2]!);
    const sheet = await screen.findByRole("dialog", { name: "Reply" });
    await user.click(within(sheet).getByRole("button", { name: "Pin" }));
    await waitFor(() => expect(messagePinItemIds()).toHaveLength(1));
    expect(heldMessagePins()[0]).toMatchObject({ kind: "reply" });
    // The block carries its mark, and the sheet's row now reads Unpin.
    const mark = await screen.findByRole("img", { name: "Pinned" });
    expect(mark.closest("[data-block]")).toHaveTextContent(ANSWERED);
    await user.click(moreButtons()[2]!);
    expect(within(await screen.findByRole("dialog", { name: "Reply" })).getByRole("button", { name: "Unpin" })).toBeInTheDocument();
  });

  it("unpins from the same sheet and the mark goes", async () => {
    const user = userEvent.setup();
    renderPane();
    await screen.findByText(ANSWERED);
    await user.click(moreButtons()[2]!);
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Pin" }));
    await screen.findByRole("img", { name: "Pinned" });
    await user.click(moreButtons()[2]!);
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Unpin" }));
    await waitFor(() => expect(screen.queryByRole("img", { name: "Pinned" })).toBeNull());
    expect(heldMessagePins()).toEqual([]);
  });

  it("says why on a refusal and keeps no mark", async () => {
    const user = userEvent.setup();
    server.use(http.post(/\/api\/pane\/[^/]+\/pins$/, () => HttpResponse.json({ error: "pin.cap", code: "pin.cap", message: "full" }, { status: 409 })));
    renderPane();
    await screen.findByText(ANSWERED);
    await user.click(moreButtons()[2]!);
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Pin" }));
    await waitFor(() => expect(screen.getByTestId("notice")).toHaveTextContent("This session has 100 pins, unpin one first."));
    expect(screen.queryByRole("img", { name: "Pinned" })).toBeNull();
  });

  it("offers no way in on a read-only device, and reads the pins all the same", async () => {
    const log: string[] = [];
    pinsRequests(log);
    renderPane({ device: { enforced: true, device: "spare-phone", authorized: false } });
    await screen.findByText(ANSWERED);
    expect(moreButtons()).toHaveLength(0);
    await waitFor(() => expect(log).toContain("GET"));
    expect(log).not.toContain("POST");
  });

  it("offers no way in on a saved copy of Chat, and asks the machine nothing", async () => {
    const log: string[] = [];
    pinsRequests(log);
    const at = Date.now() - 60_000;
    await saveChatTail(undefined, journalAgent().paneId, [{ uuid: "s1", seq: 7, ts: "", role: "assistant", parts: [{ kind: "text", text: "the saved reply" }] }], "1d", at);
    server.use(http.get(/\/api\/pane\/[^/]+\/chat/, () => HttpResponse.error()));
    renderPane({ stale: true, lastSeenAt: at, error: true });
    expect(await screen.findByText("the saved reply")).toBeInTheDocument();
    expect(moreButtons()).toHaveLength(0);
    expect(log).toEqual([]);
  });

  it("offers no way in on a bare shell, and asks nothing", async () => {
    const log: string[] = [];
    pinsRequests(log);
    const shell = fixtureShellPanes[0]!;
    renderPane({ agent: shell, paneId: shell.paneId, agents: [], shellPanes: [shell] });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(moreButtons()).toHaveLength(0);
    expect(log).toEqual([]);
  });

  it("offers no way in on a pane that is gone", async () => {
    const log: string[] = [];
    pinsRequests(log);
    renderPane({ agent: undefined, agents: [] });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(moreButtons()).toHaveLength(0);
    expect(log).toEqual([]);
  });

  describe("on a crew member", () => {
    const member = (): Partial<ComponentProps<typeof AgentChat>> => ({ scope: { host: "workshop" }, agent: { ...journalAgent(), host: "workshop" } });
    const census = (version: string) => {
      const members = structuredClone(fixtureCrewStatus.members);
      members.find((m) => m.id === "workshop")!.version = version;
      server.use(http.get("/api/crew", () => HttpResponse.json({ ...fixtureCrewStatus, members })));
    };

    it("offers the way in once the census says the member keeps pins, and pins on that member", async () => {
      const user = userEvent.setup();
      census("1.28.0");
      const urls: string[] = [];
      server.use(
        http.post(/\/api\/pane\/[^/]+\/pins$/, ({ request }) => {
          urls.push(request.url);
          return undefined;
        }),
      );
      renderPane(member(), "workshop");
      await screen.findByText(ANSWERED);
      await user.click(moreButtons()[2]!);
      await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Pin" }));
      await waitFor(() => expect(urls).toHaveLength(1));
      expect(new URL(urls[0]!).searchParams.get("host")).toBe("workshop");
    });

    it("offers no way in, and asks the member nothing, when its Collie is older than 1.28.0", async () => {
      census("1.27.0");
      const log: string[] = [];
      pinsRequests(log);
      renderPane(member(), "workshop");
      await screen.findByText(ANSWERED);
      await waitFor(() => expect(moreButtons()).toHaveLength(0));
      // The census may land after the first read; what must hold is that no write can be made.
      expect(log).not.toContain("POST");
    });

    it("says the member's Collie is older when a pin is answered with a plain 404", async () => {
      const user = userEvent.setup();
      server.use(http.post(/\/api\/pane\/[^/]+\/pins$/, () => new HttpResponse("not found", { status: 404 })));
      renderPane(member(), "workshop");
      await screen.findByText(ANSWERED);
      await user.click(moreButtons()[2]!);
      await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Pin" }));
      await waitFor(() => expect(screen.getByTestId("notice")).toHaveTextContent("That machine's Collie is older and cannot keep pins. Update it."));
    });
  });
});

// A session whose pins the bridge lists: the pane view marks the blocks they came from.
describe("AgentChat — pins that already exist", () => {
  it("marks the block a pin came from, by its item id, when the pane opens", async () => {
    setMessagePins([fixturePin({ itemId: "t2:1" })]);
    renderPane();
    const answered = await screen.findByText(ANSWERED);
    const mark = await screen.findByRole("img", { name: "Pinned" });
    expect(mark.closest("[data-block]")).toBe(answered.closest("[data-block]"));
    expect(screen.getAllByRole("img", { name: "Pinned" })).toHaveLength(1);
  });

  it("marks the block on a machine that reports no pin count, because the list is read once on open", async () => {
    // The bridge counts a pane's pins only once it has read its session; the phone does not wait for that.
    setMessagePins([fixturePin({ itemId: "t1:0" })]);
    renderPane({ agent: { ...journalAgent() } });
    await screen.findByText(ASKED);
    const mark = await screen.findByRole("img", { name: "Pinned" });
    expect(mark.closest("[data-block]")).toHaveTextContent(ASKED);
  });
});

// The belt's Pins mark and its sheet inside the pane view (M90 spec 03).
describe("AgentChat — the Pins mark and sheet", () => {
  it("draws no mark for a session without pins", async () => {
    renderPane();
    await screen.findByText(ANSWERED);
    expect(document.querySelector('[data-slot="belt-pins"]')).toBeNull();
  });

  it("lists the pins in the sheet, and unpinning the last one takes the mark away", async () => {
    const user = userEvent.setup();
    setMessagePins([fixturePin({ id: "pin-a", itemId: "t2:1", text: ANSWERED, pinnedAt: 1_700_000_000_000 })]);
    renderPane();
    const mark = await screen.findByRole("button", { name: "1 pinned" });
    await user.click(mark);
    const sheet = await screen.findByRole("dialog", { name: "Pinned messages" });
    expect(within(sheet).getByText(ANSWERED)).toBeInTheDocument();
    await user.click(within(sheet).getByRole("button", { name: "Unpin" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Pinned messages" })).toBeNull());
    await waitFor(() => expect(document.querySelector('[data-slot="belt-pins"]')).toBeNull());
    expect(heldMessagePins()).toEqual([]);
  });

  it("Show in Chat closes the sheets with no notice when the block is in Chat", async () => {
    const user = userEvent.setup();
    setMessagePins([fixturePin({ id: "pin-a", itemId: "t2:1", text: ANSWERED })]);
    renderPane();
    await user.click(await screen.findByRole("button", { name: "1 pinned" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Pinned messages" })).getByText(ANSWERED));
    await user.click(await screen.findByRole("button", { name: "Show in Chat" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByTestId("notice")).toHaveTextContent("");
  });

  it("Show in Chat says so when the block is not among the blocks Chat holds", async () => {
    const user = userEvent.setup();
    setMessagePins([fixturePin({ id: "pin-old", itemId: "long-ago:3", anchor: "an old line", text: "an old line" })]);
    renderPane();
    await user.click(await screen.findByRole("button", { name: "1 pinned" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Pinned messages" })).getByText("an old line"));
    await user.click(await screen.findByRole("button", { name: "Show in Chat" }));
    await waitFor(() => expect(screen.getByTestId("notice")).toHaveTextContent("That block is not loaded in Chat. Scroll up to load older messages."));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps the mark on a read-only device, and refuses its Unpin", async () => {
    const user = userEvent.setup();
    setMessagePins([fixturePin({ id: "pin-a", itemId: "t2:1", text: ANSWERED })]);
    renderPane({ device: { enforced: true, device: "spare-phone", authorized: false } });
    await user.click(await screen.findByRole("button", { name: "1 pinned" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Pinned messages" })).getByRole("button", { name: "Unpin" }));
    expect(heldMessagePins()).toHaveLength(1);
    expect(screen.getByTestId("notice").textContent).not.toBe("");
  });

  it("draws no mark on a bare shell, though the machine counts pins for the pane", async () => {
    setMessagePins([fixturePin({ id: "pin-a", itemId: "t2:1", text: ANSWERED })]);
    const shell = fixtureShellPanes[0]!;
    renderPane({ agent: { ...shell, pins: 2 }, paneId: shell.paneId, agents: [], shellPanes: [shell] });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.querySelector('[data-slot="belt-pins"]')).toBeNull();
  });
});

