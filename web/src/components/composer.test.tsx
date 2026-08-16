import { createRef, useState } from "react";
import type { ComponentProps, Ref } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";

import { clearStatus, setStatus, useStatus } from "@/lib/status";
import * as drafts from "@/lib/drafts";
import { isReloadHeld, __resetReloadGuard } from "@/lib/reload-guard";
import { server } from "@/test/setup";
import { recordReply } from "@/test/handlers";

import type { VoiceInput } from "@/hooks/use-voice-input";
import { Composer, type ComposerHandle } from "./composer";

// A guarded send is TWO reply calls: type (submit:false), then — once the text is verified on the
// input line — submit-only (empty text). Overriding the reply handler therefore has to keep the fake
// pane's input line honest via recordReply, or the verification poll never passes. Helper so each
// override says what it is asserting rather than repeating the protocol.
function replyHandler(onTyped: (text: string) => void, onSubmit?: () => void) {
  return http.post(/\/api\/pane\/[^/]+\/reply$/, async ({ request }) => {
    const body = (await request.json()) as { text: string; submit?: boolean };
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
const idleVoice = (): VoiceInput => ({
  phase: "idle",
  elapsedLabel: "0:00",
  canWrite: () => true,
  startRecording: vi.fn(),
  stopRecording: vi.fn(),
  cancel: vi.fn(),
});

beforeEach(() => clearStatus());

function renderComposer(
  overrides: Partial<ComponentProps<typeof Composer>> = {},
  ref?: Ref<ComposerHandle>,
) {
  const props: ComponentProps<typeof Composer> = {
    paneId: "w1:p1",
    agent: "claude",
    isShell: false,
    gone: false,
    readOnly: false,
    transcriptionEnabled: false,
    voice: idleVoice(),
    dialogPresent: false,
    text: "pane output",
    terminalDraft: null,
    rawTerminalDraft: null,
    prefs: { wrap: true, fontSize: 11, rawTerminal: false },
    setWrap: vi.fn(),
    stepFontSize: vi.fn(),
    setRawTerminal: vi.fn(),
    onSent: vi.fn(),
    ...overrides,
  };
  const router = createMemoryRouter([{ path: "/", element: <Composer ref={ref} {...props} /> }]);
  render(<RouterProvider router={router} />);
  return props;
}

function StatusSentinel() {
  const status = useStatus();
  return <div data-testid="status">{status?.text ?? ""}</div>;
}

/** renderComposer + the status sentinel, for cases that assert on the status line. */
function renderComposerWithStatus(overrides: Partial<ComponentProps<typeof Composer>> = {}) {
  const props: ComponentProps<typeof Composer> = {
    paneId: "w1:p1",
    agent: "claude",
    isShell: false,
    gone: false,
    readOnly: false,
    transcriptionEnabled: false,
    voice: idleVoice(),
    dialogPresent: false,
    text: "pane output",
    terminalDraft: null,
    rawTerminalDraft: null,
    prefs: { wrap: true, fontSize: 11, rawTerminal: false },
    setWrap: vi.fn(),
    stepFontSize: vi.fn(),
    setRawTerminal: vi.fn(),
    onSent: vi.fn(),
    ...overrides,
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
  return props;
}

describe("Composer — voice input", () => {
  it("transitions Mic → Send → Mic by trimmed emptiness, including whitespace-only input", async () => {
    const user = userEvent.setup();
    renderComposer({ transcriptionEnabled: true });
    const box = screen.getByPlaceholderText(/type a reply/i);

    expect(screen.getByRole("button", { name: "Record voice" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Send" })).not.toBeInTheDocument();

    await user.type(box, " ");
    expect(screen.getByRole("button", { name: "Record voice" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Send" })).not.toBeInTheDocument();

    await user.type(box, "typed words");
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Record voice" })).not.toBeInTheDocument();

    await user.clear(box);
    expect(screen.getByRole("button", { name: "Record voice" })).toBeEnabled();
  });

  it("keeps Mic and direct terminal typing mutually exclusive", async () => {
    renderComposer({ transcriptionEnabled: true });

    fireEvent.click(screen.getByRole("button", { name: /^type into terminal$/i }));
    expect(screen.getByPlaceholderText(/type into the terminal/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Record voice" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /stop typing into terminal/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Record voice" })).toBeEnabled());
  });

  it("uses an accessible stop control while recording", () => {
    const recordingVoice: VoiceInput = {
      ...idleVoice(),
      phase: "recording",
      elapsedLabel: "0:01",
    };
    renderComposer({ transcriptionEnabled: true, voice: recordingVoice });
    expect(screen.getByRole("button", { name: "Stop recording" })).toBeEnabled();
    const cancel = screen.getByRole("button", { name: "Cancel voice input" });
    expect(cancel).toBeEnabled();
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Recording");
    expect(status).not.toHaveTextContent("0:01");
    expect(status).not.toContainElement(cancel);
    const timer = screen.getByRole("timer", { name: "Elapsed recording time" });
    expect(timer).toHaveTextContent("0:01");
    expect(timer).toHaveAttribute("aria-live", "off");
    expect(screen.getByPlaceholderText(/type a reply/i)).toBeDisabled();
    expect(screen.getByRole("button", { name: /^type into terminal$/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Keys" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Quick" })).toBeDisabled();
  });

  it.each([
    ["requesting", "Requesting microphone…", "Requesting microphone"],
    ["finalizing", "Finishing recording…", "Finishing recording"],
    ["processing", "Processing voice…", "Processing voice"],
  ] as const)("shows truthful disabled progress while %s", (phase, status, controlLabel) => {
    renderComposer({
      transcriptionEnabled: true,
      voice: { ...idleVoice(), phase },
    });
    expect(screen.getByRole("status")).toHaveTextContent(status);
    expect(screen.getByRole("button", { name: controlLabel })).toBeDisabled();
    expect(screen.getByPlaceholderText(/type a reply/i)).toBeDisabled();
  });

  it("inserts a transcript as an editable persisted draft and never auto-replies", async () => {
    const replyCalls: unknown[] = [];
    const persist = vi.spyOn(drafts, "saveDraft");
    server.use(
      http.post(/\/api\/pane\/[^/]+\/reply$/, async ({ request }) => {
        replyCalls.push(await request.json());
        return HttpResponse.json({ ok: true });
      }),
    );
    const composerRef = createRef<ComposerHandle>();
    renderComposer({ transcriptionEnabled: true }, composerRef);

    act(() => composerRef.current!.acceptVoiceTranscript("review this before sending"));
    const box = screen.getByPlaceholderText(/type a reply/i);
    expect(box).toHaveValue("review this before sending");
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
    expect(replyCalls).toEqual([]);

    await userEvent.setup().type(box, " now");
    expect(box).toHaveValue("review this before sending now");
    expect(persist).toHaveBeenLastCalledWith(undefined, "w1:p1", "review this before sending now");
    persist.mockRestore();
  });
});

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
      http.post(/\/api\/pane\/[^/]+\/keys$/, async ({ request }) => {
        const body = (await request.json()) as { keys: string[] };
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
      http.post(/\/api\/pane\/[^/]+\/keys$/, async ({ request }) => {
        const body = (await request.json()) as { keys: string[] };
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
    renderComposer({ terminalDraft: null, rawTerminalDraft: "leftover" });
    const box = screen.getByPlaceholderText(/type a reply/i);

    await user.type(box, "new message");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(callOrder).toEqual(["keys", "reply"]));
    expect(sentKeys![0]).toBe("ctrl+k");
    // Draft length + the 32-Backspace overshoot (mid-poll-gap host typing margin) + the ctrl+k.
    expect(sentKeys).toHaveLength([..."leftover"].length + 33);
    expect(sentKeys!.slice(1).every((k) => k === "Backspace")).toBe(true);
  });

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
        http.post(/\/api\/pane\/[^/]+\/keys$/, async ({ request }) => {
          const body = (await request.json()) as { expected_prompt?: string };
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
        http.post(/\/api\/pane\/w9%3Ap9\/reply$/, async ({ request }) => {
          const body = (await request.json()) as { text: string; submit?: boolean };
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
              transcriptionEnabled={false}
              voice={idleVoice()}
              dialogPresent={false}
              text="pane output"
              terminalDraft={null}
              rawTerminalDraft="leftover"
              prefs={{ wrap: true, fontSize: 11, rawTerminal: false }}
              setWrap={vi.fn()}
              stepFontSize={vi.fn()}
              setRawTerminal={vi.fn()}
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
    renderComposer({ terminalDraft: null });
    const box = screen.getByPlaceholderText(/type a reply/i);

    await user.type(box, "hello");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(callOrder).toEqual(["reply"]));
  });

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
      transcriptionEnabled: false,
      voice: idleVoice(),
      dialogPresent: false,
      text: "pane output",
      terminalDraft: null,
      rawTerminalDraft: null,
      prefs: { wrap: true, fontSize: 11, rawTerminal: false },
      setWrap: vi.fn(),
      stepFontSize: vi.fn(),
      setRawTerminal: vi.fn(),
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
            transcriptionEnabled={false}
            voice={idleVoice()}
            dialogPresent={false}
            text="pane output"
            terminalDraft={null}
            rawTerminalDraft={null}
            prefs={{ wrap: true, fontSize: 11, rawTerminal: false }}
            setWrap={vi.fn()}
            stepFontSize={vi.fn()}
            setRawTerminal={vi.fn()}
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

  it("sends committed keyboard text as literal ordered keys with no implicit Enter", async () => {
    const keyCalls: string[][] = [];
    let replyCalls = 0;
    server.use(
      http.post(/\/api\/pane\/[^/]+\/keys$/, async ({ request }) => {
        keyCalls.push(((await request.json()) as { keys: string[] }).keys);
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
      http.post(/\/api\/pane\/[^/]+\/keys$/, async ({ request }) => {
        keyCalls.push(((await request.json()) as { keys: string[] }).keys);
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
      http.post(/\/api\/pane\/[^/]+\/keys$/, async ({ request }) => {
        keyCalls.push(((await request.json()) as { keys: string[] }).keys);
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
            transcriptionEnabled={false}
            voice={idleVoice()}
            dialogPresent={false}
            text="pane output"
            terminalDraft={null}
            rawTerminalDraft={null}
            prefs={{ wrap: true, fontSize: 11, rawTerminal: false }}
            setWrap={vi.fn()}
            stepFontSize={vi.fn()}
            setRawTerminal={vi.fn()}
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
      http.post(/\/api\/pane\/[^/]+\/reply$/, async ({ request }) => {
        const body = (await request.json()) as { text: string; submit?: boolean };
        calls.push(body.submit ? "submit" : "type");
        return HttpResponse.json({ ok: true });
      }),
    );
  }

  // The first read is an omp picker; after the deliberate override types, the next live read has
  // the command in omp's composer. This drives the palette → guarded send composition through its
  // real pre-flight and verification phases rather than mocking either child in isolation.
  const OMP_COLS = 189;
  const padOmp = (open: string, body: string, close: string, filler: string) =>
    open + body + filler.repeat(OMP_COLS - open.length - body.length - close.length) + close;
  const OMP_PICKER = [
    padOmp("╭──", " Select a model ", "╮", "─"),
    padOmp("│ ", " ❯ 1. claude-opus  ", " │", " "),
    padOmp("╰──", "", "──╯", "─"),
  ].join("\n");
  const ompComposer = (draft: string) =>
    [
      "transcript above the composer",
      "",
      padOmp("╭── ⬢ Auto > ⑂ master ", "", "╮", "─"),
      padOmp("╰─ ", draft, " ─╯", " "),
    ].join("\n");

  function serveOmpPicker(calls: string[], paneId = "w1:p1") {
    let typed = "";
    let probes = 0;
    const panePath = `/api/pane/${encodeURIComponent(paneId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`;
    server.use(
      http.get(new RegExp(`${panePath}$`), () => {
        probes += 1;
        return HttpResponse.json({
          paneId,
          text: typed ? ompComposer(typed) : OMP_PICKER,
          truncated: false,
          revision: 1,
        });
      }),
      http.post(new RegExp(`${panePath}/reply$`), async ({ request }) => {
        const body = (await request.json()) as { text: string; submit?: boolean };
        if (body.submit) calls.push("submit");
        else {
          typed = body.text;
          calls.push(`type:${body.text}`);
        }
        return HttpResponse.json({ ok: true });
      }),
    );
    return () => probes;
  }

  // The pre-flight is a round-trip, so leaving its owner must invalidate the result before the
  // response decides anything. Drive every possible pre-flight verdict through the same window:
  // blocked used to publish a stale override; ready and transport-error must not type or publish an
  // error into the successor pane either.
  it.each(["blocked", "ready", "error"] as const)(
    "drops a deferred %s pre-flight after navigation", async (outcome) => {
      const user = userEvent.setup();
      const PANE_A = "w9:stale";
      let announcePreflight!: () => void;
      let releasePreflight!: () => void;
      let resolvePreflightResponse!: () => void;
      const preflightIssued = new Promise<void>((resolve) => {
        announcePreflight = resolve;
      });
      const preflightHeld = new Promise<void>((resolve) => {
        releasePreflight = resolve;
      });
      const preflightResponse = new Promise<void>((resolve) => {
        resolvePreflightResponse = resolve;
      });
      const panePath = `/api/pane/${encodeURIComponent(PANE_A).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`;
      const replyCalls: string[] = [];
      server.use(
        http.get(new RegExp(`${panePath}$`), async () => {
          announcePreflight();
          await preflightHeld;
          resolvePreflightResponse();
          if (outcome === "error") return HttpResponse.error();
          return HttpResponse.json({
            paneId: PANE_A,
            text: outcome === "blocked" ? OMP_PICKER : ompComposer(""),
            truncated: false,
            revision: 1,
          });
        }),
        http.post(new RegExp(`${panePath}/reply$`), async ({ request }) => {
          const body = (await request.json()) as { text: string };
          replyCalls.push(body.text);
          return HttpResponse.json({ ok: true });
        }),
      );

      function Harness() {
        const [navigated, setNavigated] = useState(false);
        const paneId = navigated ? "w9:current" : PANE_A;
        return (
          <>
            <StatusSentinel />
            <button type="button" onClick={() => setNavigated(true)}>
              Navigate
            </button>
            <Composer
              key={paneId}
              paneId={paneId}
              agent={navigated ? "claude" : "omp"}
              isShell={false}
              gone={false}
              readOnly={false}
              transcriptionEnabled
              voice={idleVoice()}
              dialogPresent={false}
              text="pane output"
              terminalDraft={null}
              rawTerminalDraft={null}
              prefs={{ wrap: true, fontSize: 11, rawTerminal: false }}
              setWrap={vi.fn()}
              stepFontSize={vi.fn()}
              setRawTerminal={vi.fn()}
              onSent={vi.fn()}
            />
          </>
        );
      }

      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const router = createMemoryRouter([{ path: "/", element: <Harness /> }]);
        render(<RouterProvider router={router} />);
        await user.type(screen.getByPlaceholderText(/type a reply/i), "stale attempt");
        await user.click(screen.getByRole("button", { name: "Send" }));
        await preflightIssued;

        await user.click(screen.getByRole("button", { name: "Navigate" }));
        const currentDraft = screen.getByPlaceholderText(/type a reply/i);
        await user.type(currentDraft, "current draft");
        releasePreflight();
        await preflightResponse;
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });

        expect(replyCalls).toEqual([]);
        expect(currentDraft).toHaveValue("current draft");
        expect(drafts.loadDraft(undefined, PANE_A)).toBe("stale attempt");
        expect(screen.getByTestId("status")).toBeEmptyDOMElement();
        expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
        expect(screen.queryByRole("button", { name: "Type anyway?" })).not.toBeInTheDocument();
        expect(consoleError).not.toHaveBeenCalledWith(expect.stringMatching(/unmounted component/i));
      } finally {
        consoleError.mockRestore();
      }
    },
  );

  /** Capture the ten-second arm timer so the component's expiry can be driven without blocking MSW. */
  function captureOverrideExpiry() {
    const nativeSetTimeout = globalThis.setTimeout;
    let expiry: (() => void) | null = null;
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation((handler, timeout, ...args) => {
      if (timeout === 10_000) {
        expiry = () => {
          if (typeof handler === "function") handler(...args);
        };
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return nativeSetTimeout(handler, timeout, ...args);
    });
    return {
      timeoutSpy,
      expire: () => {
        if (expiry === null) throw new Error("Override timeout was not armed");
        expiry();
      },
    };
  }

  it("retries a blocked palette command from an empty voice composer", async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    serveOmpPicker(calls);
    const props = renderComposerWithStatus({ agent: "omp", transcriptionEnabled: true });

    expect(screen.getByRole("button", { name: "Record voice" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Agent" }));
    await user.click(screen.getByText("/branch"));

    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent(/Tap Send again to type anyway/i),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Agent commands" })).not.toBeInTheDocument(),
    );
    expect(screen.getByPlaceholderText(/type a reply/i)).toHaveValue("");
    expect(screen.getByRole("button", { name: "Type anyway?" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Record voice" })).not.toBeInTheDocument();
    expect(calls).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Type anyway?" }));
    await waitFor(() => expect(calls).toEqual(["type:/branch", "submit"]));
    expect(screen.getByPlaceholderText(/type a reply/i)).toHaveValue("");
    expect(props.onSent).toHaveBeenCalledOnce();
  });

  it("retries the palette command without replacing an unrelated composer draft", async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    serveOmpPicker(calls);
    const props = renderComposerWithStatus({ agent: "omp" });
    const box = screen.getByPlaceholderText(/type a reply/i);
    await user.type(box, "unrelated draft");

    await user.click(screen.getByRole("button", { name: "Agent" }));
    await user.click(screen.getByText("/branch"));
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent(/Tap Send again to type anyway/i),
    );
    expect(box).toHaveValue("unrelated draft");
    expect(screen.getByRole("button", { name: "Type anyway?" })).toBeEnabled();
    expect(calls).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Type anyway?" }));
    await waitFor(() => expect(calls).toEqual(["type:/branch", "submit"]));
    expect(box).toHaveValue("unrelated draft");
    expect(props.onSent).toHaveBeenCalledOnce();
  });

  it("expires its override instruction with the empty voice composer control", async () => {
    const { timeoutSpy, expire } = captureOverrideExpiry();
    try {
      const user = userEvent.setup();
      const calls: string[] = [];
      serveOmpPicker(calls);
      renderComposerWithStatus({ agent: "omp", transcriptionEnabled: true });

      await user.click(screen.getByRole("button", { name: "Agent" }));
      await user.click(screen.getByText("/branch"));
      await screen.findByRole("button", { name: "Type anyway?" });
      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 10_000);

      act(expire);

      expect(screen.getByTestId("status")).toBeEmptyDOMElement();
      expect(screen.queryByRole("button", { name: "Type anyway?" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Record voice" })).toBeEnabled();
      expect(calls).toEqual([]);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("does not clear a newer status when an override expires", async () => {
    const { timeoutSpy, expire } = captureOverrideExpiry();
    try {
      const user = userEvent.setup();
      const calls: string[] = [];
      serveOmpPicker(calls);
      renderComposerWithStatus({ agent: "omp", transcriptionEnabled: true });

      await user.click(screen.getByRole("button", { name: "Agent" }));
      await user.click(screen.getByText("/branch"));
      await screen.findByRole("button", { name: "Type anyway?" });
      act(() => setStatus("A newer operation", "error"));

      act(expire);

      expect(screen.getByTestId("status")).toHaveTextContent("A newer operation");
      expect(screen.queryByRole("button", { name: "Type anyway?" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Record voice" })).toBeEnabled();
      expect(calls).toEqual([]);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("removes its override instruction when navigating to an empty voice composer", async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    serveOmpPicker(calls);

    function Harness() {
      const [navigated, setNavigated] = useState(false);
      const paneId = navigated ? "w1:p2" : "w1:p1";
      return (
        <>
          <StatusSentinel />
          <button type="button" onClick={() => setNavigated(true)}>
            Navigate
          </button>
          <Composer
            key={paneId}
            paneId={paneId}
            agent={navigated ? "claude" : "omp"}
            isShell={false}
            gone={false}
            readOnly={false}
            transcriptionEnabled
            voice={idleVoice()}
            dialogPresent={false}
            text="pane output"
            terminalDraft={null}
            rawTerminalDraft={null}
            prefs={{ wrap: true, fontSize: 11, rawTerminal: false }}
            setWrap={vi.fn()}
            stepFontSize={vi.fn()}
            setRawTerminal={vi.fn()}
            onSent={vi.fn()}
          />
        </>
      );
    }

    const router = createMemoryRouter([{ path: "/", element: <Harness /> }]);
    render(<RouterProvider router={router} />);

    await user.click(screen.getByRole("button", { name: "Agent" }));
    await user.click(screen.getByText("/branch"));
    await screen.findByRole("button", { name: "Type anyway?" });
    await user.click(screen.getByRole("button", { name: "Navigate" }));

    expect(screen.getByTestId("status")).toBeEmptyDOMElement();
    expect(screen.queryByRole("button", { name: "Type anyway?" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Record voice" })).toBeEnabled();
    expect(calls).toEqual([]);
  });

  it("retries a retained typed draft without clearing edits made before the override", async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    serveOmpPicker(calls);
    const props = renderComposerWithStatus({ agent: "omp" });
    const box = screen.getByPlaceholderText(/type a reply/i);
    await user.type(box, "first draft");

    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByRole("button", { name: "Type anyway?" });

    await user.clear(box);
    await user.type(box, "newer draft");
    expect(drafts.loadDraft(undefined, "w1:p1")).toBe("newer draft");

    await user.click(screen.getByRole("button", { name: "Type anyway?" }));
    await waitFor(() => expect(calls).toEqual(["type:first draft", "submit"]));
    expect(box).toHaveValue("newer draft");
    expect(drafts.loadDraft(undefined, "w1:p1")).toBe("newer draft");
    expect(props.onSent).toHaveBeenCalledOnce();
  });

  it("replaces an armed override with the latest blocked palette command", async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    const paneId = "w1:force-replace";
    const probes = serveOmpPicker(calls, paneId);
    const props = renderComposerWithStatus({ paneId, agent: "omp", transcriptionEnabled: true });

    await user.click(screen.getByRole("button", { name: "Agent" }));
    await user.click(screen.getByText("/branch"));
    await waitFor(() => expect(probes()).toBe(1));
    expect(screen.getByRole("button", { name: "Type anyway?" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Agent" }));
    await user.click(screen.getByText("/fork"));
    await waitFor(() => expect(probes()).toBe(2));
    expect(screen.getByTestId("status")).toHaveTextContent(/Tap Send again to type anyway/i);
    expect(screen.getByRole("button", { name: "Type anyway?" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Record voice" })).not.toBeInTheDocument();
    expect(calls).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Type anyway?" }));
    await waitFor(() => expect(calls).toEqual(["type:/fork", "submit"]));
    expect(props.onSent).toHaveBeenCalledOnce();
  });

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

// Drives the composer's TWO draft props the way the parent does across polls: `rawTerminalDraft` is
// the live per-poll line, `terminalDraft` is its 1.5s-stabilised twin (useStableTerminalDraft). Two
// hidden controls set them independently (empty string → null), so a test can model a raw-only blip,
// a stabilised draft, live host typing (raw changes while stable lags), and the line clearing — all
// without real timers. `initialDraft` seeds a fully-stranded draft (raw + stable) at mount.
function renderDraftHarness(overrides: Partial<ComponentProps<typeof Composer>> = {}) {
  const { terminalDraft: initialDraft = null, voice = idleVoice(), ...rest } = overrides;
  function Harness() {
    const [raw, setRaw] = useState<string | null>(initialDraft);
    const [stable, setStable] = useState<string | null>(initialDraft);
    const props: ComponentProps<typeof Composer> = {
      paneId: "w1:p1",
      agent: "claude",
      isShell: false,
      gone: false,
      readOnly: false,
      transcriptionEnabled: false,
      voice,
      dialogPresent: false,
      text: "pane output",
      prefs: { wrap: true, fontSize: 11, rawTerminal: false },
      setWrap: vi.fn(),
      stepFontSize: vi.fn(),
      setRawTerminal: vi.fn(),
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
      http.post(/\/api\/pane\/[^/]+\/keys$/, async ({ request }) => {
        sentKeys = ((await request.json()) as { keys: string[] }).keys;
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
      transcriptionEnabled: false,
      voice: idleVoice(),
      dialogPresent: false,
      text: "pane output",
      terminalDraft: draft,
      rawTerminalDraft: draft,
      prefs: { wrap: true, fontSize: 11, rawTerminal: false },
      setWrap: vi.fn(),
      stepFontSize: vi.fn(),
      setRawTerminal: vi.fn(),
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

  it("holds while voice activity is in progress", () => {
    renderComposer({
      transcriptionEnabled: true,
      voice: { ...idleVoice(), phase: "recording", elapsedLabel: "0:01" },
    });
    expect(isReloadHeld()).toBe(true);
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
      http.post(/\/api\/pane\/[^/]+\/keys$/, async ({ request }) => {
        const body = (await request.json()) as { keys: string[] };
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
      http.post(/\/api\/pane\/[^/]+\/reply$/, async ({ request }) => {
        const body = (await request.json()) as { text: string; submit?: boolean };
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
  const controlsToggle = (name: string) =>
    screen
      .getAllByRole("button", { name })
      .find((b) => b.hasAttribute("aria-expanded")) as HTMLElement;

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
      transcriptionEnabled: false,
      voice: idleVoice(),
      dialogPresent: false,
      text: "pane output",
      terminalDraft: null,
      rawTerminalDraft: null,
      prefs: { wrap: true, fontSize: 11, rawTerminal: false },
      setWrap: vi.fn(),
      stepFontSize: vi.fn(),
      setRawTerminal: vi.fn(),
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
