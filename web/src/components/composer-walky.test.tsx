import { createRef, useState, type ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { loadDraft, saveDraft } from "@/lib/drafts";
import { markLive, resetLiveness } from "@/lib/liveness";
import { clearStatus } from "@/lib/status";
import { recordedWalkyPosts, recordedWalkyTakeBacks } from "@/test/handlers";
import { server } from "@/test/setup";
import type { WalkyReceipt, WalkyRow } from "@/lib/walky";
import { Composer, type ComposerHandle } from "./composer";
import { WalkyLogProvider } from "./walky-log";

// M62 spec 05 on the composer: a long press on Send offers "Send as message", which posts to
// `POST /api/walky` with this pane's address; and a Reply handed in by the Messages sheet makes the
// next Send a message to the sender with `replyTo`.

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => {
  clearStatus();
  resetLiveness();
  markLive("w1:p1");
});
afterEach(() => cleanup());

function renderComposer(handle = createRef<ComposerHandle>(), overrides: Partial<ComponentProps<typeof Composer>> = {}) {
  const props: ComponentProps<typeof Composer> = {
    paneId: "w1:p1",
    agent: "claude",
    isShell: false,
    gone: false,
    readOnly: false,
    surface: { revision: 1, turn: "idle", modal: "none", composer: "empty" },
    text: "pane output",
    terminalDraft: null,
    rawTerminalDraft: null,
    prefs: { wrap: true, fontSize: 11, draftFontSize: 14, chatFontSize: 14, fontFamily: "system", rawTerminal: false, tapToFocus: true, expandClippedReply: true, stretchText: false },
    display: { open: false, onToggle: vi.fn() },
    onSent: vi.fn(),
    ...overrides,
  };
  const router = createMemoryRouter([{ path: "/", element: <Composer ref={handle} {...props} /> }]);
  render(<RouterProvider router={router} />);
  return handle;
}

/** Any Send Protocol request the composer should NOT make. */
function watchPlainSends(): string[] {
  const seen: string[] = [];
  server.use(http.post(/\/api\/send$/, ({ request }) => (seen.push(request.url), HttpResponse.json({ receipt: { outcome: "sent", keys: [] }, offers: [] }))));
  return seen;
}

describe("Send as message (the Send button's long-press menu)", () => {
  it("opens the menu on a context-menu press and posts the draft to this pane's address", async () => {
    const user = userEvent.setup();
    const plain = watchPlainSends();
    renderComposer();
    await user.type(screen.getByPlaceholderText(/type a reply/i), "Stop and report");
    fireEvent.contextMenu(screen.getByRole("button", { name: "Send" }));
    await user.click(await screen.findByRole("button", { name: "Send as message" }));
    await waitFor(() => expect(recordedWalkyPosts()).toHaveLength(1));
    const [posted] = recordedWalkyPosts();
    expect(posted).toMatchObject({ to: "local/w1:p1", body: "Stop and report" });
    expect(posted?.id).toMatch(/^wt_[a-z0-9]{12}$/);
    expect(posted).not.toHaveProperty("replyTo");
    // The receipt state is told beside the box, and the draft left with the message.
    expect(await screen.findByText("Message to this pane: queued")).toBeInTheDocument();
    await waitFor(() => expect(loadDraft(undefined, "w1:p1") ?? "").toBe(""));
    expect(plain).toEqual([]);
  });

  it("addresses the pane's current session instance when the pane carries one", async () => {
    const user = userEvent.setup();
    renderComposer(createRef<ComposerHandle>(), { instance: "k3f9" });
    await user.type(screen.getByPlaceholderText(/type a reply/i), "Stop and report");
    fireEvent.contextMenu(screen.getByRole("button", { name: "Send" }));
    await user.click(await screen.findByRole("button", { name: "Send as message" }));
    await waitFor(() => expect(recordedWalkyPosts()).toHaveLength(1));
    expect(recordedWalkyPosts()[0]).toMatchObject({ to: "local/w1:p1#k3f9", body: "Stop and report" });
    // The note beside the box still reads in words, with the token nowhere in it.
    expect(await screen.findByText("Message to this pane: queued")).toBeInTheDocument();
  });

  it("opens the menu on a real hold, and a plain tap still sends the reply the ordinary way", async () => {
    const user = userEvent.setup();
    const plain = watchPlainSends();
    renderComposer();
    await user.type(screen.getByPlaceholderText(/type a reply/i), "hello");
    const send = screen.getByRole("button", { name: "Send" });
    fireEvent.pointerDown(send, { button: 0, clientX: 5, clientY: 5 });
    await act(() => new Promise((r) => setTimeout(r, 520)));
    fireEvent.pointerUp(send);
    expect(await screen.findByRole("button", { name: "Send as message" })).toBeInTheDocument();
    expect(plain).toEqual([]);
    expect(recordedWalkyPosts()).toEqual([]);
  });

  it("keeps the draft and says why when the bridge refuses the message", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("/api/walky", () =>
        HttpResponse.json({ receipt: { id: "wt_aaaaaaaaaaaa", state: "refused", reason: "rate limit", verified: "local", at: 1, by: "solo", target: "local/w1:p1" } }),
      ),
    );
    renderComposer();
    await user.type(screen.getByPlaceholderText(/type a reply/i), "again");
    fireEvent.contextMenu(screen.getByRole("button", { name: "Send" }));
    await user.click(await screen.findByRole("button", { name: "Send as message" }));
    expect(await screen.findByText("Message to this pane: not sent: rate limit")).toBeInTheDocument();
    expect(loadDraft(undefined, "w1:p1")).toBe("again");
  });

  it("names the message limit, not the draft store, when the text is too long to send as a message", async () => {
    saveDraft(undefined, "w1:p1", "x".repeat(4_001));
    renderComposer();
    fireEvent.contextMenu(await screen.findByRole("button", { name: "Send" }));
    fireEvent.click(await screen.findByRole("button", { name: "Send as message" }));
    expect(await screen.findByText("Message not sent: A message holds at most 4,000 characters.")).toBeInTheDocument();
    expect(recordedWalkyPosts()).toEqual([]);
  });

  it("offers no menu on a locked field, even with a draft in the box and a press on Send", async () => {
    // A draft kept from before the device lost write access: the box holds text, so Send is drawn.
    saveDraft(undefined, "w1:p1", "Stop and report");
    renderComposer(createRef<ComposerHandle>(), { readOnly: true });
    const send = await screen.findByRole("button", { name: "Send" });
    fireEvent.contextMenu(send);
    fireEvent.pointerDown(send, { button: 0, clientX: 5, clientY: 5 });
    await act(() => new Promise((r) => setTimeout(r, 520)));
    fireEvent.pointerUp(send);
    expect(screen.queryByRole("button", { name: "Send as message" })).toBeNull();
    expect(recordedWalkyPosts()).toEqual([]);
  });
});

