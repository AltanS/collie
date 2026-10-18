import { createRef, useState, type ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { loadDraft, saveDraft } from "@/lib/drafts";
import { markLive, resetLiveness } from "@/lib/liveness";
import { clearStatus } from "@/lib/status";
import { recordedWalkyPosts } from "@/test/handlers";
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
