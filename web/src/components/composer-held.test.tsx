import { useState, type ComponentProps } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { loadDraft } from "@/lib/drafts";
import { markLive, resetLiveness } from "@/lib/liveness";
import { clearStatus, useStatus } from "@/lib/status";
import type { HeldRow } from "@/lib/surface/send";
import { server } from "@/test/setup";
import { Composer } from "./composer";

// M56 spec 15 on the composer: the sends the bridge holds for a pane show as ONE card that floats over
// the mirror's bottom edge (ADR 0061, amended 2026-10-18), each row with the control its state allows.
// The rows come from the snapshot (the `held` prop); the composer only draws them and calls the bridge.
// One row shows whole; two or more collapse to a head and the first text until Show all.

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => {
  clearStatus();
  resetLiveness();
  markLive("w1:p1");
});
afterEach(() => cleanup());

function StatusProbe() {
  const status = useStatus();
  return <output data-testid="status">{status?.text ?? ""}</output>;
}

function renderComposer(overrides: Partial<ComponentProps<typeof Composer>> = {}) {
  const props: ComponentProps<typeof Composer> = {
    paneId: "w1:p1",
    agent: "claude",
    isShell: false,
    gone: false,
    readOnly: false,
    surface: { revision: 1, turn: "running", modal: "none", composer: "empty" },
    text: "pane output",
    terminalDraft: null,
    rawTerminalDraft: null,
    prefs: { wrap: true, fontSize: 11, draftFontSize: 14, chatFontSize: 14, fontFamily: "system", rawTerminal: false, tapToFocus: true, expandClippedReply: true, stretchText: false },
    display: { open: false, onToggle: vi.fn() },
    onSent: vi.fn(),
    ...overrides,
  };
  const router = createMemoryRouter([
    {
      path: "/",
      element: (
        <>
          <Composer {...props} />
          <StatusProbe />
        </>
      ),
    },
  ]);
  render(<RouterProvider router={router} />);
  return props;
}

const NOW = 1_700_000_000_000;
function row(requestId: string, state: HeldRow["state"], extra: Partial<HeldRow> = {}): HeldRow {
  return { requestId, mode: "send", text: `text of ${requestId}`, heldAt: NOW, expiresAt: NOW + 30 * 60_000, state, ...extra };
}

/** The DELETEs the fake bridge took, with its answer for each. */
function fakeDelete(answer: { status?: number; body: object }) {
  const calls: string[] = [];
  server.use(
    http.delete("/api/send/:id", ({ request, params }) => {
      calls.push(`${String(params.id)}${new URL(request.url).search}`);
      return HttpResponse.json(answer.body, { status: answer.status ?? 200 });
    }),
  );
  return calls;
}

interface Posted {
  id: string;
  text: string;
  mode: string;
  resendOf?: string;
  rowsHash?: string;
}
function fakeSend(body: (posted: Posted) => object) {
  const sends: Posted[] = [];
  server.use(
    http.post(/\/api\/send$/, async ({ request }) => {
      // SAFETY: the composer under test is the only poster, and it sends a SendRequestBody, whose fields Posted names.
      const posted = (await request.json()) as Posted;
      sends.push(posted);
      return HttpResponse.json(body(posted));
    }),
  );
  return sends;
}

/** The Show all / Show less toggle, found by the words it shows. */
const showAll = () => screen.getByRole("button", { name: "Show all queued messages" });
const showLess = () => screen.getByRole("button", { name: "Show less of the queue" });

