import { createRef, useState, type ComponentProps, type RefObject } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetDraftPrune, clearAllDrafts, loadDraft, loadPutBack } from "@/lib/drafts";
import { __resetPending, pendingLines } from "@/lib/durable-pending";
import { markLive, resetLiveness } from "@/lib/liveness";
import { paneScopeKey } from "@/lib/scope";
import { __forgetSendAgainMemory } from "@/lib/send-again";
import { __forgetSendIntentMemory, loadIntent } from "@/lib/send-intent";
import { clearStatus, currentStatus } from "@/lib/status";
import type { HeldRow } from "@/lib/surface/send";
import type { Surface } from "@/lib/surface/surface";
import { recordedSends, sendAnswer, sendHandler } from "@/test/handlers";
import { server } from "@/test/setup";
import { CrewProvider } from "./crew-provider";
import { Composer, type ComposerHandle } from "./composer";

// M104 spec 01, the composer's half of "one move at the tap": a send of the box lets go of the box at the tap, puts the
// person's line in Chat at once, and holds the text until the send has an end. The invariant suite walks every end
// (src/test/invariants/calm-send.invariants.test.tsx); these are the named cases around it.

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => {
  clearStatus();
  resetLiveness();
  markLive("w1:p1");
  sessionStorage.clear();
  localStorage.clear();
  __resetDraftPrune();
  __forgetSendAgainMemory();
  __forgetSendIntentMemory();
  __resetPending();
});
afterEach(() => cleanup());

const FREE: Surface = { revision: 1, turn: "idle", modal: "none", composer: "empty" };
const KEY = paneScopeKey(undefined, "w1:p1");
const PROPS: ComponentProps<typeof Composer> = {
  paneId: "w1:p1",
  agent: "claude",
  isShell: false,
  gone: false,
  readOnly: false,
  surface: FREE,
  text: "pane output",
  terminalDraft: null,
  rawTerminalDraft: null,
  prefs: { wrap: true, fontSize: 11, draftFontSize: 14, chatFontSize: 14, fontFamily: "system", rawTerminal: false, tapToFocus: true, expandClippedReply: true, stretchText: false },
  display: { open: false, onToggle: vi.fn() },
  onSent: vi.fn(),
};

function mount(first: Partial<ComponentProps<typeof Composer>> = {}, handle: RefObject<ComposerHandle | null> = createRef<ComposerHandle>()) {
  let update: (next: Partial<ComponentProps<typeof Composer>>) => void = () => undefined;
  function Harness() {
    const [over, setOver] = useState(first);
    update = (next) => act(() => setOver((was) => ({ ...was, ...next })));
    return (
      <CrewProvider servers={undefined}>
        <Composer ref={handle} {...PROPS} {...over} />
      </CrewProvider>
    );
  }
  render(<RouterProvider router={createMemoryRouter([{ path: "/", element: <Harness /> }])} />);
  return { update: (next: Partial<ComponentProps<typeof Composer>>) => update(next) };
}

function field(): HTMLTextAreaElement {
  // SAFETY: the composer's field is a textarea.
  return screen.getAllByRole("textbox").find((box) => box.tagName === "TEXTAREA") as HTMLTextAreaElement;
}

/** The bridge, held until the test lets it give `answer`. */
function holdBridge(answer: (id: string) => object | Response) {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  const ids: string[] = [];
  server.use(
    http.post("/api/send", async ({ request }) => {
      // SAFETY: the composer posts a SendRequestBody, which has an id.
      const body = (await request.json()) as { id: string };
      ids.push(body.id);
      await opened;
      const out = answer(body.id);
      return out instanceof Response ? out : HttpResponse.json(out);
    }),
  );
  return { release: () => act(async () => open()), ids };
}

const sendEnded = () => waitFor(() => expect(document.querySelector("[data-slot='composer-primary'] .animate-spin")).toBeNull());

