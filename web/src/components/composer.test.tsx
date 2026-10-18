import { useState } from "react";
import type { ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";

import { clearStatus, useStatus } from "@/lib/status";
import { isReloadHeld, __resetReloadGuard } from "@/lib/reload-guard";
import { loadDraft, loadDraftEntry, saveDraft } from "@/lib/drafts";
import { __resetOperatorCommands } from "@/lib/operator-config";
import { server } from "@/test/setup";
import { fixtureServers, recordedSends, sendAnswer, sendHandler, type SentRequest } from "@/test/handlers";
import { CrewProvider } from "./crew-provider";
import { Composer } from "./composer";
import { addRow, chordKey, DEFAULT_BOARD, setCell } from "@/lib/key-board";
import { resetKeyBoard, setKeyBoard } from "@/lib/key-board-store";
import { type ServerSummary } from "@/lib/types";
import type { Surface } from "@/lib/surface/surface";
import { asJsonObject } from "@/lib/json";
import { markLive } from "@/lib/liveness";
import { beginCatchUp, endCatchUp, setLocked } from "@/lib/idle";
import { offersFor, SEND_REASONS, type SendReason } from "@/lib/surface/send";
import { WAY_OUT_STATES, type WayOutState } from "@/lib/way-out";
import { wayOutCase } from "@/test/way-out-states";

// M46 spec 11 turns every send off for a pane the bridge has not answered lately (lib/liveness.ts).
// These suites drive sends against a mocked network and never poll first, so they pin the pane live;
// the gating itself is covered by liveness.test.ts and the *-offline suites.
vi.mock("@/lib/liveness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/liveness")>()),
  isLive: () => true,
  useLive: () => true,
}));

// Every text the composer sends is ONE Send Protocol request (M56 spec 06): the bridge types, checks
// the box and presses Enter itself, and answers with a receipt. The fake bridge (test/handlers.ts)
// records the request and answers `sent`; this helper also calls back with the text as "typed" and
// then "submitted", so a test can say what reached the pane in the words it always used. `answer`
// overrides the receipt.
function replyHandler(
  onTyped: (text: string) => void,
  onSubmit?: () => void,
  answer: (request: SentRequest) => ReturnType<typeof sendAnswer> = (request) => sendAnswer(request.id, "sent"),
) {
  return sendHandler((request) => {
    onTyped(request.text);
    const body = answer(request);
    if (asJsonObject(body.receipt)?.outcome === "sent") onSubmit?.();
    return body;
  });
}

/** The Surface of a free box: idle, no modal, an empty composer. The default of every render here. */
const FREE: Surface = { revision: 1, turn: "idle", modal: "none", composer: "empty" };
/** A modal ask of each kind, the shape the bridge folds a read dialog into. */
const askOf = (kind: "menu" | "permission" | "question"): Surface => ({
  revision: 2,
  turn: "idle",
  modal: { ask: { id: `ask-${kind}`, kind, options: [{ id: "1", label: "Yes" }, { id: "2", label: "No" }], channel: "keys", hash: "0a1b2c" } },
  composer: "unknown",
});
const ASK_MENU = askOf("menu");

/**
 * A footer strip whose condition has just lifted.
 *
 * Every in-flow strip in this composer arrives and leaves through `ui/collapse.tsx` (DESIGN.md §1),
 * which HOLDS its last child for the 240ms exit so the box slides shut on the words that explain it
 * rather than on nothing. So "gone" is two frames, not one: still in the tree, inside a `Collapse`
 * whose `data-state` is `closed`. A bare `not.toBeInTheDocument()` on the tick after the tap is the
 * assertion that would pass again if someone reverted the wrapper — it says "torn out of the flow",
 * which is the exact fault the wrapper exists to stop.
 *
 * jsdom runs no transitions and measures no heights, so the state attribute is the thing there IS to
 * read; the height half is CSS (`grid-rows-[0fr]`) and `collapse.test.tsx` pins that.
 */
function expectLeaving(el: HTMLElement | null) {
  if (el === null) return; // the exit already finished and it unmounted — also gone
  const row = el.closest('[data-slot="collapse"]');
  expect(row).not.toBeNull();
  expect(row!.getAttribute("data-state")).toBe("closed");
}

// Composer owns the send flow (draft → api.sendReply → clear/error) plus the destructive-command
// two-tap guard. It uses useRevalidator, so it needs a data router like AgentChat's tests.

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => clearStatus());

function renderComposer(overrides: Partial<ComponentProps<typeof Composer>> = {}) {
  const props: ComponentProps<typeof Composer> = {
    paneId: "w1:p1",
    agent: "claude",
    isShell: false,
    gone: false,
    readOnly: false,
    surface: FREE,
    text: "pane output",
    terminalDraft: null,
    rawTerminalDraft: null,
    prefs: { wrap: true, fontSize: 11, draftFontSize: 14, chatFontSize: 14, fontFamily: "system", rawTerminal: false, tapToFocus: true, expandClippedReply: true },
    display: { open: false, onToggle: vi.fn() },
    onSent: vi.fn(),
    ...overrides,
  };
  const router = createMemoryRouter([{ path: "/", element: <Composer {...props} /> }]);
  render(<RouterProvider router={router} />);
  return props;
}

function ComposerForReload() {
  return (
    <Composer
      paneId="w1:p1"
      agent="claude"
      isShell={false}
      gone={false}
      readOnly={false}
      surface={FREE}
      text="pane output"
      terminalDraft={null}
      rawTerminalDraft={null}
      prefs={{ wrap: true, fontSize: 11, draftFontSize: 14, chatFontSize: 14, fontFamily: "system", rawTerminal: false, tapToFocus: true, expandClippedReply: true }}
      display={{ open: false, onToggle: vi.fn() }}
      onSent={vi.fn()}
    />
  );
}

function StatusSentinel() {
  const status = useStatus();
  return <div data-testid="status">{status?.text ?? ""}</div>;
}

/** renderComposer + the status sentinel, for cases that assert on the status line. `servers` opts
 *  the render into a crew (default: solo, i.e. no host chrome and no host in any copy). */
function renderComposerWithStatus(
  overrides: Partial<ComponentProps<typeof Composer>> = {},
  servers?: ServerSummary[],
) {
  const props: ComponentProps<typeof Composer> = {
    paneId: "w1:p1",
    agent: "claude",
    isShell: false,
    gone: false,
    readOnly: false,
    surface: FREE,
    text: "pane output",
    terminalDraft: null,
    rawTerminalDraft: null,
    prefs: { wrap: true, fontSize: 11, draftFontSize: 14, chatFontSize: 14, fontFamily: "system", rawTerminal: false, tapToFocus: true, expandClippedReply: true },
    display: { open: false, onToggle: vi.fn() },
    onSent: vi.fn(),
    ...overrides,
  };
  const router = createMemoryRouter([
    {
      path: "/",
      element: (
        <CrewProvider servers={servers}>
          <StatusSentinel />
          <Composer {...props} />
        </CrewProvider>
      ),
    },
  ]);
  const { container } = render(<RouterProvider router={router} />);
  lastContainer = container;
  return props;
}

let lastContainer: HTMLElement | null = null;

/** `renderComposerWithStatus`, plus the render's own container to query (DESIGN.md §9). */
function renderWithContainer(overrides: Partial<ComponentProps<typeof Composer>> = {}) {
  const props = renderComposerWithStatus(overrides);
  return { props, container: lastContainer! };
}

describe("Composer: keyboard hints on the field (issue 465)", () => {
  it("turns correction and spell check off on a shell pane and keeps autoCapitalize none", () => {
    renderComposer({ isShell: true, agent: undefined });
    const box = screen.getByPlaceholderText(/shell command/i);
    expect(box).toHaveAttribute("autocapitalize", "none");
    expect(box).toHaveAttribute("autocorrect", "off");
    expect(box).toHaveAttribute("spellcheck", "false");
  });

  it("leaves correction and spell check at the keyboard default on an agent pane", () => {
    renderComposer();
    const box = screen.getByRole("textbox");
    expect(box).toHaveAttribute("autocapitalize", "none");
    expect(box).not.toHaveAttribute("autocorrect");
    expect(box).not.toHaveAttribute("spellcheck");
  });
});

describe("Composer — send", () => {
  it("sends non-destructive input on the first tap and clears the draft", async () => {
    const user = userEvent.setup();
    const props = renderComposer();
    const box = screen.getByPlaceholderText(/type a reply/i);

    await user.type(box, "looks good");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(box).toHaveValue(""));
    expect(props.onSent).toHaveBeenCalled();
  });

  // The phone reads nothing before a send and sends no key of its own (M56 spec 06): no pre-flight
  // read, no sweep of a stranded draft, no submit key. One request, and the bridge does the rest.
  it("sends one Send Protocol request and nothing else, stranded draft or not", async () => {
    const user = userEvent.setup();
    const wire: string[] = [];
    server.events.on("request:start", ({ request }) => {
      wire.push(`${request.method} ${new URL(request.url).pathname}`);
    });
    try {
      renderComposerWithStatus({ terminalDraft: null, rawTerminalDraft: "leftover" });
      const box = screen.getByPlaceholderText(/type a reply/i);

      await user.type(box, "hello there");
      await user.click(screen.getByRole("button", { name: "Send" }));

      await waitFor(() => expect(box).toHaveValue(""));
      expect(wire).toEqual(["POST /api/send"]);
      expect(recordedSends()).toEqual([{ id: expect.any(String), pane: "w1:p1", text: "hello there", mode: "send" }]);
    } finally {
      server.events.removeAllListeners();
    }
  });

  it("sequential sends with no stranded draft do not call keys before reply", async () => {
    const user = userEvent.setup();
    const callLog: string[] = [];
    server.use(
      http.post(/\/api\/pane\/[^/]+\/keys$/, async () => {
        callLog.push("keys");
        return HttpResponse.json({ ok: true });
      }),
      ...replyHandler(
        (typed) => callLog.push(`reply:${typed}`),
        () => callLog.push("submit"),
      ),
    );
    renderComposer();
    const box = screen.getByPlaceholderText(/type a reply/i);

    await user.type(box, "first");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(callLog).toContain("reply:first"));
    // The second send waits for the first answer, as sequential human taps do.
    await waitFor(() => expect(callLog).toContain("submit"));

    await user.type(box, "second");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(callLog).toContain("reply:second"));

    expect(callLog.filter((e) => e.startsWith("reply:"))).toEqual(["reply:first", "reply:second"]);
    expect(callLog).not.toContain("keys");
  });

  it("keeps the draft and offers Submit or Discard when the text was typed and not submitted", async () => {
    const user = userEvent.setup();
    server.use(...sendHandler((request) => sendAnswer(request.id, "typed_not_submitted", "modal_cue", { offers: ["submit", "discard", "keys"] })));
    const props: ComponentProps<typeof Composer> = {
      paneId: "w1:p1",
      agent: "claude",
      isShell: false,
      gone: false,
      readOnly: false,
      surface: FREE,
      text: "pane output",
      terminalDraft: null,
      rawTerminalDraft: null,
      prefs: { wrap: true, fontSize: 11, draftFontSize: 14, chatFontSize: 14, fontFamily: "system", rawTerminal: false, tapToFocus: true, expandClippedReply: true },
      display: { open: false, onToggle: vi.fn() },
      onSent: vi.fn(),
    };
    const router = createMemoryRouter([
      {
        path: "/",
        element: (
          <>
            <StatusSentinel />
            <Composer {...props} />
          </>
        ),
      },
    ]);
    render(<RouterProvider router={router} />);
    const box = screen.getByPlaceholderText(/type a reply/i);

    await user.type(box, "almost sent");
    await user.click(screen.getByRole("button", { name: "Send" }));

    // The outcome is at the thumb (M56 spec 07), and the header holds nothing for the person to act on.
    expect(await screen.findByText(/Enter was not pressed/i)).toBeInTheDocument();
    expect(screen.getByTestId("status").textContent).toBe("");
    expect(box).toHaveValue("almost sent");
    expect(screen.getByRole("button", { name: "Submit" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Discard" })).toBeInTheDocument();
    // The person's next look is the pane, so the mirror snaps to the tail; the draft stays.
    expect(props.onSent).toHaveBeenCalled();
  });
});

// ── THE SURFACE TABLE (M56 spec 06) ───────────────────────────────────────────────────────────────
//
// The composer's Send slot is a pure function of the pane's Surface and three facts (gone, read-only,
// offline), in lib/send-slot.ts. One row per Surface row of the M56 README's composer table: what the
// slot and the placeholder say, and what one tap sends. The bridge's answer to a tap is faked per row
// the way the Send Protocol answers on that screen (bridge/surface/protocol.ts).
describe("Composer: the Surface table (M56 spec 06)", () => {
  const UNREADABLE: Surface = { revision: 3, turn: "idle", modal: "unreadable", composer: "empty" };
  const NO_MATCH: Surface = { revision: 3, turn: "unknown", modal: "unknown", composer: "unknown", reason: "no-match" };
  const STALE: Surface = { revision: 3, turn: "unknown", modal: "unknown", composer: "unknown", reason: "stale" };
  const RUNNING: Surface = { revision: 3, turn: "running", modal: "none", composer: "empty" };
  const DRAFT: Surface = { revision: 3, turn: "idle", modal: "none", composer: "draft" };
  const UNREACHABLE: Surface = { revision: 3, turn: "unknown", modal: "unknown", composer: "unreachable" };

  async function typeAndSend(words: string) {
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox"), words);
    await user.click(screen.getByRole("button", { name: "Send" }));
    return user;
  }

  it("free: Send is the fast path, one request, and the draft goes", async () => {
    const props = renderComposerWithStatus({ surface: FREE });
    expect(screen.getByPlaceholderText(/type a reply/i)).toBeEnabled();
    await typeAndSend("looks good to me");
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue(""));
    expect(recordedSends().map(({ text, mode }) => ({ text, mode }))).toEqual([{ text: "looks good to me", mode: "send" }]);
    expect(props.onSent).toHaveBeenCalled();
  });

  it("free: a text with a reserved lead goes as a command", async () => {
    renderComposerWithStatus({ surface: FREE });
    await typeAndSend("/compact");
    await waitFor(() => expect(recordedSends()).toHaveLength(1));
    expect(recordedSends()[0]!.mode).toBe("command");
  });

  it("composer draft: the bridge refuses draft_present and the strip offers Add, Replace and Cancel", async () => {
    server.use(...sendHandler((request) => sendAnswer(request.id, "refused", "draft_present", { offers: ["append", "replace", "cancel"], surface: DRAFT })));
    renderComposerWithStatus({ surface: DRAFT });
    await typeAndSend("my message");
    await waitFor(() => expect(screen.getByRole("button", { name: "Add to it" })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Replace" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.getByText(/already holds a draft/i)).toBeInTheDocument();
    expect(screen.getByTestId("status").textContent).toBe("");
    expect(screen.getByRole("textbox")).toHaveValue("my message");
  });

  it.each(["menu", "permission", "question"] as const)("modal ask (%s): the placeholder stays the plain reply line, the slot is Answer the dialog, and a tap sends nothing", async (kind) => {
    const onAnswerDialog = vi.fn();
    renderComposerWithStatus({ surface: askOf(kind), onAnswerDialog });
    const box = screen.getByPlaceholderText("Type a reply…");
    const user = userEvent.setup();
    await user.type(box, "for after the dialog");
    await user.click(screen.getByRole("button", { name: "Answer the dialog" }));
    expect(onAnswerDialog).toHaveBeenCalledTimes(1);
    expect(recordedSends()).toEqual([]);
    expect(box).toHaveValue("for after the dialog");
  });

  it("modal unreadable: two taps, nothing typed on the first, the second commits the rows the person saw", async () => {
    server.use(
      ...sendHandler((request) =>
        request.rowsHash === undefined
          ? sendAnswer(request.id, "refused", "unconfirmed", { offers: ["commit", "keys"], rowsHash: "0f00ba", surface: UNREADABLE, detail: "Collie cannot read this screen. Check the pane, then tap Type here." })
          : sendAnswer(request.id, "sent"),
      ),
    );
    const onAnswerDialog = vi.fn();
    const { container } = renderWithContainer({ surface: UNREADABLE, onAnswerDialog, dialogCard: true });
    // A false overlay hit must never block a send: the field and Send stay as on a free box.
    expect(screen.getByPlaceholderText("Type a reply…")).toBeEnabled();
    const user = await typeAndSend("carry on please");

    await waitFor(() => expect(container.querySelector('[data-slot="composer-refusal"]')).not.toBeNull());
    expect(container.querySelector('[data-slot="composer-refusal"]')).toHaveTextContent(/cannot read this screen.*cannot read was open over the box/i);
    // The phone's sentence says it once: the bridge's same English is not repeated under it.
    expect(container.querySelector('[data-slot="composer-refusal-detail"]')).toBeNull();
    expect(screen.getByRole("textbox")).toHaveValue("carry on please");
    // Its control goes to the card, the same way the Answer the dialog word does.
    await user.click(screen.getByRole("button", { name: "Answer the dialog" }));
    expect(onAnswerDialog).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Type here" }));
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue(""));
    expect(recordedSends().map(({ text, mode, rowsHash }) => ({ text, mode, rowsHash }))).toEqual([
      { text: "carry on please", mode: "send", rowsHash: undefined },
      { text: "carry on please", mode: "send", rowsHash: "0f00ba" },
    ]);
  });

  it("turn running: Send asks the bridge, which refuses, and the notice says the agent was working", async () => {
    server.use(...sendHandler((request) => sendAnswer(request.id, "refused", "not_free", { offers: ["keys"], surface: RUNNING, detail: "The input box is not free." })));
    const { container } = renderWithContainer({ surface: RUNNING });
    await typeAndSend("next step please");
    await waitFor(() => expect(container.querySelector('[data-slot="composer-refusal"]')).toHaveTextContent(/not free.*agent was working/i));
    expect(screen.getByRole("textbox")).toHaveValue("next step please");
    // No card to go to: the notice carries no control.
    expect(screen.queryByRole("button", { name: "Answer the dialog" })).toBeNull();
  });

  it("unknown (no-match): the probed Send, two taps, with no card to go to", async () => {
    server.use(
      ...sendHandler((request) =>
        request.rowsHash === undefined
          ? sendAnswer(request.id, "refused", "unconfirmed", { offers: ["commit", "keys"], rowsHash: "77aa00", surface: NO_MATCH })
          : sendAnswer(request.id, "sent"),
      ),
    );
    const { container } = renderWithContainer({ surface: NO_MATCH });
    const user = await typeAndSend("ls -la");
    await waitFor(() => expect(container.querySelector('[data-slot="composer-refusal"]')).toHaveTextContent(/could not find the input box/i));
    expect(screen.queryByRole("button", { name: "Answer the dialog" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Type here" }));
    await waitFor(() => expect(recordedSends()).toHaveLength(2));
    expect(recordedSends()[1]!.rowsHash).toBe("77aa00");
  });

  it.each([
    ["stale", /too old/i],
    ["contested", /did not agree/i],
    ["torn", /changed while Collie read it/i],
  ] as const)("unknown (%s): Send asks for a fresh read, and the notice names the reason", async (reason, words) => {
    const surface: Surface = { ...STALE, reason };
    server.use(...sendHandler((request) => sendAnswer(request.id, "refused", "bound", { surface })));
    const { container } = renderWithContainer({ surface });
    await typeAndSend("are you there");
    await waitFor(() => expect(container.querySelector('[data-slot="composer-refusal"]')).toHaveTextContent(words));
    expect(container.querySelector('[data-slot="composer-refusal"]')).toHaveTextContent(/did not hold still/i);
  });

  it("composer unreachable: the field is locked and names the reason; nothing can be sent", () => {
    renderComposerWithStatus({ surface: UNREACHABLE, unreachableNote: "workshop is not answering the lead" });
    const box = screen.getByPlaceholderText("workshop is not answering the lead");
    expect(box).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("composer unreachable with no note says the box cannot be reached", () => {
    renderComposerWithStatus({ surface: UNREACHABLE });
    expect(screen.getByPlaceholderText("Can't reach the input box")).toBeDisabled();
  });

  it("the facts outrank every row: a gone pane and a read-only device lock the field, even over an ask", () => {
    renderComposerWithStatus({ surface: ASK_MENU, gone: true });
    expect(screen.getByPlaceholderText("Pane is gone")).toBeDisabled();
    cleanup();
    renderComposerWithStatus({ surface: ASK_MENU, readOnly: true });
    expect(screen.getByPlaceholderText(/read-only/i)).toBeDisabled();
  });

  it("offline: the field stays typeable, Send waits for a live read", async () => {
    renderComposerWithStatus({ surface: FREE, stale: true });
    const user = userEvent.setup();
    const box = screen.getByPlaceholderText(/type a reply/i);
    await user.type(box, "later");
    expect(box).toHaveValue("later");
    expect(screen.getByRole("button", { name: "Reconnect to send" })).toBeDisabled();
    expect(recordedSends()).toEqual([]);
  });
});

// A dialog a grammar READ owns the agent's keyboard. The refusal used to live only in the header
// StatusArea, which a phone has scrolled away or under the keyboard when Send is tapped (field case
// 2026-10-15, ADR 0009). It now stands in the Send slot and the placeholder too. Since M56 spec 06 a
// read dialog is the Surface's `modal ask`, and this is that row of the table (M51 spec 10 folded in).
describe("Composer: a read dialog is refused at the thumb", () => {
  it("replaces Send with an 'Answer the dialog' word once there is a draft", async () => {
    const user = userEvent.setup();
    renderComposerWithStatus({ surface: askOf("permission") });

    await user.type(screen.getByPlaceholderText("Type a reply…"), "for after the dialog");

    const button = screen.getByRole("button", { name: "Answer the dialog" });
    expect(button).toBeEnabled();
    expect(button).toHaveTextContent("Answer the dialog");
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  });

  it("keeps the empty box's own primary action, and the placeholder stays the plain reply line", () => {
    renderComposerWithStatus({ surface: ASK_MENU });

    expect(screen.queryByRole("button", { name: "Answer the dialog" })).toBeNull();
    expect(screen.getByPlaceholderText("Type a reply…")).toBeInTheDocument();
  });

  it.each(["menu", "permission", "question"] as const)("does not name a %s in the placeholder", (kind) => {
    renderComposerWithStatus({ surface: askOf(kind) });

    expect(screen.getByRole("textbox")).toHaveAttribute("placeholder", "Type a reply…");
  });

  it("stays typeable and keeps the draft", async () => {
    const user = userEvent.setup();
    renderComposerWithStatus({ surface: ASK_MENU });
    const box = screen.getByPlaceholderText("Type a reply…");

    await user.type(box, "for after the dialog");

    expect(box).toHaveValue("for after the dialog");
  });

  it("a tap goes to the card and sends no text and no key", async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    server.use(
      http.post(/\/api\/pane\/[^/]+\/keys$/, () => {
        calls.push("keys");
        return HttpResponse.json({ ok: true });
      }),
      ...replyHandler(() => calls.push("reply"), () => calls.push("submit")),
    );
    const onAnswerDialog = vi.fn();
    const props = renderComposerWithStatus({ surface: ASK_MENU, onAnswerDialog });
    const box = screen.getByPlaceholderText("Type a reply…");

    await user.type(box, "for after the dialog");
    await user.click(screen.getByRole("button", { name: "Answer the dialog" }));

    expect(onAnswerDialog).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
    expect(box).toHaveValue("for after the dialog");
    expect(props.onSent).not.toHaveBeenCalled();
  });

  it("the keyboard submit is refused at the phone too: nothing reaches the bridge", async () => {
    const user = userEvent.setup();
    renderComposerWithStatus({ surface: ASK_MENU });
    await user.type(screen.getByPlaceholderText("Type a reply…"), "please do not approve anything");
    await user.keyboard("{Control>}{Enter}{/Control}");
    // Told at the Send slot, not in the header (M56 spec 07): the ask has its own word beside the notice.
    expect(await screen.findByText(/dialog is waiting/i)).toBeInTheDocument();
    expect(screen.getByTestId("status").textContent).toBe("");
    expect(recordedSends()).toEqual([]);
  });

  it("says why at the thumb when the bridge cannot read the screen, and its control goes to the card", async () => {
    const user = userEvent.setup();
    server.use(
      ...sendHandler((request) =>
        sendAnswer(request.id, "refused", "unconfirmed", { offers: ["commit", "keys"], rowsHash: "0abc", surface: { revision: 4, turn: "idle", modal: "unreadable", composer: "empty" } }),
      ),
    );
    const onAnswerDialog = vi.fn();
    const { container } = renderWithContainer({ surface: { revision: 4, turn: "idle", modal: "unreadable", composer: "empty" }, onAnswerDialog, dialogCard: true });

    await user.type(screen.getByPlaceholderText("Type a reply…"), "for after the dialog");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(container.querySelector('[data-slot="composer-refusal"]')).toHaveTextContent(/cannot read this screen/i));
    expect(screen.getByRole("button", { name: "Type here" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Answer the dialog" }));
    expect(onAnswerDialog).toHaveBeenCalledTimes(1);
    // Only the first tap went out, and it typed nothing: the bridge refused before any key.
    expect(recordedSends()).toHaveLength(1);
  });

  // The 2026-10-16 field case on lane 8788: a free box with Claude Code's agents panel under it read
  // unreadable. The notice said its sentence twice, offered a card that was not there, and had no ✕.
  it("an unreadable screen with no dialog card: the sentence once, no Answer the dialog, and a ✕ that hides the notice", async () => {
    const user = userEvent.setup();
    const unreadable = { revision: 4, turn: "idle", modal: "unreadable", composer: "empty" } as const;
    server.use(
      ...sendHandler((request) =>
        sendAnswer(request.id, "refused", "unconfirmed", {
          offers: ["commit", "keys"],
          rowsHash: "0abc",
          surface: unreadable,
          detail: "Collie cannot read this screen. Check the pane, then tap Type here.",
        }),
      ),
    );
    const onAnswerDialog = vi.fn();
    const { container } = renderWithContainer({ surface: unreadable, onAnswerDialog });
    await user.type(screen.getByRole("textbox"), "carry on please");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(container.querySelector('[data-slot="composer-refusal"]')).toHaveTextContent(/cannot read this screen/i));
    expect(container.textContent?.match(/Collie cannot read this screen/g)).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Answer the dialog" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Hide this notice" }));
    await waitFor(() => expect(container.querySelector('[data-slot="composer-refusal"]')).toBeNull());
    // The offers stay: the ✕ hid only the notice.
    expect(screen.getByRole("button", { name: "Type here" })).toBeInTheDocument();

    // The same words over the same screen stay hidden; a send that reads another screen shows again.
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(recordedSends()).toHaveLength(2));
    expect(container.querySelector('[data-slot="composer-refusal"]')).toBeNull();
    server.use(...sendHandler((request) => sendAnswer(request.id, "refused", "unconfirmed", { offers: ["commit", "keys"], rowsHash: "0abd", surface: { ...unreadable, revision: 5 } })));
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(container.querySelector('[data-slot="composer-refusal"]')).toHaveTextContent(/cannot read this screen/i));
  });

  // The review of 2026-10-16: a refusal with no offers has no strip, so a hidden notice would leave
  // the tap with no visible answer. The same refusal on the same still screen shows the notice again.
  it("a hidden notice comes back when a tap meets the same refusal with no offers", async () => {
    const user = userEvent.setup();
    const unreadable = { revision: 4, turn: "idle", modal: "unreadable", composer: "empty" } as const;
    server.use(...sendHandler((request) => sendAnswer(request.id, "refused", "unconfirmed", { surface: unreadable })));
    const { container } = renderWithContainer({ surface: unreadable });
    await user.type(screen.getByRole("textbox"), "carry on please");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(container.querySelector('[data-slot="composer-refusal"]')).toHaveTextContent(/cannot read this screen/i));

    await user.click(screen.getByRole("button", { name: "Hide this notice" }));
    await waitFor(() => expect(container.querySelector('[data-slot="composer-refusal"]')).toBeNull());
    expect(screen.queryByRole("button", { name: "Type here" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(recordedSends()).toHaveLength(2));
    await waitFor(() => expect(container.querySelector('[data-slot="composer-refusal"]')).toHaveTextContent(/cannot read this screen/i));
  });

  it("the offers' ✕ hides the notice with the strip", async () => {
    const user = userEvent.setup();
    const unreadable = { revision: 4, turn: "idle", modal: "unreadable", composer: "empty" } as const;
    server.use(...sendHandler((request) => sendAnswer(request.id, "refused", "unconfirmed", { offers: ["commit", "keys"], rowsHash: "0abc", surface: unreadable })));
    const { container } = renderWithContainer({ surface: unreadable });
    await user.type(screen.getByRole("textbox"), "carry on please");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Type here" })).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Dismiss the send offers" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Type here" })).toBeNull());
    await waitFor(() => expect(container.querySelector('[data-slot="composer-refusal"]')).toBeNull());
  });

  it("draws no refusal notice for a read dialog: its word stands in the Send slot", async () => {
    const user = userEvent.setup();
    const { container } = renderWithContainer({ surface: ASK_MENU });
    await user.type(screen.getByPlaceholderText("Type a reply…"), "for after the dialog");

    expect(container.querySelector('[data-slot="composer-refusal"]')).toBeNull();
  });

  it("leaves an overlay Collie cannot read on the two-tap Send, with the plain placeholder", () => {
    renderComposerWithStatus({ surface: { revision: 4, turn: "idle", modal: "unreadable", composer: "empty" } });

    expect(screen.queryByRole("button", { name: "Answer the dialog" })).toBeNull();
    expect(screen.getByPlaceholderText("Type a reply…")).toBeInTheDocument();
  });
});

// A shell's password prompt never echoes what is typed (#103), so the bridge cannot see a text land
// there. When the bridge refuses a tap over such a screen (the stub below answers `unconfirmed`), the
// composer reads the screen it already shows for the prompt, display only, and says so. A bare shell
// with no profile gets such a refusal only at a password prompt (the bridge runs the same detector);
// anywhere else the bridge types its text and presses Enter blind.
describe("Composer: password prompt", () => {
  const SUDO = "$ sudo systemctl restart collie\n[sudo] password for altan:";
  const SHELL: Surface = { revision: 9, turn: "unknown", modal: "unknown", composer: "unknown", reason: "no-match" };

  function refuseUnconfirmed() {
    server.use(...sendHandler((request) => sendAnswer(request.id, "refused", "unconfirmed", { offers: ["commit", "keys"], rowsHash: "5ad0", surface: SHELL })));
  }

  it("names the prompt and offers Type beside the two-tap Send", async () => {
    const user = userEvent.setup();
    refuseUnconfirmed();
    renderComposerWithStatus({ isShell: true, agent: undefined, surface: SHELL, text: SUDO });
    const box = screen.getByPlaceholderText(/shell command/i);

    await user.type(box, "hunter2hunter2");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(screen.getByText("[sudo] password for altan:")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /use type/i })).toBeInTheDocument();
    // The two-tap Send is untouched: a false positive costs a dismissal, not an action.
    expect(screen.getByRole("button", { name: "Type here" })).toBeInTheDocument();
    expect(recordedSends()).toHaveLength(1);
  });

  it("the bridge's own password-prompt stop on a bare shell (not_free, the key pad only) raises the same notice and drops the draft", async () => {
    const user = userEvent.setup();
    server.use(
      ...sendHandler((request) =>
        sendAnswer(request.id, "refused", "not_free", { offers: ["keys"], surface: SHELL, detail: "A password prompt is waiting on the last row. Collie does not type into it from the text box. Use Type to answer it." }),
      ),
    );
    renderComposerWithStatus({ isShell: true, agent: undefined, surface: SHELL, text: SUDO });
    const box = screen.getByPlaceholderText(/shell command/i);

    await user.type(box, "hunter2hunter2");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(screen.getByText("[sudo] password for altan:")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /use type/i })).toBeInTheDocument();
    expect(loadDraft(undefined, "w1:p1")).toBeNull();
    expect(recordedSends()).toHaveLength(1);
  });

  it("drops the stored draft the moment it recognises the prompt, button or no button", async () => {
    const user = userEvent.setup();
    refuseUnconfirmed();
    renderComposerWithStatus({ isShell: true, agent: undefined, surface: SHELL, text: SUDO });
    const box = screen.getByPlaceholderText(/shell command/i);

    await user.type(box, "hunter2hunter2");
    expect(localStorage.getItem("collie:draft:default:w1:p1")).toContain("hunter2hunter2");

    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByRole("button", { name: /use type/i });
    expect(localStorage.getItem("collie:draft:default:w1:p1")).toBeNull();
    // Through the store's own reader: the draft store has an in-memory tier too (lib/drafts.ts).
    expect(loadDraft(undefined, "w1:p1")).toBeNull();

    await user.click(screen.getByRole("button", { name: /dismiss password-prompt notice/i }));
    expect(box).toHaveValue("hunter2hunter2");
    expect(localStorage.getItem("collie:draft:default:w1:p1")).toBeNull();
  });

  it("the handoff clears the draft before arming Type", async () => {
    const user = userEvent.setup();
    refuseUnconfirmed();
    renderComposerWithStatus({ isShell: true, agent: undefined, surface: SHELL, text: SUDO });
    const box = screen.getByPlaceholderText(/shell command/i);

    await user.type(box, "hunter2hunter2");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await user.click(await screen.findByRole("button", { name: /use type/i }));

    await waitFor(() => expect(screen.getByPlaceholderText(/type into the terminal/i)).toHaveValue(""));
    expect(localStorage.getItem("collie:draft:default:w1:p1")).toBeNull();
    expectLeaving(screen.queryByRole("button", { name: /use type/i }));
  });
});