describe("the held-send card", () => {
  it("one row: its label, its Cancel, its text clamped to three lines", () => {
    renderComposer({ held: [row("req00001", "held")] });
    const found = document.querySelectorAll('[data-slot="held-row"]');
    expect(found).toHaveLength(1);
    expect(found[0]).toHaveTextContent("Queued. Sends when the turn ends.");
    expect(screen.getByText("text of req00001")).toHaveClass("line-clamp-3");
    expect(screen.getAllByRole("button", { name: "Cancel the queued message" })).toHaveLength(1);
    // Nothing to fold with one row, so no toggle.
    expect(screen.queryByRole("button", { name: /show all|show less/i })).toBeNull();
    expect(document.querySelector('[data-slot="held-card"]')).toHaveAttribute("data-mode", "single");
  });

  it("two held rows start collapsed: a count, the first text on two lines, a Show all toggle and no Cancel", () => {
    renderComposer({ held: [row("req00001", "held"), row("req00002", "held", { text: "second\nline" })] });
    const card = document.querySelector('[data-slot="held-card"]')!;
    expect(card).toHaveAttribute("data-mode", "collapsed");
    expect(card).toHaveTextContent("2 queued. Sends when the turn ends.");
    expect(screen.getByText("text of req00001")).toHaveClass("line-clamp-2");
    expect(screen.queryByText(/second/)).toBeNull();
    expect(document.querySelectorAll('[data-slot="held-row"]')).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Cancel the queued message" })).toBeNull();
    // The visible words, and an accessible name that starts with them.
    expect(showAll()).toHaveTextContent("Show all");
    expect(showAll()).toHaveAttribute("aria-expanded", "false");
  });

  it("Show all lists every row, oldest first, each with its Cancel; Show less collapses again", async () => {
    const user = userEvent.setup();
    renderComposer({ held: [row("req00001", "held"), row("req00002", "held", { text: "second\nline" })] });
    await user.click(showAll());
    const card = document.querySelector('[data-slot="held-card"]')!;
    expect(card).toHaveAttribute("data-mode", "expanded");
    const found = document.querySelectorAll('[data-slot="held-row"]');
    expect(found).toHaveLength(2);
    expect(found[0]).toHaveTextContent("Queued. Sends when the turn ends.");
    expect(found[0]).toHaveTextContent("text of req00001");
    expect(found[1]).toHaveTextContent("second line");
    expect(screen.getAllByRole("button", { name: "Cancel the queued message" })).toHaveLength(2);
    // Each row is a single row as today: its text clamped to three lines, inside a list that scrolls in the card.
    expect(screen.getByText("text of req00001")).toHaveClass("line-clamp-3");
    const list = card.querySelector('[data-slot="held-list"]')!;
    expect(list.className).toMatch(/(?:^|\s)max-h-\[45dvh\](?=\s|$)/);
    expect(list.className).toMatch(/(?:^|\s)overflow-y-auto(?=\s|$)/);
    expect(list.contains(found[0] ?? null)).toBe(true);
    expect(showLess()).toHaveTextContent("Show less");
    expect(showLess()).toHaveAttribute("aria-expanded", "true");

    await user.click(showLess());
    expect(card).toHaveAttribute("data-mode", "collapsed");
    expect(document.querySelectorAll('[data-slot="held-row"]')).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Cancel the queued message" })).toBeNull();
  });

  it("a Cancel in the open list calls DELETE for that row only", async () => {
    const user = userEvent.setup();
    const calls = fakeDelete({ body: { result: "cancelled" } });
    const props = renderComposer({ scope: { session: "demo" }, held: [row("req00001", "held"), row("req00002", "held")] });
    await user.click(showAll());
    const second = document.querySelectorAll<HTMLElement>('[data-slot="held-row"]')[1]!;
    await user.click(within(second).getByRole("button", { name: "Cancel the queued message" }));
    await waitFor(() => expect(calls).toEqual(["req00002?pane=w1%3Ap1&session=demo"]));
    await waitFor(() => expect(props.onSent).toHaveBeenCalled());
  });

  it("mixed rows: the head wears the first row's own label, not a count", () => {
    renderComposer({ held: [row("req00001", "ended", { outcome: "expired" }), row("req00002", "held"), row("req00003", "held")] });
    const card = document.querySelector('[data-slot="held-card"]')!;
    expect(card).toHaveAttribute("data-mode", "collapsed");
    expect(card).toHaveTextContent("Not sent. The turn did not end within 30 minutes.");
    expect(card).not.toHaveTextContent("queued. Sends when the turn ends.");
    expect(screen.getByText("text of req00001")).toBeInTheDocument();
    // Collapsed, even an ended row's Resend and Dismiss wait for Show all.
    expect(screen.queryByRole("button", { name: "Dismiss the message" })).toBeNull();
  });

  it("a queue whose first row is going out now: that label heads the card, and its row has no button", async () => {
    const user = userEvent.setup();
    renderComposer({ held: [row("req00001", "running"), row("req00002", "held")] });
    const card = document.querySelector('[data-slot="held-card"]')!;
    // Mixed (one is going out now): the first row's label.
    expect(card).toHaveTextContent("Sending now.");
    await user.click(showAll());
    const found = document.querySelectorAll<HTMLElement>('[data-slot="held-row"]');
    expect(within(found[0]!).queryAllByRole("button")).toHaveLength(0);
    expect(within(found[1]!).getByRole("button", { name: "Cancel the queued message" })).toBeInTheDocument();
  });

  it("an empty queue draws no card", () => {
    renderComposer({ held: [] });
    expect(document.querySelector('[data-slot="held-card"]')).toBeNull();
    expect(document.querySelector('[data-slot="floating-cards"]')).toBeNull();
  });

  it("a request going out now says so and has no button", () => {
    renderComposer({ held: [row("req00001", "running")] });
    expect(screen.getByText("Sending now.")).toBeInTheDocument();
    // SAFETY: the query matches the row's own div, which is an HTMLElement.
    const held = document.querySelector('[data-slot="held-row"]') as HTMLElement;
    expect(within(held).queryAllByRole("button")).toHaveLength(0);
  });

  it("an expired one offers Resend and Dismiss; Resend posts a NEW request by the old id with an empty text, and never calls the cancel route", async () => {
    const user = userEvent.setup();
    const calls = fakeDelete({ body: { result: "dismissed" } });
    const sends = fakeSend((posted) => ({ receipt: { requestId: posted.id, outcome: "sent", keys: [] }, offers: [] }));
    const props = renderComposer({ held: [row("req00001", "ended", { outcome: "expired" })] });
    expect(screen.getByText("Not sent. The turn did not end within 30 minutes.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss the message" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Resend the message" }));
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toMatchObject({ text: "", mode: "send", resendOf: "req00001" });
    expect(sends[0]!.id).not.toBe("req00001");
    expect(JSON.stringify(sends[0])).not.toContain("text of req00001");
    await waitFor(() => expect(props.onSent).toHaveBeenCalled());
    expect(calls).toEqual([]);
  });

  it("a Resend keeps the old row's mode", async () => {
    const user = userEvent.setup();
    const sends = fakeSend((posted) => ({ receipt: { requestId: posted.id, outcome: "sent", keys: [] }, offers: [] }));
    renderComposer({ held: [row("req00001", "ended", { outcome: "expired", mode: "command", text: "/compact" })] });
    await user.click(screen.getByRole("button", { name: "Resend the message" }));
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toMatchObject({ text: "", mode: "command", resendOf: "req00001" });
  });

  it("a Resend the bridge refuses keeps the row: the text is not dismissed", async () => {
    const user = userEvent.setup();
    const calls = fakeDelete({ body: { result: "dismissed" } });
    const sends = fakeSend((posted) => ({ receipt: { requestId: posted.id, outcome: "refused", reason: "not_free", keys: [] }, offers: [] }));
    renderComposer({ held: [row("req00001", "ended", { outcome: "refused", reason: "write_failed" })] });
    expect(screen.getByText("Not sent. Check the pane, then send again.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Resend the message" }));
    await waitFor(() => expect(sends).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Resend the message" })).toBeEnabled());
    expect(calls).toEqual([]);
  });

  it("Dismiss lets an ended row go with one DELETE and sends nothing", async () => {
    const user = userEvent.setup();
    const calls = fakeDelete({ body: { result: "dismissed" } });
    const sends = fakeSend(() => ({}));
    renderComposer({ held: [row("req00001", "ended", { outcome: "unknown" })] });
    await user.click(screen.getByRole("button", { name: "Dismiss the message" }));
    await waitFor(() => expect(calls).toEqual(["req00001?pane=w1%3Ap1"]));
    expect(sends).toEqual([]);
  });

  it("a row that ended unknown says the text may have reached the agent, with Dismiss and no Resend", async () => {
    const user = userEvent.setup();
    const calls = fakeDelete({ body: { result: "dismissed" } });
    renderComposer({ held: [row("req00001", "ended", { outcome: "unknown" })] });
    expect(screen.getByText("The text may have reached the agent. Read the chat.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resend the message" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Dismiss the message" }));
    await waitFor(() => expect(calls).toEqual(["req00001?pane=w1%3Ap1"]));
  });

  it("a row that ended typed_not_submitted offers Submit, Discard and Dismiss; Submit posts mode submit with the row's text, then dismisses", async () => {
    const user = userEvent.setup();
    const calls = fakeDelete({ body: { result: "dismissed" } });
    const sends = fakeSend((posted) => ({ receipt: { requestId: posted.id, outcome: "sent", keys: [] }, offers: [] }));
    renderComposer({ held: [row("req00001", "ended", { outcome: "typed_not_submitted" })] });
    expect(screen.getByText("Typed, not sent. The text is still in the box.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resend the message" })).toBeNull();
    expect(screen.getByRole("button", { name: "Dismiss the message" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Submit the text in the box" }));
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toMatchObject({ text: "text of req00001", mode: "submit" });
    expect(sends[0]!.resendOf).toBeUndefined();
    await waitFor(() => expect(calls).toEqual(["req00001?pane=w1%3Ap1"]));
  });

  it("Discard posts mode discard with the row's text, then dismisses", async () => {
    const user = userEvent.setup();
    const calls = fakeDelete({ body: { result: "dismissed" } });
    const sends = fakeSend((posted) => ({ receipt: { requestId: posted.id, outcome: "discarded", keys: [] }, offers: [] }));
    renderComposer({ held: [row("req00001", "ended", { outcome: "typed_not_submitted" })] });
    await user.click(screen.getByRole("button", { name: "Discard the text in the box" }));
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toMatchObject({ text: "text of req00001", mode: "discard" });
    await waitFor(() => expect(calls).toEqual(["req00001?pane=w1%3Ap1"]));
  });

  it("a Submit the bridge refuses keeps the row", async () => {
    const user = userEvent.setup();
    const calls = fakeDelete({ body: { result: "dismissed" } });
    const sends = fakeSend((posted) => ({ receipt: { requestId: posted.id, outcome: "refused", reason: "not_free", keys: [] }, offers: [] }));
    renderComposer({ held: [row("req00001", "ended", { outcome: "typed_not_submitted" })] });
    await user.click(screen.getByRole("button", { name: "Submit the text in the box" }));
    await waitFor(() => expect(sends).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "Submit the text in the box" })).toBeEnabled());
    expect(calls).toEqual([]);
  });

  it("a typed row whose Discard the bridge refuses (the box no longer holds the text) still goes with Dismiss, which sends nothing", async () => {
    const user = userEvent.setup();
    const calls = fakeDelete({ body: { result: "dismissed" } });
    const sends = fakeSend((posted) => ({ receipt: { requestId: posted.id, outcome: "refused", reason: "not_free", keys: [] }, offers: [] }));
    renderComposer({ held: [row("req00001", "ended", { outcome: "typed_not_submitted" })] });
    await user.click(screen.getByRole("button", { name: "Discard the text in the box" }));
    await waitFor(() => expect(sends).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "Dismiss the message" })).toBeEnabled());
    expect(calls).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Dismiss the message" }));
    await waitFor(() => expect(calls).toEqual(["req00001?pane=w1%3Ap1"]));
    expect(sends).toHaveLength(1);
  });

  it("a Cancel that finds the request already sent says it went out", async () => {
    const user = userEvent.setup();
    fakeDelete({ status: 409, body: { result: "refused", reason: "busy", receipt: { requestId: "req00001", outcome: "sent", keys: [] } } });
    renderComposer({ held: [row("req00001", "held")] });
    await user.click(screen.getByRole("button", { name: "Cancel the queued message" }));
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("It already went out."));
  });

  it("a row whose pane closed offers Dismiss only", () => {
    renderComposer({ held: [row("req00001", "ended", { outcome: "refused", reason: "pane_gone" })] });
    expect(screen.getByText("Not sent. The pane closed.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss the message" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resend the message" })).toBeNull();
  });

  it("a crew member's pane shows its rows with no row buttons, collapsed or open: the cancel route does not cross a link", async () => {
    const user = userEvent.setup();
    renderComposer({ scope: { host: "badger" }, held: [row("req00001", "held"), row("req00002", "ended", { outcome: "expired" })] });
    expect(screen.queryByRole("button", { name: /cancel|resend|dismiss|submit|discard/i })).toBeNull();
    // Show all is a view, not an act on the queue, so it stays and the rows can still be read.
    await user.click(showAll());
    expect(document.querySelectorAll('[data-slot="held-row"]')).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /cancel|resend|dismiss|submit|discard/i })).toBeNull();
  });

  it("a locked composer shows its rows with no buttons", () => {
    renderComposer({ readOnly: true, held: [row("req00001", "held")] });
    expect(document.querySelectorAll('[data-slot="held-row"]')).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Cancel the queued message" })).toBeNull();
  });

  it("a locked composer with several rows: no row buttons open or collapsed", async () => {
    const user = userEvent.setup();
    renderComposer({ readOnly: true, held: [row("req00001", "held"), row("req00002", "held")] });
    expect(screen.queryByRole("button", { name: "Cancel the queued message" })).toBeNull();
    await user.click(showAll());
    expect(document.querySelectorAll('[data-slot="held-row"]')).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Cancel the queued message" })).toBeNull();
  });

  it("a send the bridge answers held clears the draft and says queued, with no refusal notice", async () => {
    const user = userEvent.setup();
    const sends = fakeSend((posted) => ({ receipt: { requestId: posted.id, outcome: "held", keys: [] }, offers: [], detail: "The agent is working." }));
    // The bridge decides held on its own read; the phone's surface is idle so its box is open to type in.
    renderComposer({ surface: { revision: 1, turn: "idle", modal: "none", composer: "empty" } });
    await user.type(screen.getByPlaceholderText(/type a reply/i), "after the turn");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sends).toHaveLength(1));
    await waitFor(() => expect(loadDraft(undefined, "w1:p1") ?? "").toBe(""));
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("Queued. Sends when the turn ends."));
    expect(document.querySelector('[data-slot="composer-refusal"]')).toBeNull();
    expect(screen.queryByTestId("send-offers")).toBeNull();
  });
});

