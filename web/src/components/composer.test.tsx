import { useState } from "react";
import type { ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";

import { clearStatus, useStatus } from "@/lib/status";
import { isReloadHeld, __resetReloadGuard } from "@/lib/reload-guard";
import { loadDraft } from "@/lib/drafts";
import { server } from "@/test/setup";
import { fixtureServers, recordReply } from "@/test/handlers";
import { PackProvider } from "./pack-provider";
import { Composer } from "./composer";
import { statusLabel, type ServerSummary } from "@/lib/types";

// A guarded send is TWO reply calls: type (submit:false), then — once the text is verified on the
// input line — submit-only (empty text). Overriding the reply handler therefore has to keep the fake
// pane's input line honest via recordReply, or the verification poll never passes. Helper so each
// override says what it is asserting rather than repeating the protocol.
function replyHandler(onTyped: (text: string) => void, onSubmit?: () => void) {
  return http.post<never, { text: string; submit?: boolean }>(/\/api\/pane\/[^/]+\/reply$/, async ({ request }) => {
    const body = await request.json();
    recordReply(body);
    if (body.submit) onSubmit?.();
    else onTyped(body.text);
    return HttpResponse.json({ ok: true });
  });
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
    dialogPresent: false,
    text: "pane output",
    terminalDraft: null,
    rawTerminalDraft: null,
    prefs: { wrap: true, fontSize: 11, fontFamily: "system", rawTerminal: false, tapToFocus: true },
    setWrap: vi.fn(),
    stepFontSize: vi.fn(),
    setRawTerminal: vi.fn(),
    setTapToFocus: vi.fn(),
    onSent: vi.fn(),
    ...overrides,
  };
  const router = createMemoryRouter([{ path: "/", element: <Composer {...props} /> }]);
  render(<RouterProvider router={router} />);
  return props;
}

/**
 * Wait for a send that can never verify to reach its terminal `stalled` outcome.
 *
 * A reply handler that doesn't `recordReply` leaves the fake pane's input line empty, so the
 * type-then-verify guard polls POLL_ATTEMPTS × POLL_DELAY_MS (~2.8s) and only then reports. That
 * report is a `setStatus` on a MODULE-SCOPED singleton, which outlives the test that started it: a
 * test that returns first hands its stall to whichever test is running ~2.8s later, past this file's
 * `clearStatus()`, where it reads as that test's own failure. Every test that fires a send it never
 * lets verify ends with this. Needs a status sentinel in the render (`renderComposerWithStatus`).
 */
async function awaitTerminalStall() {
  await waitFor(
    () => expect(screen.getByTestId("status")).toHaveTextContent(/didn't reach the input box/i),
    { timeout: 5000 },
  );
}

function StatusSentinel() {
  const status = useStatus();
  return <div data-testid="status">{status?.text ?? ""}</div>;
}

/** renderComposer + the status sentinel, for cases that assert on the status line. `servers` opts
 *  the render into a pack (default: solo, i.e. no host chrome and no host in any copy). */
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
    dialogPresent: false,
    text: "pane output",
    terminalDraft: null,
    rawTerminalDraft: null,
    prefs: { wrap: true, fontSize: 11, fontFamily: "system", rawTerminal: false, tapToFocus: true },
    setWrap: vi.fn(),
    stepFontSize: vi.fn(),
    setRawTerminal: vi.fn(),
    setTapToFocus: vi.fn(),
    onSent: vi.fn(),
    ...overrides,
  };
  const router = createMemoryRouter([
    {
      path: "/",
      element: (
        <PackProvider servers={servers}>
          <StatusSentinel />
          <Composer {...props} />
        </PackProvider>
      ),
    },
  ]);
  render(<RouterProvider router={router} />);
  return props;
}