describe("Composer — typing into the terminal", () => {
  /** The entry point: the named "Type" toggle in the Controls row, beside Keys. */
  function startDirectTyping() {
    fireEvent.click(screen.getByRole("button", { name: /^type into terminal$/i }));
    return screen.getByPlaceholderText(/type into the terminal/i);
  }

  it("focuses the textarea synchronously so the activation gesture opens the phone keyboard", () => {
    renderComposer();

    expect(startDirectTyping()).toHaveFocus();
  });

  // The entry point must be a deliberate press and nothing else: it sits in a row of dock toggles,
  // so it must not send, and it must not leave a half-open dock covering the keyboard it needs.
  it("arms from the Controls row without sending, and closes an open dock", async () => {
    let replyCalls = 0;
    server.use(...replyHandler(() => replyCalls++));
    renderComposer();
    fireEvent.click(screen.getByRole("button", { name: /^keys$/i }));
    expect(screen.getByRole("button", { name: /close keys/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^type into terminal$/i }));

    expect(screen.getByPlaceholderText(/type into the terminal/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /close keys/i })).toBeNull();
    expect(replyCalls).toBe(0);
    expect(screen.getByRole("button", { name: /^type into terminal$/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("shows the armed strip and stops from it", async () => {
    renderComposer();
    startDirectTyping();

    const strip = screen.getByText(/typing into terminal/i);
    expect(strip).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^stop$/i }));

    await waitFor(() =>
      expect(screen.queryByPlaceholderText(/type into the terminal/i)).toBeNull(),
    );
  });

  // The other half of the same rule: the composer locking (pane gone, device demoted to read-only,
  // or the idle pause) means the view is no longer live either.
  it("stops when the composer locks under it", async () => {
    function Harness() {
      const [gone, setGone] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setGone(true)}>
            lock it
          </button>
          <Composer
            paneId="w1:p1"
            agent="claude"
            isShell={false}
            gone={gone}
            readOnly={false}
            surface={FREE}
            text="pane output"
            terminalDraft={null}
            rawTerminalDraft={null}
            prefs={{ wrap: true, fontSize: 11, draftFontSize: 14, chatFontSize: 14, fontFamily: "system", rawTerminal: false, tapToFocus: true, expandClippedReply: true }}
            display={{ open: false, onToggle: vi.fn() }}
            onSent={vi.fn()}
          />
        </>
      );
    }
    const router = createMemoryRouter([{ path: "/", element: <Harness /> }]);
    render(<RouterProvider router={router} />);

    fireEvent.click(screen.getByRole("button", { name: /^type into terminal$/i }));
    expect(screen.getByPlaceholderText(/type into the terminal/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "lock it" }));

    await waitFor(() =>
      expect(screen.queryByPlaceholderText(/type into the terminal/i)).toBeNull(),
    );
  });

  it.each(["idle lock", "catch-up"])("disarms behind the %s cover and never restores automatically", (cover) => {
    renderComposer();
    startDirectTyping();
    try {
      act(() => {
        if (cover === "idle lock") setLocked(true);
        else beginCatchUp();
      });
      expect(screen.queryByPlaceholderText(/type into the terminal/i)).toBeNull();
      // A named choice cannot re-arm while the view is still covered, even if invoked directly.
      fireEvent.click(screen.getByRole("button", { name: /^type into terminal$/i }));
      expect(screen.queryByPlaceholderText(/type into the terminal/i)).toBeNull();
      act(() => {
        setLocked(false);
        endCatchUp();
      });
      expect(screen.getByPlaceholderText(/type a reply/i)).toBeInTheDocument();
      expect(startDirectTyping()).toBeInTheDocument();
    } finally {
      act(() => {
        setLocked(false);
        endCatchUp();
      });
    }
  });

  // The mirror stops tracking the pane when the page is backgrounded, so the next keystroke would
  // go into a terminal the user is not looking at.
  it("stops when the page is hidden", async () => {
    renderComposer();
    startDirectTyping();

    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    fireEvent(document, new Event("visibilitychange"));

    await waitFor(() =>
      expect(screen.queryByPlaceholderText(/type into the terminal/i)).toBeNull(),
    );
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });

  // The disarm above is invisible while the page is hidden — lib/status.ts expires a non-error in
  // 2.5s, so a message published on the way out is gone before anyone can read it. Coming back to a
  // focused field with the mode silently off is how keystrokes meant for the terminal end up in the
  // reply draft instead, so the message has to wait for the return trip.
  it("says the mode stopped once the page comes back", async () => {
    renderComposerWithStatus();
    startDirectTyping();

    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() =>
      expect(screen.queryByPlaceholderText(/type into the terminal/i)).toBeNull(),
    );
    expect(screen.getByTestId("status")).not.toHaveTextContent(/backgrounded/i);

    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent(/stopped typing into the terminal/i),
    );
  });

  // The notice above expires; a focused field does not. Handing the composer back with the keyboard
  // still up is what turns "the mode stopped" into keystrokes buffered as a reply, so the disarm
  // puts the keyboard away — same as the blur on a failed batch.
  it("puts the keyboard away when the page is hidden, rather than leaving the field primed", async () => {
    renderComposerWithStatus();
    const box = startDirectTyping();
    box.focus();
    expect(document.activeElement).toBe(box);

    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(document.activeElement).not.toBe(box));
    expect(screen.queryByPlaceholderText(/type into the terminal/i)).toBeNull();

    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent(/stopped typing into the terminal/i),
    );
    // Still not focused on the way back: the reply field must be entered on purpose.
    expect(document.activeElement).not.toBe(box);
  });

  // The blur above is deferred, so it can outlive the disarm that scheduled it. Re-arming is the
  // ordinary way that happens: you come back, tap Type again, and the old timer must not fire into
  // the session that replaced it and drop the keyboard you just asked for. What prevents it is
  // activate()'s cancelPendingBlur() — remove that one line and this test fails, which is the whole
  // reason it runs the timers by hand instead of waiting them out.
  it("does not blur a re-armed session with the disarm it already superseded", () => {
    renderComposerWithStatus();
    const box = startDirectTyping();
    const blurred = vi.spyOn(box, "blur");

    // Fake timers only for the race itself: the deferred blur must be held, not waited out.
    vi.useFakeTimers();
    try {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      fireEvent(document, new Event("visibilitychange")); // schedules the blur
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      fireEvent(document, new Event("visibilitychange"));
      fireEvent.click(screen.getByRole("button", { name: /^type into terminal$/i })); // re-arm
      // Run the zero-delay blur, and stop well short of the re-armed session's 60s watchdog.
      act(() => vi.advanceTimersByTime(1000));
    } finally {
      vi.useRealTimers();
    }

    expect(blurred).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText(/type into the terminal/i)).toBeInTheDocument();
  });

  // The notice is owed by the pane that was armed, and a pane can change WHILE the page is hidden —
  // a push notification deep-links straight into another one. Delivering it on arrival would tell
  // you the mode stopped on a pane where it was never running.
  it("does not announce the background disarm over a pane it was never armed on", async () => {
    function Harness() {
      const [paneId, setPaneId] = useState("w1:p1");
      return (
        <>
          <StatusSentinel />
          <button type="button" onClick={() => setPaneId("w1:p2")}>
            Switch pane
          </button>
          <Composer
            paneId={paneId}
            agent="claude"
            isShell={false}
            gone={false}
            readOnly={false}
            surface={FREE}
            text="pane output"
            terminalDraft={null}
            rawTerminalDraft={null}
            prefs={{ wrap: true, fontSize: 11, draftFontSize: 14, chatFontSize: 14, fontFamily: "system", rawTerminal: false, tapToFocus: true, expandClippedReply: true }}
            display={{ open: false, onToggle: vi.fn() }}
            onSent={vi.fn()}
          />
        </>
      );
    }
    const router = createMemoryRouter([{ path: "/", element: <Harness /> }]);
    render(<RouterProvider router={router} />);
    startDirectTyping();

    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    fireEvent(document, new Event("visibilitychange"));
    fireEvent.click(screen.getByRole("button", { name: "Switch pane" }));
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    fireEvent(document, new Event("visibilitychange"));

    await waitFor(() => expect(screen.getByPlaceholderText(/type a reply/i)).toBeInTheDocument());
    expect(screen.getByTestId("status")).not.toHaveTextContent(/backgrounded/i);
  });

  // AltanS #379: the mode belongs to the session that armed it. When the
  // agent under the pane changes (exit to shell), the mode disarms with a
  // notice instead of streaming into the stranger. Mounting with an agent
  // already set is not a change — no disarm, no notice.
  it("disarms with a notice when the pane's agent changes", async () => {
    function Harness() {
      const [agent, setAgent] = useState<string | undefined>("claude");
      return (
        <>
          <StatusSentinel />
          <button type="button" onClick={() => setAgent(undefined)}>
            agent exits
          </button>
          <Composer
            paneId="w1:p1"
            agent={agent}
            isShell={false}
            gone={false}
            readOnly={false}
            surface={FREE}
            text="pane output"
            terminalDraft={null}
            rawTerminalDraft={null}
            prefs={{ wrap: true, fontSize: 11, draftFontSize: 14, chatFontSize: 14, fontFamily: "system", rawTerminal: false, tapToFocus: true, expandClippedReply: true }}
            display={{ open: false, onToggle: vi.fn() }}
            onSent={vi.fn()}
          />
        </>
      );
    }
    const router = createMemoryRouter([{ path: "/", element: <Harness /> }]);
    render(<RouterProvider router={router} />);
    startDirectTyping();
    expect(screen.getByPlaceholderText(/type into the terminal/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "agent exits" }));

    await waitFor(() =>
      expect(screen.queryByPlaceholderText(/type into the terminal/i)).toBeNull(),
    );
    expect(screen.getByTestId("status")).toHaveTextContent(/agent changed/i);
  });

  // Same pane, same agent, a minute without a key: the mode disarms with a
  // notice. The clock starts at the arming, because arming and then typing
  // chat after the agent exited is the trap. A keystroke at 59s restarts it,
  // so only 60s of true silence fires. Fake timers: the watchdog is the only
  // clock under test.
  it("disarms after 60 seconds without a keystroke, restarted by activity", async () => {
    server.use(
      http.post<never, { keys: string[] }>(/\/api\/pane\/[^/]+\/keys$/, async () => {
        return HttpResponse.json({ ok: true });
      }),
    );
    renderComposerWithStatus();
    vi.useFakeTimers();
    const box = startDirectTyping();
    try {
      act(() => vi.advanceTimersByTime(59_000));
      expect(screen.getByPlaceholderText(/type into the terminal/i)).toBeInTheDocument();
      fireEvent.change(box, { target: { value: "y" } });
      act(() => vi.advanceTimersByTime(59_000));
      expect(screen.getByPlaceholderText(/type into the terminal/i)).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(1000));
    } finally {
      vi.useRealTimers();
    }

    await waitFor(() =>
      expect(screen.queryByPlaceholderText(/type into the terminal/i)).toBeNull(),
    );
    expect(screen.getByTestId("status")).toHaveTextContent(/no key for 60 seconds/i);
  });

  it("disarms an armed mode that was never touched after 60 seconds", async () => {
    renderComposerWithStatus();
    vi.useFakeTimers();
    startDirectTyping();
    try {
      act(() => vi.advanceTimersByTime(59_000));
      expect(screen.getByPlaceholderText(/type into the terminal/i)).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(1000));
    } finally {
      vi.useRealTimers();
    }

    await waitFor(() =>
      expect(screen.queryByPlaceholderText(/type into the terminal/i)).toBeNull(),
    );
    expect(screen.getByTestId("status")).toHaveTextContent(/no key for 60 seconds/i);
  });

  it("sends committed keyboard text as literal ordered keys with no implicit Enter", async () => {
    const keyCalls: string[][] = [];
    let replyCalls = 0;
    server.use(
      http.post<never, { keys: string[] }>(/\/api\/pane\/[^/]+\/keys$/, async ({ request }) => {
        keyCalls.push((await request.json()).keys);
        return HttpResponse.json({ ok: true });
      }),
      ...replyHandler(() => replyCalls++),
    );
    // Type into terminal writes raw keys, so a modal ask does not stop it.
    renderComposerWithStatus({ surface: ASK_MENU });

    const box = startDirectTyping();
    expect(screen.getByRole("button", { name: /^type into terminal$/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.change(box, { target: { value: "b a" } });

    await waitFor(() => expect(keyCalls).toEqual([["b", "Space", "a"]]));
    expect(keyCalls.flat()).not.toContain("Enter");
    expect(replyCalls).toBe(0);
    expect(box).toHaveValue("");
    expect(screen.getByTestId("status")).toHaveTextContent(/typing into the terminal/i);
  });

  it("sends a swiped/IME-composed word once when composition commits", async () => {
    const keyCalls: string[][] = [];
    server.use(
      http.post<never, { keys: string[] }>(/\/api\/pane\/[^/]+\/keys$/, async ({ request }) => {
        keyCalls.push((await request.json()).keys);
        return HttpResponse.json({ ok: true });
      }),
    );
    renderComposer();
    const box = startDirectTyping();

    fireEvent.compositionStart(box);
    fireEvent.input(box, {
      target: { value: "swipe" },
      data: "swipe",
      inputType: "insertCompositionText",
      isComposing: true,
    });
    expect(keyCalls).toEqual([]);
    fireEvent.compositionEnd(box, { data: "swipe" });

    await waitFor(() => expect(keyCalls).toEqual([["s", "w", "i", "p", "e"]]));
    // Gboard may emit the committed value once more as an ordinary input after compositionend.
    fireEvent.input(box, {
      target: { value: "swipe" },
      data: "swipe",
      inputType: "insertText",
      isComposing: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(keyCalls).toEqual([["s", "w", "i", "p", "e"]]);
  });

  it("sends terminal keys that do not change the textarea value", async () => {
    const keyCalls: string[][] = [];
    server.use(
      http.post<never, { keys: string[] }>(/\/api\/pane\/[^/]+\/keys$/, async ({ request }) => {
        keyCalls.push((await request.json()).keys);
        return HttpResponse.json({ ok: true });
      }),
    );
    renderComposer();
    const box = startDirectTyping();

    fireEvent.keyDown(box, { key: "Backspace" });
    await waitFor(() => expect(keyCalls).toEqual([["Backspace"]]));
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(keyCalls).toEqual([["Backspace"], ["Enter"]]));

    // Android can omit keydown for its virtual Backspace and expose only beforeinput.
    fireEvent(
      box,
      new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "deleteContentBackward",
      }),
    );
    await waitFor(() =>
      expect(keyCalls).toEqual([["Backspace"], ["Enter"], ["Backspace"]]),
    );

    // Gboard can mark its virtual Enter as composing while it commits the current candidate.
    fireEvent(
      box,
      new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertParagraph",
        isComposing: true,
      }),
    );
    await waitFor(() =>
      expect(keyCalls).toEqual([["Backspace"], ["Enter"], ["Backspace"], ["Enter"]]),
    );
  });

  it("exits on a tap of the highlighted keyboard button", async () => {
    const user = userEvent.setup();
    renderComposer();
    const box = startDirectTyping();

    fireEvent.blur(box); // dismissing the Android keyboard does not silently disarm the mode
    expect(screen.getByPlaceholderText(/type into the terminal/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /stop typing into terminal/i }));

    expect(screen.getByPlaceholderText(/type a reply/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("stops direct typing when a key batch is refused", async () => {
    server.use(
      http.post(/\/api\/pane\/[^/]+\/keys$/, () =>
        HttpResponse.json({ ok: false, error: "pane unavailable" }, { status: 500 }),
      ),
    );
    renderComposerWithStatus();
    const box = startDirectTyping();

    fireEvent.change(box, { target: { value: "b" } });

    const replyBox = await screen.findByPlaceholderText(/type a reply/i);
    await waitFor(() => expect(replyBox).not.toHaveFocus());
    expect(screen.getByTestId("status")).toHaveTextContent(/pane unavailable/i);
  });

  it("refuses activation while a buffered reply exists", async () => {
    const user = userEvent.setup();
    renderComposerWithStatus();
    const box = screen.getByPlaceholderText(/type a reply/i);
    await user.type(box, "keep this draft");

    // The refusal belongs on the named choice, where there is somewhere to explain it.
    fireEvent.click(screen.getByRole("button", { name: /^type into terminal$/i }));

    expect(screen.getByPlaceholderText(/type a reply/i)).toHaveValue("keep this draft");
    expect(screen.queryByPlaceholderText(/type into the terminal/i)).not.toBeInTheDocument();
    expect(screen.getByTestId("status")).toHaveTextContent(/send or clear the draft/i);
  });

  it("resets when the composer changes panes", () => {
    function Harness() {
      const [paneId, setPaneId] = useState("w1:p1");
      return (
        <>
          <button type="button" onClick={() => setPaneId("w1:p2")}>
            Switch pane
          </button>
          <Composer
            paneId={paneId}
            agent="claude"
            isShell={false}
            gone={false}
            readOnly={false}
            surface={FREE}
            text="pane output"
            terminalDraft={null}
            rawTerminalDraft={null}
            prefs={{ wrap: true, fontSize: 11, draftFontSize: 14, chatFontSize: 14, fontFamily: "system", rawTerminal: false, tapToFocus: true, expandClippedReply: true }}
            display={{ open: false, onToggle: vi.fn() }}
            onSent={vi.fn()}
          />
        </>
      );
    }
    const router = createMemoryRouter([{ path: "/", element: <Harness /> }]);
    render(<RouterProvider router={router} />);
    startDirectTyping();

    fireEvent.click(screen.getByRole("button", { name: "Switch pane" }));

    expect(screen.getByPlaceholderText(/type a reply/i)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/type keys/i)).not.toBeInTheDocument();
  });
});