// The card holds no space (ADR 0061, amended 2026-10-18): it is placed in the floating notice slot, or
// floated above the composer's own top edge, and never in the composer's flow above the box.
describe("the held-send card floats", () => {
  it("alone, it floats above the composer's top edge: absolute, pass-through wrapper, no Collapse", () => {
    renderComposer({ held: [row("req00001", "held")] });
    const card = document.querySelector('[data-slot="held-card"]')!;
    const column = card.closest('[data-slot="floating-cards"]')!;
    expect(column.className).toMatch(/(?:^|\s)absolute(?=\s|$)/);
    expect(column.className).toMatch(/(?:^|\s)bottom-full(?=\s|$)/);
    expect(column.className).toMatch(/(?:^|\s)pointer-events-none(?=\s|$)/);
    // The card takes touches back, and is a uniform dashed box with no left accent.
    expect(card.className).toMatch(/(?:^|\s)pointer-events-auto(?=\s|$)/);
    expect(card.className).toMatch(/(?:^|\s)border(?=\s|$)/);
    expect(card.className).toMatch(/(?:^|\s)border-dashed(?=\s|$)/);
    expect(card.className).not.toMatch(/border-l/);
    expect(card.closest('[data-slot="collapse"]')).toBeNull();
    // Absolute, so it takes no row of the composer's flow above the box (the old `held-rows` strip is gone).
    expect(card.parentElement).toBe(column);
    expect(document.querySelector('[data-slot="held-rows"]')).toBeNull();
  });

  it("portals into the slot it is handed, and nowhere else", () => {
    const slot = document.createElement("div");
    document.body.append(slot);
    try {
      renderComposer({ draftNoticeSlot: slot, held: [row("req00001", "held"), row("req00002", "held")] });
      const card = slot.querySelector('[data-slot="held-card"]');
      expect(card).not.toBeNull();
      expect(document.querySelectorAll('[data-slot="held-card"]')).toHaveLength(1);
      // In the slot, the column is only the pass-through: the slot does the positioning.
      const column = slot.querySelector('[data-slot="floating-cards"]')!;
      expect(column.className).not.toMatch(/(?:^|\s)absolute(?=\s|$)/);
      expect(column.className).toMatch(/(?:^|\s)pointer-events-none(?=\s|$)/);
    } finally {
      slot.remove();
    }
  });

  it("with the terminal-draft notice also due, both float in one column: the held card first, the notice nearest the belt", () => {
    const slot = document.createElement("div");
    document.body.append(slot);
    try {
      renderComposer({
        draftNoticeSlot: slot,
        terminalDraft: "typed in the terminal",
        rawTerminalDraft: "typed in the terminal",
        held: [row("req00001", "held")],
      });
      const column = slot.querySelector('[data-slot="floating-cards"]')!;
      const children = Array.from(column.children);
      expect(children).toHaveLength(2);
      expect(children[0]).toHaveAttribute("data-slot", "held-card");
      expect(children[1]).toHaveAttribute("data-slot", "terminal-draft-notice");
      expect(children[1]).toHaveTextContent("typed in the terminal");
      expect(column.className).toMatch(/(?:^|\s)flex-col(?=\s|$)/);
      expect(column.className).toMatch(/(?:^|\s)gap-1\.5(?=\s|$)/);
    } finally {
      slot.remove();
    }
  });

  it("with no draft notice, the held card is the column's only child", () => {
    renderComposer({ held: [row("req00001", "held")] });
    const column = document.querySelector('[data-slot="floating-cards"]')!;
    expect(column.children).toHaveLength(1);
  });
});