describe("the strip follows a queued message (M62 hardening I)", () => {
  /** The pane's walky list as the loader would hand it, one row for the message the test sent. */
  function rowOf(receipt: WalkyReceipt): WalkyRow {
    return {
      v: 1,
      id: receipt.id,
      kind: "operator",
      from: { memberId: null, address: null, harness: null, label: "phone" },
      to: "local/w1:p1",
      replyTo: null,
      at: 1,
      body: "Stop and report",
      signer: null,
      signature: null,
      receipt,
    };
  }

  it("shows the final word once the pane's list reads the receipt out of `accepted`, with no poll of its own", async () => {
    const user = userEvent.setup();
    let setRows: (rows: WalkyRow[]) => void = () => {};
    function Harness(props: ComponentProps<typeof Composer>) {
      const [rows, set] = useState<WalkyRow[]>([]);
      setRows = set;
      return (
        <WalkyLogProvider rows={rows} reads={1}>
          <Composer {...props} />
        </WalkyLogProvider>
      );
    }
    const props: ComponentProps<typeof Composer> = {
      paneId: "w1:p1",
      agent: "claude",
      isShell: false,
      gone: false,
      readOnly: false,
      surface: { revision: 1, turn: "idle", modal: "none", composer: "empty" },
      text: "pane output",
      terminalDraft: null,
      rawTerminalDraft: null,
      prefs: { wrap: true, fontSize: 11, draftFontSize: 14, chatFontSize: 14, fontFamily: "system", rawTerminal: false, tapToFocus: true, expandClippedReply: true, stretchText: false },
      display: { open: false, onToggle: vi.fn() },
      onSent: vi.fn(),
    };
    const router = createMemoryRouter([{ path: "/", element: <Harness {...props} /> }]);
    render(<RouterProvider router={router} />);
    await user.type(screen.getByPlaceholderText(/type a reply/i), "Stop and report");
    fireEvent.contextMenu(screen.getByRole("button", { name: "Send" }));
    await user.click(await screen.findByRole("button", { name: "Send as message" }));
    expect(await screen.findByText("Message to this pane: queued")).toBeInTheDocument();
    const id = recordedWalkyPosts()[0]?.id ?? "";
    const base: WalkyReceipt = { id, state: "accepted", verified: "local", at: 1, by: "local", target: "local/w1:p1" };
    // A revalidation that still reads `accepted` changes nothing.
    act(() => setRows([rowOf(base)]));
    expect(screen.getByText("Message to this pane: queued")).toBeInTheDocument();
    // A held message (M62 spec 02): still `accepted`, with what holds it, and when it will be typed.
    act(() => setRows([rowOf({ ...base, reason: "draft present" })]));
    expect(await screen.findByText("Message to this pane: held: draft present. Typed when the box clears or the turn ends, up to 60 minutes. Do not send it again.")).toBeInTheDocument();
    act(() => setRows([rowOf({ ...base, reason: "turn running", at: 2 })]));
    expect(await screen.findByText(/^Message to this pane: held: turn running\. /)).toBeInTheDocument();
    act(() => setRows([rowOf({ ...base, state: "inbox-only", reason: "dialog open" })]));
    expect(await screen.findByText("Message to this pane: waiting in the inbox, not typed: dialog open")).toBeInTheDocument();
  });
});