// ── THE DRAFT FIELD'S SIZE ────────────────────────────────────────────────────────────────────
//
// The field used to be pinned to the primitive's 16px — not as a design choice, but because a
// sub-16px focused input makes iOS Safari zoom the whole page and never zoom back. That fact is now
// a floor inside `applyDraftFontSize`, so everywhere else gets the operator's own number.
//
// PINNED ON THE STYLE, not on a measurement: jsdom lays nothing out, so `getComputedStyle` would
// only read back the inline value anyway. The inline style IS the contract here — it is what
// outranks the `.font-mono` class (hooks/use-display-prefs.ts says why that class cannot be
// re-pointed with a custom property).
describe("Composer — the draft field wears its own size", () => {
  it("applies the operator's draft size, merged with the terminal face and not replacing it", () => {
    renderComposerWithStatus({
      prefs: {
        wrap: true,
        fontSize: 11,
        draftFontSize: 13,
        chatFontSize: 14,
        fontFamily: "jetbrains",
        expandClippedReply: true,
        rawTerminal: false,
        tapToFocus: true,
      },
    });
    const box = screen.getByPlaceholderText(/type a reply/i);
    expect(box.style.fontSize).toBe("13px");
    expect(box.style.fontFamily).toContain("JetBrains Mono");
  });

  it("writes the size even for the default family, where no font-family is written at all", () => {
    renderComposerWithStatus();
    const box = screen.getByPlaceholderText(/type a reply/i);
    expect(box.style.fontSize).toBe("14px"); // the fixture's default
    // The stylesheet's own `--font-mono` still applies, byte for byte as before the size existed.
    expect(box.style.fontFamily).toBe("");
    expect(box.className).toMatch(/(?:^|\s)font-mono(?=\s|$)/);
  });

  // What the field's class list promises, unchanged by the size landing on it: no horizontal
  // strip reserved for anything, and the wrap rule. The strip was `pr-11`, for the attach button
  // in the field's bottom-right corner; the button is the field's sibling in the box now (ADR 0057),
  // so the 44px is typing area again and NOTHING may reserve it back by adding a padding here.
  it("reserves no gutter in the field, and keeps the wrap rule where it was", () => {
    renderComposerWithStatus();
    const box = screen.getByPlaceholderText(/type a reply/i);
    expect(box.className).not.toMatch(/(?:^|\s)pr-/);
    expect(box.className).toMatch(/(?:^|\s)wrap-anywhere(?=\s|$)/);
  });
});

// ── §1: EVERY IN-FLOW STRIP IN THIS FOOTER ARRIVES THROUGH `Collapse` ─────────────────────────
//
// These were bare conditionals, so each one teleported the composer up by its own height the moment
// its condition flipped — reported from the outside as "a notification in the footer pushed content
// up". The rule is DESIGN.md §1's: an in-flow surface appears and disappears through
// `ui/collapse.tsx` and through nothing else.
//
// PINNED STRUCTURALLY, because jsdom measures no heights and runs no transitions: the assertion
// walks up from the strip's own text to the nearest `[data-slot="collapse"]` and requires it to be
// there and OPEN. Every other test in this file passes with the wrapper removed; these do not.
describe("Composer — the footer's strips animate in, never jump in", () => {
  const rowOf = (el: HTMLElement) => el.closest('[data-slot="collapse"]');

  // `open` lands one tick after the mount, deliberately: `Collapse` paints the collapsed state
  // first so the browser has something to transition FROM (setting both in one commit is a jump with
  // extra steps). So the wait is the animation being real, not test flake.
  async function expectArrivedThroughCollapse(el: HTMLElement) {
    const row = rowOf(el);
    expect(row).not.toBeNull();
    await waitFor(() => expect(row!.getAttribute("data-state")).toBe("open"));
  }

  it("wraps the oversize-draft line", async () => {
    renderComposerWithStatus();
    const box = screen.getByPlaceholderText(/type a reply/i);
    fireEvent.change(box, { target: { value: "# heading\n".repeat(1200) } });
    await expectArrivedThroughCollapse(
      await screen.findByText(/too long to keep as a saved draft/i),
    );
  });

  it("wraps the armed-mode slot the direct-typing strip stands in", async () => {
    renderComposerWithStatus();
    fireEvent.click(screen.getByRole("button", { name: /^type into terminal$/i }));
    // The strip's own words, not the button that armed it — the button is in the controls row and
    // is not in flow the way the strip is.
    await expectArrivedThroughCollapse(await screen.findByText(/typing into terminal/i));
  });

  it("wraps the pending-send preview, which stays in the footer as a VERIFICATION surface", async () => {
    // It is not moved to the top pills, and the reason is in composer.tsx at the strip: the "sent"
    // EVENT is already a pill (`composer.status.sent`, asserted here too), while this half holds the
    // words that were sent on screen until the mirror echoes them back, so the operator can check
    // what landed rather than tapping Send twice. That outlives a pill's 2.5s and would be truncated
    // by one.
    const user = userEvent.setup();
    renderComposerWithStatus();
    const box = screen.getByPlaceholderText(/type a reply/i);
    await user.type(box, "ship it");
    await user.click(screen.getByRole("button", { name: "Send" }));

    const preview = await screen.findByText(/ship it/i, { selector: "span" });
    await expectArrivedThroughCollapse(preview);
    // The event half really is in the pills, so the footer is carrying only the verification half.
    expect(screen.getByTestId("status")).toHaveTextContent(/sent/i);
  }, 15000);
});

// A draft too big for the disk tier survives a pane switch but not the app closing, and the only
// thing that makes that difference visible is this row. Before it, the oversize write was skipped
// and a remount silently restored an OLDER, SHORTER draft — text the user never wrote.
describe("Composer — oversize draft notice", () => {
  it("says an oversize draft won't survive the app closing, and stops saying it when it fits", async () => {
    const props = renderComposerWithStatus();
    const box = screen.getByPlaceholderText(/type a reply/i);

    expect(screen.queryByText(/too long to keep as a saved draft/i)).not.toBeInTheDocument();

    // Paste, rather than type: 8 KiB of userEvent keystrokes would take minutes.
    fireEvent.change(box, { target: { value: "# heading\n".repeat(1200) } });
    expect(await screen.findByText(/too long to keep as a saved draft/i)).toBeInTheDocument();
    // …and the whole paste is still what the store hands back, which is the actual fix.
    expect(loadDraft(undefined, props.paneId)).toHaveLength(12000);

    fireEvent.change(box, { target: { value: "short again" } });
    await waitFor(() =>
      expect(screen.queryByText(/too long to keep as a saved draft/i)).not.toBeInTheDocument(),
    );
  });
});

describe("Composer — destructive-input confirm", () => {
  it("holds a destructive command for a second tap, then sends", async () => {
    const user = userEvent.setup();
    const props = renderComposer();
    const box = screen.getByPlaceholderText(/type a reply/i);

    await user.type(box, "rm -rf node_modules");

    // First tap: the Send button flips to a "Really send?" confirm — nothing is sent yet.
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.getByRole("button", { name: /really send/i })).toBeInTheDocument();
    expect(box).toHaveValue("rm -rf node_modules"); // draft kept
    expect(props.onSent).not.toHaveBeenCalled();

    // Second tap confirms: now it actually sends and clears.
    await user.click(screen.getByRole("button", { name: /really send/i }));
    await waitFor(() => expect(box).toHaveValue(""));
    expect(props.onSent).toHaveBeenCalled();
  });

  it("names the machine in the confirm — and only on a crew", async () => {
    const user = userEvent.setup();
    // Solo: the copy is exactly what it has always been, host clause and all absent.
    renderComposerWithStatus({ scope: { host: "workshop" } });
    await user.type(screen.getByPlaceholderText(/type a reply/i), "sudo reboot");
    await user.click(screen.getByRole("button", { name: "Send" }));
    // The reason stands at the Send slot beside "Really send?", not in the header (M56 spec 07).
    expect(screen.getByText("Destructive: sudo (runs as root), tap Send again to confirm")).toBeInTheDocument();
    expect(screen.getByTestId("status").textContent).toBe("");
    cleanup();

    // On a crew, "rm -r" is a different sentence depending on whose disk it runs on.
    clearStatus();
    renderComposerWithStatus({ scope: { host: "workshop" } }, fixtureServers);
    await user.type(screen.getByPlaceholderText(/type a reply/i), "sudo reboot");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.getByText("Destructive: sudo (runs as root) on workshop, tap Send again to confirm")).toBeInTheDocument();
  });

  it("does not arm the confirm for innocent input", async () => {
    const user = userEvent.setup();
    renderComposer();
    const box = screen.getByPlaceholderText(/type a reply/i);

    await user.type(box, "run the sudoku solver"); // "sudo" look-alike must not trip the guard
    await user.click(screen.getByRole("button", { name: "Send" }));

    // Sent straight away — no "Really send?" ever appeared, and the draft cleared.
    expect(screen.queryByRole("button", { name: /really send/i })).not.toBeInTheDocument();
    await waitFor(() => expect(box).toHaveValue(""));
  });
});

// THE MACHINE, ON THE ACTIONS BELT. It has moved twice and the reasoning is cumulative. Docked
// inside the text box it cost 60px of the widest part of the composer; on the 14px status band above
// the controls row it cost nothing, but the band's other half — the pane's status word — was what
// Altan asked to be rid of ("the server is still necessary somewhere, but the status is unnecessary
// at this place"). So the band went and the chip came down one row, onto the belt every one of those
// buttons writes from.
//
// Each claim below fails in BOTH directions: a chip that never renders passes none of them, a chip
// that always renders fails the solo case, and a chip left on a band fails the first.
describe("Composer — the machine opens the actions belt, and no band stands above it", () => {
  const box = () => screen.getByPlaceholderText(/type a reply/i);
  const row = () => document.querySelector<HTMLElement>('[data-slot="composer-controls"]')!;
  /** The belt: the scrolling row, which carries the ground, the rules and the row's own margins. */
  const actions = () => document.querySelector<HTMLElement>('[data-slot="composer-actions"]')!;
  /** Any strip the field reserves. Read off the class, because the jsdom render has no layout. */
  const reserved = (el: HTMLElement) => /(?:^|\s)pr-(\d+)(?=\s|$)/.exec(el.className)?.[1];

  it("has no status band at all any more, and adds no visible word in its place", () => {
    // The band is gone, and the word did not move somewhere else: a status word anywhere in this
    // footer would be the thing Altan
    // asked to be rid of, wearing a different address.
    renderComposerWithStatus({ scope: { host: "workshop" } }, fixtureServers);
    expect(document.querySelector('[data-slot="composer-status"]')).toBeNull();
    for (const word of ["needs you", "working", "done", "idle", "unknown", "shell"]) {
      expect(screen.queryByText(word)).toBeNull();
    }
  });

  it("is NOT in the composer field: no chip in the box, and the field reserves no strip at all", async () => {
    // The revision this round is. NO `pr-*`, because there is nothing inside the field to keep a
    // line clear of any more: the attach button is the field's sibling in the box (ADR 0057).
    // It was `pr-11`, measured at 254px of typing width at a true 390px content width and 184px at
    // 320px, on a crew exactly as on a solo install; docked, the crew figures were 194px and 124px.
    // Read off the class, because a conditional `pr-*` would not stack with another (tailwind-merge
    // keeps the last padding-right) and this is where such a one would land.
    const user = userEvent.setup();
    renderComposerWithStatus({ scope: { host: "workshop" } }, fixtureServers);
    expect(reserved(box())).toBeUndefined();
    // …and nothing in the box carries the host, by either route: no chip node inside it, and no
    // `aria-describedby` pointing the textarea at one.
    const field = box().parentElement!;
    expect(field.querySelector('[aria-label*="host" i]')).toBeNull();
    expect(box().getAttribute("aria-describedby")).toBeNull();
    // The placeholder is still the field's whole accessible name, unshared.
    expect(box().getAttribute("aria-label")).toBeNull();
    expect(box().getAttribute("aria-labelledby")).toBeNull();
    // A wrapping draft still grows the field and nothing else claims a height in the box.
    await user.type(box(), "a draft that wraps onto a second line in the composer");
    expect(box().className).not.toMatch(/(?:^|\s)h-\d/);
  });

  it("keeps the controls group NAMED once the visible word is gone", () => {
    // "Controls" was doing two jobs and only one of them was visual. Sighted it labelled five
    // self-labelling buttons; in the accessibility tree it is the ONLY thing naming the group. So it
    // is `sr-only`, not deleted — which is also why `composer.controls.label` is still a live key in
    // all seven dictionaries. Delete the label and this group announces as an unnamed run of buttons.
    renderComposerWithStatus({ scope: { host: "workshop" } }, fixtureServers);
    expect(screen.getByRole("group", { name: "Controls" })).toBe(row());
    expect(row().getAttribute("aria-labelledby")).toBe("composer-controls-label");
    const label = document.getElementById("composer-controls-label")!;
    expect(label.className).toMatch(/(?:^|\s)sr-only(?=\s|$)/);
  });

  it("carries exactly ONE rule at each seam, and the belt draws its own two", () => {
    // DESIGN.md §4: where two chrome regions stack, ONE component draws the boundary. Two drawing it
    // gives a 2px line where the language says 1px — a fault this codebase has already fixed twice
    // (space-strip / tab-strip).
    //
    // The belt closes its LOWER edge only, and the chrome block draws the upper one: the dock draws
    // nothing (its top rule and fill moved out to the chrome block in agent-chat.tsx, which also
    // carries the swipe handle, so the boundary against the terminal is drawn once above everything
    // the thumb operates — agent-chat.test.tsx pins that half), the status band that used to sit
    // between them is gone, and the belt now stands flush under that one rule with no margin.
    renderComposerWithStatus({ scope: { host: "workshop" } }, fixtureServers);
    expect(actions().className).toMatch(/(?:^|\s)border-b(?=\s|$)/);
    // `border-border`, not `border-rule` — the belt's edge is a component edge inside ONE chrome
    // surface (the input below); the regional cut is the chrome block's top rule.
    expect(actions().className).toMatch(/(?:^|\s)border-border(?=\s|$)/);
    expect(actions().className).not.toMatch(/(?:^|\s)border-rule(?=\s|$)/);
    // NO top rule and NO top margin — either one would put a second hairline, or a strip of empty
    // chrome, between the mirror and the belt.
    expect(actions().className).not.toMatch(/(?:^|\s)(?:border-y|border-t|mt-)/);
    // The controls group draws NOTHING at all: with the capsule retired it stands on the belt's own
    // ground, so it can neither double a seam nor outline itself.
    expect(row().className).not.toMatch(/(?:^|\s)border/);
    expect(row().className).not.toMatch(/(?:^|\s)rounded/);
    // …and the dock around them draws no edge either — the chrome block above it does.
    const dock = actions().previousElementSibling!;
    expect(dock.className).not.toMatch(/(?:^|\s)border/);
    expect(dock.className).not.toMatch(/(?:^|\s)pt-/);
    // …and the belt has no top margin of its own. It was `mt-2`, the air between the status band and
    // these buttons, then `mt-1.5`, the room the pull-up grip's upper half hung into. Both are gone,
    // so the belt stands flush under the chrome block's rule and there is no empty strip above it.
    // The bottom margin is `mb-1` now, not `mb-1.5` — it came down 2px with the belt itself when the
    // belt shrank to pill height (Option 6 of the belt-shade deck).
    expect(actions().className).toMatch(/(?:^|\s)mb-1(?=\s|$)/);
  });

  it("runs the ground and the rules edge to edge, and puts the gutter back on the scroller", () => {
    // FULL-BLEED: `-mx-3` cancels the dock's `px-3`, so the ground and both rules reach the viewport
    // edges. A band that stopped 12px short would read as a wide capsule — the shape this row just
    // stopped being — so the ground and the rules belong to the element carrying that margin and
    // never to the scroller one level in.
    //
    // THE GROUND IS A FILL, AND THAT OVERRIDES DESIGN.md §4 FOR THIS ROW ALONE. §4 says chrome
    // separates with a rule and never a fill, and the status band that used to stand here carried
    // the measurement that argued one down. Altan asked for a belt, which is a fill, so this is the
    // operator's call. WHICH fill is measured: against the composer's `--chrome`, `bg-foreground/6`
    // is 1.13:1 light and 1.16:1 dark, and it is the only symmetric recipe available — `--muted` IS
    // `--chrome` in light and `--card` IS `--chrome` in dark, so neither token separates in both.
    renderComposerWithStatus({ scope: { host: "workshop" } }, fixtureServers);
    expect(actions().className).toMatch(/(?:^|\s)-mx-3(?=\s|$)/);
    expect(actions().className).toMatch(/(?:^|\s)bg-foreground\/6(?=\s|$)/);
    expect(actions().className).not.toMatch(/rounded/);
    // The 12px goes back on the SCROLLER, not on the OverflowEdges wrapper between them: that
    // wrapper owns the flex sizing and the edge cues, and deliberately no padding of its own.
    // `pl-3`/`pr-3` rather than one `px-3`: with a pinned Switch block the right half becomes a
    // dynamic inline `paddingRight` instead (actions-row.tsx's `useSwitchBlockWidth`), so the two
    // sides are separate classes even though this handle-less render keeps both at 12px.
    const scrollerClass = actions().querySelector(".overflow-x-auto")!.className;
    expect(scrollerClass).toMatch(/(?:^|\s)pl-3(?=\s|$)/);
    expect(scrollerClass).toMatch(/(?:^|\s)pr-3(?=\s|$)/);
    // The group's GUTTER is the scroller's and nothing else: with the capsule gone, Collie's
    // controls stand on the belt's own ground and own no padding at all.
    expect(row().className).not.toMatch(/(?:^|\s)px-/);
  });
});

// Drives the composer's TWO draft props the way the parent does across polls: `rawTerminalDraft` is
// the live per-poll line, `terminalDraft` is its 1.5s-stabilised twin (useStableTerminalDraft). Two
// hidden controls set them independently (empty string → null), so a test can model a raw-only blip,
// a stabilised draft, live host typing (raw changes while stable lags), and the line clearing — all
// without real timers. `initialDraft` seeds a fully-stranded draft (raw + stable) at mount.
function renderDraftHarness(overrides: Partial<ComponentProps<typeof Composer>> = {}) {
  const { terminalDraft: initialDraft = null, ...rest } = overrides;
  function Harness() {
    const [raw, setRaw] = useState<string | null>(initialDraft);
    const [stable, setStable] = useState<string | null>(initialDraft);
    const props: ComponentProps<typeof Composer> = {
      paneId: "w1:p1",
      agent: "claude",
      isShell: false,
      gone: false,
      readOnly: false,
      surface: FREE,
      text: "pane output",
      prefs: { wrap: true, fontSize: 11, draftFontSize: 14, chatFontSize: 14, fontFamily: "system", rawTerminal: false, tapToFocus: true, expandClippedReply: true },
      display: { open: false, onToggle: vi.fn() },
      onSent: vi.fn(),
      ...rest,
      terminalDraft: stable,
      rawTerminalDraft: raw,
    };
    return (
      <>
        <input
          data-testid="raw-control"
          defaultValue={initialDraft ?? ""}
          onChange={(e) => setRaw(e.target.value === "" ? null : e.target.value)}
        />
        <input
          data-testid="stable-control"
          defaultValue={initialDraft ?? ""}
          onChange={(e) => setStable(e.target.value === "" ? null : e.target.value)}
        />
        <Composer {...props} />
      </>
    );
  }
  const router = createMemoryRouter([{ path: "/", element: <Harness /> }]);
  render(<RouterProvider router={router} />);
}

// The raw line updated this poll (may differ from the stabilised value while the host is typing).
const setRawDraft = (value: string) =>
  fireEvent.change(screen.getByTestId("raw-control"), { target: { value } });
// The stabilised value promoting/clearing (what gates the preview's appearance).
const setStableDraft = (value: string) =>
  fireEvent.change(screen.getByTestId("stable-control"), { target: { value } });
// A draft that has BOTH appeared and passed the 1.5s stability gate — raw and stable carry it.
const strandDraft = (value: string) => {
  setRawDraft(value);
  setStableDraft(value);
};

// The composer input is EXCLUSIVELY phone-owned: a terminal draft is never written into it by a poll.
// The reported bug was the reverse — b9603e9's auto-adopt kept re-syncing the field to the draft, so
// while the host was typing the input flickered fill→clear→fill. These pin that it can never happen.
describe("Composer — input is phone-owned (never auto-written by the terminal draft)", () => {
  it("never writes the draft into the input across appear → stabilise → live typing → vanish", async () => {
    renderDraftHarness();
    const box = screen.getByPlaceholderText(/type a reply/i);
    expect(box).toHaveValue("");

    setRawDraft("d"); // a raw draft appears (one poll) — input untouched
    expect(box).toHaveValue("");

    setStableDraft("d"); // it stabilises (the preview may show) — input still untouched
    await screen.findByText(/draft in terminal/i);
    expect(box).toHaveValue("");

    // Live host typing: a distinct raw draft every poll. The input never oscillates.
    for (const t of ["dr", "dra", "draf", "draft", "draft "]) {
      setRawDraft(t);
      expect(box).toHaveValue("");
    }

    setRawDraft(""); // the host line clears — input stays empty
    expect(box).toHaveValue("");
  });

  it("leaves the user's own typed text intact while a draft appears, streams, and vanishes", async () => {
    const user = userEvent.setup();
    renderDraftHarness();
    const box = screen.getByPlaceholderText(/type a reply/i);
    await user.type(box, "my mobile message");

    strandDraft("host draft"); // a draft strands while the user is mid-compose
    await screen.findByText(/draft in terminal/i);
    expect(box).toHaveValue("my mobile message");

    setRawDraft("host draft grows"); // host keeps typing — preview follows, input does not
    expect(box).toHaveValue("my mobile message");

    setRawDraft(""); // host line clears
    expect(box).toHaveValue("my mobile message");
  });
});