/**
 * The composer with a queue and a pane that two hidden controls change, the way the parent changes them
 * across polls: `rows-control` sets how many of `ROWS` the bridge holds, `pane-control` the pane id.
 */
const ROWS: readonly HeldRow[] = [row("req00001", "held"), row("req00002", "held"), row("req00003", "held")];
function renderChangingQueue(initialCount: number) {
  function Host() {
    const [count, setCount] = useState(initialCount);
    const [paneId, setPaneId] = useState("w1:p1");
    return (
      <>
        <input data-testid="rows-control" defaultValue={String(initialCount)} onChange={(e) => setCount(Number(e.target.value))} />
        <input data-testid="pane-control" defaultValue="w1:p1" onChange={(e) => setPaneId(e.target.value)} />
        <Composer
          paneId={paneId}
          agent="claude"
          isShell={false}
          gone={false}
          readOnly={false}
          surface={{ revision: 1, turn: "running", modal: "none", composer: "empty" }}
          text="pane output"
          terminalDraft={null}
          rawTerminalDraft={null}
          prefs={{ wrap: true, fontSize: 11, draftFontSize: 14, chatFontSize: 14, fontFamily: "system", rawTerminal: false, tapToFocus: true, expandClippedReply: true, stretchText: false }}
          display={{ open: false, onToggle: vi.fn() }}
          onSent={vi.fn()}
          held={ROWS.slice(0, count)}
        />
      </>
    );
  }
  render(<RouterProvider router={createMemoryRouter([{ path: "/", element: <Host /> }])} />);
}
const setQueue = (count: number) => fireEvent.change(screen.getByTestId("rows-control"), { target: { value: String(count) } });
const setPane = (paneId: string) => fireEvent.change(screen.getByTestId("pane-control"), { target: { value: paneId } });