describe("a send of the box lets go at the tap (M104)", () => {
  it("empties the box at the tap, puts the line in Chat as sending, and keeps the stored draft until the end", async () => {
    const user = userEvent.setup();
    const bridge = holdBridge((id) => sendAnswer(id, "sent"));
    mount();
    await user.type(field(), "carry on");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(bridge.ids).toHaveLength(1));
    expect(field().value).toBe("");
    expect(pendingLines(KEY).map((line) => [line.text, line.state])).toEqual([["carry on", "sending"]]);
    // A reload now still finds the text: nothing is lost before the answer.
    expect(loadDraft(undefined, "w1:p1")).toBe("carry on");
    await bridge.release();
    await sendEnded();
    expect(pendingLines(KEY).map((line) => line.state)).toEqual(["sent"]);
    expect(loadDraft(undefined, "w1:p1") ?? "").toBe("");
    // "Sent" stands beside the session's name, never in its place.
    expect(currentStatus()?.beside).toBe(true);
  });

  it("puts the text back into an empty box on a refusal, with the line gone from Chat", async () => {
    const user = userEvent.setup();
    const bridge = holdBridge((id) => sendAnswer(id, "refused", "busy", { offers: ["keys"] }));
    mount();
    await user.type(field(), "carry on");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(bridge.ids).toHaveLength(1));
    await bridge.release();
    await sendEnded();
    expect(field().value).toBe("carry on");
    expect(pendingLines(KEY)).toEqual([]);
  });

  it("a lost answer puts the text back with its request id, so the next tap asks under the same id", async () => {
    const user = userEvent.setup();
    const bridge = holdBridge(() => HttpResponse.json({ error: "boom" }, { status: 500 }));
    mount();
    await user.type(field(), "carry on");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(bridge.ids).toHaveLength(1));
    await bridge.release();
    await sendEnded();
    expect(field().value).toBe("carry on");
    expect(loadIntent(undefined, "w1:p1")?.requestId).toBe(bridge.ids[0]);
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(bridge.ids).toHaveLength(2));
    expect(bridge.ids[1]).toBe(bridge.ids[0]);
  });

  it("never touches a new text typed meanwhile: the sent one waits beside the notice, and Put back waits for an empty box", async () => {
    const user = userEvent.setup();
    const bridge = holdBridge((id) => sendAnswer(id, "refused", "busy", { offers: ["keys"] }));
    mount();
    await user.type(field(), "carry on");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(bridge.ids).toHaveLength(1));
    fireEvent.change(field(), { target: { value: "a new thought" } });
    await bridge.release();
    await sendEnded();
    expect(field().value).toBe("a new thought");
    expect(screen.getByText("Not sent, kept here: carry on")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Put back" }));
    // Never merged, never over the new text: the tap says what to do first.
    expect(field().value).toBe("a new thought");
    expect(screen.getByText("Empty the box first, then tap Put back.")).toBeInTheDocument();
    fireEvent.change(field(), { target: { value: "" } });
    await user.click(screen.getByRole("button", { name: "Put back" }));
    expect(field().value).toBe("carry on");
    await waitFor(() => expect(screen.queryByText("Not sent, kept here: carry on")).toBeNull());
  });

  it("hands a held send's line over to the held row in the render that row arrives", async () => {
    const user = userEvent.setup();
    const bridge = holdBridge((id) => sendAnswer(id, "held"));
    const m = mount();
    await user.type(field(), "carry on");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(bridge.ids).toHaveLength(1));
    await bridge.release();
    await sendEnded();
    expect(pendingLines(KEY).map((line) => line.handover)).toEqual([true]);
    const row: HeldRow = { requestId: bridge.ids[0]!, mode: "send", text: "carry on", heldAt: Date.now(), expiresAt: Date.now() + 60_000, state: "held" };
    m.update({ held: [row] });
    expect(pendingLines(KEY)).toEqual([]);
  });

  it("gives a shell line and a command no line in Chat, and still empties the box at the tap", async () => {
    const user = userEvent.setup();
    const bridge = holdBridge((id) => sendAnswer(id, "sent"));
    mount();
    await user.type(field(), "/compact");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(bridge.ids).toHaveLength(1));
    expect(field().value).toBe("");
    expect(pendingLines(KEY)).toEqual([]);
    await bridge.release();
    await sendEnded();
    cleanup();
    __resetPending();
    const shell = holdBridge((id) => sendAnswer(id, "sent"));
    mount({ isShell: true, agent: undefined });
    await user.type(field(), "ls -la");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(shell.ids).toHaveLength(1));
    expect(field().value).toBe("");
    expect(pendingLines(KEY)).toEqual([]);
    await shell.release();
    await sendEnded();
  });

  it("a sign-in code never gets a line in Chat and is never held", async () => {
    const user = userEvent.setup();
    server.use(...sendHandler((request) => sendAnswer(request.id, "refused", "busy", { offers: ["keys"] })));
    mount({ surface: { ...FREE, revision: 4, field: "secret" } });
    await user.type(screen.getByRole("textbox", { name: "Sign-in code" }), "FAKEcode1234");
    await user.click(screen.getByRole("button", { name: "Send the code" }));
    await waitFor(() => expect(recordedSends()).toHaveLength(1));
    await sendEnded();
    expect(pendingLines(KEY)).toEqual([]);
    expect(document.querySelector("[data-slot='composer-held-back']")).toBeNull();
    expect(loadDraft(undefined, "w1:p1") ?? "").not.toContain("FAKEcode1234");
    // Nor is it ever stored where Put back keeps its texts (the M102 review 3).
    expect(loadPutBack(undefined, "w1:p1")).toEqual([]);
    expect(JSON.stringify({ ...localStorage })).not.toContain("FAKEcode1234");
  });
});