describe("Composer — terminal-draft preview", () => {
  it("does not render the preview when there is no stranded draft", () => {
    renderComposer({ terminalDraft: null, rawTerminalDraft: null });
    expect(screen.queryByText(/draft in terminal/i)).not.toBeInTheDocument();
  });

  it("appears only after the draft stabilises — a raw-only blip never flashes it", async () => {
    renderDraftHarness();
    expect(screen.queryByText(/draft in terminal/i)).not.toBeInTheDocument();

    setRawDraft("blip"); // raw only (not yet stable) → no preview
    expect(screen.queryByText(/draft in terminal/i)).not.toBeInTheDocument();

    setStableDraft("blip"); // stabilised → the preview promotes
    expect(await screen.findByText(/draft in terminal/i)).toBeInTheDocument();
    expect(screen.getByText("blip")).toBeInTheDocument();
  });

  it("tracks the raw draft live once shown — host typing streams into the preview text", async () => {
    renderDraftHarness();
    strandDraft("foo");
    expect(await screen.findByText("foo")).toBeInTheDocument();

    // Raw updates every poll; the stabilised value lags, but the preview text follows the raw line.
    setRawDraft("foobar");
    expect(await screen.findByText("foobar")).toBeInTheDocument();
    expect(screen.queryByText("foo")).not.toBeInTheDocument();

    setRawDraft("foobar baz");
    expect(await screen.findByText("foobar baz")).toBeInTheDocument();
  });

  it("unmounts when the raw draft goes null (submitted or cleared on the host)", async () => {
    renderDraftHarness();
    strandDraft("gone soon");
    await screen.findByText(/draft in terminal/i);

    setRawDraft(""); // → null: the host line was cleared/submitted
    await waitFor(() => expect(screen.queryByText(/draft in terminal/i)).not.toBeInTheDocument());
  });

  // ADR 0061: the notice floats, and its x hides it until the draft is gone.
  it("floats out of the flow: absolutely positioned, never a row of the composer", async () => {
    renderDraftHarness();
    strandDraft("floating");
    await screen.findByText(/draft in terminal/i);

    // The floating column does the positioning (it is shared with the held-send card); the notice's
    // own wrapper is only the pass-through.
    const wrapper = screen.getByText("floating").closest('[data-slot="terminal-draft-notice"]')!;
    expect(wrapper.className).toMatch(/(?:^|\s)pointer-events-none(?=\s|$)/);
    const column = wrapper.closest('[data-slot="floating-cards"]')!;
    expect(column.className).toMatch(/(?:^|\s)absolute(?=\s|$)/);
    expect(column.className).toMatch(/(?:^|\s)pointer-events-none(?=\s|$)/);
    // No Collapse around it: nothing in the composer's flow grows when it arrives.
    expect(wrapper.closest('[data-slot="collapse"]')).toBeNull();
    // The notice itself takes touches back from the pass-through wrapper.
    expect(wrapper.firstElementChild!.className).toMatch(/(?:^|\s)pointer-events-auto(?=\s|$)/);
  });

  it("portals into the slot it is handed, and nowhere inside the composer", async () => {
    const slot = document.createElement("div");
    document.body.append(slot);
    renderDraftHarness({ draftNoticeSlot: slot });
    strandDraft("in the slot");
    await screen.findByText(/draft in terminal/i);

    expect(slot).toHaveTextContent("in the slot");
    const wrapper = slot.querySelector('[data-slot="terminal-draft-notice"]')!;
    // In the slot the wrapper is only the pass-through: the slot does the positioning.
    expect(wrapper.className).not.toMatch(/(?:^|\s)absolute(?=\s|$)/);
    slot.remove();
  });

  it("the x hides it, and editing the host draft keeps it hidden", async () => {
    const user = userEvent.setup();
    renderDraftHarness();
    strandDraft("dismiss me");
    await screen.findByText(/draft in terminal/i);

    await user.click(screen.getByRole("button", { name: "Dismiss the terminal draft notice" }));
    expect(screen.queryByText(/draft in terminal/i)).toBeNull();

    // The host keeps typing into the same line: still hidden, however it changes.
    setRawDraft("dismiss me now");
    strandDraft("something else entirely");
    expect(screen.queryByText(/draft in terminal/i)).toBeNull();
  });

  it("comes back for the next draft once the dismissed one is gone", async () => {
    const user = userEvent.setup();
    renderDraftHarness();
    strandDraft("first");
    await screen.findByText(/draft in terminal/i);
    await user.click(screen.getByRole("button", { name: "Dismiss the terminal draft notice" }));

    // The host line clears (sent or wiped on the host)…
    setRawDraft("");
    setStableDraft("");
    // …and a later draft shows the notice again.
    strandDraft("second");
    expect(await screen.findByText("second")).toBeInTheDocument();
    expect(screen.getByText(/draft in terminal/i)).toBeInTheDocument();
  });

  it("Take over still works from the floating notice", async () => {
    const user = userEvent.setup();
    renderDraftHarness();
    strandDraft("carry this");
    await screen.findByText(/draft in terminal/i);

    await user.click(screen.getByRole("button", { name: /take over/i }));
    expect(screen.getByPlaceholderText(/type a reply/i)).toHaveValue("carry this");
    expect(screen.queryByText(/draft in terminal/i)).toBeNull();
  });

  it("persists across subsequent polls of the same text with no user action", async () => {
    renderDraftHarness();
    strandDraft("still here");
    await screen.findByText(/draft in terminal/i);

    // Repeated polls that just re-report the SAME raw text (no take-over, no send, no change) must
    // never hide the preview — it's honest state, not a one-shot notice.
    for (let i = 0; i < 3; i++) {
      setRawDraft("still here");
      expect(screen.getByText(/draft in terminal/i)).toBeInTheDocument();
      expect(screen.getByText("still here")).toBeInTheDocument();
    }
  });

  it("Take over copies the CURRENT draft into the composer, marks it handled, and hides the preview", async () => {
    const user = userEvent.setup();
    const keyCalls: string[] = [];
    server.use(
      http.post(/\/api\/pane\/[^/]+\/keys$/, async () => {
        keyCalls.push("keys");
        return HttpResponse.json({ ok: true });
      }),
    );
    renderDraftHarness();
    strandDraft("take me over");
    await screen.findByText(/draft in terminal/i);
    const box = screen.getByPlaceholderText(/type a reply/i);
    expect(box).toHaveValue(""); // never auto-written before the deliberate takeover

    await user.click(screen.getByRole("button", { name: /take over/i }));
    expect(box).toHaveValue("take me over"); // the text lands, one-shot
    expectLeaving(screen.queryByText(/draft in terminal/i)); // preview sliding shut
    expect(keyCalls).toEqual([]); // takeover writes NOTHING to the terminal
  });

  it("after Take over, a divergent host draft honestly re-shows the preview with the new text", async () => {
    const user = userEvent.setup();
    renderDraftHarness();
    strandDraft("original");
    await screen.findByText(/draft in terminal/i);

    await user.click(screen.getByRole("button", { name: /take over/i }));
    expectLeaving(screen.queryByText(/draft in terminal/i));

    // The host keeps typing → a DIFFERENT draft → the preview returns with the new text.
    strandDraft("original plus more");
    expect(await screen.findByText(/draft in terminal/i)).toBeInTheDocument();
    expect(screen.getByText("original plus more")).toBeInTheDocument();
  });

  it("re-stranding the SAME text after the line cleared is a fresh draft — the preview returns", async () => {
    // Regression: the handled key used to persist past the line clearing, so taking over "continue"
    // once muted every future "continue" in the pane until a navigation reset the component.
    const user = userEvent.setup();
    renderDraftHarness();
    strandDraft("continue");
    await screen.findByText(/draft in terminal/i);

    await user.click(screen.getByRole("button", { name: /take over/i }));
    expectLeaving(screen.queryByText(/draft in terminal/i));

    strandDraft(""); // the host line empties (submitted/wiped on the host)
    strandDraft("continue"); // …and later the very same text strands again
    const label = await screen.findByText(/draft in terminal/i);
    // Scope to the preview block — "continue" also sits in the composer input from the take-over.
    expect(label.parentElement).toHaveTextContent("continue");
  });

  // The phone sweeps nothing since M56 spec 06: the bridge sees the draft still in the host's box,
  // refuses `draft_present`, and its Replace offer is the one deliberate way to overwrite it.
  it("send after Take over meets the host line at the bridge: Replace overwrites it, and no key leaves the phone", async () => {
    const user = userEvent.setup();
    const callOrder: string[] = [];
    server.use(
      http.post(/\/api\/pane\/[^/]+\/keys$/, () => {
        callOrder.push("keys");
        return HttpResponse.json({ ok: true });
      }),
      ...replyHandler(
        (typed) => callOrder.push(`reply:${typed}`),
        undefined,
        (request) => (request.mode === "replace" ? sendAnswer(request.id, "sent") : sendAnswer(request.id, "refused", "draft_present", { offers: ["append", "replace", "cancel"] })),
      ),
    );
    renderDraftHarness();
    strandDraft("adopted line");
    await screen.findByText(/draft in terminal/i);

    await user.click(screen.getByRole("button", { name: /take over/i }));
    const box = screen.getByPlaceholderText(/type a reply/i);
    expect(box).toHaveValue("adopted line");

    // The host line still holds the draft (takeover never touched it), so the bridge refuses the send.
    await user.click(screen.getByRole("button", { name: "Send" }));
    await user.click(await screen.findByRole("button", { name: "Replace" }));
    await waitFor(() => expect(box).toHaveValue("")); // cleared after the replace went out
    expect(callOrder).toEqual(["reply:adopted line", "reply:adopted line"]);
    expect(recordedSends().map((r) => r.mode)).toEqual(["send", "replace"]);
  });

  it("read-only device: shows the preview and allows Take over (local copy), writing nothing to the terminal", async () => {
    const user = userEvent.setup();
    const keyCalls: string[] = [];
    server.use(
      http.post(/\/api\/pane\/[^/]+\/keys$/, async () => {
        keyCalls.push("keys");
        return HttpResponse.json({ ok: true });
      }),
    );
    renderDraftHarness({ readOnly: true });
    strandDraft("read only draft");
    expect(await screen.findByText(/draft in terminal/i)).toBeInTheDocument();
    const box = screen.getByPlaceholderText(/read-only/i);
    expect(box).toHaveValue(""); // never auto-written

    await user.click(screen.getByRole("button", { name: /take over/i }));
    expect(box).toHaveValue("read only draft"); // local copy landed
    expect(box).toBeDisabled(); // still locked — can't edit or send
    expect(keyCalls).toEqual([]); // no terminal writes at all
  });
});

// Mitigation A for the in-flight self-race: the composer knows what it just sent, so when the SAME
// text shows up on the terminal's "❯" line moments later (our own reply before the bridge's pending
// Enter lands), it must NOT be treated as a stranded draft — no chip, and no destructive clear-prefix
// on the next Send. A harness lets the test flip `terminalDraft` after a send, the way the parent
// would once the mirror echoes the in-flight text back.
describe("Composer — in-flight echo suppression (match-last-sent)", () => {
  function EchoHarness({ echoValue }: { echoValue: string }) {
    // The echo lands on BOTH the raw and the stabilised line at once (a persistent echo is stable).
    const [draft, setDraft] = useState<string | null>(null);
    const props: ComponentProps<typeof Composer> = {
      paneId: "w1:p1",
      agent: "claude",
      isShell: false,
      gone: false,
      readOnly: false,
      surface: FREE,
      text: "pane output",
      terminalDraft: draft,
      rawTerminalDraft: draft,
      prefs: { wrap: true, fontSize: 11, draftFontSize: 14, chatFontSize: 14, fontFamily: "system", rawTerminal: false, tapToFocus: true, expandClippedReply: true },
      display: { open: false, onToggle: vi.fn() },
      onSent: vi.fn(),
    };
    return (
      <>
        <button onClick={() => setDraft(echoValue)}>__set-draft</button>
        <Composer {...props} />
      </>
    );
  }

  function renderEcho(echoValue: string) {
    const router = createMemoryRouter([
      { path: "/", element: <EchoHarness echoValue={echoValue} /> },
    ]);
    render(<RouterProvider router={router} />);
  }

  it("suppresses the chip AND skips the clear-prefix when the draft matches what we just sent", async () => {
    const user = userEvent.setup();
    const callLog: string[] = [];
    server.use(
      http.post(/\/api\/pane\/[^/]+\/keys$/, async () => {
        callLog.push("keys");
        return HttpResponse.json({ ok: true });
      }),
      ...replyHandler(
        (typed) => callLog.push(`reply:${typed}`),
        () => callLog.push("submit"),
      ),
    );
    renderEcho("/rename");
    const box = screen.getByPlaceholderText(/type a reply/i);

    // Send "/rename"; the composer remembers it.
    await user.type(box, "/rename");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(callLog).toContain("reply:/rename"));
    // Let the first send clear its settle window before the follow-up, as a human pause does.
    await waitFor(() => expect(callLog).toContain("submit"));

    // The mirror now echoes the in-flight "/rename" back onto the ❯ line — no stranded-draft chip.
    await user.click(screen.getByRole("button", { name: "__set-draft" }));
    expect(screen.queryByText(/draft in terminal/i)).not.toBeInTheDocument();

    // A follow-up send must NOT fire the destructive ctrl+k/backspace clear-prefix against our own
    // in-flight reply — it goes straight to reply.
    await user.type(box, "next message");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(callLog).toContain("reply:next message"));
    expect(callLog).not.toContain("keys");
    expect(callLog.filter((e) => e.startsWith("reply:"))).toEqual([
      "reply:/rename",
      "reply:next message",
    ]);
  });

  it("still treats a genuinely different stranded draft as real (previews it; Take over + Send goes to the bridge)", async () => {
    const user = userEvent.setup();
    const callLog: string[] = [];
    server.use(
      http.post(/\/api\/pane\/[^/]+\/keys$/, async () => {
        callLog.push("keys");
        return HttpResponse.json({ ok: true });
      }),
      ...replyHandler((typed) => callLog.push(`reply:${typed}`)),
    );
    renderEcho("someone else's leftover");
    const box = screen.getByPlaceholderText(/type a reply/i);

    await user.type(box, "hello");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(callLog).toContain("reply:hello"));

    // A draft that is NOT what we just sent is a real stranded draft — not suppressed. It shows in the
    // preview (never auto-written into the now-empty input).
    await user.click(screen.getByRole("button", { name: "__set-draft" }));
    expect(await screen.findByText(/draft in terminal/i)).toBeInTheDocument();
    expect(box).toHaveValue("");

    // Take it over, then send: one request, and the bridge decides about the line in the box.
    callLog.length = 0;
    await user.click(screen.getByRole("button", { name: /take over/i }));
    expect(box).toHaveValue("someone else's leftover");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(callLog).toContain("reply:someone else's leftover"));
    expect(callLog).not.toContain("keys");
  });
});

// While a send is still in flight, the terminal line carries OUR staging text (attachments go
// out as host paths) — the draft preview must stay off for it, or a slow photo send flashes the
// card while the guard verifies. The gate only hides DURING the send; afterwards the ordinary
// echo/handled path resumes, so a foreign draft that is still there surfaces again once its line
// changes (pinned for the non-sending case by the test above).
describe("Composer — no draft preview while its own send is in flight", () => {
  function FlightHarness({ staged }: { staged: string }) {
    // The parent strands the staged line while the send is held, the way the mirror would once
    // the guard has typed the text and Enter is still pending. The second button strands a
    // DIFFERENT line afterwards, proving the gate delays rather than permanently suppresses.
    const [draft, setDraft] = useState<string | null>(null);
    const props: ComponentProps<typeof Composer> = {
      paneId: "w1:p1",
      agent: "claude",
      isShell: false,
      gone: false,
      readOnly: false,
      surface: FREE,
      text: "pane output",
      terminalDraft: draft,
      rawTerminalDraft: draft,
      prefs: { wrap: true, fontSize: 11, draftFontSize: 14, chatFontSize: 14, fontFamily: "system", rawTerminal: false, tapToFocus: true, expandClippedReply: true },
      display: { open: false, onToggle: vi.fn() },
      onSent: vi.fn(),
    };
    return (
      <>
        <button onClick={() => setDraft(staged)}>__strand-staged</button>
        <button onClick={() => setDraft("host typed more afterwards")}>__strand-other</button>
        <Composer {...props} />
      </>
    );
  }

  function renderFlight(staged: string) {
    const router = createMemoryRouter([{ path: "/", element: <FlightHarness staged={staged} /> }]);
    render(<RouterProvider router={router} />);
  }

  // Hold the Send Protocol's answer: the send stays staged (sending) until the returned release runs,
  // as it does while the bridge types the text and checks the box. "submit" is logged with the answer.
  function holdTypeCall(callLog: string[]) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.post(/\/api\/pane\/[^/]+\/keys$/, async () => HttpResponse.json({ ok: true })),
      http.post<never, { id: string; text: string }>("/api/send", async ({ request }) => {
        const body = await request.json();
        callLog.push(`reply:${body.text}`);
        await gate;
        callLog.push("submit");
        return HttpResponse.json(sendAnswer(body.id, "sent"));
      }),
    );
    return { release };
  }

  it("hides its own staged photo path for the whole send, and stays quiet after", async () => {
    const user = userEvent.setup();
    const callLog: string[] = [];
    const { release } = holdTypeCall(callLog);
    const staged = "schau mal /home/andiw/.local/state/collie/uploads/w4_p2-abc123.jpg";
    renderFlight(staged);
    await user.type(screen.getByPlaceholderText(/type a reply/i), staged);
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(callLog).toContain(`reply:${staged}`));
    // The bridge has typed the line and Enter is pending: the staged text must not surface.
    await user.click(screen.getByRole("button", { name: "__strand-staged" }));
    expect(screen.queryByText(/draft in terminal/i)).not.toBeInTheDocument();
    release();
    await waitFor(() => expect(callLog).toContain("submit"));
    expect(screen.queryByText(/draft in terminal/i)).not.toBeInTheDocument();
  });

  it("hides even a foreign draft while the send is in flight", async () => {
    // The send moment belongs to the phone: a host draft that appears mid-send waits until the
    // send completes rather than fighting it for the mirror.
    const user = userEvent.setup();
    const callLog: string[] = [];
    const { release } = holdTypeCall(callLog);
    renderFlight("someone else's leftover");
    await user.type(screen.getByPlaceholderText(/type a reply/i), "hello");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(callLog).toContain("reply:hello"));
    await user.click(screen.getByRole("button", { name: "__strand-staged" }));
    expect(screen.queryByText(/draft in terminal/i)).not.toBeInTheDocument();
    release();
    await waitFor(() => expect(callLog).toContain("submit"));
    // The delay is bounded, not permanent: a genuinely new line after the send surfaces again.
    // (This doubles as the in-harness positive control — a latch that never fires could not pass.)
    await user.click(screen.getByRole("button", { name: "__strand-other" }));
    expect(await screen.findByText(/draft in terminal/i)).toBeInTheDocument();
  });
});

// The no-service-worker self-updater must never reload over unsent work. The composer holds a reload
// (lib/reload-guard) while its phone-owned input has REAL text or an upload is in flight — but a
// terminal draft alone is SAFE (it lives on the "❯" line and its preview re-derives after a reload),
// so it must NOT hold, or a stranded draft would wedge the update forever.
describe("Composer — reload-guard hold (no-SW self-update safety gate)", () => {
  beforeEach(() => __resetReloadGuard());

  it("holds a reload while the composer has unsent text, releases when it's cleared", async () => {
    const user = userEvent.setup();
    renderComposer();
    const box = screen.getByPlaceholderText(/type a reply/i);
    expect(isReloadHeld()).toBe(false);

    await user.type(box, "half-written thought");
    expect(isReloadHeld()).toBe(true);

    await user.clear(box);
    expect(isReloadHeld()).toBe(false);
  });

  it("a terminal draft alone (preview only, empty input) does NOT hold — it re-derives after a reload", async () => {
    renderDraftHarness();
    strandDraft("just a preview");
    await screen.findByText(/draft in terminal/i);
    expect(screen.getByPlaceholderText(/type a reply/i)).toHaveValue(""); // nothing phone-owned to lose
    expect(isReloadHeld()).toBe(false);
  });

  it("holds while an image upload is in flight, releases once it settles", async () => {
    // Failing upload keeps the draft empty (a successful one adds a chip, which then legitimately
    // holds as real unsent work) — so the release is observable in isolation.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    server.use(
      http.post(/\/api\/pane\/[^/]+\/upload$/, async () => {
        await gate;
        return HttpResponse.json({ ok: false, error: "upload failed" });
      }),
    );
    renderComposer();
    expect(isReloadHeld()).toBe(false);

    const file = new File(["x"], "shot.png", { type: "image/png" });
    // SAFETY: `getByTestId` throws when the element is absent, and this id is on an `<input>`.
    const fileInput = screen.getByTestId("attach-files") as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => expect(isReloadHeld()).toBe(true)); // uploading → held
    release();
    await waitFor(() => expect(isReloadHeld()).toBe(false)); // settled, input still empty → released
  });
});

