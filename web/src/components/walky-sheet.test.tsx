import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { WalkyLogProvider, WalkyPanesProvider } from "@/components/walky-log";
import { clockTime } from "@/lib/format";
import type { AgentView } from "@/lib/types";
import { fixtureWalkyAgent, fixtureWalkyOperator, fixtureWalkySelf, fixtureWalkySent } from "@/test/handlers";
import type { WalkyRow } from "@/lib/walky";

import { WalkySheet } from "./walky-sheet";

// The pane's Messages sheet (M62 spec 05): newest first, each row with its kind, sender, age, body and
// receipt state, and a Reply on an agent message only.

function sheet(rows: readonly WalkyRow[] | null, over: Partial<React.ComponentProps<typeof WalkySheet>> = {}) {
  const props: React.ComponentProps<typeof WalkySheet> = { open: true, onClose: vi.fn(), onReply: vi.fn(), canReply: true, ...over };
  render(
    <WalkyLogProvider rows={rows}>
      <WalkySheet {...props} />
    </WalkyLogProvider>,
  );
  return props;
}

const bodies = () => [...document.querySelectorAll('[data-slot="walky-list-row"]')].map((el) => el.getAttribute("data-kind"));

describe("WalkySheet", () => {
  it("lists the messages newest first, whatever order they arrived in", () => {
    sheet([fixtureWalkyAgent, fixtureWalkyOperator]);
    // The operator message is a minute newer in the fixtures.
    expect(bodies()).toEqual(["operator", "agent"]);
  });

  it("shows kind, sender, body and the receipt state with who verified it", () => {
    sheet([fixtureWalkyAgent, fixtureWalkyOperator]);
    const agentRow = screen.getByText("Tests are green on fix-465. You can merge.").closest('[data-slot="walky-list-row"]');
    if (!(agentRow instanceof HTMLElement)) throw new Error("no row for the agent message");
    const inside = within(agentRow);
    expect(inside.getByText("agent")).toBeInTheDocument();
    expect(inside.getByText("collie-workspace#fix-465")).toBeInTheDocument();
    expect(inside.getByText("typed into the pane")).toBeInTheDocument();
    expect(inside.getByText(/signed by bluefin/)).toBeInTheDocument();
    // The other row was not typed, and says why.
    expect(screen.getByText("waiting in the inbox, not typed: dialog open")).toBeInTheDocument();
  });

  it("draws a long body in full: no line clamp on the sheet row, which is where the card's clamped body is read (#641)", () => {
    const long = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n");
    sheet([{ ...fixtureWalkyAgent, body: long }]);
    const body = document.querySelector('[data-slot="walky-sheet-body"]');
    if (!(body instanceof HTMLElement)) throw new Error("no sheet body");
    expect(body.className).not.toMatch(/line-clamp-/);
    expect(body).toHaveClass("whitespace-pre-wrap");
    expect(body.textContent).toBe(long);
    // The card keeps its three-line clamp (pinned in walky-card.test.tsx), so the sheet is the way to the rest.
  });

  it("draws a message whose `to` and sender address carry a session token without splitting them", async () => {
    const user = userEvent.setup();
    const row: WalkyRow = {
      ...fixtureWalkyAgent,
      from: { ...fixtureWalkyAgent.from, address: "bluefin/w6:p3#k3f9" },
      to: "bluefin/w1:p1#zz99",
    };
    const props = sheet([row]);
    expect(screen.getByText("Tests are green on fix-465. You can merge.")).toBeInTheDocument();
    expect(screen.getByText("typed into the pane")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Reply/ }));
    // Reply hands the row as it stands: its sender's address keeps the token.
    expect(props.onReply).toHaveBeenCalledExactlyOnceWith(row);
    expect(vi.mocked(props.onReply).mock.calls[0]?.[0].from.address).toBe("bluefin/w6:p3#k3f9");
  });

  it("offers Reply on the agent message only, and hands the row to the caller", async () => {
    const user = userEvent.setup();
    const props = sheet([fixtureWalkyAgent, fixtureWalkyOperator]);
    const replies = screen.getAllByRole("button", { name: /^Reply/ });
    expect(replies).toHaveLength(1);
    expect(replies[0]).toHaveAccessibleName("Reply to collie-workspace#fix-465");
    await user.click(replies[0]!);
    expect(props.onReply).toHaveBeenCalledExactlyOnceWith(fixtureWalkyAgent);
  });

  it("offers no Reply to a device that may not write", () => {
    sheet([fixtureWalkyAgent], { canReply: false });
    expect(screen.queryByRole("button", { name: /^Reply/ })).toBeNull();
  });

  it("offers no Reply to an agent message with no address", () => {
    sheet([{ ...fixtureWalkyAgent, from: { ...fixtureWalkyAgent.from, address: null } }]);
    expect(screen.queryByRole("button", { name: /^Reply/ })).toBeNull();
  });

  it("says so when there are none, and when the machine keeps none", () => {
    sheet([]);
    expect(screen.getByText("No messages for this pane yet.")).toBeInTheDocument();
  });

  it("says the machine does not keep messages when the list could not be read", () => {
    sheet(null);
    expect(screen.getByText("This machine does not keep messages yet.")).toBeInTheDocument();
  });
});