// The M102 review 3 of the Put back road: it never loses a text. An open Undo window counts as a draft, the notice holds
// every text that waits (newest first), and the list is stored with the pane's draft.
describe("Put back never loses a text (the M102 review 3)", () => {
  const kept = () => document.querySelector("[data-slot='composer-held-back']");

  it("an open Undo window counts as a draft: a text that comes back waits on Put back, and Undo still brings the draft back", async () => {
    const user = userEvent.setup();
    const handle = createRef<ComposerHandle>();
    mount({}, handle);
    await user.type(field(), "my draft");
    await user.click(screen.getByRole("button", { name: "Clear message" }));
    expect(field().value).toBe("");
    // The queued card's refused text comes back while the Undo window is open.
    act(() => handle.current?.keepLine("card words"));
    expect(field().value).toBe("");
    expect(kept()).toHaveTextContent("Not sent, kept here: card words");
    await user.click(screen.getByRole("button", { name: "Undo clear" }));
    expect(field().value).toBe("my draft");
    expect(kept()).toHaveTextContent("Not sent, kept here: card words");
  });

  it("two texts that come back while the box holds a draft both wait: the newest shows with the count, and Put back brings the next", async () => {
    const user = userEvent.setup();
    const handle = createRef<ComposerHandle>();
    const bridge = holdBridge((id) => sendAnswer(id, "refused", "busy", { offers: ["keys"] }));
    mount({}, handle);
    await user.type(field(), "carry on");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(bridge.ids).toHaveLength(1));
    fireEvent.change(field(), { target: { value: "a new thought" } });
    act(() => handle.current?.keepLine("card words"));
    expect(kept()).toHaveTextContent("Not sent, kept here: card words");
    // The running send fails too: its text joins the list, and the card's text is still there.
    await bridge.release();
    await sendEnded();
    expect(kept()).toHaveTextContent("Not sent, kept here: carry on");
    expect(screen.getByText("2 texts wait here. This is the newest.")).toBeInTheDocument();
    fireEvent.change(field(), { target: { value: "" } });
    await user.click(screen.getByRole("button", { name: "Put back" }));
    expect(field().value).toBe("carry on");
    expect(kept()).toHaveTextContent("Not sent, kept here: card words");
    expect(screen.queryByText(/texts wait here/u)).toBeNull();
    fireEvent.change(field(), { target: { value: "" } });
    await user.click(screen.getByRole("button", { name: "Put back" }));
    expect(field().value).toBe("card words");
    await waitFor(() => expect(kept()).toBeNull());
  });

  it("is stored with the pane's draft: a remount shows it again, another pane never does, and the device wipe takes it", async () => {
    const user = userEvent.setup();
    const handle = createRef<ComposerHandle>();
    mount({}, handle);
    await user.type(field(), "my draft");
    act(() => handle.current?.keepLine("card words"));
    expect(kept()).toHaveTextContent("Not sent, kept here: card words");
    expect(loadPutBack(undefined, "w1:p1").map((item) => item.draft)).toEqual(["card words"]);
    cleanup();
    mount();
    expect(kept()).toHaveTextContent("Not sent, kept here: card words");
    cleanup();
    mount({ paneId: "w1:p2" });
    expect(kept()).toBeNull();
    clearAllDrafts();
    expect(loadPutBack(undefined, "w1:p1")).toEqual([]);
  });
});