describe("Composer — quick keys / image attach", () => {
  it("shows the attach button on the reply-input row without the quick-key strip being visible", async () => {
    const user = userEvent.setup();
    renderComposer();

    // The quick-key strip only renders once composerFocused && keyboardOpen — keyboardOpen defaults
    // to false in jsdom (no visualViewport resize fires), so none of its keys are present here.
    expect(screen.queryByRole("button", { name: "Esc" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Tab" })).not.toBeInTheDocument();

    // The attach button now lives on the always-visible reply-input row instead of the strip.
    const attach = screen.getByRole("button", { name: "Attach file" });
    expect(attach).toBeEnabled();
    await user.click(attach); // clickable without throwing (opens the hidden file input)
  });

  it("does not render digit shortcut buttons in the composer (they live behind the Keys dock's 123 chip)", () => {
    renderComposer();
    for (const d of ["1", "2", "3", "4", "5"]) {
      expect(screen.queryByRole("button", { name: d })).not.toBeInTheDocument();
    }
  });

  // The photos input carries `multiple`, so the picker can return several files in one change;
  // onPickFile must upload every one, not just the first.
  it("uploads every photo when several are selected at once", async () => {
    let uploadCalls = 0;
    server.use(
      http.post(/\/api\/pane\/[^/]+\/upload$/, () => {
        uploadCalls++;
        return HttpResponse.json({ ok: true, path: `/tmp/shot-${uploadCalls}.png` });
      }),
    );
    renderComposer();

    const a = new File(["a"], "a.png", { type: "image/png" });
    const b = new File(["b"], "b.png", { type: "image/png" });
    // SAFETY: `getByTestId` throws when the element is absent, and this id is on an `<input>`.
    const photos = screen.getByTestId("attach-photos") as HTMLInputElement;
    fireEvent.change(photos, { target: { files: [a, b] } });

    await waitFor(() => expect(uploadCalls).toBe(2));
  });
});

// The picker's own refusal (lib/attachments.ts), driven by what THIS bridge published on
// /api/config's `upload` block — never the pre-attachment fallback, since every case here publishes
// one. The store (lib/operator-config.ts) caches its one read for the life of a "page", so each case
// resets it and republishes its own /api/config before rendering, and waits for the file input's
// `accept` to reflect the published block before touching the picker — otherwise the assertion could
// run against the LEGACY fallback the composer renders on its very first tick.
describe("Composer — attachment limits published by this bridge", () => {
  beforeEach(() => __resetOperatorCommands());
  afterEach(() => __resetOperatorCommands());

  function publishUpload(upload: { maxBytes: number; imageTypes: string[]; textTypes: string[] }) {
    server.use(
      http.get("/api/config", () => HttpResponse.json({ push: false, vapidPublicKey: "", upload })),
    );
  }

  // The FILES input, not the photos one. The composer renders two (lib/attachments.ts explains
  // why); the photos input's `accept` is the constant `image/*` and says nothing about what this
  // bridge published, so every assertion here is about the second.
  async function waitForPublishedAccept(accept: string) {
    await waitFor(() => expect(screen.getByTestId("attach-files")).toHaveAttribute("accept", accept));
  }

  it("refuses a file larger than the published cap and never calls the upload API", async () => {
    publishUpload({ maxBytes: 1 * 1024 * 1024, imageTypes: ["png"], textTypes: [] });
    let uploadCalls = 0;
    server.use(
      http.post(/\/api\/pane\/[^/]+\/upload$/, () => {
        uploadCalls++;
        return HttpResponse.json({ ok: true, path: "/tmp/should-not-happen" });
      }),
    );
    renderComposerWithStatus();
    await waitForPublishedAccept("image/*,.png");

    const file = new File(["x".repeat(2 * 1024 * 1024)], "shot.png", { type: "image/png" });
    // SAFETY: `getByTestId` throws when the element is absent, and this id is on an `<input>`.
    const fileInput = screen.getByTestId("attach-files") as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent(/bigger than 1 MB/));
    expect(uploadCalls).toBe(0);
  });

  it("uploads a .md file when the bridge published md in textTypes", async () => {
    publishUpload({ maxBytes: 10 * 1024 * 1024, imageTypes: ["png"], textTypes: ["md"] });
    server.use(
      http.post(/\/api\/pane\/[^/]+\/upload$/, () => HttpResponse.json({ ok: true, path: "/tmp/notes.md" })),
    );
    renderComposer();
    await waitForPublishedAccept("image/*,.png,.md");

    const file = new File(["# hi"], "notes.md", { type: "text/markdown" });
    // SAFETY: `getByTestId` throws when the element is absent, and this id is on an `<input>`.
    const fileInput = screen.getByTestId("attach-files") as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [file] } });

    // A chip, not a path (ADR 0060): the field holds the marker, the chip holds the name.
    const box = screen.getByPlaceholderText(/type a reply/i);
    await waitFor(() => expect(box).toHaveValue("[File #1] "));
    expect(screen.getByRole("button", { name: "Remove notes.md" })).toBeInTheDocument();
  });

  it("refuses a .rb file the bridge did not publish and never calls the upload API", async () => {
    publishUpload({ maxBytes: 10 * 1024 * 1024, imageTypes: ["png"], textTypes: ["md"] });
    let uploadCalls = 0;
    server.use(
      http.post(/\/api\/pane\/[^/]+\/upload$/, () => {
        uploadCalls++;
        return HttpResponse.json({ ok: true, path: "/tmp/should-not-happen" });
      }),
    );
    renderComposerWithStatus();
    await waitForPublishedAccept("image/*,.png,.md");

    const file = new File(["puts 1"], "app.rb", { type: "text/x-ruby" });
    // SAFETY: `getByTestId` throws when the element is absent, and this id is on an `<input>`.
    const fileInput = screen.getByTestId("attach-files") as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("Collie can't attach app.rb."));
    expect(uploadCalls).toBe(0);
  });
});

describe("Composer — clipboard image paste", () => {
  it("uploads a pasted image the same way the picker does and adds its chip and marker", async () => {
    server.use(
      http.post(/\/api\/pane\/[^/]+\/upload$/, () => HttpResponse.json({ ok: true, path: "/tmp/shot.png" })),
    );
    renderComposer();
    const box = screen.getByPlaceholderText(/type a reply/i);
    const file = new File(["x"], "shot.png", { type: "image/png" });
    const item = { kind: "file", type: "image/png", getAsFile: () => file };

    fireEvent.paste(box, { clipboardData: { items: [item] } });

    await waitFor(() => expect(box).toHaveValue("[Image #1] "));
    expect(screen.getByRole("button", { name: "Remove shot.png" })).toBeInTheDocument();
  });

  it("leaves a plain-text paste alone — no upload, nothing written by the paste handler", () => {
    // The regression that matters most: `onPasteFile` only intercepts `item.kind === "file"`, so a
    // clipboard item MSW/jsdom never sees as a file (kind "string", the shape a normal text copy
    // produces) must fall straight through to the textarea's own paste handling — no upload call,
    // no path written into the box.
    let uploadCalls = 0;
    server.use(
      http.post(/\/api\/pane\/[^/]+\/upload$/, () => {
        uploadCalls++;
        return HttpResponse.json({ ok: true, path: "/tmp/should-not-happen" });
      }),
    );
    renderComposer();
    const box = screen.getByPlaceholderText(/type a reply/i);
    const item = { kind: "string", type: "text/plain", getAsFile: () => null };

    fireEvent.paste(box, { clipboardData: { items: [item] } });

    expect(box).toHaveValue("");
    expect(screen.queryByText(/Image added/i)).not.toBeInTheDocument();
    expect(uploadCalls).toBe(0);
  });
});