describe("Show all lives in memory, per pane", () => {
  it("collapses by itself once the rows drop to one, and the next queue starts collapsed", async () => {
    const user = userEvent.setup();
    renderChangingQueue(3);
    await user.click(showAll());
    expect(document.querySelector('[data-slot="held-card"]')).toHaveAttribute("data-mode", "expanded");

    setQueue(1);
    const card = document.querySelector('[data-slot="held-card"]')!;
    expect(card).toHaveAttribute("data-mode", "single");

    setQueue(3);
    expect(document.querySelector('[data-slot="held-card"]')).toHaveAttribute("data-mode", "collapsed");
    expect(document.querySelectorAll('[data-slot="held-row"]')).toHaveLength(0);
  });

  it("collapses when the queue empties and refills", async () => {
    const user = userEvent.setup();
    renderChangingQueue(2);
    await user.click(showAll());
    setQueue(0);
    expect(document.querySelector('[data-slot="held-card"]')).toBeNull();
    setQueue(2);
    expect(document.querySelector('[data-slot="held-card"]')).toHaveAttribute("data-mode", "collapsed");
  });

  it("stays open while the queue changes between two and more", async () => {
    const user = userEvent.setup();
    renderChangingQueue(3);
    await user.click(showAll());
    setQueue(2);
    expect(document.querySelector('[data-slot="held-card"]')).toHaveAttribute("data-mode", "expanded");
    expect(document.querySelectorAll('[data-slot="held-row"]')).toHaveLength(2);
  });

  it("a pane switch starts the next pane's card collapsed", async () => {
    const user = userEvent.setup();
    markLive("w1:p2");
    renderChangingQueue(3);
    await user.click(showAll());
    expect(document.querySelector('[data-slot="held-card"]')).toHaveAttribute("data-mode", "expanded");

    setPane("w1:p2");
    expect(document.querySelector('[data-slot="held-card"]')).toHaveAttribute("data-mode", "collapsed");
  });
});