describe("a reply handed in by the Messages sheet", () => {
  it("names the sender, then posts to the sender's address with replyTo on a plain Send", async () => {
    const user = userEvent.setup();
    const plain = watchPlainSends();
    const handle = renderComposer();
    act(() => handle.current?.startMessage({ to: "bluefin/w6:p3", replyTo: "wt_k3f9x2m8q1a0", label: "collie-workspace#fix-465" }));
    expect(await screen.findByText("Reply to collie-workspace#fix-465")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox"), "Merge it");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(recordedWalkyPosts()).toHaveLength(1));
    expect(recordedWalkyPosts()[0]).toMatchObject({ to: "bluefin/w6:p3", body: "Merge it", replyTo: "wt_k3f9x2m8q1a0" });
    expect(plain).toEqual([]);
    // The reply went, so the target is spent and the next Send is the ordinary one.
    await waitFor(() => expect(screen.queryByText("Reply to collie-workspace#fix-465")).toBeNull());
  });

  it("keeps the token of the sender's address, and does not put the pane's own instance on a reply", async () => {
    const user = userEvent.setup();
    const handle = renderComposer(createRef<ComposerHandle>(), { instance: "zz99" });
    act(() => handle.current?.startMessage({ to: "bluefin/w6:p3#k3f9", replyTo: "wt_k3f9x2m8q1a0", label: "peer" }));
    await user.type(await screen.findByRole("textbox"), "Merge it");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(recordedWalkyPosts()).toHaveLength(1));
    expect(recordedWalkyPosts()[0]).toMatchObject({ to: "bluefin/w6:p3#k3f9", replyTo: "wt_k3f9x2m8q1a0" });
  });

  it("turns back into a plain reply when the strip is dismissed", async () => {
    const user = userEvent.setup();
    const handle = renderComposer();
    act(() => handle.current?.startMessage({ to: "bluefin/w6:p3", replyTo: "wt_k3f9x2m8q1a0", label: "peer" }));
    await user.click(await screen.findByRole("button", { name: "Send as a plain reply again" }));
    await waitFor(() => expect(screen.queryByText("Reply to peer")).toBeNull());
  });
});

describe("the held mark (M62 spec 03)", () => {
  /** A message held for this pane's box (`local/w1:p1` on a solo install), from another pane. */
  const heldForThisPane: WalkyRow = {
    v: 1,
    id: "wt_he1dh01dh01d",
    kind: "agent",
    from: { memberId: null, address: "local/w2:p1", harness: "pi", label: "repo#other" },
    to: "local/w1:p1",
    replyTo: null,
    at: Date.parse("2026-10-21T09:30:00Z"),
    body: "Tests are green.",
    signer: null,
    signature: null,
    receipt: { id: "wt_he1dh01dh01d", state: "accepted", reason: "draft present", verified: "local", at: Date.parse("2026-10-21T09:30:01Z"), by: "solo", target: "local/w1:p1" },
  };
  /** A message THIS pane sent that is held at the far pane: not this box's business. */
  const heldElsewhere: WalkyRow = {
    ...heldForThisPane,
    id: "wt_he1de1sewhe",
    from: { memberId: null, address: "local/w1:p1", harness: "claude", label: "repo#this" },
    to: "local/w2:p1",
    receipt: { ...heldForThisPane.receipt, id: "wt_he1de1sewhe", target: "local/w2:p1" },
  };

  function renderWithRows(rows: readonly WalkyRow[], onOpenMessages: (() => void) | undefined) {
    const props: ComponentProps<typeof Composer> = {
      paneId: "w1:p1",
      agent: "claude",
      isShell: false,
      gone: false,
      readOnly: false,
      surface: { revision: 1, turn: "idle", modal: "none", composer: "empty" },
      text: "pane output",
      terminalDraft: null,
      rawTerminalDraft: null,
      prefs: { wrap: true, fontSize: 11, draftFontSize: 14, chatFontSize: 14, fontFamily: "system", rawTerminal: false, tapToFocus: true, expandClippedReply: true, stretchText: false },
      display: { open: false, onToggle: vi.fn() },
      onSent: vi.fn(),
      onOpenMessages,
    };
    const router = createMemoryRouter([
      {
        path: "/",
        element: (
          <WalkyLogProvider rows={rows}>
            <Composer {...props} />
          </WalkyLogProvider>
        ),
      },
    ]);
    render(<RouterProvider router={router} />);
  }

  it("counts the messages held for this pane's box, and a tap opens the Messages sheet", async () => {
    const user = userEvent.setup();
    const onOpenMessages = vi.fn();
    renderWithRows([heldForThisPane, heldElsewhere], onOpenMessages);
    const mark = await screen.findByText("1 message waits for the box to clear");
    expect(mark).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "1 message waits for the box to clear" }));
    expect(onOpenMessages).toHaveBeenCalledOnce();
  });

  it("reads the plural, and draws nothing with no held message or no sheet to open", () => {
    const second: WalkyRow = { ...heldForThisPane, id: "wt_he1dh01dh02d", receipt: { ...heldForThisPane.receipt, id: "wt_he1dh01dh02d" } };
    renderWithRows([heldForThisPane, second], vi.fn());
    expect(screen.getByText("2 messages wait for the box to clear")).toBeInTheDocument();
    cleanup();
    renderWithRows([heldElsewhere], vi.fn());
    expect(screen.queryByText(/wait(s)? for the box to clear/)).toBeNull();
    cleanup();
    renderWithRows([heldForThisPane], undefined);
    expect(screen.queryByText(/wait(s)? for the box to clear/)).toBeNull();
  });
});