describe("Composer — keys dock (in-flow, not an overlay)", () => {
  it("tapping Keys docks the NavTray in the normal flow (no fixed overlay) and toggles it closed", async () => {
    const user = userEvent.setup();
    renderComposer();

    const keys = screen.getByRole("button", { name: "Keys" });
    expect(keys).toHaveAttribute("aria-expanded", "false");
    // Closed by default — the tray isn't mounted.
    expect(screen.queryByRole("button", { name: "Esc" })).not.toBeInTheDocument();

    await user.click(keys);
    expect(keys).toHaveAttribute("aria-expanded", "true");

    // The NavTray is now mounted (its Esc key is a good witness)…
    const esc = screen.getByRole("button", { name: "Esc" });
    expect(esc).toBeInTheDocument();
    // …and it is IN-FLOW, not inside a fixed overlay/dialog (the BottomSheet's covering role="dialog").
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(esc.closest('[aria-modal="true"]')).toBeNull();
    expect(esc.closest(".fixed")).toBeNull();

    // Tapping Keys again closes the dock (single-valued drawer toggle).
    await user.click(keys);
    expect(keys).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Esc" })).not.toBeInTheDocument();
  });

  it("the dock's own X close button dismisses it", async () => {
    const user = userEvent.setup();
    renderComposer();

    await user.click(screen.getByRole("button", { name: "Keys" }));
    expect(screen.getByRole("button", { name: "Esc" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close Keys" }));
    expect(screen.queryByRole("button", { name: "Esc" })).not.toBeInTheDocument();
  });

  it("the pencil sits beside the KEYS label on the same line, ahead of the close X, and opens the editor", async () => {
    const user = userEvent.setup();
    renderComposer();
    await user.click(screen.getByRole("button", { name: "Keys" }));

    const pencil = screen.getByRole("button", { name: "Edit keys" });
    const close = screen.getByRole("button", { name: "Close Keys" });
    // The pencil and the label share one group, which is on the header row; the close X is the row's far end.
    const group = pencil.parentElement;
    expect(group).toHaveClass("items-center");
    expect(group?.textContent).toContain("Keys");
    expect(group?.contains(close)).toBe(false);
    expect(group?.parentElement).toBe(close.parentElement);
    expect(pencil.compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    // 28px drawn, 44px reached, like the X beside it.
    expect(pencil).toHaveClass("size-7");
    expect(pencil.className).toContain("before:-inset-2");
    // Quick has no pencil.
    expect(screen.queryByRole("dialog", { name: "Edit keys" })).toBeNull();

    await user.click(pencil);
    expect(screen.getByRole("dialog", { name: "Edit keys" })).toBeInTheDocument();
    // The dock stays put behind the sheet.
    expect(screen.getAllByRole("button", { name: "Esc" }).length).toBeGreaterThan(0);
  });

  it("the Keys dock header holds the KEYS label and the pencil and no machine name, on a crew too", async () => {
    const user = userEvent.setup();
    renderComposerWithStatus({ scope: { host: "workshop" } }, fixtureServers);
    await user.click(screen.getByRole("button", { name: "Keys" }));

    const pencil = screen.getByRole("button", { name: "Edit keys" });
    const group = pencil.parentElement!;
    // The group is the label and the pencil, nothing else: two children, no chip, no machine word.
    expect(group.children).toHaveLength(2);
    expect(group.textContent).toBe("Keys");
    const header = group.parentElement!;
    expect(header.textContent).not.toMatch(/workshop/i);
    expect(header.querySelector("[data-slot='host-chip']")).toBeNull();
  });

  it("a custom key from the board goes out through the same pane.send_keys, a sequence in order", async () => {
    const user = userEvent.setup();
    let sentKeys: string[] | null = null;
    server.use(
      http.post<never, { keys: string[] }>(/\/api\/pane\/[^/]+\/keys$/, async ({ request }) => {
        sentKeys = (await request.json()).keys;
        return HttpResponse.json({ ok: true });
      }),
    );
    const seq = chordKey(["ctrl+b", "c"]);
    if (seq === null) throw new Error("bad key");
    setKeyBoard(setCell(addRow(DEFAULT_BOARD), 14, seq));
    try {
      renderComposer();
      await user.click(screen.getByRole("button", { name: "Keys" }));
      await user.click(screen.getByRole("button", { name: "Ctrl+B, then C" }));
      await waitFor(() => expect(sentKeys).toEqual(["ctrl+b", "c"]));
    } finally {
      resetKeyBoard();
    }
  });

  it("routes a docked key press through pane.send_keys", async () => {
    const user = userEvent.setup();
    let sentKeys: string[] | null = null;
    server.use(
      http.post<never, { keys: string[] }>(/\/api\/pane\/[^/]+\/keys$/, async ({ request }) => {
        const body = await request.json();
        sentKeys = body.keys;
        return HttpResponse.json({ ok: true });
      }),
    );
    renderComposer();

    await user.click(screen.getByRole("button", { name: "Keys" }));
    await user.click(screen.getByRole("button", { name: "Esc" }));

    await waitFor(() => expect(sentKeys).toEqual(["Escape"]));
  });
});

describe("Composer — quick dock (in-flow, matches the keys dock)", () => {
  it("tapping Quick docks the reply grids in the normal flow (no fixed overlay) and toggles it closed", async () => {
    const user = userEvent.setup();
    renderComposer();

    const quick = screen.getByRole("button", { name: "Quick" });
    expect(quick).toHaveAttribute("aria-expanded", "false");
    // Closed by default — none of the quick replies are mounted.
    expect(screen.queryByRole("button", { name: "yes" })).not.toBeInTheDocument();

    await user.click(quick);
    expect(quick).toHaveAttribute("aria-expanded", "true");

    // The reply grid is now mounted ("yes" is a good witness)…
    const yes = screen.getByRole("button", { name: "yes" });
    expect(yes).toBeInTheDocument();
    // …and it is IN-FLOW like the keys dock, not inside a BottomSheet's covering role="dialog".
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(yes.closest('[aria-modal="true"]')).toBeNull();
    expect(yes.closest(".fixed")).toBeNull();

    // Tapping Quick again closes the dock (single-valued drawer toggle).
    await user.click(quick);
    expect(quick).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "yes" })).not.toBeInTheDocument();
  });

  it("opening Quick closes an open Keys dock (shared single-valued drawer)", async () => {
    const user = userEvent.setup();
    renderComposer();

    await user.click(screen.getByRole("button", { name: "Keys" }));
    expect(screen.getByRole("button", { name: "Esc" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Quick" }));
    // Keys unmounts, Quick mounts — only one dock at the single placement site.
    expect(screen.queryByRole("button", { name: "Esc" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "yes" })).toBeInTheDocument();
  });

  it("the dock's own X close button dismisses it", async () => {
    const user = userEvent.setup();
    renderComposer();

    await user.click(screen.getByRole("button", { name: "Quick" }));
    expect(screen.getByRole("button", { name: "yes" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close Quick" }));
    expect(screen.queryByRole("button", { name: "yes" })).not.toBeInTheDocument();
  });

  it("a quick-action tap sends its text through the reply path, then closes the dock", async () => {
    const user = userEvent.setup();
    let replyText: string | null = null;
    server.use(...replyHandler((typed) => (replyText = typed)));
    const props = renderComposer();

    await user.click(screen.getByRole("button", { name: "Quick" }));
    await user.click(screen.getByRole("button", { name: "continue" }));

    await waitFor(() => expect(replyText).toBe("continue"));
    // onSent fires on send completion, which waits out the submit settle past the type POST.
    await waitFor(() => expect(props.onSent).toHaveBeenCalled());
    // The dock deliberately OUTLIVES the send — the ✓ has to land somewhere the user is still
    // looking — and closes itself once the echo has been seen.
    await waitFor(
      () => expect(screen.queryByRole("button", { name: "continue" })).not.toBeInTheDocument(),
      { timeout: 3000 },
    );
  });

  it("a quick reply echoes on its OWN button and locks its siblings while in flight", async () => {
    const user = userEvent.setup();
    // Hold the Send Protocol's answer open, so the in-flight state is observable rather than a race
    // against a handler that resolves instantly.
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.post<never, { id: string }>("/api/send", async ({ request }) => {
        const body = await request.json();
        await gate;
        return HttpResponse.json(sendAnswer(body.id, "sent"));
      }),
    );
    renderComposer();

    await user.click(screen.getByRole("button", { name: "Quick" }));
    await user.click(screen.getByRole("button", { name: "continue" }));

    // The tapped reply is busy; an untapped sibling is locked out so a second send can't race it.
    await waitFor(() => expect(screen.getByRole("button", { name: "continue" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "skip" })).toBeDisabled();

    release();
    // Once it settles the dock closes itself — proof the flight actually resolved.
    await waitFor(
      () => expect(screen.queryByRole("button", { name: "continue" })).not.toBeInTheDocument(),
      { timeout: 3000 },
    );
  });

  it("a failed quick reply keeps the dock open and re-enables the grid", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("/api/send", () => HttpResponse.json({ error: "nope" }, { status: 500 })),
    );
    renderComposer();

    await user.click(screen.getByRole("button", { name: "Quick" }));
    await user.click(screen.getByRole("button", { name: "continue" }));

    // No ✓, no close — the reply never landed, so the dock stays put for a retry.
    await waitFor(() => expect(screen.getByRole("button", { name: "continue" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "skip" })).toBeEnabled();
  });
});

// The gear is the composer's; the PANEL it opens is not any more. It became a BottomSheet on
// 2026-09-30 and a sheet cannot be mounted inside the composer's animated, sticky ancestry, so
// AgentChat owns it and this file owns only the button. What the rows themselves draw is pinned in
// display-prefs.test.tsx.
describe("Composer — the Display gear", () => {
  it("nothing display-related sits on the permanent rows", () => {
    renderComposer();
    expect(screen.queryByRole("button", { name: "Decrease font size" })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Wrap lines" })).not.toBeInTheDocument();
  });

  it("the gear asks its owner to toggle the sheet", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    renderComposer({ display: { open: false, onToggle } });

    const gear = screen.getByRole("button", { name: "Display settings" });
    expect(gear).toHaveAttribute("aria-expanded", "false");
    await user.click(gear);
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("an open sheet is reported on the gear, and closes the Keys tray under it", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    renderComposer({ display: { open: true, onToggle } });
    expect(screen.getByRole("button", { name: "Display settings" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    await user.click(screen.getByRole("button", { name: "Keys" }));
    expect(screen.getByRole("button", { name: "Esc" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Display settings" }));
    expect(screen.queryByRole("button", { name: "Esc" })).not.toBeInTheDocument();
  });

  it("the gear stays reachable on a read-only device", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    renderComposer({ readOnly: true, display: { open: false, onToggle } });

    // Keys/Quick are write affordances and lock; the gear is local view state and must not.
    expect(screen.getByRole("button", { name: "Keys" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Display settings" }));
    expect(onToggle).toHaveBeenCalledOnce();
  });
});

describe("Composer — a composed key queue is guarded on the way out", () => {
  /** Open Keys and stage one chord, so the queue is genuinely dirty. */
  async function stageAKey(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: "Keys" }));
    await user.click(screen.getByRole("button", { name: "Ctrl" }));
    await user.click(screen.getByRole("button", { name: "Tab" }));
    expect(screen.getByRole("button", { name: "Remove Ctrl Tab" })).toBeInTheDocument();
  }

  it("the dock's X needs a second tap while keys are staged", async () => {
    const user = userEvent.setup();
    renderComposerWithStatus();
    await stageAKey(user);

    await user.click(screen.getByRole("button", { name: "Close Keys" }));
    // Still open — the composed sequence is not thrown away on one tap.
    expect(screen.getByRole("button", { name: "Remove Ctrl Tab" })).toBeInTheDocument();
    expect(screen.getByTestId("status")).toHaveTextContent(/discard 1 queued key/i);

    await user.click(screen.getByRole("button", { name: "Close Keys" }));
    expect(screen.queryByRole("button", { name: "Esc" })).not.toBeInTheDocument();
  });

  // The ✕ is not the only exit — the Keys toggle and the other drawer buttons unmount the tray just
  // as effectively, which is why the guard lives on the drawer transition rather than the button.
  // `getAllByRole` + a filter on `aria-expanded` used to be load-bearing here because the tray's own
  // segmented "Keys" tab shared the Controls row toggle's accessible name; that tab is gone (the tray
  // is one fixed pad now), so a plain `getByRole` would resolve too, but the filter still says
  // precisely which button this helper means.
  const controlsToggle = (name: string): HTMLElement => {
    const toggle = screen
      .getAllByRole("button", { name })
      .find((b) => b.hasAttribute("aria-expanded"));
    // Asserted as a real failure rather than by widening `undefined` away: if the toggle is gone,
    // that IS the bug, and the case should say so here instead of at the first property read.
    if (!toggle) throw new Error(`no aria-expanded toggle named ${name}`);
    return toggle;
  };

  it.each([
    ["the Keys toggle", () => controlsToggle("Keys")],
    ["the Quick toggle", () => controlsToggle("Quick")],
    ["the Display gear", () => screen.getByRole("button", { name: "Display settings" })],
  ])("%s also needs a second tap while keys are staged", async (_label, getButton) => {
    const user = userEvent.setup();
    renderComposerWithStatus();
    await stageAKey(user);

    await user.click(getButton());
    expect(screen.getByRole("button", { name: "Remove Ctrl Tab" })).toBeInTheDocument();

    await user.click(getButton());
    expect(screen.queryByRole("button", { name: "Remove Ctrl Tab" })).not.toBeInTheDocument();
  });

  // Over-guarding trains you to double-tap through the confirm reflexively, which kills its value
  // where it matters. One tap of setup is not work worth protecting.
  it("an armed modifier with NO staged keys closes on the first tap", async () => {
    const user = userEvent.setup();
    renderComposer();

    await user.click(screen.getByRole("button", { name: "Keys" }));
    await user.click(screen.getByRole("button", { name: "Ctrl" })); // armed, but nothing staged
    await user.click(screen.getByRole("button", { name: "Close Keys" }));

    expect(screen.queryByRole("button", { name: "Esc" })).not.toBeInTheDocument();
  });

  it("a clean Keys dock closes on the first tap", async () => {
    const user = userEvent.setup();
    renderComposer();

    await user.click(screen.getByRole("button", { name: "Keys" }));
    await user.click(screen.getByRole("button", { name: "Close Keys" }));

    expect(screen.queryByRole("button", { name: "Esc" })).not.toBeInTheDocument();
  });

  // The count must not outlive the tray: a stale value would arm a phantom confirm on a later,
  // perfectly clean close.
  it("does not arm a phantom confirm on a later clean open", async () => {
    const user = userEvent.setup();
    renderComposer();
    await stageAKey(user);

    await user.click(screen.getByRole("button", { name: "Close Keys" })); // arm
    await user.click(screen.getByRole("button", { name: "Close Keys" })); // discard

    await user.click(screen.getByRole("button", { name: "Keys" })); // reopen, empty
    await user.click(screen.getByRole("button", { name: "Close Keys" }));
    expect(screen.queryByRole("button", { name: "Esc" })).not.toBeInTheDocument();
  });
});

describe("Composer — quick replies follow the pane kind", () => {
  it("an agent pane gets the agent set", async () => {
    const user = userEvent.setup();
    renderComposer({ agent: "claude", isShell: false });
    await user.click(screen.getByRole("button", { name: "Quick" }));

    expect(screen.getByRole("button", { name: "continue" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "commit and push" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "drastically simplify" })).toBeInTheDocument();
  });

  it("a shell pane gets y/n, not the agent phrases", async () => {
    const user = userEvent.setup();
    renderComposer({ agent: "shell", isShell: true });
    await user.click(screen.getByRole("button", { name: "Quick" }));

    expect(screen.getByRole("button", { name: "y" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "n" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "commit and push" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "drastically simplify" })).not.toBeInTheDocument();
  });
});

// The draft is the message you are in the middle of writing — and the whole reason you leave a pane
// mid-reply is to go read another tab. The composer unmounts when you do (DetailRoute keys AgentChat
// by paneId), so without persistence the message is simply gone. These pin the round trip, the
// per-pane isolation (pane A's text must never appear in pane B), and the clear-on-send.
describe("Composer — draft persistence", () => {
  function draftProps(
    overrides: Partial<ComponentProps<typeof Composer>> = {},
  ): ComponentProps<typeof Composer> {
    return {
      paneId: "w1:p1",
      agent: "claude",
      isShell: false,
      gone: false,
      readOnly: false,
      surface: FREE,
      text: "pane output",
      terminalDraft: null,
      rawTerminalDraft: null,
      prefs: { wrap: true, fontSize: 11, draftFontSize: 14, chatFontSize: 14, fontFamily: "system", rawTerminal: false, tapToFocus: true, expandClippedReply: true },
      display: { open: false, onToggle: vi.fn() },
      onSent: vi.fn(),
      ...overrides,
    };
  }

  /** Mounts the composer under a harness that can swap `paneId` IN PLACE (no remount) — the harder
   *  of the two realities the component has to survive. */
  function renderSwitchable(initialPane: string) {
    let swap: ((id: string) => void) | null = null;
    function Harness() {
      const [paneId, setPaneId] = useState(initialPane);
      swap = setPaneId;
      return <Composer {...draftProps({ paneId })} />;
    }
    const router = createMemoryRouter([{ path: "/", element: <Harness /> }]);
    const view = render(<RouterProvider router={router} />);
    return { view, swap: (id: string) => act(() => swap?.(id)) };
  }

  function mount(paneId = "w1:p1") {
    const router = createMemoryRouter([
      { path: "/", element: <Composer {...draftProps({ paneId })} /> },
    ]);
    return render(<RouterProvider router={router} />);
  }

  it("restores the draft after a remount", async () => {
    const user = userEvent.setup();
    const first = mount();
    await user.type(screen.getByPlaceholderText(/type a reply/i), "half a thought");
    first.unmount();

    mount();
    expect(screen.getByPlaceholderText(/type a reply/i)).toHaveValue("half a thought");
  });

  it("keeps drafts per pane — pane A's text never shows in pane B", async () => {
    const user = userEvent.setup();
    const { swap } = renderSwitchable("w1:p1");
    const box = () => screen.getByPlaceholderText(/type a reply/i);

    await user.type(box(), "for pane A");
    swap("w1:p2");
    expect(box()).toHaveValue(""); // no bleed
    await user.type(box(), "for pane B");

    swap("w1:p1");
    expect(box()).toHaveValue("for pane A");
    swap("w1:p2");
    expect(box()).toHaveValue("for pane B");
  });

  it("forgets the draft once the user empties the box", async () => {
    const user = userEvent.setup();
    const first = mount();
    const box = screen.getByPlaceholderText(/type a reply/i);
    await user.type(box, "never mind");
    await user.clear(box);
    first.unmount();

    mount();
    expect(screen.getByPlaceholderText(/type a reply/i)).toHaveValue("");
  });

  it("clears the stored draft on a verified send", async () => {
    const user = userEvent.setup();
    const first = mount();
    await user.type(screen.getByPlaceholderText(/type a reply/i), "looks good");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.getByPlaceholderText(/type a reply/i)).toHaveValue(""));
    first.unmount();

    mount();
    expect(screen.getByPlaceholderText(/type a reply/i)).toHaveValue("");
  });
});

// A placeholder is a LABEL, and it may not decide how tall this control is.
//
// `ui/chat/chat-input.tsx` carries `field-sizing-content`, so an EMPTY textarea takes its height
// from the placeholder — measured in Chrome at a 390px viewport, 46px with a one-line placeholder
// and 70px with a wrapping one. That put the composer at a different height in different LOCALES
// (9 of the 36 composer placeholder strings in the six dictionaries overrun the 252px this field
// leaves), which is DESIGN.md §2 with a translated string as the state. The two classes below are
// what stop it, and they are a pair: `whitespace-nowrap` keeps it to one line, `overflow-hidden`
// clips that line at the CONTENT box so it cannot paint out through `pr-11` and under the attach
// button. Pinned here because both look like tidy-away decoration at the call site.
describe("Composer — the placeholder cannot resize the field", () => {
  it("keeps the placeholder to one clipped line, whatever the locale gave it", () => {
    renderComposer({ readOnly: true });
    const box = screen.getByPlaceholderText(/read-only/i);

    expect(box.className).toMatch(/placeholder:whitespace-nowrap/);
    expect(box.className).toMatch(/placeholder:overflow-hidden/);
  });
});

// An uploaded host path may not push Send off the screen.
//
// A COUPLING TEST. jsdom computes no layout, so neither of the classes below can be *observed*
// working here — what each one pins is a fact about a real browser that only a class can carry
// into this file.
//
// The fact behind `wrap-anywhere`: `overflow-wrap: anywhere` and `overflow-wrap: break-word` paint
// identically, and differ in exactly one place — `anywhere` participates in INTRINSIC sizing and
// `break-word` (the textarea's UA default) does not. `ui/chat/chat-input.tsx` carries
// `field-sizing-content`, which is the property that turns an intrinsic width into a laid-out one,
// so under the default the field's min-content width was the width of the longest unbreakable
// token. `uploadFile()` appends exactly such a token — the bridge's host path for the attached
// image — so the composer row was laid out wider than the screen and Send, its last element,
// landed past the right edge. Measured in Chrome at 390px; reported as "the Send button
// disappeared after I uploaded a picture".
//
// The other half is on the wrapper (`ui/collapse.tsx`, pinned in `collapse.test.tsx`): the bottom
// region is a Collapse grid item, and a grid item's automatic minimum is `auto` on the width axis
// too, so the giant intrinsic width propagated all the way up. Both classes are needed and both
// look like tidy-away decoration at their call sites.
describe("Composer — a long upload path cannot widen the field", () => {
  it("wraps the VALUE anywhere, so no unbreakable token sets the field's intrinsic width", () => {
    renderComposer();
    const box = screen.getByPlaceholderText(/type a reply/i);

    expect(box.className).toMatch(/(?:^|\s)wrap-anywhere(?:\s|$)/);
    // …and the placeholder contract above is untouched by it: `white-space` beats `overflow-wrap`,
    // so the placeholder is still the one clipped line it was.
    expect(box.className).toMatch(/placeholder:whitespace-nowrap/);
  });

  // The path no longer reaches the field at all (ADR 0060): the chip holds it and the marker
  // holds its place. The two classes above still matter for a path the operator types or pastes.
  it("keeps an uploaded path out of the field: the marker stands in for it", async () => {
    const path = "/home/operator/.local/share/collie/uploads/2026-08-31T09-14-22-a1b2c3d4e5f6.png";
    server.use(http.post(/\/api\/pane\/[^/]+\/upload$/, () => HttpResponse.json({ ok: true, path })));
    renderComposer();
    const box = screen.getByPlaceholderText(/type a reply/i);
    const file = new File(["x"], "shot.png", { type: "image/png" });

    fireEvent.paste(box, {
      clipboardData: { items: [{ kind: "file", type: "image/png", getAsFile: () => file }] },
    });

    await waitFor(() => expect(box).toHaveValue("[Image #1] "));
    expect(box).not.toHaveValue(expect.stringContaining(path));
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
  });
});

// ── THE PICKER ASKS WHICH, BECAUSE ONE INPUT CANNOT ─────────────────────────────────────────────
//
// A phone offers the camera roll only when every entry in `accept` maps to a gallery, so the
// extension list that makes a `.md` pickable is what hid the gallery: the attach button opened the
// file browser and nothing else. Two inputs, and one question in front of them.
describe("Composer — the attach picker offers photos as well as files", () => {
  beforeEach(() => __resetOperatorCommands());
  afterEach(() => __resetOperatorCommands());

  function publishUpload(upload: { maxBytes: number; imageTypes: string[]; textTypes: string[] }) {
    server.use(
      http.get("/api/config", () => HttpResponse.json({ push: false, vapidPublicKey: "", upload })),
    );
  }

  it("the photos input asks for image/* alone, whatever else the bridge publishes", async () => {
    publishUpload({ maxBytes: 10 * 1024 * 1024, imageTypes: ["png"], textTypes: ["md", "ts"] });
    renderComposer();
    await waitFor(() =>
      expect(screen.getByTestId("attach-files")).toHaveAttribute("accept", "image/*,.png,.md,.ts"),
    );
    expect(screen.getByTestId("attach-photos")).toHaveAttribute("accept", "image/*");
  });

  it("flashes the icon and buzzes on the tap, and lets go once nothing is standing on it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const buzzes: unknown[] = [];
    // `navigator.vibrate` is undefined in jsdom, which is also how iOS Safari behaves — so the
    // stub is what makes the call observable, not a change in behaviour.
    Object.defineProperty(navigator, "vibrate", {
      configurable: true,
      value: (ms: number) => {
        buzzes.push(ms);
        return true;
      },
    });
    // The PHOTOS-ONLY host, deliberately: there the tap opens a native picker and nothing else, so
    // the flash is the whole of the acknowledgement and its timer is observable. On a host that
    // opens the picker menu the button stays lit for as long as that menu stands, which the
    // anchored-picker test above covers.
    publishUpload({ maxBytes: 10 * 1024 * 1024, imageTypes: ["png"], textTypes: [] });
    renderComposer();
    await waitFor(() =>
      expect(screen.getByTestId("attach-files")).toHaveAttribute("accept", "image/*,.png"),
    );

    // Anchored on whitespace: the ghost variant carries `hover:bg-accent` at rest, and a bare
    // substring match would read that as the pressed tone on every render.
    const PRESSED = /(^|\s)bg-primary(\s|$)/;
    const attach = screen.getByRole("button", { name: "Attach file" });
    expect(attach.className).not.toMatch(PRESSED);
    await user.click(attach);
    expect(buzzes).toHaveLength(1);
    expect(attach.className).toMatch(PRESSED);

    // The flash is a timer, not a state the button can get stuck in.
    await vi.advanceTimersByTimeAsync(400);
    await waitFor(() => expect(attach.className).not.toMatch(PRESSED));
  });

  it("opens the two-row picker on a bridge that takes text as well, ABOVE the button", async () => {
    const user = userEvent.setup();
    publishUpload({ maxBytes: 10 * 1024 * 1024, imageTypes: ["png"], textTypes: ["md"] });
    renderComposer();
    await waitFor(() =>
      expect(screen.getByTestId("attach-files")).toHaveAttribute("accept", "image/*,.png,.md"),
    );
    const attach = screen.getByRole("button", { name: "Attach file" });
    expect(attach).toHaveAttribute("aria-expanded", "false");
    await user.click(attach);
    expect(await screen.findByRole("button", { name: "Photos" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Files" })).toBeInTheDocument();
    expect(attach).toHaveAttribute("aria-expanded", "true");
    // ABOVE, not over. A bottom sheet covered this button 42ms after the tap, which is what made
    // its press highlight unseeable; the anchor is what the highlight depends on.
    expect(screen.getByRole("dialog").className).toMatch(/(^|\s)bottom-full(\s|$)/);
    // And the trigger stays lit under its own open menu.
    expect(attach.className).toMatch(/(^|\s)bg-primary(\s|$)/);
  });

  it("a photos-only bridge opens the camera roll directly — no sheet with one answer in it", async () => {
    const user = userEvent.setup();
    publishUpload({ maxBytes: 10 * 1024 * 1024, imageTypes: ["png"], textTypes: [] });
    renderComposer();
    await waitFor(() =>
      expect(screen.getByTestId("attach-files")).toHaveAttribute("accept", "image/*,.png"),
    );
    let opened: string | null = null;
    for (const id of ["attach-photos", "attach-files"]) {
      screen.getByTestId(id).addEventListener("click", () => {
        opened = id;
      });
    }
    await user.click(screen.getByRole("button", { name: "Attach file" }));
    expect(screen.queryByRole("button", { name: "Photos" })).not.toBeInTheDocument();
    expect(opened).toBe("attach-photos");
  });

  it("each row opens its own input, and the sheet closes behind it", async () => {
    const user = userEvent.setup();
    publishUpload({ maxBytes: 10 * 1024 * 1024, imageTypes: ["png"], textTypes: ["md"] });
    renderComposer();
    await waitFor(() =>
      expect(screen.getByTestId("attach-files")).toHaveAttribute("accept", "image/*,.png,.md"),
    );
    const opened: string[] = [];
    for (const id of ["attach-photos", "attach-files"]) {
      screen.getByTestId(id).addEventListener("click", () => opened.push(id));
    }

    await user.click(screen.getByRole("button", { name: "Attach file" }));
    await user.click(await screen.findByRole("button", { name: "Photos" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Photos" })).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Attach file" }));
    await user.click(await screen.findByRole("button", { name: "Files" }));
    expect(opened).toEqual(["attach-photos", "attach-files"]);
  });
});

// ── THE COMPOSER IS ONE BOX, ONE ROW (.adr/0057, amended twice on 2026-09-22) ───────────────────
//
// The field, the attach control and Send used to be three shapes on one line. They are one bordered
// container now, the prompt-input pattern the shadcn-registry chat kits settled on, ported by hand.
// For one round the box put a toolbar row under the field; on a phone that was a second row of
// height on an empty composer, so the box is ONE row: the field, attach, the primary action — attach
// stood at the left for one round, then moved back beside Send, where it was before this ADR.
//
// These are STRUCTURAL and COUPLING assertions, in the house style of the two blocks above: jsdom
// measures no layout, so what a class carries into this file is a fact about a real browser. What
// each one stops is named at the assertion.
describe("Composer — the composer is one box", () => {
  const field = () => screen.getByPlaceholderText(/type a reply/i);
  /** The bordered container: the field's own parent, which is where the frame is drawn. */
  const boxOf = (el: HTMLElement) => el.parentElement!;
  const attach = () => screen.getByRole("button", { name: "Attach file" });

  // THE SEND KEY IS UNCHANGED BY THE NEW SHAPE, and it is the first thing a ported pattern gets
  // wrong: every kit this was read from sends on a bare Enter. Enter is a shell character here, so
  // it must stay a newline, and Cmd/Ctrl+Enter is the submit. Nothing pinned this before.
  it("still sends on Ctrl+Enter, and still leaves a bare Enter to the textarea", async () => {
    const user = userEvent.setup();
    const props = renderComposer();

    await user.type(field(), "looks good");
    // `fireEvent` returns false when the handler called preventDefault, so this reads the two
    // decisions directly: the plain key is handed to the textarea, the modified one is taken.
    expect(fireEvent.keyDown(field(), { key: "Enter" })).toBe(true);
    expect(props.onSent).not.toHaveBeenCalled();
    expect(field()).toHaveValue("looks good");

    expect(fireEvent.keyDown(field(), { key: "Enter", ctrlKey: true })).toBe(false);
    await waitFor(() => expect(field()).toHaveValue(""));
    expect(props.onSent).toHaveBeenCalled();
  });

  it("sends on Cmd+Enter too, for a keyboard-attached phone and a Mac", async () => {
    const user = userEvent.setup();
    const props = renderComposer();

    await user.type(field(), "ship it");
    expect(fireEvent.keyDown(field(), { key: "Enter", metaKey: true })).toBe(false);
    await waitFor(() => expect(field()).toHaveValue(""));
    expect(props.onSent).toHaveBeenCalled();
  });

  it("holds the field, attach and the primary action as siblings on ONE row of the box", async () => {
    renderComposer();
    const box = boxOf(field());
    const send = screen.getByRole("button", { name: "Send" });

    // One row, no toolbar row under the field: the three are direct children of the box, in
    // reading order field, attach, action — attach next to the primary action, as it stood
    // before the one-box change.
    expect(attach().parentElement).toBe(box);
    expect(send.parentElement).toBe(box);
    const order = [...box.children].filter((el) => el === attach() || el === field() || el === send);
    expect(order).toEqual([field(), attach(), send]);
    // The box IS the flex row, and `items-end` pins both buttons to the bottom edge while a long
    // draft grows the field upward.
    expect(box.className).toMatch(/(?:^|\s)flex(?=\s|$)/);
    expect(box.className).toMatch(/(?:^|\s)items-end(?=\s|$)/);
    expect(box.className).not.toMatch(/(?:^|\s)flex-col(?=\s|$)/);
    // The field takes the width the buttons leave, and the buttons never give theirs up.
    expect(field().className).toMatch(/(?:^|\s)flex-1(?=\s|$)/);
    expect(attach().className).toMatch(/(?:^|\s)shrink-0(?=\s|$)/);
    expect(send.className).toMatch(/(?:^|\s)shrink-0(?=\s|$)/);
  });

  // AN EMPTY COMPOSER IS ONE BUTTON ROW TALL. The buttons are 36px; the box's `p-1` is their 4px
  // hit-area reach, so the inside of the box is 44px. The field claims one line against the 36px
  // face and no more: `min-h-9` with `py-1.5`, and nothing taller left over from the primitive.
  it("claims one button row of height for an empty field, and no second row", () => {
    renderComposer();
    const box = boxOf(field());
    expect(box.className).toMatch(/(?:^|\s)p-1(?=\s|$)/);
    expect(field().className).toMatch(/(?:^|\s)min-h-9(?=\s|$)/);
    expect(field().className).toMatch(/(?:^|\s)py-1\.5(?=\s|$)/);
    expect(field().className).not.toMatch(/(?:^|\s)min-h-(?:1[0-9]|[2-9][0-9])(?=\s|$)/);
    expect(field()).toHaveAttribute("rows", "1");
  });

  it("draws ONE frame and ONE focus mark on the box, and none of it on the textarea", () => {
    renderComposer();
    const box = boxOf(field());

    // The frame. `focus-within`, so a caret in the textarea marks the whole shape: the border takes
    // the ring colour and a 1px ring (a box-shadow) thickens it, which costs no layout (DESIGN.md
    // §2). That is the visible focus indicator, and it is the only one.
    expect(box.className).toMatch(/(?:^|\s)rounded-xl(?=\s|$)/);
    expect(box.className).toMatch(/(?:^|\s)border-input(?=\s|$)/);
    expect(box.className).toMatch(/(?:^|\s)focus-within:border-ring(?=\s|$)/);
    expect(box.className).toMatch(/(?:^|\s)focus-within:ring-1(?=\s|$)/);
    expect(box.className).toMatch(/(?:^|\s)focus-within:ring-ring(?=\s|$)/);
    // …and NO second frame outside it. An offset outline on top of the ring-coloured border drew
    // two frames around one field, which is the defect this amendment fixed.
    expect(box.className).not.toMatch(/outline-offset/);
    expect(box.className).not.toMatch(/focus-within:outline-(?:1|2|4|8|ring)/);

    // The inner control draws no frame of its own either.
    expect(field().className).toMatch(/(?:^|\s)border-0(?=\s|$)/);
    expect(field().className).not.toMatch(/(?:^|\s)rounded-/);
    expect(field().className).not.toMatch(/focus-visible:outline-2/);
    expect(field().className).not.toMatch(/focus-visible:border-ring/);
    expect(field().className).not.toMatch(/focus-visible:ring/);
  });

  // A 200-CHARACTER UNBROKEN PATH MAY NOT PUSH THE PRIMARY ACTION OFF THE SCREEN.
  //
  // `uploadFile()` appends the bridge's host path for an attached image, one run of `/`-joined
  // characters with no break opportunity. The field is `field-sizing-content`, so under the
  // textarea's UA `break-word` that token would become the field's laid-out width, and Send, beside
  // it on the same row, would go off the right edge: the "the Send button disappeared after I
  // uploaded a picture" report. Two independent things stop it and this pins both: the value wraps
  // ANYWHERE, and the field is `min-w-0`, so as a flex item it may be narrower than its content.
  it("keeps the primary action in the row under a 200-character unbroken path", async () => {
    const path = `/home/operator/${"a".repeat(181)}.png`;
    expect(path.length).toBeGreaterThanOrEqual(200);
    renderComposer();

    fireEvent.change(field(), { target: { value: path } });
    await waitFor(() => expect(field()).toHaveValue(path));

    expect(field().className).toMatch(/(?:^|\s)wrap-anywhere(?=\s|$)/);
    expect(field().className).toMatch(/(?:^|\s)min-w-0(?=\s|$)/);
    const send = screen.getByRole("button", { name: "Send" });
    // Still in the box's one row, beside the field, after the field.
    expect(send.parentElement).toBe(field().parentElement);
    expect(field().compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Nothing in the field reserves a horizontal strip for a control, so the path has the field's
    // whole width to wrap into.
    expect(field().className).not.toMatch(/(?:^|\s)pr-/);
  });

  // DESIGN.md §6: 44px is the floor for anything tappable, and both buttons in the box are drawn at
  // 36px. They buy the floor back as HIT AREA, the trade that section sanctions, and the reach is
  // the arithmetic at `TOOLBAR_TAP_TARGET`: 36 + 4 + 4 = 44 in both axes. Drawn size and hit area
  // are one decision here; a `size-9` that loses the `::before` is a 36px target.
  it("buys the 44px tap floor back on both buttons in the box", () => {
    renderComposer();
    for (const button of [attach(), screen.getByRole("button", { name: "Send" })]) {
      expect(button.className).toMatch(/(?:^|\s)size-9(?=\s|$)/);
      expect(button.className).toMatch(/(?:^|\s)relative(?=\s|$)/);
      expect(button.className).toMatch(/before:-inset-1/);
    }
  });

  it("recedes the whole box when nothing may be written to it, and disables both buttons", () => {
    renderComposer({ readOnly: true });
    const box = screen.getByPlaceholderText(/read-only/i).parentElement!;

    // The surface says it, not just the placeholder. `bg-muted/40` is last in the cn(), so
    // tailwind-merge drops the `bg-background` it replaces.
    expect(box.className).toMatch(/(?:^|\s)bg-muted\/40(?=\s|$)/);
    expect(box.className).not.toMatch(/(?:^|\s)bg-background(?=\s|$)/);
    expect(attach()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });
});

// ── AN ATTACHMENT IS A CHIP, AND ITS MARKER HOLDS ITS PLACE (ADR 0060) ──────────────────────────
//
// An upload used to write the bridge's host path into the draft. Now it adds a chip above the field
// and a `[Image #N]` / `[File #N]` marker where the caret stood; Send swaps each marker for its
// path, and a chip whose marker was edited away sends its path in front. Asserted at the network
// (the guard's typed text), because the line the terminal gets is the whole point.
describe("Composer — an attachment is a chip (ADR 0060)", () => {
  /** The upload route, answering each upload with the next path in order (the picker uploads one
   *  by one, in pick order), then `/tmp/upload-N` once the list runs out. */
  function uploadAnswers(...paths: string[]) {
    let calls = 0;
    server.use(
      http.post(/\/api\/pane\/[^/]+\/upload$/, () => {
        calls += 1;
        return HttpResponse.json({ ok: true, path: paths[calls - 1] ?? `/tmp/upload-${calls}` });
      }),
    );
  }

  function pick(...files: File[]) {
    // SAFETY: `getByTestId` throws when the element is absent, and this id is on an `<input>`.
    const photos = screen.getByTestId("attach-photos") as HTMLInputElement;
    fireEvent.change(photos, { target: { files } });
  }

  const png = (name: string) => new File(["x"], name, { type: "image/png" });
  // SAFETY: the composer's only placeholder-bearing control is its ChatInput, a `<textarea>`, and
  // `getByPlaceholderText` throws when it is absent.
  const field = () => screen.getByPlaceholderText(/type a reply/i) as HTMLTextAreaElement;

  it("adds a chip, and puts its marker at the caret without touching the text around it", async () => {
    uploadAnswers("/a.png");
    renderComposer();
    fireEvent.change(field(), { target: { value: "see this" } });
    act(() => {
      field().focus();
      field().setSelectionRange(3, 3);
    });

    pick(png("a.png"));

    await waitFor(() => expect(field()).toHaveValue("see [Image #1] this"));
    const list = screen.getByRole("list", { name: "Attachments" });
    expect(list).toHaveTextContent("#1");
    expect(screen.getByRole("button", { name: "Remove a.png" })).toBeInTheDocument();
  });

  it("puts the marker at the end when the field never had a caret", async () => {
    uploadAnswers();
    renderComposer();
    fireEvent.change(field(), { target: { value: "hello" } });
    act(() => field().blur());
    // A change with no caret report of its own: jsdom leaves selectionStart at the end.
    pick(png("a.png"));
    await waitFor(() => expect(field()).toHaveValue("hello [Image #1] "));
  });

  it("marks a multi-photo pick in pick order, one chip each (PR #259)", async () => {
    uploadAnswers();
    renderComposer();

    pick(png("first.png"), png("second.png"), png("third.png"));

    await waitFor(() => expect(field()).toHaveValue("[Image #1] [Image #2] [Image #3] "));
    const removes = screen.getAllByRole("button", { name: /^Remove / });
    expect(removes.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Remove first.png",
      "Remove second.png",
      "Remove third.png",
    ]);
  });

  it("the x removes the chip and its marker, with the space beside it", async () => {
    const user = userEvent.setup();
    uploadAnswers();
    renderComposer();
    fireEvent.change(field(), { target: { value: "see this" } });
    act(() => {
      field().focus();
      field().setSelectionRange(3, 3);
    });
    pick(png("a.png"));
    await waitFor(() => expect(field()).toHaveValue("see [Image #1] this"));

    await user.click(screen.getByRole("button", { name: "Remove a.png" }));

    expect(field()).toHaveValue("see this");
    expect(screen.queryByRole("list", { name: "Attachments" })).toBeNull();
    expect(loadDraftEntry(undefined, "w1:p1")?.attachments).toEqual([]);
  });

  it("Send swaps each marker for its path, where it stands", async () => {
    const user = userEvent.setup();
    const typed: string[] = [];
    uploadAnswers("/a.png", "/b.png");
    server.use(...replyHandler((t) => typed.push(t)));
    const props = renderComposer();

    fireEvent.change(field(), { target: { value: "look at " } });
    pick(png("a.png"));
    await waitFor(() => expect(field()).toHaveValue("look at [Image #1] "));
    fireEvent.change(field(), { target: { value: `${field().value}and ` } });
    act(() => field().setSelectionRange(field().value.length, field().value.length));
    pick(png("b.png"));
    await waitFor(() => expect(field()).toHaveValue("look at [Image #1] and [Image #2] "));

    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(props.onSent).toHaveBeenCalled());
    expect(typed).toEqual(["look at /a.png and /b.png"]);
    // Text and chips leave together, and the next draft numbers from #1 again.
    expect(field()).toHaveValue("");
    expect(screen.queryByRole("list", { name: "Attachments" })).toBeNull();
    expect(loadDraftEntry(undefined, "w1:p1")).toBeNull();
  });

  it("a chip whose marker was edited away sends its path in front, and is never dropped", async () => {
    const user = userEvent.setup();
    const typed: string[] = [];
    uploadAnswers("/a.png");
    server.use(...replyHandler((t) => typed.push(t)));
    const props = renderComposer();
    pick(png("a.png"));
    await waitFor(() => expect(field()).toHaveValue("[Image #1] "));

    // Deleting the marker by hand keeps the chip.
    fireEvent.change(field(), { target: { value: "hello" } });
    expect(screen.getByRole("button", { name: "Remove a.png" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(props.onSent).toHaveBeenCalled());
    expect(typed).toEqual(["/a.png hello"]);
  });

  it("leaves a marker-looking string with no chip behind it exactly as typed", async () => {
    const user = userEvent.setup();
    const typed: string[] = [];
    server.use(...replyHandler((t) => typed.push(t)));
    const props = renderComposer();
    fireEvent.change(field(), { target: { value: "[Image #7] is a label" } });

    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(props.onSent).toHaveBeenCalled());
    expect(typed).toEqual(["[Image #7] is a label"]);
  });

  // 2026-10-14, minibuch: a draft carried a stale `[Image #1]` with no chip behind it (text copied
  // from a pane that was closed), the next photo was numbered #1 again, and Send swapped BOTH copies
  // for its path. Two trailing paths became two images in Claude's box, and the send stalled.
  it("numbers a new chip past every marker already in the text, so a stale one is never its twin", async () => {
    const user = userEvent.setup();
    const typed: string[] = [];
    uploadAnswers("/a.png");
    server.use(...replyHandler((t) => typed.push(t)));
    const props = renderComposer();
    fireEvent.change(field(), { target: { value: "look at this [Image #1]" } });
    pick(png("a.png"));
    await waitFor(() => expect(field()).toHaveValue("look at this [Image #1] [Image #2] "));

    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(props.onSent).toHaveBeenCalled());
    expect(typed).toEqual(["look at this [Image #1] /a.png"]);
  });

  it("chips alone are something to send: Send is enabled and sends the paths", async () => {
    const user = userEvent.setup();
    const typed: string[] = [];
    uploadAnswers("/a.png");
    server.use(...replyHandler((t) => typed.push(t)));
    const props = renderComposer();
    pick(png("a.png"));
    await waitFor(() => expect(field()).toHaveValue("[Image #1] "));
    fireEvent.change(field(), { target: { value: "" } });

    const send = screen.getByRole("button", { name: "Send" });
    expect(send).toBeEnabled();
    await user.click(send);
    await waitFor(() => expect(props.onSent).toHaveBeenCalled());
    expect(typed).toEqual(["/a.png"]);
  });

  it("the destructive confirm reads the composed line, paths included", async () => {
    const user = userEvent.setup();
    const typed: string[] = [];
    uploadAnswers("/a.png");
    server.use(...replyHandler((t) => typed.push(t)));
    renderComposerWithStatus();
    fireEvent.change(field(), { target: { value: "rm -rf " } });
    act(() => field().setSelectionRange(7, 7));
    pick(png("a.png"));
    await waitFor(() => expect(field()).toHaveValue("rm -rf [Image #1] "));

    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("button", { name: /really send/i })).toBeInTheDocument();
    expect(typed).toEqual([]);
  });

  it("a failed send keeps the chips and the text", async () => {
    const user = userEvent.setup();
    uploadAnswers("/a.png");
    server.use(
      http.post("/api/send", () => HttpResponse.json({ error: "pane unavailable" }, { status: 500 })),
    );
    const props = renderComposerWithStatus();
    pick(png("a.png"));
    await waitFor(() => expect(field()).toHaveValue("[Image #1] "));
    fireEvent.change(field(), { target: { value: "[Image #1] look" } });

    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.getByTestId("status")).not.toHaveTextContent(/^$/));

    expect(props.onSent).not.toHaveBeenCalled();
    expect(field()).toHaveValue("[Image #1] look");
    expect(screen.getByRole("button", { name: "Remove a.png" })).toBeInTheDocument();
  });

  it("stores the chips with the draft, and a reload keeps the numbering going", async () => {
    uploadAnswers("/a.png", "/b.png");
    renderComposer();
    pick(png("a.png"));
    await waitFor(() => expect(field()).toHaveValue("[Image #1] "));
    expect(loadDraftEntry(undefined, "w1:p1")).toEqual({
      text: "[Image #1] ",
      attachments: [{ n: 1, path: "/a.png", name: "a.png", kind: "image" }],
      next: 2,
    });

    // A fresh mount reads it back: the chip returns as an icon tile (no preview survives a reload).
    cleanup();
    renderComposer();
    expect(field()).toHaveValue("[Image #1] ");
    expect(screen.getByRole("button", { name: "Remove a.png" })).toBeInTheDocument();
    expect(screen.queryByRole("img")).toBeNull();

    act(() => field().setSelectionRange(field().value.length, field().value.length));
    pick(png("b.png"));
    await waitFor(() => expect(field()).toHaveValue("[Image #1] [Image #2] "));
  });

  it("never reuses a removed chip's number within the draft", async () => {
    const user = userEvent.setup();
    uploadAnswers();
    renderComposer();
    fireEvent.change(field(), { target: { value: "keep " } });
    pick(png("a.png"), png("b.png"));
    await waitFor(() => expect(field()).toHaveValue("keep [Image #1] [Image #2] "));
    await user.click(screen.getByRole("button", { name: "Remove b.png" }));
    expect(field()).toHaveValue("keep [Image #1] ");

    act(() => field().setSelectionRange(field().value.length, field().value.length));
    pick(png("c.png"));
    await waitFor(() => expect(field()).toHaveValue("keep [Image #1] [Image #3] "));
  });

  it("an old text-only draft still loads, with no chips", () => {
    localStorage.setItem("collie:draft:default:w1:p1", JSON.stringify({ text: "from before", at: Date.now() }));
    renderComposer();
    expect(field()).toHaveValue("from before");
    expect(screen.queryByRole("list", { name: "Attachments" })).toBeNull();
  });

  it("a restored draft that is only chips still offers Send", () => {
    saveDraft(undefined, "w1:p1", "", [{ n: 1, path: "/a.png", name: "a.png", kind: "image" }], 2);
    renderComposer();
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Remove a.png" })).toBeInTheDocument();
  });

  describe("with object URLs", () => {
    const created: string[] = [];
    const revoked: string[] = [];
    // jsdom has no object URLs at all, so each case defines the two statics and removes them again.
    function defineStatic(name: "createObjectURL" | "revokeObjectURL", value: ((file: Blob) => string) | ((url: string) => void)) {
      Object.defineProperty(URL, name, { value, configurable: true, writable: true });
    }
    beforeEach(() => {
      created.length = 0;
      revoked.length = 0;
      defineStatic("createObjectURL", () => {
        const url = `blob:test/${created.length + 1}`;
        created.push(url);
        return url;
      });
      defineStatic("revokeObjectURL", (url: string) => {
        revoked.push(url);
      });
    });
    afterEach(() => {
      __resetOperatorCommands();
      Reflect.deleteProperty(URL, "createObjectURL");
      Reflect.deleteProperty(URL, "revokeObjectURL");
    });

    it("draws a photo as a thumbnail, and releases it when its chip is removed", async () => {
      const user = userEvent.setup();
      uploadAnswers();
      renderComposer();
      pick(png("a.png"));
      const thumb = await screen.findByRole("img", { name: "a.png" });
      expect(thumb).toHaveAttribute("src", "blob:test/1");

      await user.click(screen.getByRole("button", { name: "Remove a.png" }));
      expect(revoked).toEqual(["blob:test/1"]);
    });

    it("releases every thumbnail on send and on unmount", async () => {
      const user = userEvent.setup();
      uploadAnswers();
      server.use(...replyHandler(() => {}));
      const props = renderComposer();
      pick(png("a.png"));
      await screen.findByRole("img", { name: "a.png" });
      await user.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(props.onSent).toHaveBeenCalled());
      expect(revoked).toEqual(["blob:test/1"]);

      pick(png("b.png"));
      await screen.findByRole("img", { name: "b.png" });
      cleanup();
      expect(revoked).toEqual(["blob:test/1", "blob:test/2"]);
    });

    it("draws a non-image file as a named tile, never a thumbnail", async () => {
      __resetOperatorCommands();
      server.use(
        http.get("/api/config", () =>
          HttpResponse.json({
            push: false,
            vapidPublicKey: "",
            upload: { maxBytes: 10 * 1024 * 1024, imageTypes: ["png"], textTypes: ["md"] },
          }),
        ),
      );
      uploadAnswers();
      renderComposer();
      await waitFor(() => expect(screen.getByTestId("attach-files")).toHaveAttribute("accept", "image/*,.png,.md"));
      // SAFETY: `getByTestId` throws when the element is absent, and this id is on an `<input>`.
      const files = screen.getByTestId("attach-files") as HTMLInputElement;
      fireEvent.change(files, {
        target: { files: [new File(["# hi"], "a-rather-long-notes-file.md", { type: "text/markdown" })] },
      });
      await waitFor(() => expect(field()).toHaveValue("[File #1] "));
      expect(screen.queryByRole("img")).toBeNull();
      expect(created).toEqual([]);
      expect(screen.getByRole("list", { name: "Attachments" })).toHaveTextContent("a-rather-long…");
    });

  });
});

// THE BELT'S X AND ITS UNDO (M40 spec 04, issue #291; Altan, 2026-09-26/27). An icon-only X on the
// belt's pinned block while the phone's box holds text or chips. One tap empties the text, the chips
// and the stored draft of this pane and sends nothing to the pane; the slot then shows Undo until the
// next act (no timer), and Undo puts all three back.
describe("Composer — the belt's clear control (M40 spec 04, #291)", () => {
  const chip = { n: 1, path: "/tmp/a.png", name: "a.png", kind: "image" as const };
  // SAFETY: the composer's only placeholder-bearing control is its ChatInput, a `<textarea>`, and
  // `getByPlaceholderText` throws when it is absent.
  const field = () => screen.getByPlaceholderText(/type a reply/i) as HTMLTextAreaElement;
  const xButton = () => screen.queryByRole("button", { name: "Clear message" });
  const undoButton = () => screen.queryByRole("button", { name: "Undo clear" });

  /** Every request that is not a read, as `METHOD /path`. The X and Undo must add none: no key, no
   *  reply, no upload reaches any pane. */
  const writes: string[] = [];
  function logWrites({ request }: { request: Request }) {
    if (request.method !== "GET") writes.push(`${request.method} ${new URL(request.url).pathname}`);
  }
  beforeEach(() => {
    writes.length = 0;
    server.events.on("request:start", logWrites);
  });
  afterEach(() => {
    server.events.removeListener("request:start", logWrites);
    vi.useRealTimers();
  });

  function pick(...files: File[]) {
    // SAFETY: `getByTestId` throws when the element is absent, and this id is on an `<input>`.
    const photos = screen.getByTestId("attach-photos") as HTMLInputElement;
    fireEvent.change(photos, { target: { files } });
  }

  it("draws no X on an empty box", () => {
    renderComposer();
    expect(xButton()).not.toBeInTheDocument();
    expect(undoButton()).not.toBeInTheDocument();
  });

  it("draws the X on the belt once the box holds text, and takes it away when the text goes", () => {
    renderComposer();
    fireEvent.change(field(), { target: { value: "half a thought" } });
    const x = xButton();
    expect(x).toBeInTheDocument();
    expect(x!.closest('[data-slot="composer-actions"]')).not.toBeNull();
    fireEvent.change(field(), { target: { value: "" } });
    expect(xButton()).not.toBeInTheDocument();
  });

  it("draws the X for a box that holds only a chip", () => {
    saveDraft(undefined, "w1:p1", "", [chip], 2);
    renderComposer();
    expect(field()).toHaveValue("");
    expect(xButton()).toBeInTheDocument();
  });

  it("one tap clears the text, the chips and the stored draft, and sends nothing to the pane", async () => {
    const user = userEvent.setup();
    saveDraft(undefined, "w1:p1", "see [Image #1] this", [chip], 2);
    renderComposer();
    expect(screen.getByRole("button", { name: "Remove a.png" })).toBeInTheDocument();

    await user.click(xButton()!);

    expect(field()).toHaveValue("");
    expect(screen.queryByRole("button", { name: "Remove a.png" })).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Attachments" })).not.toBeInTheDocument();
    expect(loadDraftEntry(undefined, "w1:p1")).toBeNull();
    // The slot is Undo now, and the empty box is back to its microphone-or-Send rest.
    expect(undoButton()).toBeInTheDocument();
    expect(xButton()).not.toBeInTheDocument();
    expect(writes).toEqual([]);
  });

  it("clear, then Undo: the text, the chips, their numbering and the stored draft all come back", async () => {
    const user = userEvent.setup();
    saveDraft(undefined, "w1:p1", "see [Image #1] this", [chip], 2);
    renderComposer();

    await user.click(xButton()!);
    await user.click(undoButton()!);

    expect(field()).toHaveValue("see [Image #1] this");
    expect(screen.getByRole("button", { name: "Remove a.png" })).toBeInTheDocument();
    expect(loadDraftEntry(undefined, "w1:p1")).toEqual({ text: "see [Image #1] this", attachments: [chip], next: 2 });
    // The window is spent: the box holds a draft again, so the slot is the X again.
    expect(undoButton()).not.toBeInTheDocument();
    expect(xButton()).toBeInTheDocument();
    expect(writes).toEqual([]);
  });

  it("clear keeps the numbering it restarted: a chip after an Undo continues from the old next", async () => {
    const user = userEvent.setup();
    saveDraft(undefined, "w1:p1", "[Image #1] [Image #2] ", [chip, { ...chip, n: 2, name: "b.png" }], 3);
    renderComposer();
    await user.click(xButton()!);
    // Cleared, the draft is gone from the store, numbering and all.
    expect(loadDraftEntry(undefined, "w1:p1")).toBeNull();
    await user.click(undoButton()!);
    expect(loadDraftEntry(undefined, "w1:p1")?.next).toBe(3);
  });

  it("clear: Undo has no timer, it stands until the next act", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderComposer();
    fireEvent.change(field(), { target: { value: "never mind" } });

    await user.click(xButton()!);
    expect(undoButton()).toBeInTheDocument();

    // Altan, 2026-09-27: a slot that left on a clock narrowed the pinned block under a tap on its way.
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(undoButton()).toBeInTheDocument();
  });

  it("clear: a tap on another belt control ends Undo, and the draft stays gone", async () => {
    const user = userEvent.setup();
    renderComposer();
    fireEvent.change(field(), { target: { value: "never mind" } });
    await user.click(xButton()!);
    expect(undoButton()).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Keys" }));

    expect(undoButton()).not.toBeInTheDocument();
    // An empty box after the window: the slot empties, nothing comes back.
    expect(xButton()).not.toBeInTheDocument();
    expect(field()).toHaveValue("");
    expect(loadDraftEntry(undefined, "w1:p1")).toBeNull();
  });

  it("clear: the next keystroke ends the Undo window, and the slot is the X again", async () => {
    const user = userEvent.setup();
    renderComposer();
    fireEvent.change(field(), { target: { value: "first try" } });
    await user.click(xButton()!);

    await user.type(field(), "n");

    expect(field()).toHaveValue("n");
    expect(undoButton()).not.toBeInTheDocument();
    expect(xButton()).toBeInTheDocument();
    // The keystroke's draft is the stored one, never the cleared text.
    expect(loadDraftEntry(undefined, "w1:p1")?.text).toBe("n");
  });

  it("clear: a new chip ends the Undo window, and numbers from #1 again", async () => {
    const user = userEvent.setup();
    server.use(http.post(/\/api\/pane\/[^/]+\/upload$/, () => HttpResponse.json({ ok: true, path: "/tmp/new.png" })));
    saveDraft(undefined, "w1:p1", "[Image #1] ", [chip], 2);
    renderComposer();
    await user.click(xButton()!);

    pick(new File(["x"], "new.png", { type: "image/png" }));

    await waitFor(() => expect(field()).toHaveValue("[Image #1] "));
    expect(screen.getByRole("button", { name: "Remove new.png" })).toBeInTheDocument();
    expect(undoButton()).not.toBeInTheDocument();
    expect(xButton()).toBeInTheDocument();
  });

  it("clear: a pane switch ends the Undo window, and the cleared draft never comes back", async () => {
    const user = userEvent.setup();
    let swap: ((id: string) => void) | null = null;
    function Harness() {
      const [paneId, setPaneId] = useState("w1:p1");
      swap = setPaneId;
      return (
        <Composer
          paneId={paneId}
          agent="claude"
          isShell={false}
          gone={false}
          readOnly={false}
          surface={FREE}
          text="pane output"
          terminalDraft={null}
          rawTerminalDraft={null}
          prefs={{ wrap: true, fontSize: 11, draftFontSize: 14, chatFontSize: 14, fontFamily: "system", rawTerminal: false, tapToFocus: true, expandClippedReply: true }}
          display={{ open: false, onToggle: vi.fn() }}
          onSent={vi.fn()}
        />
      );
    }
    render(<RouterProvider router={createMemoryRouter([{ path: "/", element: <Harness /> }])} />);
    fireEvent.change(field(), { target: { value: "for pane A" } });
    await user.click(xButton()!);
    expect(undoButton()).toBeInTheDocument();

    act(() => swap?.("w1:p2"));
    expect(undoButton()).not.toBeInTheDocument();
    act(() => swap?.("w1:p1"));
    expect(field()).toHaveValue("");
    expect(undoButton()).not.toBeInTheDocument();
    expect(loadDraftEntry(undefined, "w1:p1")).toBeNull();
  });

  it("clear: a remount (a page reload) finds the box empty, with no Undo window and no X", async () => {
    const user = userEvent.setup();
    const first = render(
      <RouterProvider router={createMemoryRouter([{ path: "/", element: <ComposerForReload /> }])} />,
    );
    fireEvent.change(field(), { target: { value: "not this one" } });
    await user.click(xButton()!);
    expect(undoButton()).toBeInTheDocument();

    first.unmount();
    render(<RouterProvider router={createMemoryRouter([{ path: "/", element: <ComposerForReload /> }])} />);

    expect(field()).toHaveValue("");
    // The Undo window lived in memory only, and a reload ends it.
    expect(undoButton()).not.toBeInTheDocument();
    expect(xButton()).not.toBeInTheDocument();
  });

  it("clear keeps the field focused, so the phone keyboard stays up", async () => {
    const user = userEvent.setup();
    renderComposer();
    await user.click(field());
    await user.keyboard("hello");
    expect(field()).toHaveFocus();

    await user.click(xButton()!);
    expect(field()).toHaveValue("");
    expect(field()).toHaveFocus();

    await user.click(undoButton()!);
    expect(field()).toHaveValue("hello");
    expect(field()).toHaveFocus();
  });

  it("clear disarms a pending Really send? confirm, because the draft it was about is gone", async () => {
    const user = userEvent.setup();
    renderComposer();
    fireEvent.change(field(), { target: { value: "rm -rf build" } });
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.getByRole("button", { name: "Really send?" })).toBeInTheDocument();

    await user.click(xButton()!);
    expect(screen.queryByRole("button", { name: "Really send?" })).not.toBeInTheDocument();
    expect(writes).toEqual([]);
  });

  describe("when the X is inert, and when it is not", () => {
    it("is inert while a send is in flight: aria-disabled, and a tap clears nothing", async () => {
      const user = userEvent.setup();
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      server.use(
        http.post<never, { id: string }>("/api/send", async ({ request }) => {
          const body = await request.json();
          await held;
          return HttpResponse.json(sendAnswer(body.id, "sent"));
        }),
      );
      const props = renderComposer();
      fireEvent.change(field(), { target: { value: "looks good" } });
      await user.click(screen.getByRole("button", { name: "Send" }));

      const x = xButton()!;
      await waitFor(() => expect(x).toHaveAttribute("aria-disabled", "true"));
      await user.click(x);
      expect(field()).toHaveValue("looks good");
      expect(undoButton()).not.toBeInTheDocument();

      release();
      await waitFor(() => expect(props.onSent).toHaveBeenCalled());
      // The request log is live: the send itself is in it, so the empty logs above are real.
      expect(writes).toContain("POST /api/send");
      // The verified send emptied the box itself, so the slot is empty, not Undo.
      expect(xButton()).not.toBeInTheDocument();
      expect(undoButton()).not.toBeInTheDocument();
    });

    it("is inert while Type is armed: the field is a live keyboard then, not a draft", async () => {
      const user = userEvent.setup();
      // Chips alone with no text: the one draft Type can still arm over.
      saveDraft(undefined, "w1:p1", "", [chip], 2);
      renderComposer();
      await user.click(screen.getByRole("button", { name: "Type into terminal" }));
      const x = xButton()!;
      expect(x).toHaveAttribute("aria-disabled", "true");
      await user.click(x);
      expect(screen.getByRole("button", { name: "Remove a.png" })).toBeInTheDocument();
    });

    it("arming Type ends an open Undo window", async () => {
      const user = userEvent.setup();
      renderComposer();
      fireEvent.change(field(), { target: { value: "draft" } });
      await user.click(xButton()!);
      expect(undoButton()).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Type into terminal" }));
      expect(undoButton()).not.toBeInTheDocument();
    });

    it("is not inert on a locked composer: the draft is this phone's own", async () => {
      const user = userEvent.setup();
      saveDraft(undefined, "w1:p1", "typed before the pane went", [], 1);
      renderComposer({ gone: true });
      // A gone pane has its own placeholder, so the field is addressed by its role here.
      const box = screen.getByRole("textbox");
      expect(box).toBeDisabled();
      const x = xButton()!;
      expect(x).not.toHaveAttribute("aria-disabled");
      await user.click(x);
      expect(box).toHaveValue("");
      expect(loadDraftEntry(undefined, "w1:p1")).toBeNull();
      await user.click(undoButton()!);
      expect(box).toHaveValue("typed before the pane went");
      expect(writes).toEqual([]);
    });
  });

  describe("with object URLs", () => {
    const revoked: string[] = [];
    beforeEach(() => {
      revoked.length = 0;
      let n = 0;
      Object.defineProperty(URL, "createObjectURL", {
        value: () => `blob:test/${++n}`,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(URL, "revokeObjectURL", {
        value: (url: string) => revoked.push(url),
        configurable: true,
        writable: true,
      });
    });
    afterEach(() => {
      Reflect.deleteProperty(URL, "createObjectURL");
      Reflect.deleteProperty(URL, "revokeObjectURL");
    });

    it("clear holds a photo's preview for Undo, and releases it only when the window ends without one", async () => {
      const user = userEvent.setup();
      server.use(http.post(/\/api\/pane\/[^/]+\/upload$/, () => HttpResponse.json({ ok: true, path: "/tmp/a.png" })));
      renderComposer();
      pick(new File(["x"], "a.png", { type: "image/png" }));
      expect(await screen.findByRole("img", { name: "a.png" })).toHaveAttribute("src", "blob:test/1");

      await user.click(xButton()!);
      expect(screen.queryByRole("img", { name: "a.png" })).not.toBeInTheDocument();
      expect(revoked).toEqual([]);

      await user.click(undoButton()!);
      expect(screen.getByRole("img", { name: "a.png" })).toHaveAttribute("src", "blob:test/1");
      expect(revoked).toEqual([]);

      // Cleared again, and this time a keystroke ends the window: now the preview goes.
      await user.click(xButton()!);
      await user.type(field(), "x");
      expect(revoked).toEqual(["blob:test/1"]);
    });

    it("clear: an Undo window open at unmount releases the previews it held", async () => {
      const user = userEvent.setup();
      server.use(http.post(/\/api\/pane\/[^/]+\/upload$/, () => HttpResponse.json({ ok: true, path: "/tmp/a.png" })));
      renderComposer();
      pick(new File(["x"], "a.png", { type: "image/png" }));
      await screen.findByRole("img", { name: "a.png" });
      await user.click(xButton()!);
      cleanup();
      expect(revoked).toEqual(["blob:test/1"]);
    });
  });
});

// THE LEFT-HAND COMPOSER (Settings -> Hand). The box runs mirrored in CSS and the DOM keeps the
// right-hand order, so the tab and reading order are the same for both hands: field, Attach, Send.
describe("Composer — hand", () => {
  beforeEach(() => __resetOperatorCommands());
  afterEach(() => __resetOperatorCommands());

  const box = () => document.querySelector<HTMLElement>('[data-slot="composer-box"]')!;
  const publishUpload = () =>
    server.use(
      http.get("/api/config", () =>
        HttpResponse.json({
          push: false,
          vapidPublicKey: "",
          upload: { maxBytes: 10 * 1024 * 1024, imageTypes: ["png"], textTypes: ["md"] },
        }),
      ),
    );

  it("is the right hand by default: the box is not mirrored and the attach panel opens right-aligned", async () => {
    const user = userEvent.setup();
    publishUpload();
    renderComposer();
    expect(box().className).not.toMatch(/(?:^|\s)flex-row-reverse(?=\s|$)/);
    expect(document.body.innerHTML).not.toMatch(/direction:(?:rtl|ltr)/);
    await user.click(await screen.findByRole("button", { name: "Attach file" }));
    const panel = await screen.findByRole("dialog", { name: "Attach" });
    expect(panel.className).toMatch(/(?:^|\s)right-0(?=\s|$)/);
    expect(panel.className).not.toMatch(/(?:^|\s)left-0(?=\s|$)/);
  });

  it("left: mirrors the box so Send, Attach, then the field read left to right, in the same DOM order", () => {
    renderComposer();
    const order = (el: HTMLElement) =>
      [...el.children]
        .map((c) => c.getAttribute("aria-label") ?? c.tagName)
        .filter((n) => ["TEXTAREA", "Attach file", "Send"].includes(n));
    const right = order(box());
    cleanup();
    renderComposer({ hand: "left" });
    expect(box().className).toMatch(/(?:^|\s)flex-row-reverse(?=\s|$)/);
    expect(order(box())).toEqual(right);
    // DOM: field, Attach, Send. Mirrored on screen that is Send, Attach, field.
    expect(right).toEqual(["TEXTAREA", "Attach file", "Send"]);
  });

  it("left: opens the attach panel left-aligned, against the side Attach stands on", async () => {
    const user = userEvent.setup();
    publishUpload();
    renderComposer({ hand: "left" });
    await user.click(await screen.findByRole("button", { name: "Attach file" }));
    const panel = await screen.findByRole("dialog", { name: "Attach" });
    expect(panel.className).toMatch(/(?:^|\s)left-0(?=\s|$)/);
    expect(panel.className).not.toMatch(/(?:^|\s)right-0(?=\s|$)/);
  });

  it("left: hands the belt the same hand, so it runs right to left with its block at the left", () => {
    renderComposer({ hand: "left" });
    const belt = document.querySelector<HTMLElement>('[data-slot="composer-actions"]')!;
    expect(belt.querySelector(".overflow-x-auto")!.className).toContain("[direction:rtl]");
  });
});

// A line copied off the mirror carries the bridge's dots, not the secret behind them. The composer
// warns, and never blocks: reply-action.ts accepts `•` as a mask slot on purpose.
describe("Composer — a draft that holds masked text", () => {
  const CAUTION = /this reply holds masked text/i;

  it("warns under the box while the draft holds a run of dots, and goes when they are deleted", async () => {
    renderComposerWithStatus();
    const box = screen.getByPlaceholderText(/type a reply/i);
    expect(screen.queryByText(CAUTION)).toBeNull();
    fireEvent.change(box, { target: { value: "export KEY=sk-o••••••••" } });
    const caution = await screen.findByText(CAUTION);
    expect(caution).toHaveTextContent("The pane gets the dots, not the secret.");
    await waitFor(() => expect(caution.closest('[data-slot="collapse"]')!.getAttribute("data-state")).toBe("open"));
    fireEvent.change(box, { target: { value: "export KEY=" } });
    expectLeaving(screen.queryByText(CAUTION));
  });

  it("does not warn for three dots or an ordinary sentence", () => {
    renderComposerWithStatus();
    const box = screen.getByPlaceholderText(/type a reply/i);
    fireEvent.change(box, { target: { value: "wait for it ••• then run the tests" } });
    expect(screen.queryByText(CAUTION)).toBeNull();
  });

  it("does not block Send", () => {
    renderComposerWithStatus();
    fireEvent.change(screen.getByPlaceholderText(/type a reply/i), { target: { value: "ghp_••••••••" } });
    expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled();
  });
});

// ── M56 spec 07: the way out ─────────────────────────────────────────────────────────────────────
//
// The invariant across all thirteen states (the per-state behaviour is composer.way-out.test.tsx), then the
// outcomes at the thumb, then the Keys dock. The states are the table in test/way-out-states.ts.

/** Mounts the composer in one of the thirteen states, with the Screen pill, and the status sentinel. */
function renderState(state: WayOutState, over: Partial<ComponentProps<typeof Composer>> = {}) {
  const c = wayOutCase(state);
  markLive("w1:p1", Date.now() - c.readAgeMs);
  const onToggle = vi.fn();
  renderComposerWithStatus({
    surface: c.surface,
    gone: c.gone,
    readOnly: c.readOnly,
    stale: c.offline,
    unreachableNote: c.unreachableNote,
    screen: { on: false, onToggle },
    ...over,
  });
  return { onToggle };
}

/** The words an action starts with. The header may hold none of them from the send path. */
const ACTION_WORDS = /\b(tap|check|try|send again|submit|add|replace|cancel|answer|reconnect|wait|read the screen|open|use)\b/i;

describe("the way out", () => {
  it("the placeholder is the plain reply line in every state but a pane that is gone, a device that may not write and a box out of reach", () => {
    const expected = (state: WayOutState) =>
      state === "gone" ? "Pane is gone" : state === "readOnly" ? "Read-only, not authorised" : state === "unreachable" ? "workshop is not answering" : "Type a reply…";
    for (const state of WAY_OUT_STATES) {
      renderState(state);
      // A draft, a dialog, a running turn, an unreadable screen, the unknown family and a send in the queue
      // all read like a free box: no state sentence in the field.
      expect(screen.getByRole("textbox"), state).toHaveAttribute("placeholder", expected(state));
      cleanup();
    }
  });

  it("a shell pane shows the shell line in the same states", () => {
    for (const state of WAY_OUT_STATES) {
      if (state === "gone" || state === "readOnly" || state === "unreachable") continue;
      renderState(state, { isShell: true });
      expect(screen.getByRole("textbox"), state).toHaveAttribute("placeholder", "Type a shell command…");
      cleanup();
    }
  });

  it("the Screen pill is one tap away in every state but a pane that is gone", async () => {
    const user = userEvent.setup();
    for (const state of WAY_OUT_STATES) {
      const { onToggle } = renderState(state);
      const pill = screen.queryByRole("button", { name: "Show the screen rows, without cards" });
      if (state === "gone") {
        expect(pill, state).toBeNull();
      } else {
        expect(pill, state).not.toBeNull();
        await user.click(pill!);
        expect(onToggle, state).toHaveBeenCalledTimes(1);
      }
      cleanup();
    }
  });

  it("the session lock never hides the key pad: a send in flight leaves the Keys dock open and enabled", async () => {
    let release: () => void = () => undefined;
    server.use(
      http.post("/api/send", async () => {
        await new Promise<void>((resolve) => (release = resolve));
        return HttpResponse.json({ offers: [], receipt: { outcome: "sent", keys: [] } });
      }),
    );
    const user = userEvent.setup();
    renderState("free");
    await user.type(screen.getByRole("textbox"), "slow one");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.getByRole("button", { name: "Keys" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Keys" }));
    expect(screen.getByRole("button", { name: "Esc" })).toBeEnabled();
    release();
  });
});

describe("outcome at the thumb", () => {
  const SURFACES = {
    ask: wayOutCase("ask").surface,
    running: wayOutCase("running").surface,
    noMatch: wayOutCase("no-match").surface,
  };

  async function send(answer: () => ReturnType<typeof sendAnswer>, over: Partial<ComponentProps<typeof Composer>> = {}, text = "hello there") {
    server.use(...sendHandler(answer));
    const user = userEvent.setup();
    renderState("free", over);
    await user.type(screen.getByRole("textbox"), text);
    await user.click(screen.getByRole("button", { name: "Send" }));
    return user;
  }

  const refusalText = () => document.querySelector('[data-slot="composer-refusal"]')?.textContent ?? "";
  const header = () => screen.getByTestId("status").textContent ?? "";

  it("sent: the draft goes, the check flashes, and the header says only Sent", async () => {
    await send(() => sendAnswer("x", "sent"));
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue(""));
    await waitFor(() => expect(header()).toBe("Sent ✓"));
    expect(refusalText()).toBe("");
  });

  it("sent and queued behind the turn: the draft goes, and the header says it waits for the turn, not a refusal", async () => {
    await send(() => sendAnswer("x", "sent", undefined, { queued: true }), { surface: SURFACES.running });
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue(""));
    await waitFor(() => expect(header()).toBe("Queued. The agent takes it after this turn."));
    expect(refusalText()).toBe("");
  });

  it("refused turn_running: the agent is working, said as that, with the draft kept", async () => {
    await send(() => sendAnswer("x", "refused", "turn_running", { offers: ["keys"], surface: SURFACES.running }), { surface: SURFACES.running });
    await waitFor(() => expect(refusalText()).not.toBe(""));
    expect(refusalText()).toBe("The agent is working. Send again when it is done.");
    expect(screen.getByRole("textbox")).toHaveValue("hello there");
  });

  it("refused draft_present: Add to it, Replace and Cancel, with the draft kept", async () => {
    await send(() => sendAnswer("x", "refused", "draft_present", { offers: ["append", "replace", "cancel"], surface: wayOutCase("draft").surface }));
    const strip = await screen.findByTestId("send-offers");
    for (const word of ["Add to it", "Replace", "Cancel"]) expect(strip).toHaveTextContent(word);
    expect(screen.getByRole("textbox")).toHaveValue("hello there");
    expect(header()).toBe("");
  });

  it("typed_not_submitted: Submit and Discard are new requests with new ids, and the draft is kept", async () => {
    const user = await send(() => sendAnswer("x", "typed_not_submitted", "mismatch", { offers: ["submit", "discard", "keys"] }));
    await screen.findByRole("button", { name: "Submit" });
    expect(screen.getByRole("button", { name: "Discard" })).toBeInTheDocument();
    const first = recordedSends()[0]!.id;
    await user.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(recordedSends()).toHaveLength(2));
    expect(recordedSends()[1]).toMatchObject({ mode: "submit" });
    expect(recordedSends()[1]!.id).not.toBe(first);
    expect(screen.getByRole("textbox")).toHaveValue("hello there");
  });

  // Send drill 2 (Codex on Herdr, 2026-10-16): a typed_not_submitted on a pane with no frame showed the
  // typed sentence with only Take over and Open Keys. Submit and Discard show for every reason, and each
  // carries the rows hash of the answer, so the bridge acts only on the screen the person saw.
  it.each(["mismatch", "changed", "modal_cue", "stale_token", "submit_failed"] as const)(
    "typed_not_submitted %s with no frame: Submit and Discard show, and Submit carries the rows hash it was offered with",
    async (reason) => {
      const user = await send(() => sendAnswer("x", "typed_not_submitted", reason, { offers: offersFor("typed_not_submitted", reason, false), rowsHash: "0f00ba", surface: SURFACES.noMatch }));
      await screen.findByRole("button", { name: "Submit" });
      expect(screen.getByRole("button", { name: "Discard" })).toBeInTheDocument();
      expect(refusalText()).toMatch(/Your text is in the box, but Enter was not pressed\. Submit it or discard it\./u);
      await user.click(screen.getByRole("button", { name: "Submit" }));
      await waitFor(() => expect(recordedSends()).toHaveLength(2));
      expect(recordedSends()[1]).toMatchObject({ mode: "submit", text: "hello there", rowsHash: "0f00ba" });
    },
  );

  it("typed_not_submitted with no frame: Discard carries the rows hash it was offered with", async () => {
    const user = await send(() => sendAnswer("x", "typed_not_submitted", "mismatch", { offers: offersFor("typed_not_submitted", "mismatch", false), rowsHash: "0f00ba", surface: SURFACES.noMatch }));
    await user.click(await screen.findByRole("button", { name: "Discard" }));
    await waitFor(() => expect(recordedSends()).toHaveLength(2));
    expect(recordedSends()[1]).toMatchObject({ mode: "discard", text: "hello there", rowsHash: "0f00ba" });
  });

  it("typed_not_submitted changed with the text in the box (send drill a6): the typed sentence, not that the box held a draft", async () => {
    await send(() => sendAnswer("x", "typed_not_submitted", "changed", { offers: ["submit", "discard", "keys"], surface: wayOutCase("draft").surface }), {}, "!echo ok");
    await waitFor(() => expect(refusalText()).toMatch(/Your text is in the box, but Enter was not pressed\. Submit it or discard it\./u));
    expect(refusalText()).not.toMatch(/held a draft/iu);
    expect(screen.getByRole("button", { name: "Submit" })).toBeInTheDocument();
  });

  it("refused probe_failed: names the Surface and points to the Keys dock and the Screen", async () => {
    await send(() => sendAnswer("x", "refused", "probe_failed", { surface: SURFACES.noMatch, offers: ["keys"] }));
    await waitFor(() => expect(refusalText()).toMatch(/typing did not land.*could not find the input box/i));
    expect(screen.getByRole("button", { name: "Open Keys" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Screen" })).toBeInTheDocument();
    expect(header()).toBe("");
  });

  it("refused not_free: names the dialog that was open and points to its card and the Keys dock", async () => {
    const onAnswerDialog = vi.fn();
    const user = await send(() => sendAnswer("x", "refused", "not_free", { surface: SURFACES.ask }), { onAnswerDialog, dialogCard: true });
    await waitFor(() => expect(refusalText()).toMatch(/not free.*a menu was open/i));
    await user.click(screen.getByRole("button", { name: "Answer the dialog" }));
    expect(onAnswerDialog).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Open Keys" }));
    expect(screen.getByRole("button", { name: "Esc" })).toBeEnabled();
    expect(header()).toBe("");
  });

  it("unknown: says to read the screen, then send again, keeps the draft, and the next tap is accepted as a new request", async () => {
    const user = await send(() => sendAnswer("x", "unknown", "no_evidence", { offers: ["keys"] }));
    await waitFor(() => expect(refusalText()).toMatch(/read the screen, then send again/i));
    expect(screen.getByRole("button", { name: "Screen" })).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("hello there");
    expect(header()).toBe("");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(recordedSends()).toHaveLength(2));
    expect(recordedSends()[1]!.id).not.toBe(recordedSends()[0]!.id);
  });

  it("no answer: says so at the thumb, keeps the draft and the request id, and the retry does not send twice", async () => {
    server.use(http.post("/api/send", () => new HttpResponse("down", { status: 502 })));
    const user = userEvent.setup();
    renderState("free");
    await user.type(screen.getByRole("textbox"), "lost in flight");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(refusalText()).toMatch(/no answer.*does not send twice/i));
    expect(screen.getByRole("textbox")).toHaveValue("lost in flight");
    expect(header()).toBe("");
  });

  it("stale: the screen moved since the person looked, and the Screen is offered to read it again", async () => {
    await send(() => sendAnswer("x", "refused", "stale_surface", { surface: SURFACES.noMatch }));
    await waitFor(() => expect(refusalText()).toMatch(/the screen changed/i));
    expect(screen.getByRole("button", { name: "Screen" })).toBeInTheDocument();
  });

  it("a discard says so, in the neutral tone, and keeps the phone's draft", async () => {
    await send(() => sendAnswer("x", "discarded"));
    await waitFor(() => expect(refusalText()).toMatch(/the text was removed from the box/i));
    expect(screen.getByRole("textbox")).toHaveValue("hello there");
    expect(header()).toBe("");
  });

  it("every closed outcome and reason lands at the thumb, and none of them puts an action in the header", async () => {
    const outcomeOf = (reason: SendReason): string =>
      ["mismatch", "changed", "modal_cue", "stale_token", "submit_failed"].includes(reason)
        ? "typed_not_submitted"
        : ["crash", "lost_lock", "no_evidence"].includes(reason)
          ? "unknown"
          : "refused";
    for (const reason of SEND_REASONS) {
      server.use(...sendHandler(() => sendAnswer("x", outcomeOf(reason), reason, { offers: ["keys"], surface: SURFACES.noMatch })));
      const user = userEvent.setup();
      renderState("free");
      await user.type(screen.getByRole("textbox"), "hello there");
      await user.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(refusalText(), reason).not.toBe(""));
      expect(header(), reason).not.toMatch(ACTION_WORDS);
      cleanup();
      clearStatus();
    }
  }, 20_000);

  it("a send with no link says Reconnect to send on the Send slot, keeps the draft, and the header stays empty", async () => {
    const user = userEvent.setup();
    renderState("offline");
    await user.type(screen.getByRole("textbox"), "later");
    expect(screen.getByRole("button", { name: "Reconnect to send" })).toBeDisabled();
    expect(screen.getByRole("textbox")).toHaveValue("later");
    expect(recordedSends()).toEqual([]);
    expect(header()).toBe("");
  });

  it("a destructive line says why it waits beside Really send, not in the header", async () => {
    const user = userEvent.setup();
    renderState("free");
    await user.type(screen.getByRole("textbox"), "sudo reboot");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.getByRole("button", { name: /really send/i })).toBeInTheDocument();
    expect(document.querySelector('[data-slot="composer-destructive"]')?.textContent).toMatch(/sudo/);
    expect(header()).toBe("");
  });
});

describe("keys dock", () => {
  it("is enabled in every state except gone, read-only and offline, and opens in one tap", async () => {
    const user = userEvent.setup();
    for (const state of WAY_OUT_STATES) {
      renderState(state);
      const keys = screen.getByRole("button", { name: "Keys" });
      if (state === "gone" || state === "readOnly") {
        expect(keys, state).toBeDisabled();
      } else {
        expect(keys, state).toBeEnabled();
        await user.click(keys);
        const esc = screen.getByRole("button", { name: "Esc" });
        // Offline the dock opens and its pad waits; everywhere else it sends.
        if (state === "offline") expect(esc, state).toBeDisabled();
        else expect(esc, state).toBeEnabled();
      }
      cleanup();
    }
  });

  it("a key press from a box that is out of reach goes to the bridge", async () => {
    const keysSent: string[][] = [];
    server.use(
      http.post(/\/api\/pane\/[^/]+\/keys/, async ({ request }) => {
        const body = asJsonObject(JSON.parse(await request.text()));
        const keys = body?.keys;
        if (Array.isArray(keys)) keysSent.push(keys.map(String));
        return HttpResponse.json({ ok: true });
      }),
    );
    const user = userEvent.setup();
    renderState("unreachable");
    await user.click(screen.getByRole("button", { name: "Keys" }));
    await user.click(screen.getByRole("button", { name: "Esc" }));
    await waitFor(() => expect(keysSent.length).toBeGreaterThan(0));
  });
});

// ── THE CAP (M56 spec 09) ─────────────────────────────────────────────────────────────────────────
//
// After N manual sends on one harness and version inside 24 hours, the manual Send takes one more
// confirm. The bridge counts and files the frame hash; the phone shows the count and the version, and
// the next commit carries `capAck`. It only adds a tap: the manual Send and the Keys dock stay.
describe("the cap (M56 spec 09)", () => {
  const UNREADABLE: Surface = { revision: 3, turn: "idle", modal: "unreadable", composer: "empty" };
  const CAP = { count: 5, limit: 5, harness: "agent", version: "2.1.301" };

  /** The fake bridge on a screen it cannot read: unconfirmed first, then the cap's refusal, then sent. */
  function capBridge(capped: boolean) {
    return sendHandler((request) => {
      if (request.rowsHash === undefined) return sendAnswer(request.id, "refused", "unconfirmed", { offers: ["commit", "keys"], rowsHash: "0f00ba", surface: UNREADABLE });
      if (capped && request.capAck !== true) {
        return sendAnswer(request.id, "refused", "unconfirmed", { offers: ["commit", "keys"], rowsHash: "0f00ba", surface: UNREADABLE, cap: CAP, detail: "The bridge's own English." });
      }
      return sendAnswer(request.id, "sent");
    });
  }

  async function typeAndSend(words: string) {
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox"), words);
    await user.click(screen.getByRole("button", { name: "Send" }));
    return user;
  }

  it("under the cap the manual Send is two taps, and no commit carries a cap ack", async () => {
    server.use(...capBridge(false));
    renderWithContainer({ surface: UNREADABLE });
    const user = await typeAndSend("carry on please");
    await user.click(await screen.findByRole("button", { name: "Type here" }));
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue(""));
    expect(recordedSends().map(({ rowsHash, capAck }) => ({ rowsHash, capAck }))).toEqual([{ rowsHash: undefined, capAck: undefined }, { rowsHash: "0f00ba", capAck: undefined }]);
  });

  it("at the cap the commit is refused once more with the count and the version, and the next tap carries the ack", async () => {
    server.use(...capBridge(true));
    const { container } = renderWithContainer({ surface: UNREADABLE });
    const user = await typeAndSend("carry on please");
    await user.click(await screen.findByRole("button", { name: "Type here" }));

    await waitFor(() => expect(container.querySelector('[data-slot="composer-refusal"]')).toHaveTextContent(/on agent 2\.1\.301 5 times today/i));
    // The phone's own words stand in the notice, not the bridge's English.
    expect(container.querySelector('[data-slot="composer-refusal"]')).not.toHaveTextContent(/bridge's own english/i);
    expect(screen.getByRole("textbox")).toHaveValue("carry on please");
    expect(screen.queryByRole("button", { name: "Type here" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Confirm and type" }));
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue(""));
    expect(recordedSends().map(({ rowsHash, capAck }) => ({ rowsHash, capAck }))).toEqual([
      { rowsHash: undefined, capAck: undefined },
      { rowsHash: "0f00ba", capAck: undefined },
      { rowsHash: "0f00ba", capAck: true },
    ]);
  });

  it("a harness with no version is named alone in the cap's notice, not as `agent -`", async () => {
    server.use(
      ...sendHandler((request) =>
        request.rowsHash === undefined
          ? sendAnswer(request.id, "refused", "unconfirmed", { offers: ["commit", "keys"], rowsHash: "0f00ba", surface: UNREADABLE })
          : sendAnswer(request.id, "refused", "unconfirmed", { offers: ["commit", "keys"], rowsHash: "0f00ba", surface: UNREADABLE, cap: { ...CAP, version: "-" } }),
      ),
    );
    const { container } = renderWithContainer({ surface: UNREADABLE });
    const user = await typeAndSend("carry on please");
    await user.click(await screen.findByRole("button", { name: "Type here" }));
    await waitFor(() => expect(container.querySelector('[data-slot="composer-refusal"]')).toHaveTextContent("on agent 5 times today"));
    expect(container.querySelector('[data-slot="composer-refusal"]')?.textContent).not.toMatch(/agent -|\s{2}/u);
  });

  it("the cap never removes the manual Send or the Keys dock", async () => {
    server.use(...capBridge(true));
    renderWithContainer({ surface: UNREADABLE });
    const user = await typeAndSend("carry on please");
    await user.click(await screen.findByRole("button", { name: "Type here" }));
    await screen.findByRole("button", { name: "Confirm and type" });
    // The field, the Send button and the Keys board are all still there, enabled, with the draft kept.
    expect(screen.getByRole("textbox")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
    expect(screen.getByRole("button", { name: /^keys$/i })).toBeEnabled();
    expect(screen.getByRole("textbox")).toHaveValue("carry on please");
  });

  it("dismissing the notice and tapping Send again starts over from the first tap, with no ack held", async () => {
    server.use(...capBridge(true));
    renderWithContainer({ surface: UNREADABLE });
    const user = await typeAndSend("carry on please");
    await user.click(await screen.findByRole("button", { name: "Type here" }));
    await screen.findByRole("button", { name: "Confirm and type" });
    await user.click(screen.getByRole("button", { name: "Dismiss the send offers" }));
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(recordedSends()).toHaveLength(3));
    expect(recordedSends()[2]!.rowsHash).toBeUndefined();
    expect(recordedSends()[2]!.capAck).toBeUndefined();
  });
});