describe("WalkySheet focus (a tapped card or id chip)", () => {
  /** An element the case needs, or a failure: a lookup that cannot narrow without an assertion. */
  const el = (node: Element | null | undefined): HTMLElement => {
    if (!(node instanceof HTMLElement)) throw new Error("element missing");
    return node;
  };
  const focused = () => [...document.querySelectorAll('[data-slot="walky-list-row"][data-focused="true"]')];

  it("highlights the row of the focused id, and only that row", () => {
    sheet([fixtureWalkyAgent, fixtureWalkyOperator], { focusId: fixtureWalkyAgent.id });
    expect(focused()).toHaveLength(1);
    expect(focused()[0]).toHaveAttribute("data-kind", "agent");
    // The focused row keeps its Reply, in the same row.
    expect(within(el(focused()[0])).getByRole("button", { name: "Reply to collie-workspace#fix-465" })).toBeInTheDocument();
  });

  it("changes only the paint of the row: the border is in the base, nothing is added or removed", () => {
    sheet([fixtureWalkyAgent], { focusId: fixtureWalkyAgent.id });
    const cls = el(focused()[0]).className;
    expect(cls).toContain("border ");
    expect(cls).toContain("bg-status-working/8");
    expect(cls).not.toMatch(/(^|\s)(border-l|border-l-\d|rounded-l)/);
  });

  it("highlights nothing for no id, or for an id the log lacks", () => {
    sheet([fixtureWalkyAgent], { focusId: null });
    expect(focused()).toHaveLength(0);
    document.body.innerHTML = "";
    sheet([fixtureWalkyAgent], { focusId: "wt_zzzzzzzzzzzz" });
    expect(focused()).toHaveLength(0);
  });

  it("scrolls the focused row to the middle of the sheet's own scroller", () => {
    const panel = document.createElement("div");
    document.body.append(panel);
    const spy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      // SAFETY: the sheet reads only `top` and `height` of a rect; the rest of a DOMRect is not used here.
      return { top: this.tagName === "LI" ? 900 : 100, height: 80 } as DOMRect;
    });
    const scrollHeight = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(2000);
    const clientHeight = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(500);
    // SAFETY: the scroller walk reads only `overflowY` of the computed style.
    const overflow = vi.spyOn(window, "getComputedStyle").mockReturnValue({ overflowY: "auto" } as CSSStyleDeclaration);
    try {
      sheet([fixtureWalkyOperator, fixtureWalkyAgent], { focusId: fixtureWalkyAgent.id });
      const scroller = [...document.querySelectorAll<HTMLElement>("*")].find((node) => node.scrollTop > 0);
      // Row top 900 minus scroller top 100, less half of the room left around an 80px row in 500px.
      expect(scroller?.scrollTop).toBe(900 - 100 - (500 - 80) / 2);
    } finally {
      spy.mockRestore();
      scrollHeight.mockRestore();
      clientHeight.mockRestore();
      overflow.mockRestore();
      panel.remove();
    }
  });

  it("moves the focus to the message a row answers when its reply-to chip is tapped, if the log holds it", async () => {
    const user = userEvent.setup();
    sheet([fixtureWalkyAgent, fixtureWalkyOperator], { focusId: fixtureWalkyOperator.id });
    expect(focused()[0]).toHaveAttribute("data-kind", "operator");
    const note = document.querySelector('[data-slot="walky-reply-to"]');
    // The log holds the answered message, so the chip tells it by sender and time; the id stays off the screen.
    const told = `collie-workspace#fix-465, ${clockTime(fixtureWalkyAgent.at)}`;
    expect(note).toHaveTextContent(`In reply to ${told}`);
    expect(note?.textContent).not.toContain(fixtureWalkyAgent.id);
    await user.click(within(el(note)).getByRole("button", { name: `Open the message from ${told}` }));
    expect(focused()).toHaveLength(1);
    expect(focused()[0]).toHaveAttribute("data-kind", "agent");
  });

  it("shows the answered id as plain text when the log lacks it", () => {
    sheet([fixtureWalkyOperator]);
    const note = document.querySelector('[data-slot="walky-reply-to"]');
    expect(note).toHaveTextContent(`In reply to ${fixtureWalkyAgent.id}`);
    expect(within(el(note)).queryByRole("button")).toBeNull();
  });

  it("names no reply-to on a message that answers nothing", () => {
    sheet([fixtureWalkyAgent]);
    expect(document.querySelector('[data-slot="walky-reply-to"]')).toBeNull();
  });

  it("starts again from the given focus when the sheet closes and opens", async () => {
    const user = userEvent.setup();
    const rows = [fixtureWalkyAgent, fixtureWalkyOperator];
    const view = render(
      <WalkyLogProvider rows={rows}>
        <WalkySheet open onClose={vi.fn()} onReply={vi.fn()} canReply focusId={fixtureWalkyOperator.id} />
      </WalkyLogProvider>,
    );
    await user.click(screen.getByRole("button", { name: /^Open the message from collie-workspace#fix-465/ }));
    expect(focused()[0]).toHaveAttribute("data-kind", "agent");
    const again = (open: boolean) => (
      <WalkyLogProvider rows={rows}>
        <WalkySheet open={open} onClose={vi.fn()} onReply={vi.fn()} canReply focusId={fixtureWalkyOperator.id} />
      </WalkyLogProvider>
    );
    view.rerender(again(false));
    view.rerender(again(true));
    expect(focused()[0]).toHaveAttribute("data-kind", "operator");
  });
});

describe("WalkySheet with rows in both directions", () => {
  const MIXED = [fixtureWalkyAgent, fixtureWalkySent, fixtureWalkyOperator];
  const rowsOf = () => [...document.querySelectorAll<HTMLElement>('[data-slot="walky-list-row"]')];

  it("orders newest first across both directions", () => {
    sheet(MIXED, { self: fixtureWalkySelf });
    // 09:32 sent, 09:31 operator, 09:30 agent.
    expect(rowsOf().map((r) => r.getAttribute("data-direction") + ":" + r.getAttribute("data-kind"))).toEqual([
      "sent:agent",
      "received:operator",
      "received:agent",
    ]);
  });

  it("titles a sent row \"To <target>\" with the receipt's state words, no kind badge, no Reply", () => {
    sheet(MIXED, { self: fixtureWalkySelf });
    const row = rowsOf()[0];
    if (row === undefined) throw new Error("no rows");
    const inside = within(row);
    // No live pane is known here, so the target shows as the address, as it always did.
    expect(inside.getByText("Sent to bluefin/w6:p3")).toBeInTheDocument();
    expect(inside.getByText("typed into the pane")).toBeInTheDocument();
    expect(inside.getByText("Merged. Thanks.")).toBeInTheDocument();
    expect(inside.queryByText("agent")).toBeNull();
    expect(inside.queryByText("collie-workspace#this-pane")).toBeNull();
    expect(inside.queryByRole("button")).toBeNull();
    // The sender's own row says nothing of who vouched for it.
    expect(row.textContent).not.toMatch(/this machine|signed by/);
  });

  it("keeps the received rows as they were: kind badge, sender label, verified word, Reply on the agent's", () => {
    sheet(MIXED, { self: fixtureWalkySelf });
    const received = rowsOf().filter((r) => r.getAttribute("data-direction") === "received");
    expect(received).toHaveLength(2);
    expect(received[1] && within(received[1]).getByText("collie-workspace#fix-465")).toBeInTheDocument();
    expect(received[1] && within(received[1]).getByText(/signed by bluefin/)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Reply/ })).toHaveLength(1);
  });

  it("reports the failure of a sent message in the log's words", () => {
    const refused = { ...fixtureWalkySent, receipt: { ...fixtureWalkySent.receipt, state: "refused" as const, reason: "pane replaced" } };
    sheet([refused], { self: fixtureWalkySelf });
    expect(screen.getByText("not sent: pane replaced")).toBeInTheDocument();
    expect(document.querySelector('[data-slot="walky-state"]')?.className).toContain("text-status-blocked");
  });

  it("names a broadcast's receipt target in words", () => {
    sheet([{ ...fixtureWalkySent, receipt: { ...fixtureWalkySent.receipt, target: "all" } }], { self: fixtureWalkySelf });
    expect(screen.getByText("Sent to every machine")).toBeInTheDocument();
  });

  it("can focus a sent row, and a chip can point at it", async () => {
    const user = userEvent.setup();
    const reply = { ...fixtureWalkyOperator, replyTo: fixtureWalkySent.id };
    sheet([fixtureWalkySent, reply], { self: fixtureWalkySelf, focusId: reply.id });
    await user.click(screen.getByRole("button", { name: /^Open the message from collie-workspace#this-pane/ }));
    const marked = document.querySelector('[data-focused="true"]');
    expect(marked).toHaveAttribute("data-direction", "sent");
  });

  it("without a pane address every row reads as received, as before sent rows existed", () => {
    sheet(MIXED);
    expect(rowsOf().every((r) => r.getAttribute("data-direction") === "received")).toBe(true);
  });
});

describe("a held message's two ways out (M62 spec 03)", () => {
  const heldReceipt = (row: WalkyRow): WalkyRow => ({ ...row, receipt: { ...row.receipt, state: "accepted", reason: "draft present" } });
  /** The operator's own message, held for this pane's box: Cancel. */
  const operatorHeld = heldReceipt(fixtureWalkyOperator);
  /** An agent's message held for this pane's box: the owner's Drop. */
  const agentHeld = heldReceipt(fixtureWalkyAgent);
  /** A message this pane sent, held at the far pane: the far pane's business, nothing here. */
  const sentHeld = heldReceipt(fixtureWalkySent);

  it("offers Cancel on the operator's held message and Drop on an agent's, nothing on a sent or settled row", () => {
    sheet([operatorHeld, agentHeld, sentHeld, { ...fixtureWalkySent, id: "wt_s3ntaaaa0002" }], { self: fixtureWalkySelf, onCancel: vi.fn(), onDrop: vi.fn() });
    expect(screen.getByRole("button", { name: "Cancel the message to bluefin/w1:p1" })).toHaveTextContent("Cancel");
    expect(screen.getByRole("button", { name: "Drop the message from collie-workspace#fix-465" })).toHaveTextContent("Drop");
    expect(screen.getAllByRole("button", { name: /^(Cancel|Drop) the message/ })).toHaveLength(2);
    expect(screen.getAllByText("held: that session has unsent text")).toHaveLength(3);
  });

  it("hands the row to onCancel or onDrop, and shows the line the caller answers with", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn(async () => null);
    const onDrop = vi.fn(async () => "Already typed. Nothing to take back.");
    sheet([operatorHeld, agentHeld], { self: fixtureWalkySelf, onCancel, onDrop });
    await user.click(screen.getByRole("button", { name: /^Cancel the message/ }));
    expect(onCancel).toHaveBeenCalledExactlyOnceWith(operatorHeld);
    expect(document.querySelector('[data-slot="walky-takeback-note"]')).toBeNull();
    await user.click(screen.getByRole("button", { name: /^Drop the message/ }));
    expect(onDrop).toHaveBeenCalledExactlyOnceWith(agentHeld);
    expect(await screen.findByText("Already typed. Nothing to take back.")).toBeInTheDocument();
  });

  it("offers neither without a write (canReply false), nor without a handler", () => {
    sheet([operatorHeld, agentHeld], { self: fixtureWalkySelf, canReply: false, onCancel: vi.fn(), onDrop: vi.fn() });
    expect(screen.queryAllByRole("button", { name: /^(Cancel|Drop) the message/ })).toHaveLength(0);
    cleanup();
    sheet([operatorHeld, agentHeld], { self: fixtureWalkySelf });
    expect(screen.queryAllByRole("button", { name: /^(Cancel|Drop) the message/ })).toHaveLength(0);
  });
});

// ── SESSIONS BY NAME (M80 spec 12) ────────────────────────────────────────────

function livePane(over: Partial<AgentView> = {}): AgentView {
  return {
    paneId: "w6:p3",
    workspaceId: "w6",
    workspaceLabel: "collie-workspace",
    workspaceNumber: 6,
    tabId: "w6:t1",
    agent: "claude",
    status: "idle",
    cwd: "/home/altan/collie",
    focused: false,
    kind: "agent",
    host: "bluefin",
    ...over,
  };
}

function namedSheet(panes: AgentView[], rows: readonly WalkyRow[]) {
  const open = vi.fn();
  render(
    <WalkyLogProvider rows={rows}>
      <WalkyPanesProvider value={{ live: { panes, lead: "bluefin" }, open }}>
        <WalkySheet open onClose={vi.fn()} onReply={vi.fn()} canReply self={fixtureWalkySelf} />
      </WalkyPanesProvider>
    </WalkyLogProvider>,
  );
  return open;
}

describe("WalkySheet names sessions", () => {
  it("names the sender of a received row by its live pane, and keeps the log's label without one", () => {
    namedSheet([livePane({ paneLabel: "plumbing" })], [fixtureWalkyAgent]);
    expect(screen.getByText("plumbing")).toBeInTheDocument();
    expect(screen.queryByText("collie-workspace#fix-465")).toBeNull();
    expect(screen.getByRole("button", { name: "Reply to plumbing" })).toBeInTheDocument();
  });

  it("titles a sent row \"Sent to <name>\", and \"Sent to <name> on <machine>\" for another machine", () => {
    const far = livePane({ host: "workshop", paneId: "w2:p1", paneLabel: "docs" });
    const farRow: WalkyRow = { ...fixtureWalkySent, id: "wt_s3ntaaaa0002", to: "workshop/w2:p1", at: fixtureWalkySent.at + 1000, receipt: { ...fixtureWalkySent.receipt, id: "wt_s3ntaaaa0002", target: "workshop/w2:p1" } };
    namedSheet([livePane({ paneLabel: "plumbing" }), far], [fixtureWalkySent, farRow]);
    expect(screen.getByText("Sent to plumbing")).toBeInTheDocument();
    expect(screen.getByText("Sent to docs on workshop")).toBeInTheDocument();
  });

  it("resolves a sent row from the message's `to` with its token: a replaced pane is not named by its newcomer", () => {
    // fixtureWalkySent.to is `bluefin/w6:p3#k3f9`, its receipt target the bare `bluefin/w6:p3`.
    namedSheet([livePane({ paneLabel: "newcomer", instance: "n3w1" })], [fixtureWalkySent]);
    expect(screen.queryByText("Sent to newcomer")).toBeNull();
    expect(screen.getByText("Sent to bluefin/w6:p3")).toBeInTheDocument();
    cleanup();
    namedSheet([livePane({ paneLabel: "plumbing", instance: "k3f9" })], [fixtureWalkySent]);
    expect(screen.getByText("Sent to plumbing")).toBeInTheDocument();
  });

  it("draws a live session in the body as a chip that opens its pane, and leaves a claim as text", async () => {
    const user = userEvent.setup();
    const row: WalkyRow = { ...fixtureWalkyAgent, body: "Look at bluefin/w6:p3#k3f9, not at ghost/w1:p1." };
    const panes = [livePane({ paneLabel: "plumbing", instance: "k3f9" })];
    const open = namedSheet(panes, [row]);
    const body = document.querySelector<HTMLElement>('[data-slot="walky-sheet-body"]');
    if (body === null) throw new Error("no sheet body");
    expect(body).toHaveTextContent("Look at plumbing, not at ghost/w1:p1.");
    const chip = within(body).getByRole("button", { name: "Open plumbing" });
    expect(chip).toHaveAttribute("data-slot", "walky-name-chip");
    await user.click(chip);
    expect(open).toHaveBeenCalledExactlyOnceWith(panes[0]);
  });

  it("keeps an address without its token as written, adds the name after it, and draws no button", () => {
    const row: WalkyRow = { ...fixtureWalkyAgent, body: "Look at w6:p3 and bluefin/w6:p3." };
    namedSheet([livePane({ paneLabel: "plumbing", instance: "k3f9" })], [row]);
    const body = document.querySelector('[data-slot="walky-sheet-body"]');
    expect(body).toHaveTextContent("Look at w6:p3 (plumbing) and bluefin/w6:p3 (plumbing).");
    expect(body?.querySelector("button")).toBeNull();
  });

  it("words a held reason for a person", () => {
    namedSheet([], [{ ...fixtureWalkyAgent, receipt: { ...fixtureWalkyAgent.receipt, state: "accepted", reason: "turn running" } }]);
    expect(screen.getByText("held: that session is busy")).toBeInTheDocument();
  });
});

describe("the walky talky switch at the head of the sheet (M89 spec 04)", () => {
  const switchOf = () => screen.getByRole("switch", { name: "WalkyTalky" });

  it("shows the session's flag: on reads checked, off reads unchecked with the struck radio and the hint", () => {
    sheet([fixtureWalkyAgent], { onWalkyOff: vi.fn(async () => null) });
    expect(switchOf()).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Off: other agents cannot message this session. You still can.")).toBeInTheDocument();
    expect(document.querySelector('[data-slot="walky-off"] svg.lucide-walky-talky')).not.toBeNull();
    cleanup();
    sheet([fixtureWalkyAgent], { walkyOff: true, onWalkyOff: vi.fn(async () => null) });
    expect(switchOf()).toHaveAttribute("aria-checked", "false");
    expect(document.querySelector('[data-slot="walky-off"] svg.lucide-walky-talky-off')).not.toBeNull();
  });

  it("shows on an empty list and on a list the machine could not read", () => {
    sheet([], { onWalkyOff: vi.fn(async () => null) });
    expect(switchOf()).toBeInTheDocument();
    cleanup();
    sheet(null, { onWalkyOff: vi.fn(async () => null) });
    expect(switchOf()).toBeInTheDocument();
  });

  it("is a 44 px row, and the label is part of the target", async () => {
    const user = userEvent.setup();
    const onWalkyOff = vi.fn(async () => null);
    sheet([fixtureWalkyAgent], { onWalkyOff });
    const row = document.querySelector('[data-slot="walky-off"] label');
    if (!(row instanceof HTMLElement)) throw new Error("no switch row");
    expect(row).toHaveClass("min-h-11");
    await user.click(within(row).getByText("WalkyTalky"));
    expect(onWalkyOff).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("posts once per tap, takes no second tap while the call runs, and holds the new place", async () => {
    const user = userEvent.setup();
    let done: (value: string | null) => void = () => undefined;
    const onWalkyOff = vi.fn(() => new Promise<string | null>((resolve) => (done = resolve)));
    sheet([fixtureWalkyAgent], { onWalkyOff });
    await user.click(switchOf());
    expect(switchOf()).toHaveAttribute("aria-checked", "false");
    expect(switchOf()).toBeDisabled();
    await user.click(switchOf());
    expect(onWalkyOff).toHaveBeenCalledExactlyOnceWith(true);
    done(null);
    // Free again once the call answered, still showing the value asked for until the row confirms it.
    await vi.waitFor(() => expect(switchOf()).not.toBeDisabled());
    expect(switchOf()).toHaveAttribute("aria-checked", "false");
  });

  it("names the hint as the switch's description", () => {
    sheet([fixtureWalkyAgent], { onWalkyOff: vi.fn(async () => null) });
    expect(switchOf()).toHaveAccessibleDescription("Off: other agents cannot message this session. You still can.");
  });

  it("lets the row speak again after the hold when the row never confirmed the ask", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      sheet([fixtureWalkyAgent], { onWalkyOff: vi.fn(async () => null) });
      await user.click(switchOf());
      await vi.waitFor(() => expect(switchOf()).not.toBeDisabled());
      expect(switchOf()).toHaveAttribute("aria-checked", "false");
      // Another hand turned it on again before the row showed off: the row's value wins after the hold.
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.waitFor(() => expect(switchOf()).toHaveAttribute("aria-checked", "true"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("puts the switch back and says why when the call fails", async () => {
    const user = userEvent.setup();
    sheet([fixtureWalkyAgent], { onWalkyOff: vi.fn(async () => "Not changed: offline") });
    await user.click(switchOf());
    expect(await screen.findByText("Not changed: offline")).toBeInTheDocument();
    expect(switchOf()).toHaveAttribute("aria-checked", "true");
    expect(switchOf()).not.toBeDisabled();
  });

  it("is not there for a door that passes no switch: a read-only device, a saved copy, a quiet machine", () => {
    sheet([fixtureWalkyAgent], { canReply: false, walkyOff: true });
    expect(screen.queryByRole("switch")).toBeNull();
    expect(document.querySelector('[data-slot="walky-off"]')).toBeNull();
  });
});