describe("Cancel on the held outcome line (M62 spec 03)", () => {
  it("offers Cancel while the list says the message is held, and posts the cancel route", async () => {
    const user = userEvent.setup();
    // The bridge answers `held` for this message, and the pane's list carries that receipt.
    let postedId: string | null = null;
    server.use(
      http.post(/\/api\/walky$/, async ({ request }) => {
        // SAFETY: the Composer under test posts `{ id, to, body }` through postWalky; this fake reads two of its strings back.
        const body = (await request.json()) as { id: string; to: string };
        postedId = body.id;
        return HttpResponse.json({ receipt: { id: body.id, target: body.to, state: "accepted", reason: "draft present", verified: "local", at: Date.now(), by: "solo" } });
      }),
    );
    let rows: readonly WalkyRow[] = [];
    function Harness() {
      const [list, setList] = useState<readonly WalkyRow[]>(rows);
      rows = list;
      // The list follows the first post: what the bridge's pane list would hold after the send.
      const props: ComponentProps<typeof Composer> = {
        paneId: "w1:p1",
        agent: "claude",
        isShell: false,
        gone: false,
        readOnly: false,
        surface: { revision: 1, turn: "idle", modal: "none", composer: "empty" },
        text: "pane output",
        terminalDraft: null,
        rawTerminalDraft: null,
        prefs: { wrap: true, fontSize: 11, draftFontSize: 14, chatFontSize: 14, fontFamily: "system", rawTerminal: false, tapToFocus: true, expandClippedReply: true, stretchText: false },
        display: { open: false, onToggle: vi.fn() },
        onSent: vi.fn(),
      };
      return (
        <WalkyLogProvider rows={list}>
          <button type="button" onClick={() => setList(heldRows())}>
            list read
          </button>
          <Composer {...props} />
        </WalkyLogProvider>
      );
    }
    const heldRows = (): WalkyRow[] => {
      const id = postedId ?? "wt_000000000000";
      return [
        {
          v: 1,
          id,
          kind: "operator",
          from: { memberId: null, address: null, harness: null, label: "phone" },
          to: "local/w1:p1",
          replyTo: null,
          at: Date.now(),
          body: "Stop and report",
          signer: null,
          signature: null,
          receipt: { id, state: "accepted", reason: "draft present", verified: "local", at: Date.now(), by: "solo", target: "local/w1:p1" },
        },
      ];
    };
    const router = createMemoryRouter([{ path: "/", element: <Harness /> }]);
    render(<RouterProvider router={router} />);
    await user.type(screen.getByPlaceholderText(/type a reply/i), "Stop and report");
    fireEvent.contextMenu(screen.getByRole("button", { name: "Send" }));
    await user.click(await screen.findByRole("button", { name: "Send as message" }));
    expect(await screen.findByText(/Message to this pane: held: draft present/)).toBeInTheDocument();
    // No Cancel until the pane's own list carries the held receipt: the strip follows the list, not the first answer.
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "list read" }));
    const cancel = await screen.findByRole("button", { name: "Cancel" });
    await user.click(cancel);
    await waitFor(() => expect(recordedWalkyTakeBacks()).toEqual([`cancel ${String(postedId)}`]));
  });
});