describe("Composer — send", () => {
  // #34: a dialog owns the TUI's keyboard. Sending free text at one loses the message AND makes the
  // submit key answer the dialog, approving whatever was highlighted. Nothing may leave the phone.
  it("refuses to send while a dialog is on screen, and keeps the draft", async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    server.use(
      http.post(/\/api\/pane\/[^/]+\/keys$/, () => {
        calls.push("keys");
        return HttpResponse.json({ ok: true });
      }),
      replyHandler(() => calls.push("reply")),
    );
    // A stranded raw draft too, so the destructive pre-clear sweep would fire if the refusal came
    // after it instead of before — those ctrl+k/Backspaces would land in the dialog.
    const props = renderComposerWithStatus({ dialogPresent: true, rawTerminalDraft: "leftover" });
    const box = screen.getByPlaceholderText(/type a reply/i);

    await user.type(box, "please do not approve anything");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent(/dialog is waiting/i));
    expect(calls).toEqual([]); // no keys, no reply — nothing reached the pane at all
    expect(box).toHaveValue("please do not approve anything"); // the message survives
    expect(props.onSent).not.toHaveBeenCalled();
  });

  // The same #34 failure one step upstream. `dialogPresent` and the stranded draft are both derived
  // from the mirror's snapshot, which lags the live pane by a poll while following and is FROZEN
  // while the user has scrolled back or opened find — so both can say "composer, with a draft on the
  // ❯ line" about a pane that has since put a dialog up. The pre-clear sweep is ctrl+k plus a run of
  // Backspaces; fired at that dialog it is keystrokes into a modal, which is exactly what must never
  // happen. Nothing destructive may go out until something has read the LIVE pane.
  it("does not sweep the terminal line when the live pane no longer shows a composer", async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    server.use(
      // The live pane: a dialog owns it, and there is no input box anywhere on screen.
      http.get(/\/api\/pane\/[^/]+$/, () =>
        HttpResponse.json({
          paneId: "w1:p1",
          text: "Do you want to proceed?\n❯ 1. Yes\n  2. No",
          truncated: false,
          revision: 2,
        }),
      ),
      http.post(/\/api\/pane\/[^/]+\/keys$/, () => {
        calls.push("keys");
        return HttpResponse.json({ ok: true });
      }),
      replyHandler(() => calls.push("reply")),
    );
    // What the composer still believes, from the stale mirror: no dialog, and a draft to sweep.
    const props = renderComposerWithStatus({ dialogPresent: false, rawTerminalDraft: "leftover" });
    const box = screen.getByPlaceholderText(/type a reply/i);

    await user.type(box, "please do not approve anything");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent(/input box isn't on screen/i),
    );
    expect(calls).toEqual([]); // no sweep, no reply — the pre-flight ran first and refused
    expect(box).toHaveValue("please do not approve anything");
    expect(props.onSent).not.toHaveBeenCalled();
  });

  // The override tap, end to end, on an omp pane. omp lifts no interactive block kind at all, so
  // `dialogPresent` is STRUCTURALLY false for it and the reply pre-flight is the only guard there is —
  // which makes this the pane where the force path matters most. `force` is armed by a `blocked`
  // outcome, i.e. by the app having just PROVEN a dialog owns the keyboard, and the retry used to make
  // the destructive sweep the first thing on the wire, into that dialog.
  it("the `Type anyway?` retry types into the pane but never sweeps it", async () => {
    const user = userEvent.setup();
    const wire: string[] = [];
    const COLS = 189;
    const pad = (open: string, body: string, close: string, filler: string) =>
      open + body + filler.repeat(COLS - open.length - body.length - close.length) + close;
    // omp with a `/model` picker up: no `╰─ … ─╯` anywhere, so `composerReady` is false.
    const ompModal = [
      pad("╭──", " Select a model ", "╮", "─"),
      pad("│ ", " ❯ 1. claude-opus  ", " │", " "),
      pad("╰──", "", "──╯", "─"),
    ].join("\n");
    server.use(
      http.get(/\/api\/pane\/[^/]+$/, () =>
        HttpResponse.json({ paneId: "w1:p1", text: ompModal, truncated: false, revision: 2 }),
      ),
      http.post<never, { keys: string[] }>(/\/api\/pane\/[^/]+\/keys$/, async ({ request }) => {
        const body = await request.json();
        wire.push(`keys:${body.keys[0]}×${body.keys.length}`);
        return HttpResponse.json({ ok: true });
      }),
      replyHandler(
        (text) => wire.push(`type:${text}`),
        () => wire.push("submit"),
      ),
    );
    // The frozen mirror still shows a stranded draft on the ❯ line — what arms the sweep.
    renderComposerWithStatus({ agent: "omp", rawTerminalDraft: "leftover" });
    const box = screen.getByPlaceholderText(/type a reply/i);
    await user.type(box, "please do not approve anything");

    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent(/Tap Send again to type anyway/i),
    );
    expect(wire).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Type anyway?" }));
    await waitFor(() => expect(wire).toContain("type:please do not approve anything"));
    // The picker never turns into an input box, so type-then-verify polls out and reports `stalled`.
    // Wait for that terminal outcome INSIDE the test: it lands on the module-scoped status singleton
    // ~2.8s after the type (POLL_ATTEMPTS × POLL_DELAY_MS), and a test that ended first would have
    // it write into whichever test was running by then, past this file's `clearStatus()`.
    await waitFor(
      () => expect(screen.getByTestId("status")).toHaveTextContent(/didn't reach the input box/i),
      { timeout: 5000 },
    );
    // No `ctrl+k` + 41 Backspaces into the picker. The override is about the MESSAGE; the keys the
    // guard cannot take back stay home, and the submit key is still withheld by type-then-verify.
    expect(wire.some((w) => w.startsWith("keys:"))).toBe(false);
    expect(wire).not.toContain("submit");
    expect(box).toHaveValue("please do not approve anything");
  }, 15000);

  it("sends non-destructive input on the first tap and clears the draft", async () => {
    const user = userEvent.setup();
    const props = renderComposer();
    const box = screen.getByPlaceholderText(/type a reply/i);

    await user.type(box, "looks good");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(box).toHaveValue(""));
    expect(props.onSent).toHaveBeenCalled();
  });

  it("clears the terminal line with ctrl+k and backspaces before sendReply when a draft is stranded", async () => {
    const user = userEvent.setup();
    const callOrder: string[] = [];
    let sentKeys: string[] | null = null;
    server.use(
      http.post<never, { keys: string[] }>(/\/api\/pane\/[^/]+\/keys$/, async ({ request }) => {
        const body = await request.json();
        sentKeys = body.keys;
        callOrder.push("keys");
        return HttpResponse.json({ ok: true });
      }),
      http.post(/\/api\/pane\/[^/]+\/reply$/, async () => {
        callOrder.push("reply");
        return HttpResponse.json({ ok: true });
      }),
    );
    // The pre-clear keys on the RAW line (the actual current "❯" content), independent of whether the
    // draft ever stabilised into a visible preview — a stranded raw draft is still swept before send.
    renderComposerWithStatus({ terminalDraft: null, rawTerminalDraft: "leftover" });
    const box = screen.getByPlaceholderText(/type a reply/i);

    await user.type(box, "new message");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(callOrder).toEqual(["keys", "reply"]));
    expect(sentKeys![0]).toBe("ctrl+k");
    // Draft length + the 32-Backspace overshoot (mid-poll-gap host typing margin) + the ctrl+k.
    expect(sentKeys).toHaveLength([..."leftover"].length + 33);
    expect(sentKeys!.slice(1).every((k) => k === "Backspace")).toBe(true);
    await awaitTerminalStall(); // see the helper: an unawaited stall lands in a later test
  }, 15000);

  // The burst is the only destructive keystroke path in the app not bound to the screen that
  // authorised it. Ordering ("the read happens first") is not a freshness bound: the read's answer
  // describes the pane at the moment the BRIDGE snapshotted it, and the keys go out when the answer
  // arrives — a whole round-trip later, capped only by GET_TIMEOUT_MS. `expected_prompt` gives the
  // bridge the last word: it re-reads the pane immediately before send_keys and 409s if the row has
  // gone, which is the same mitigation lib/dialog-guard.ts gives every dialog tap.
  describe("the pre-clear burst is bound to the screen that authorised it", () => {
    const COLS = 189;
    const pad = (open: string, body: string, close: string, filler: string) =>
      open + body + filler.repeat(Math.max(0, COLS - open.length - body.length - close.length)) + close;
    const ompComposer = (draft: string) =>
      [
        "transcript above the composer",
        "",
        pad("╭── ⬢ Auto > ⑂ master ", "", "╮", "─"),
        pad("╰─ ", draft, " ─╯", " "),
      ].join("\n");
    const promptRow = (draft: string) => ompComposer(draft).split("\n")[3]!.replace(/\s+$/, "");

    it("sends the composer's own `╰─ … ─╯` row as expected_prompt", async () => {
      const user = userEvent.setup();
      const wire: string[] = [];
      let bound: string | undefined;
      server.use(
        http.get(/\/api\/pane\/[^/]+$/, () =>
          HttpResponse.json({
            paneId: "w1:p1",
            text: ompComposer("new message"), // the composer echoes our text back, so the send lands
            truncated: false,
            revision: 2,
          }),
        ),
        http.post<never, { expected_prompt?: string }>(/\/api\/pane\/[^/]+\/keys$/, async ({ request }) => {
          const body = await request.json();
          bound = body.expected_prompt;
          wire.push("keys");
          return HttpResponse.json({ ok: true });
        }),
        replyHandler(
          (text) => wire.push(`type:${text}`),
          () => wire.push("submit"),
        ),
      );
      renderComposer({ agent: "omp", rawTerminalDraft: "leftover" });

      await user.type(screen.getByPlaceholderText(/type a reply/i), "new message");
      await user.click(screen.getByRole("button", { name: "Send" }));

      await waitFor(() => expect(wire).toContain("submit"));
      expect(wire).toEqual(["keys", "type:new message", "submit"]);
      // Verbatim, and the row the Backspaces are aimed at — not a paraphrase of the screen.
      expect(bound).toBe(promptRow("new message"));
    }, 15000);

    it("abandons the send with nothing typed when the bridge refuses the binding", async () => {
      const user = userEvent.setup();
      const wire: string[] = [];
      server.use(
        http.get(/\/api\/pane\/[^/]+$/, () =>
          HttpResponse.json({
            paneId: "w1:p1",
            text: ompComposer("leftover"),
            truncated: false,
            revision: 2,
          }),
        ),
        // What the bridge answers when its own re-read no longer finds the bound row: the composer
        // left the screen between the pre-flight and the keys, so the burst would have landed on
        // whatever replaced it.
        http.post(/\/api\/pane\/[^/]+\/keys$/, () => {
          wire.push("keys-refused");
          return HttpResponse.json(
            { ok: false, error: "prompt changed", code: "prompt_changed" },
            { status: 409 },
          );
        }),
        replyHandler(
          (text) => wire.push(`type:${text}`),
          () => wire.push("submit"),
        ),
      );
      const props = renderComposerWithStatus({ agent: "omp", rawTerminalDraft: "leftover" });
      const box = screen.getByPlaceholderText(/type a reply/i);

      await user.type(box, "please do not approve anything");
      await user.click(screen.getByRole("button", { name: "Send" }));

      await waitFor(() =>
        expect(screen.getByTestId("status")).toHaveTextContent(/input box changed while clearing/i),
      );
      // The refusal aborts the whole send: no reply text follows the keys onto a screen that moved.
      expect(wire).toEqual(["keys-refused"]);
      expect(box).toHaveValue("please do not approve anything");
      expect(props.onSent).not.toHaveBeenCalled();
    }, 15000);

    it("does not sweep a pane that went read-only while the pre-flight was in flight", async () => {
      // `send()` checks `locked` once, before the pre-flight's round-trip. The burst goes out on the
      // far side of it and — unlike every other key this component sends — does not go through
      // `pressKeys`, which has its own check. A pane that died in that window used to get it anyway.
      const user = userEvent.setup();
      const wire: string[] = [];
      // The pre-flight's read is held open until the test says so, so the window this is about — the
      // one between "a read saw the composer" and "the burst goes out" — is the test's to control
      // rather than a race against the scheduler.
      let announcePreflight!: () => void;
      let releasePreflight!: () => void;
      const preflightIssued = new Promise<void>((resolve) => {
        announcePreflight = resolve;
      });
      const preflightHeld = new Promise<void>((resolve) => {
        releasePreflight = resolve;
      });
      // A pane id of this test's own, so a poll still in flight from an earlier test cannot be the
      // read this one holds open (they all use w1:p1 and fall through to the default handler).
      const PANE = "w9:p9";
      server.use(
        http.get(/\/api\/pane\/w9%3Ap9$/, async () => {
          announcePreflight();
          await preflightHeld;
          return HttpResponse.json({
            paneId: PANE,
            text: ompComposer("leftover"),
            truncated: false,
            revision: 2,
          });
        }),
        http.post(/\/api\/pane\/w9%3Ap9\/keys$/, () => {
          wire.push("keys");
          return HttpResponse.json({ ok: true });
        }),
        http.post<never, { text: string; submit?: boolean }>(/\/api\/pane\/w9%3Ap9\/reply$/, async ({ request }) => {
          const body = await request.json();
          recordReply(body);
          wire.push(body.submit ? "submit" : `type:${body.text}`);
          return HttpResponse.json({ ok: true });
        }),
      );

      let setLocked: ((v: boolean) => void) | null = null;
      function Harness() {
        const [gone, setGone] = useState(false);
        setLocked = setGone;
        return (
          <>
            <StatusSentinel />
            <Composer
              paneId={PANE}
              agent="omp"
              isShell={false}
              gone={gone}
              readOnly={false}
              dialogPresent={false}
              text="pane output"
              terminalDraft={null}
              rawTerminalDraft="leftover"
              prefs={{ wrap: true, fontSize: 11, fontFamily: "system", rawTerminal: false, tapToFocus: true }}
              setWrap={vi.fn()}
              stepFontSize={vi.fn()}
              setRawTerminal={vi.fn()}
              setTapToFocus={vi.fn()}
              onSent={vi.fn()}
            />
          </>
        );
      }
      const router = createMemoryRouter([{ path: "/", element: <Harness /> }]);
      render(<RouterProvider router={router} />);

      await user.type(screen.getByPlaceholderText(/type a reply/i), "please do not approve anything");
      await user.click(screen.getByRole("button", { name: "Send" }));
      await preflightIssued;
      act(() => setLocked?.(true)); // the pane died while the read was still in flight
      releasePreflight(); // …and only now does the read's "yes, a composer" come back

      await waitFor(() =>
        expect(screen.getByTestId("status")).toHaveTextContent(/no longer writable/i),
      );
      expect(wire).toEqual([]); // no burst, and no reply behind it
      expect(screen.getByPlaceholderText(/pane is gone/i)).toBeTruthy();
    }, 15000);
  });

  it("does not call keys before reply when terminalDraft is null", async () => {
    const user = userEvent.setup();
    const callOrder: string[] = [];
    server.use(
      http.post(/\/api\/pane\/[^/]+\/keys$/, async () => {
        callOrder.push("keys");
        return HttpResponse.json({ ok: true });
      }),
      http.post(/\/api\/pane\/[^/]+\/reply$/, async () => {
        callOrder.push("reply");
        return HttpResponse.json({ ok: true });
      }),
    );
    renderComposerWithStatus({ terminalDraft: null });
    const box = screen.getByPlaceholderText(/type a reply/i);

    await user.type(box, "hello");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(callOrder).toEqual(["reply"]));
    await awaitTerminalStall(); // see the helper: an unawaited stall lands in a later test
  }, 15000);

  it("sequential sends with no stranded draft do not call keys before reply", async () => {
    const user = userEvent.setup();
    const callLog: string[] = [];
    server.use(
      http.post(/\/api\/pane\/[^/]+\/keys$/, async () => {
        callLog.push("keys");
        return HttpResponse.json({ ok: true });
      }),
      replyHandler((typed) => callLog.push(`reply:${typed}`)),
    );
    renderComposer();
    const box = screen.getByPlaceholderText(/type a reply/i);

    await user.type(box, "first");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(callLog).toContain("reply:first"));

    await user.type(box, "second");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(callLog).toContain("reply:second"));

    expect(callLog.filter((e) => e.startsWith("reply:"))).toEqual(["reply:first", "reply:second"]);
    expect(callLog).not.toContain("keys");
  });

  it("keeps the draft and shows the partial-failure message when textDelivered is true", async () => {
    const user = userEvent.setup();
    const partialError = "typed into the pane but not submitted — check the pane before resending";
    server.use(
      http.post(/\/api\/pane\/[^/]+\/reply$/, () =>
        HttpResponse.json({ ok: false, textDelivered: true, error: partialError }),
      ),
    );
    const props: ComponentProps<typeof Composer> = {
      paneId: "w1:p1",
      agent: "claude",
      isShell: false,
      gone: false,
      readOnly: false,
      dialogPresent: false,
      text: "pane output",
      terminalDraft: null,
      rawTerminalDraft: null,
      prefs: { wrap: true, fontSize: 11, fontFamily: "system", rawTerminal: false, tapToFocus: true },
      setWrap: vi.fn(),
      stepFontSize: vi.fn(),
      setRawTerminal: vi.fn(),
      setTapToFocus: vi.fn(),
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

    await waitFor(() => expect(box).toHaveValue("almost sent"));
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent(partialError));
    expect(props.onSent).not.toHaveBeenCalled();
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
    server.use(replyHandler(() => replyCalls++));
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
            dialogPresent={false}
            text="pane output"
            terminalDraft={null}
            rawTerminalDraft={null}
            prefs={{ wrap: true, fontSize: 11, fontFamily: "system", rawTerminal: false, tapToFocus: true }}
            setWrap={vi.fn()}
            stepFontSize={vi.fn()}
            setRawTerminal={vi.fn()}
            setTapToFocus={vi.fn()}
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
      act(() => vi.runOnlyPendingTimers());
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
            dialogPresent={false}
            text="pane output"
            terminalDraft={null}
            rawTerminalDraft={null}
            prefs={{ wrap: true, fontSize: 11, fontFamily: "system", rawTerminal: false, tapToFocus: true }}
            setWrap={vi.fn()}
            stepFontSize={vi.fn()}
            setRawTerminal={vi.fn()}
            setTapToFocus={vi.fn()}
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

  it("sends committed keyboard text as literal ordered keys with no implicit Enter", async () => {
    const keyCalls: string[][] = [];
    let replyCalls = 0;
    server.use(
      http.post<never, { keys: string[] }>(/\/api\/pane\/[^/]+\/keys$/, async ({ request }) => {
        keyCalls.push((await request.json()).keys);
        return HttpResponse.json({ ok: true });
      }),
      replyHandler(() => replyCalls++),
    );
    renderComposerWithStatus({ dialogPresent: true });

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
            dialogPresent={false}
            text="pane output"
            terminalDraft={null}
            rawTerminalDraft={null}
            prefs={{ wrap: true, fontSize: 11, fontFamily: "system", rawTerminal: false, tapToFocus: true }}
            setWrap={vi.fn()}
            stepFontSize={vi.fn()}
            setRawTerminal={vi.fn()}
            setTapToFocus={vi.fn()}
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

// .adr/0009: a modal that owns the keyboard has no input box, so the reply path's PRE-FLIGHT refuses
// before typing anything. The composer's job is to keep the draft, say why, and offer one deliberate
// override — which still runs the type-then-verify guard behind it.
describe("Composer — blocked pre-flight override", () => {
  // A pane with no input box at all: the /model picker's shape.
  const PICKER = [
    "▔".repeat(60),
    "   Select model",
    "   ❯ 1. Default",
    "     2. Opus",
    "",
    "   Enter to set as default · s to use this session only · Esc to cancel",
  ].join("\n");

  function servePicker(calls: string[]) {
    server.use(
      http.get(/\/api\/pane\/[^/]+$/, () =>
        HttpResponse.json({ paneId: "w1:p1", text: PICKER, truncated: false, revision: 1 }),
      ),
      http.post<never, { text: string; submit?: boolean }>(/\/api\/pane\/[^/]+\/reply$/, async ({ request }) => {
        const body = await request.json();
        calls.push(body.submit ? "submit" : "type");
        return HttpResponse.json({ ok: true });
      }),
    );
  }

  it("keeps the draft, explains, and types nothing on the first tap", async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    servePicker(calls);
    const props = renderComposerWithStatus();
    const box = screen.getByPlaceholderText(/type a reply/i);

    await user.type(box, "use fable please");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent(/input box isn't on screen/i),
    );
    expect(screen.getByTestId("status")).toHaveTextContent(/tap send again to type anyway/i);
    expect(calls).toEqual([]); // nothing was typed into the picker
    expect(box).toHaveValue("use fable please"); // the message survives
    expect(props.onSent).not.toHaveBeenCalled();
    // The button names what the override actually does — type, not send.
    expect(screen.getByRole("button", { name: /type anyway/i })).toBeInTheDocument();
  });

  it("the second tap types anyway, but STILL withholds the submit key", async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    servePicker(calls);
    renderComposerWithStatus();
    const box = screen.getByPlaceholderText(/type a reply/i);

    await user.type(box, "use fable please");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByRole("button", { name: /type anyway/i });

    await user.click(screen.getByRole("button", { name: /type anyway/i }));

    // The text goes in (the user overruled the pre-flight) — but the pane never echoes it onto an
    // input line, so the verify step never passes and Enter is never fired. THE #34 invariant.
    await waitFor(() => expect(calls).toContain("type"));
    expect(calls).not.toContain("submit");
    expect(box).toHaveValue("use fable please");
    await awaitTerminalStall(); // see the helper: an unawaited stall lands in a later test
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

// #103. A password prompt is the one refusal that never becomes a success: `sudo` turns echo off, so
// the evidence Send needs is exactly what the screen is refusing to show, and the reporter tapped Send
// at it for three days. These pin the two halves of the answer — say what it is, and get the operator
// into the mode that works without leaving the secret behind.
describe("Composer — password prompt", () => {
  const SUDO = "$ sudo systemctl restart collie\n[sudo] password for altan:";

  function serveSudo(calls: string[]) {
    server.use(
      http.get(/\/api\/pane\/[^/]+$/, () =>
        HttpResponse.json({ paneId: "w1:p1", text: SUDO, truncated: false, revision: 1 }),
      ),
      http.post<never, { text: string; submit?: boolean }>(/\/api\/pane\/[^/]+\/reply$/, async ({ request }) => {
        const body = await request.json();
        calls.push(body.submit ? "submit" : "type");
        return HttpResponse.json({ ok: true });
      }),
    );
  }

  it("names the prompt and offers Type, without replacing the override", async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    serveSudo(calls);
    renderComposerWithStatus();
    const box = screen.getByPlaceholderText(/type a reply/i);

    await user.type(box, "hunter2hunter2");
    await user.click(screen.getByRole("button", { name: "Send" }));

    // The refusal names the mechanism, not "a menu or dialog is probably up".
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent(/password prompt/i),
    );
    // The prompt is quoted off the mirror, so the claim is checkable against the screen.
    expect(screen.getByText("[sudo] password for altan:")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /use type/i })).toBeInTheDocument();
    // The pre-existing override is untouched — a false positive costs a dismissal, not an action.
    expect(screen.getByRole("button", { name: /type anyway/i })).toBeInTheDocument();
    expect(calls).toEqual([]);
  });

  it("the handoff clears the draft before arming Type", async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    serveSudo(calls);
    renderComposerWithStatus();
    const box = screen.getByPlaceholderText(/type a reply/i);

    await user.type(box, "hunter2hunter2");
    // The write-through has already put the secret in the 48h store, before any send was attempted —
    // the leak #103 asked about. Asserted here so the assertion below isn't vacuously true.
    expect(localStorage.getItem("collie:draft:default:w1:p1")).toContain("hunter2hunter2");

    await user.click(screen.getByRole("button", { name: "Send" }));
    await user.click(await screen.findByRole("button", { name: /use type/i }));

    // Armed, and the secret is gone from the field (and from its localStorage copy with it) — which
    // is also what lets it arm at all: useDirectTyping refuses while any draft is present.
    await waitFor(() =>
      expect(screen.getByPlaceholderText(/type into the terminal/i)).toHaveValue(""),
    );
    expect(localStorage.getItem("collie:draft:default:w1:p1")).toBeNull();
    expect(screen.queryByRole("button", { name: /use type/i })).not.toBeInTheDocument();
    expect(calls).toEqual([]); // nothing was ever typed by the reply path
  });

  it("drops the stored draft the moment it recognises the prompt, button or no button", async () => {
    // The reporter's actual behaviour: tap Send, give up, walk to a laptop. No button is ever pressed,
    // so a handoff that clears on its way through would never have run — and the pane-leave save would
    // have written the password back out. The store has to be empty from the refusal onwards.
    const user = userEvent.setup();
    const calls: string[] = [];
    serveSudo(calls);
    renderComposerWithStatus();
    const box = screen.getByPlaceholderText(/type a reply/i);

    await user.type(box, "hunter2hunter2");
    expect(localStorage.getItem("collie:draft:default:w1:p1")).toContain("hunter2hunter2");

    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByRole("button", { name: /use type/i });
    expect(localStorage.getItem("collie:draft:default:w1:p1")).toBeNull();
    // Through the store's own reader, not just the storage key: the draft store has a second,
    // in-memory tier (lib/drafts.ts) and a secret surviving in a tier this assertion cannot see
    // would be #103 all over again, invisibly. clearDraft must empty both.
    expect(loadDraft(undefined, "w1:p1")).toBeNull();

    // Dismissing keeps the text on screen — the operator may still need to read it — but the typing
    // that happened while the notice was up was never stored either.
    await user.click(screen.getByRole("button", { name: /dismiss password-prompt notice/i }));
    expect(box).toHaveValue("hunter2hunter2");
    expect(localStorage.getItem("collie:draft:default:w1:p1")).toBeNull();
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

  it("names the machine in the confirm — and only on a pack", async () => {
    const user = userEvent.setup();
    // Solo: the copy is exactly what it has always been, host clause and all absent.
    renderComposerWithStatus({ scope: { host: "workshop" } });
    await user.type(screen.getByPlaceholderText(/type a reply/i), "sudo reboot");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.getByTestId("status")).toHaveTextContent(
      "Destructive: sudo (runs as root) — tap Send again to confirm",
    );
    cleanup();

    // On a pack, "rm -r" is a different sentence depending on whose disk it runs on.
    clearStatus();
    renderComposerWithStatus({ scope: { host: "workshop" } }, fixtureServers);
    await user.type(screen.getByPlaceholderText(/type a reply/i), "sudo reboot");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.getByTestId("status")).toHaveTextContent(
      "Destructive: sudo (runs as root) on workshop — tap Send again to confirm",
    );
    // …and the SAME machine is named at the box the words were typed into. Two statements of one
    // fact is right here and only here: the chip answers "where will this land" before you commit,
    // the confirm answers it at the moment you do, and a destructive command on the wrong machine is
    // the failure both exist to prevent. It is one node, docked inside the field, not a standalone
    // row above it — the row above the input is the status line's.
    expect(screen.getByLabelText("Sends to host: workshop")).toBeInTheDocument();
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

// THE MACHINE, ON THE COMPOSER'S STATUS STRIP. For one round it was docked inside the text box; the
// reasoning survives ("which machine will this land on" is asked while writing, not while reading)
// but the 60px it took out of the typing area does not. The strip above the controls row is the same
// write surface and its space was already reserved and already empty.
//
// Four claims, each failing in BOTH directions — a chip that never renders passes none of them, a
// chip that always renders fails the solo case, and a chip put back in the field fails the second.
describe("Composer — the machine and the state, on a band of their own", () => {
  const box = () => screen.getByPlaceholderText(/type a reply/i);
  const row = () => document.querySelector<HTMLElement>('[data-slot="composer-controls"]')!;
  /** The status band above it: the host run, the status slot, or both. */
  const band = () => document.querySelector<HTMLElement>('[data-slot="composer-status"]')!;
  /** The reserved word slot — the band's last child (`ui/one-of.tsx`).
   *  SAFETY: the band renders exactly two children in this order, the host run then the slot, and
   *  the host run is `null` on a solo install — so its last child is always the slot's element. */
  const slot = () => band().lastElementChild as HTMLElement;
  /** Every alternative the slot is holding open space for, in order. */
  const words = () => Array.from(slot().children).map((l) => l.textContent);
  /** The one it is actually SHOWING. */
  const shown = () => slot().querySelector<HTMLElement>("[data-active]")?.textContent ?? null;
  /** The field's own reserved strip. Read off the class, because the jsdom render has no layout. */
  const reserved = (el: HTMLElement) => /(?:^|\s)pr-(\d+)(?=\s|$)/.exec(el.className)?.[1];

  it("names the machine on the band above the controls row, and renders NOTHING on a solo install", () => {
    // Solo — every install that exists today. There is no "which machine" question to answer, so the
    // band carries the word alone. Scoped by data-slot, never a bare role query: `ui/strip-host`
    // mounts two permanent sr-only live regions, so a role sweep is ambiguous in any tree with a host.
    renderComposerWithStatus({ scope: { host: "workshop" } });
    expect(band().querySelector('[aria-label*="host" i]')).toBeNull();
    cleanup();

    // Pack — the chip appears, INSIDE the band and nowhere else. Not inside the controls group: it
    // names a machine, not a run of five buttons, and `role="group"` is named "Controls".
    renderComposerWithStatus({ scope: { host: "workshop" } }, fixtureServers);
    const chip = screen.getByLabelText("Sends to host: workshop");
    expect(band().contains(chip)).toBe(true);
    expect(row().contains(chip)).toBe(false);
  });

  it("is NOT in the composer field: no chip in the box, and the typing width is the attach strip alone", async () => {
    // The revision this round is. `pr-11` and only `pr-11` — MEASURED at 254px of typing width at a
    // true 390px content width and 184px at 320px, on a pack exactly as on a solo install; docked,
    // the pack figures were 194px and 124px. A second conditional `pr-*` would not stack
    // (tailwind-merge keeps the last padding-right), which is why the number is read off the class.
    const user = userEvent.setup();
    renderComposerWithStatus({ scope: { host: "workshop" } }, fixtureServers);
    expect(reserved(box())).toBe("11");
    // …and nothing in the field's own relative box carries the host, by either route: no chip node
    // inside it, and no `aria-describedby` pointing the textarea at one.
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
    // all six dictionaries. Delete the label and this group announces as an unnamed run of buttons.
    renderComposerWithStatus({ scope: { host: "workshop" } }, fixtureServers);
    expect(screen.getByRole("group", { name: "Controls" })).toBe(row());
    expect(row().getAttribute("aria-labelledby")).toBe("composer-controls-label");
    const label = document.getElementById("composer-controls-label")!;
    expect(label.className).toMatch(/(?:^|\s)sr-only(?=\s|$)/);
  });

  it("holds host + word on a pack, the word ALONE on a solo install, in that order", () => {
    // THE MOVE THIS ROUND MADE. The pane header's caption line carried the status word by itself, so
    // the top of a 60px row was spent on one word; it came down here, beside the machine, where
    // "which machine, and what is it doing" reads as one sentence at the surface being typed into.
    // It was MOVED and not deleted: on the app's own tokens a deuteranope reads blocked / working /
    // done as one colour in light theme, so the header's dot cannot carry the range alone
    // (status-badge.tsx holds the measurement, agent-chat.test.tsx pins the dot's survival).
    renderComposerWithStatus({ scope: { host: "workshop" }, status: "blocked" }, fixtureServers);
    expect(band().firstElementChild).toHaveTextContent("workshop"); // machine first…
    expect(shown()).toBe("needs you"); // …then what it is doing
    cleanup();

    // Solo — every install that exists today. HostChip renders null, so the word stands alone.
    renderComposerWithStatus({ scope: { host: "workshop" }, status: "blocked" });
    expect(shown()).toBe("needs you");
    expect(band().querySelector('[aria-label*="host" i]')).toBeNull();
    cleanup();

    // A bare shell has no agent and therefore no agent status, and still owes the band a word.
    renderComposerWithStatus({ isShell: true, scope: { host: "workshop" } });
    expect(shown()).toBe("shell");
  });

  it("reserves the WORD's slot, so no status can change its width", () => {
    // THE BUG THE OPERATOR FOUND. The band is right-aligned and the word is variable-width, so every
    // status change slid the host sideways — DESIGN.md §2, verbatim: a state may repaint, it may not
    // re-lay-out. MEASURED in the playground at a true 390px content width, pack pane, host chip's
    // left edge: it was 262.92 / 271.89 / 290.86 / 296.28 / 267.33px for the five statuses (a 33.4px
    // swing) and is 262.92px for all five now. In German the swing was 41.3px and is zero.
    //
    // jsdom has no layout, so what is pinned here is the STRUCTURE that makes it true: the slot
    // renders every word it could ever hold, always, and a status change only moves `data-active`
    // between them. Render one word alone and the DOM below differs per status; the test fails.
    const dom = new Map<string, string>();
    for (const status of ["blocked", "working", "done", "idle", "unknown"] as const) {
      renderComposerWithStatus({ scope: { host: "workshop" }, status }, fixtureServers);
      expect(words()).toEqual(["needs you", "working", "done", "idle", "unknown"]);
      expect(shown()).toBe(statusLabel(status));
      // Everything except which layer is in front is byte-identical across the five.
      // Normalise away the marks whose whole job is to say WHICH layer is in front — everything
      // else, the five words and the boxes they stand in, has to be identical.
      const front = /(?: data-active=""| inert=""| aria-hidden="true"|opacity-\d+|pointer-events-none)/g;
      dom.set(status, slot().innerHTML.replace(front, "").replace(/\s+/g, " "));
      cleanup();
    }
    expect(new Set(dom.values()).size).toBe(1);

    // …and the reserve is NOT a number. A pixel width could not do this job: the same slot is
    // "braucht dich" (72.2px) in German and "desconocido" (70.0px) in Spanish against "needs you"
    // at 54.6px, so any constant clips one locale or wastes another's space. The layout engine
    // measures the real glyphs of the real dictionary instead.
    renderComposerWithStatus({ scope: { host: "workshop" }, status: "done" }, fixtureServers);
    expect(slot().className).not.toMatch(/(?:^|\s)(?:min-)?w-\[/);
    expect(slot().className).not.toMatch(/(?:^|\s)(?:min-)?w-\d/);
    cleanup();

    // A GONE pane shows no word at all — and keeps the slot, because "shows nothing" is a state too
    // and a pane dying under you must not slide the machine's name at the moment you are reading it.
    renderComposerWithStatus({ scope: { host: "workshop" }, status: undefined }, fixtureServers);
    expect(shown()).toBeNull();
    expect(words()).toHaveLength(5);
    cleanup();

    // A SHELL pane reserves only what it can become. Its word is "shell" forever, so reserving the
    // agent set would buy a solo shell ~24px of permanent emptiness for states it can never enter.
    renderComposerWithStatus({ isShell: true, scope: { host: "workshop" } }, fixtureServers);
    expect(words()).toEqual(["shell"]);
  });

  it("carries exactly ONE rule at each seam, and draws each from above", () => {
    // DESIGN.md §4: where two chrome regions stack, the UPPER one closes its own bottom edge and the
    // lower draws no top edge. Two components drawing one boundary gives a 2px line where the
    // language says 1px — a fault this codebase has already fixed twice (space-strip / tab-strip).
    // MEASURED in the browser: dock border-top 1px, band border-bottom 1px, controls row 0 on every
    // side. `border-rule` and not `border-border`: this is a cut between REGIONS, 1.34:1 light and
    // 2.06:1 dark, where --border is a component's own edge at 1.16:1 / 1.26:1.
    renderComposerWithStatus({ scope: { host: "workshop" }, status: "working" }, fixtureServers);
    expect(band().className).toMatch(/(?:^|\s)border-b(?=\s|$)/);
    expect(band().className).toMatch(/(?:^|\s)border-rule(?=\s|$)/);
    expect(band().className).not.toMatch(/(?:^|\s)border-t(?=\s|$)/); // the dock already drew it
    // The row below draws nothing at all: no edge of its own, in any direction.
    expect(row().className).not.toMatch(/(?:^|\s)border/);
    // …and the seam above the band is the dock's single `border-t`, not a second line here.
    const dock = band().parentElement!;
    expect(dock.className).toMatch(/(?:^|\s)border-t border-rule(?=\s|$)/);
    expect(dock.className).not.toMatch(/(?:^|\s)border-b(?=\s|$)/);
    // A border colour with no width paints nothing (DESIGN.md §7 trap 1) — so the width is asserted
    // beside the colour, and this pin fails if either is dropped.
  });

  it("stands at ONE height — solo, pack, shell, gone, and across every status", () => {
    // MEASURED in the playground at a true 390px content width and at 320px, English and German,
    // both themes: the band is 13.00px (a 12px line box + its 1px rule) and band + controls row is
    // 57.00px, with the word alone (solo), with host + word (pack), on a shell, with no word at all
    // (a gone pane) and on every one of the five statuses. The five buttons still measure 44.00px —
    // DESIGN.md §6's floor. It was 56.00px before the rule; the rule is the one pixel it cost, and
    // the controls row takes NO top padding to pay for the seam, because the button's own box
    // already holds its icon clear of it.
    //
    // jsdom has no layout, so what is pinned are the facts that make that true and that a refactor
    // could quietly undo.
    renderComposerWithStatus({ scope: { host: "workshop" }, status: "working" });
    const soloBand = band().className;
    const soloRow = row().className;
    // The 12px line box is stated on the BAND, not just on the runs inside it, and that is
    // load-bearing: a block layer in the slot takes its line box from its own inherited strut, so
    // without this the 14px page strut wins and the band measures 25px instead of 13px. One utility
    // and never `text-[10px] leading-3` — tailwind-merge drops an earlier `leading-*` when a later
    // `text-<size>` lands in the same cn(), which once rendered the host run at a 15px line and grew
    // the pane header to 63px.
    expect(soloBand).toContain("text-[10px]/3");
    expect(soloBand).not.toMatch(/(?:^|\s)leading-/);
    // Nothing pads the row above the buttons any more — the band IS the reservation now.
    expect(soloRow).not.toMatch(/(?:^|\s)pt-/);
    expect(soloRow).not.toMatch(/(?:^|\s)py-/);
    // …and the band pays for its own rule with no vertical padding either, so 12 + 1 is the whole sum.
    expect(soloBand).not.toMatch(/(?:^|\s)(?:pt|pb|py)-/);
    cleanup();

    for (const overrides of [
      { scope: { host: "workshop" }, status: "blocked" as const },
      { scope: { host: "workshop" }, status: "done" as const },
      { scope: { host: "workshop" }, status: undefined },
    ]) {
      renderComposerWithStatus(overrides, fixtureServers);
      expect(band().className).toBe(soloBand); // the pack pays nothing for the chip
      expect(row().className).toBe(soloRow);
      // Both runs state the same 12px line box, as ONE utility.
      for (const run of [band().firstElementChild!, slot().firstElementChild!.firstElementChild!]) {
        expect(run.className).toContain("text-[10px]/3");
        expect(run.className).not.toMatch(/(?:^|\s)leading-/);
      }
      cleanup();
    }
  });

  it("runs the ground and the rule edge to edge, and still insets the content by 10px", () => {
    // The operator asked for a different background AND a bottom border. Both halves are read off
    // the class because jsdom has no layout.
    //
    // FULL-BLEED: `-mx-3` cancels the dock's `px-3`, so the fill and the rule reach both viewport
    // edges. A fill that stopped 12px short would read as a floating bar, and a rule that stopped
    // short would not separate the two regions it sits between. `px-2.5` then puts the content back
    // at the 10px inset the controls row asked for — which is also what absorbed the row's old
    // `-mx-0.5`: as a 2px overhang on a TRANSPARENT strip it was invisible, and on a filled one it
    // would not have been. The controls row keeps its own `-mx-0.5`, which is the 1px per button it
    // was bought for. tailwind-merge keeps only the LAST padding-* in one cn(), which is why the
    // band's inset is one `px-*` and not two.
    //
    // NO FILL. `--card` was tried here and measured against DESIGN.md §4, which says chrome is the
    // page colour separated by a rule and never a fill band: 1.19:1 against the dock below in both
    // themes, 1.09:1 / 1.10:1 against the mirror above, against a `border-b border-rule` doing
    // 1.45:1 light and 2.19:1 dark. The rule was doing the separating; the fill was dropped. The
    // band is page colour, per §4 — no `bg-*` utility of its own.
    renderComposerWithStatus({ scope: { host: "workshop" }, status: "working" }, fixtureServers);
    expect(band().className).toMatch(/(?:^|\s)-mx-3(?=\s|$)/);
    expect(band().className).toMatch(/(?:^|\s)px-2\.5(?=\s|$)/);
    expect(band().className).not.toMatch(/(?:^|\s)bg-/);
    expect(band().className).toMatch(/(?:^|\s)justify-end(?=\s|$)/);
    expect(row().className).toMatch(/(?:^|\s)-mx-0\.5(?=\s|$)/);
    expect(row().className).not.toMatch(/(?:^|\s)px-/); // the row's inset is the dock's, trimmed
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
      dialogPresent: false,
      text: "pane output",
      prefs: { wrap: true, fontSize: 11, fontFamily: "system", rawTerminal: false, tapToFocus: true },
      setWrap: vi.fn(),
      stepFontSize: vi.fn(),
      setRawTerminal: vi.fn(),
      setTapToFocus: vi.fn(),
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

  it("renders no dismiss button — the preview has no user-facing dismiss", async () => {
    renderDraftHarness();
    strandDraft("no dismiss here");
    await screen.findByText(/draft in terminal/i);

    expect(screen.queryByLabelText(/dismiss terminal draft/i)).not.toBeInTheDocument();
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
    expect(screen.queryByText(/draft in terminal/i)).not.toBeInTheDocument(); // preview hidden
    expect(keyCalls).toEqual([]); // takeover writes NOTHING to the terminal
  });

  it("after Take over, a divergent host draft honestly re-shows the preview with the new text", async () => {
    const user = userEvent.setup();
    renderDraftHarness();
    strandDraft("original");
    await screen.findByText(/draft in terminal/i);

    await user.click(screen.getByRole("button", { name: /take over/i }));
    expect(screen.queryByText(/draft in terminal/i)).not.toBeInTheDocument();

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
    expect(screen.queryByText(/draft in terminal/i)).not.toBeInTheDocument();

    strandDraft(""); // the host line empties (submitted/wiped on the host)
    strandDraft("continue"); // …and later the very same text strands again
    const label = await screen.findByText(/draft in terminal/i);
    // Scope to the preview block — "continue" also sits in the composer input from the take-over.
    expect(label.parentElement).toHaveTextContent("continue");
  });

  it("send after Take over pre-clears the host line exactly once, then clears the composer", async () => {
    const user = userEvent.setup();
    const callOrder: string[] = [];
    let sentKeys: string[] | null = null;
    server.use(
      http.post<never, { keys: string[] }>(/\/api\/pane\/[^/]+\/keys$/, async ({ request }) => {
        sentKeys = (await request.json()).keys;
        callOrder.push("keys");
        return HttpResponse.json({ ok: true });
      }),
      replyHandler((typed) => callOrder.push(`reply:${typed}`)),
    );
    renderDraftHarness();
    strandDraft("adopted line");
    await screen.findByText(/draft in terminal/i);

    await user.click(screen.getByRole("button", { name: /take over/i }));
    const box = screen.getByPlaceholderText(/type a reply/i);
    expect(box).toHaveValue("adopted line");

    // The host line still holds the draft (takeover never touched it), so Send sweeps it once first.
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(callOrder).toEqual(["keys", "reply:adopted line"]));
    expect(sentKeys![0]).toBe("ctrl+k");
    await waitFor(() => expect(box).toHaveValue("")); // cleared after send
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
      dialogPresent: false,
      text: "pane output",
      terminalDraft: draft,
      rawTerminalDraft: draft,
      prefs: { wrap: true, fontSize: 11, fontFamily: "system", rawTerminal: false, tapToFocus: true },
      setWrap: vi.fn(),
      stepFontSize: vi.fn(),
      setRawTerminal: vi.fn(),
      setTapToFocus: vi.fn(),
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
      replyHandler((typed) => callLog.push(`reply:${typed}`)),
    );
    renderEcho("/rename");
    const box = screen.getByPlaceholderText(/type a reply/i);

    // Send "/rename"; the composer remembers it.
    await user.type(box, "/rename");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(callLog).toContain("reply:/rename"));

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

  it("still treats a genuinely different stranded draft as real (previews it; Take over + Send pre-clears)", async () => {
    const user = userEvent.setup();
    const callLog: string[] = [];
    server.use(
      http.post(/\/api\/pane\/[^/]+\/keys$/, async () => {
        callLog.push("keys");
        return HttpResponse.json({ ok: true });
      }),
      replyHandler((typed) => callLog.push(`reply:${typed}`)),
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

    // Take it over, then send: the real stranded line is pre-cleared before the reply.
    callLog.length = 0;
    await user.click(screen.getByRole("button", { name: /take over/i }));
    expect(box).toHaveValue("someone else's leftover");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(callLog).toContain("reply:someone else's leftover"));
    expect(callLog).toContain("keys");
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
    // Failing upload keeps the input empty (a successful one appends the returned path, which then
    // legitimately holds as real unsent text) — so the release is observable in isolation.
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
    // SAFETY: the composer renders exactly one `input[type=file]` (its upload trigger), and
    // `querySelector` is typed `Element | null` for an arbitrary selector string.
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
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
    const attach = screen.getByRole("button", { name: "Attach image" });
    expect(attach).toBeEnabled();
    await user.click(attach); // clickable without throwing (opens the hidden file input)
  });

  it("does not render digit shortcut buttons in the composer (they live on the Keys dock's 123 tab)", () => {
    renderComposer();
    for (const d of ["1", "2", "3", "4", "5"]) {
      expect(screen.queryByRole("button", { name: d })).not.toBeInTheDocument();
    }
  });
});

describe("Composer — clipboard image paste", () => {
  it("uploads a pasted image the same way the picker does and appends its path", async () => {
    server.use(
      http.post(/\/api\/pane\/[^/]+\/upload$/, () => HttpResponse.json({ ok: true, path: "/tmp/shot.png" })),
    );
    renderComposer();
    const box = screen.getByPlaceholderText(/type a reply/i);
    const file = new File(["x"], "shot.png", { type: "image/png" });
    const item = { kind: "file", type: "image/png", getAsFile: () => file };

    fireEvent.paste(box, { clipboardData: { items: [item] } });

    await waitFor(() => expect(box).toHaveValue("/tmp/shot.png"));
  });

  it("leaves a plain-text paste alone — no upload, nothing written by the paste handler", () => {
    renderComposer();
    const box = screen.getByPlaceholderText(/type a reply/i);
    const item = { kind: "string", type: "text/plain", getAsFile: () => null };

    fireEvent.paste(box, { clipboardData: { items: [item] } });

    expect(box).toHaveValue("");
    expect(screen.queryByText(/Image added/i)).not.toBeInTheDocument();
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
    server.use(replyHandler((typed) => (replyText = typed)));
    const props = renderComposer();

    await user.click(screen.getByRole("button", { name: "Quick" }));
    await user.click(screen.getByRole("button", { name: "continue" }));

    await waitFor(() => expect(replyText).toBe("continue"));
    expect(props.onSent).toHaveBeenCalled();
    // The dock deliberately OUTLIVES the send — the ✓ has to land somewhere the user is still
    // looking — and closes itself once the echo has been seen.
    await waitFor(
      () => expect(screen.queryByRole("button", { name: "continue" })).not.toBeInTheDocument(),
      { timeout: 3000 },
    );
  });

  it("a quick reply echoes on its OWN button and locks its siblings while in flight", async () => {
    const user = userEvent.setup();
    // Hold the TYPE half of the guarded send open, so the in-flight state is observable rather than
    // a race against a handler that resolves instantly.
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.post<never, { text: string; submit?: boolean }>(/\/api\/pane\/[^/]+\/reply$/, async ({ request }) => {
        const body = await request.json();
        if (!body.submit) await gate;
        recordReply(body);
        return HttpResponse.json({ ok: true });
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
      http.post(/\/api\/pane\/[^/]+\/reply$/, () =>
        HttpResponse.json({ ok: false, error: "nope" }, { status: 500 }),
      ),
    );
    renderComposer();

    await user.click(screen.getByRole("button", { name: "Quick" }));
    await user.click(screen.getByRole("button", { name: "continue" }));

    // No ✓, no close — the reply never landed, so the dock stays put for a retry.
    await waitFor(() => expect(screen.getByRole("button", { name: "continue" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "skip" })).toBeEnabled();
  });
});

describe("Composer — display prefs behind the gear", () => {
  it("the View row is gone; wrap/raw/font live behind the Display gear as labelled controls", async () => {
    const user = userEvent.setup();
    renderComposer();

    // Nothing display-related is on the permanent rows any more.
    expect(screen.queryByRole("button", { name: "Decrease font size" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Display settings" }));

    // Named controls, not bare glyphs — the whole point of the move.
    expect(screen.getByRole("switch", { name: "Wrap lines" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Raw terminal" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Decrease font size" })).toBeInTheDocument();
  });

  it("the Display dock shares the single drawer slot with Keys", async () => {
    const user = userEvent.setup();
    renderComposer();

    await user.click(screen.getByRole("button", { name: "Display settings" }));
    expect(screen.getByRole("switch", { name: "Wrap lines" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Keys" }));
    expect(screen.queryByRole("switch", { name: "Wrap lines" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Esc" })).toBeInTheDocument();
  });

  it("display prefs stay reachable on a read-only device", async () => {
    const user = userEvent.setup();
    renderComposer({ readOnly: true });

    // Keys/Quick are write affordances and lock; the gear is local view state and must not.
    expect(screen.getByRole("button", { name: "Keys" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Display settings" }));
    expect(screen.getByRole("switch", { name: "Wrap lines" })).toBeInTheDocument();
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
  // The Controls row's "Keys" toggle and the tray's own "Keys" segmented tab share an accessible
  // name; only the toggle carries aria-expanded, which is what ties it to the dock.
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
  });

  it("a shell pane gets y/n, not the agent phrases", async () => {
    const user = userEvent.setup();
    renderComposer({ agent: "shell", isShell: true });
    await user.click(screen.getByRole("button", { name: "Quick" }));

    expect(screen.getByRole("button", { name: "y" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "n" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "commit and push" })).not.toBeInTheDocument();
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
      dialogPresent: false,
      text: "pane output",
      terminalDraft: null,
      rawTerminalDraft: null,
      prefs: { wrap: true, fontSize: 11, fontFamily: "system", rawTerminal: false, tapToFocus: true },
      setWrap: vi.fn(),
      stepFontSize: vi.fn(),
      setRawTerminal: vi.fn(),
      setTapToFocus: vi.fn(),
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
