import { describe, expect, it, beforeEach, vi } from "vitest";

// The plan dialog's FEEDBACK choreography (issue #95): the input row's digit → verify the field
// focused → type → verify our own words are in the box → Enter, which denies the plan and hands the
// agent the text. The api layer is mocked so the mid-flight pane states can be sequenced precisely;
// the detector is the real thing, driven by synthetic buffers in the live layout.
//
// What these tests are really pinning is the ORDER and the STOPPING POINTS. Enter here is
// irreversible — it rejects a plan and puts words in the agent's mouth — so it must be the last
// thing sent and it must never go out on anything but a fresh read showing our text. Every failure
// path below asserts what was NOT sent, which is the half that matters.
vi.mock("./api", () => ({
  fetchPane: vi.fn(),
  sendKeys: vi.fn(),
  sendReply: vi.fn(),
}));

import { fetchPane, sendKeys, sendReply } from "./api";
import { parseAnsi } from "./ansi";
import { splitLines } from "./blocks";
import { detectPromptSelect } from "./harness/claude/prompt-select";
import { FEEDBACK_MAX_LENGTH, submitPromptFeedback, submitPromptOption } from "./prompt-action";

const mockFetchPane = vi.mocked(fetchPane);
const mockSendKeys = vi.mocked(sendKeys);
const mockSendReply = vi.mocked(sendReply);

// A synthetic plan-approval dialog in the live layout (fixtures claude--plan-approval*.txt): the
// subject above, the question, the answer rows, then the input row with its static hint sub-line and
// the plan footer. `focused` puts `❯` on the input row; `text` fills its box (which replaces the
// placeholder — that IS the on-screen behaviour, see PLAN_FEEDBACK_NOTES.md).
function wrapWords(text: string, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && (line + " " + word).length > width) {
      out.push(line);
      line = word;
    } else line = line ? line + " " + word : word;
  }
  if (line) out.push(line);
  return out;
}

function buffer(
  opts: {
    focused?: boolean;
    text?: string;
    subject?: string;
    noInput?: boolean;
    wrapAt?: number;
  } = {},
) {
  const rows = ["Yes, and use auto mode", "Yes, manually approve edits"];
  const input = opts.text ? opts.text : "Tell Claude what to change";
  // A value longer than the row re-flows onto continuation lines that sit ABOVE the hint — the live
  // shape (fixture claude--plan-approval--feedback-wrapped.txt). `wrapAt` splits on word boundaries
  // the way the terminal does.
  const [head, ...rest] = opts.wrapAt ? wrapWords(input, opts.wrapAt) : [input];
  const inputRows = opts.noInput
    ? []
    : [
        `   ${opts.focused ? "❯" : " "} 3. ${head}`,
        ...rest.map((line) => `        ${line}`),
        "        shift+tab to approve with this feedback",
      ];
  return [
    opts.subject ?? " Here is Claude's plan: refactor validate()",
    "",
    " Claude has written up a plan and is ready to execute. Would you like to proceed?",
    "",
    ...rows.map((label, i) => `   ${opts.focused ? " " : i === 0 ? "❯" : " "} ${i + 1}. ${label}`),
    ...inputRows,
    "",
    " ctrl+g to edit in nano · ~/.claude/plans/refactor-validate.md",
  ].join("\n");
}

function model(opts: Parameters<typeof buffer>[0] = {}) {
  const m = detectPromptSelect(splitLines(parseAnsi(buffer(opts))));
  if (!m) throw new Error("synthetic buffer did not detect");
  return m;
}

const paneWith = (text: string, revision = 5) => ({
  paneId: "w1:p1",
  text,
  truncated: false,
  revision,
});

const noSleep = async () => {};
const base = {
  paneId: "w1:p1",
  requestedLines: 600,
  detectedRevision: 5,
  // The guard re-derives through the pane's ADAPTER (lib/dialog-guard.ts), so every call names the
  // agent whose grammar produced the buffer — an agent with no adapter fails the guard closed.
  agent: "claude",
  canWrite: () => true,
  sleep: noSleep,
};

beforeEach(() => {
  mockFetchPane.mockReset();
  mockSendKeys.mockReset();
  mockSendReply.mockReset();
  mockSendKeys.mockResolvedValue({ ok: true });
  mockSendReply.mockResolvedValue({ ok: true });
});

describe("the synthetic buffer matches the live grammar", () => {
  it("detects the input row in each of its states, and never as an option", () => {
    expect(model().feedback).toEqual({ key: "3", focused: false, text: "" });
    expect(model({ focused: true }).feedback).toEqual({ key: "3", focused: true, text: "" });
    expect(model({ text: "use a switch" }).feedback).toEqual({
      key: "3",
      focused: false,
      text: "use a switch",
    });
    expect(model().options.map((o) => o.keys)).toEqual([["1"], ["2"]]);
  });
});

describe("submitPromptFeedback — digit → verify focus → type → verify text → Enter", () => {
  it("runs the sequence in order and submits only after the text is on screen", async () => {
    const m = model();
    mockFetchPane
      .mockResolvedValueOnce(paneWith(buffer())) // entry guard: the dialog the user saw
      .mockResolvedValueOnce(paneWith(buffer({ focused: true }))) // focus poll
      .mockResolvedValue(paneWith(buffer({ focused: true, text: "use a switch instead" }))); // text poll

    const res = await submitPromptFeedback({ ...base, prompt: m, text: "use a switch instead" });

    expect(res).toEqual({ status: "sent" });
    // BOTH writes are bound, each to the region of the screen it is actually aimed at: the digit to
    // the entry guard's, the Enter to a re-read taken after the text landed. The Enter is the only
    // irreversible key in the flow, so it must not be the one that goes out unbound.
    const filled = detectPromptSelect(
      splitLines(parseAnsi(buffer({ focused: true, text: "use a switch instead" }))),
    )!;
    expect(mockSendKeys.mock.calls).toEqual([
      ["w1:p1", ["3"], undefined, m.signature],
      ["w1:p1", ["Enter"], undefined, filled.signature],
    ]);
    // Typed unsubmitted, through the reply path — one paste, immune to the per-key focus race.
    expect(mockSendReply.mock.calls).toEqual([["w1:p1", "use a switch instead", false, undefined]]);
  });

  it("reads back a value the row WRAPPED across lines, rejoined and matched exactly", async () => {
    // The row does not window a long value around the caret — it re-flows the whole thing across as
    // many lines as it needs (measured live). The grammar rejoins them, so the evidence for the Enter
    // is the FULL text, matched exactly; there is no reason to accept a partial match for the one
    // irreversible key in the flow.
    const text = "please use a switch statement rather than the guard clauses you proposed here";
    mockFetchPane
      .mockResolvedValueOnce(paneWith(buffer()))
      .mockResolvedValueOnce(paneWith(buffer({ focused: true })))
      .mockResolvedValue(paneWith(buffer({ focused: true, text, wrapAt: 30 })));
    expect(await submitPromptFeedback({ ...base, prompt: model(), text })).toEqual({
      status: "sent",
    });
    expect(mockSendKeys.mock.calls.at(-1)![1]).toEqual(["Enter"]);
  });

  it("refuses when the wrap seam loses a character — no partial match earns the Enter", async () => {
    const text = "please use a switch statement rather than guard clauses";
    mockFetchPane
      .mockResolvedValueOnce(paneWith(buffer()))
      .mockResolvedValueOnce(paneWith(buffer({ focused: true })))
      .mockResolvedValue(paneWith(buffer({ focused: true, text: text.slice(0, -6), wrapAt: 30 })));
    const res = await submitPromptFeedback({ ...base, prompt: model(), text });
    expect(res.status).toBe("error");
    expect(mockSendKeys.mock.calls.map((c) => c[1])).toEqual([["3"]]); // no Enter
  });

  it("a wrapped value keeps the dialog readable at all — the footer gap makes room", async () => {
    // Before this was understood a 355-character value pushed the footer past MAX_FOOTER_GAP and the
    // WHOLE dialog fell to the raw mirror, taking the buttons with it.
    const long = "x y ".repeat(50).trim();
    expect(model({ text: long, wrapAt: 40 }).feedback!.text).toBe(long);
  });

  it("truncates at FEEDBACK_MAX_LENGTH and types exactly what it verifies", async () => {
    const long = "x".repeat(FEEDBACK_MAX_LENGTH + 50);
    const clipped = "x".repeat(FEEDBACK_MAX_LENGTH);
    mockFetchPane
      .mockResolvedValueOnce(paneWith(buffer()))
      .mockResolvedValueOnce(paneWith(buffer({ focused: true })))
      .mockResolvedValue(paneWith(buffer({ focused: true, text: clipped })));
    expect(await submitPromptFeedback({ ...base, prompt: model(), text: long })).toEqual({
      status: "sent",
    });
    expect(mockSendReply.mock.calls[0]![1]).toBe(clipped);
  });
});

describe("submitPromptFeedback — the states it refuses BEFORE touching the pane", () => {
  it("refuses while the input already has focus (someone is typing in the terminal)", async () => {
    const res = await submitPromptFeedback({
      ...base,
      prompt: model({ focused: true }),
      text: "hi",
    });
    expect(res).toEqual({ status: "changed" });
    expect(mockFetchPane).not.toHaveBeenCalled();
    expect(mockSendKeys).not.toHaveBeenCalled();
    expect(mockSendReply).not.toHaveBeenCalled();
  });

  it("refuses when the box already holds text — our words would be PREPENDED to theirs", async () => {
    // Measured on 2.1.233: re-entering the field puts the caret at position 0, so typing prepends and
    // Backspace there is a no-op. There is no safe clear, so the phone does not type at all.
    const res = await submitPromptFeedback({
      ...base,
      prompt: model({ text: "half a sentence" }),
      text: "hi",
    });
    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
    expect(mockSendReply).not.toHaveBeenCalled();
  });

  it("refuses on a dialog that has no input row at all", async () => {
    // The same dialog with its input row removed — every other prompt family (permission, trust,
    // plain select) looks like this, and the flow must be inert on all of them.
    const plain = detectPromptSelect(splitLines(parseAnsi(buffer({ noInput: true }))))!;
    expect(plain.feedback).toBeUndefined();
    expect(await submitPromptFeedback({ ...base, prompt: plain, text: "hi" })).toEqual({
      status: "changed",
    });
    expect(mockSendKeys).not.toHaveBeenCalled();
  });

  it("refuses empty text without sending anything", async () => {
    const res = await submitPromptFeedback({ ...base, prompt: model(), text: "   " });
    expect(res.status).toBe("error");
    expect(mockSendKeys).not.toHaveBeenCalled();
  });

  it("stops at the entry guard when the dialog on screen is no longer the one tapped", async () => {
    mockFetchPane.mockResolvedValue(paneWith(buffer({ subject: " A different plan entirely" })));
    expect(await submitPromptFeedback({ ...base, prompt: model(), text: "hi" })).toEqual({
      status: "changed",
    });
    expect(mockSendKeys).not.toHaveBeenCalled();
    expect(mockSendReply).not.toHaveBeenCalled();
  });
});

describe("submitPromptFeedback — the stopping points once it has started writing", () => {
  it("types NOTHING if focus never lands: the digit's pointer move is the only side effect", async () => {
    mockFetchPane
      .mockResolvedValueOnce(paneWith(buffer())) // entry guard
      .mockResolvedValue(paneWith(buffer())); // focus never arrives
    const res = await submitPromptFeedback({ ...base, prompt: model(), text: "hi" });
    expect(res.status).toBe("error");
    expect(mockSendReply).not.toHaveBeenCalled();
    expect(mockSendKeys.mock.calls).toEqual([["w1:p1", ["3"], undefined, model().signature]]);
  });

  it("does not type feedback after voice locks the pane during focus verification", async () => {
    const m = model();
    let resolveFocused!: (value: ReturnType<typeof paneWith>) => void;
    mockFetchPane
      .mockResolvedValueOnce(paneWith(buffer()))
      .mockImplementationOnce(
        () =>
          new Promise<ReturnType<typeof paneWith>>((resolve) => {
            resolveFocused = resolve;
          }),
      );
    let canWrite = true;

    const action = submitPromptFeedback({
      ...base,
      canWrite: () => canWrite,
      prompt: m,
      text: "use a switch",
    });
    await vi.waitFor(() => expect(mockFetchPane).toHaveBeenCalledTimes(2));

    // The focus digit was sent while idle; once recording owns this pane, its resolved poll must
    // not be followed by either the reply paste or the irreversible Enter.
    canWrite = false;
    resolveFocused(paneWith(buffer({ focused: true })));

    await expect(action).resolves.toEqual({ status: "changed" });
    expect(mockSendKeys.mock.calls).toEqual([["w1:p1", ["3"], undefined, m.signature]]);
    expect(mockSendReply).not.toHaveBeenCalled();
  });

  it("sends NO Enter if the text never arrives — the words wait in the box for a human", async () => {
    // The single most important assertion in this file. A blind Enter here would submit whatever the
    // box happens to hold (possibly nothing) as a plan denial.
    mockFetchPane
      .mockResolvedValueOnce(paneWith(buffer()))
      .mockResolvedValue(paneWith(buffer({ focused: true }))); // focused, but the box stays empty
    const res = await submitPromptFeedback({ ...base, prompt: model(), text: "hi" });
    expect(res.status).toBe("error");
    expect(mockSendReply).toHaveBeenCalledTimes(1);
    expect(mockSendKeys.mock.calls.map((c) => c[1])).toEqual([["3"]]); // no Enter
  });

  it("aborts if the dialog DRIFTS mid-flight — a successor never gets the Enter", async () => {
    mockFetchPane
      .mockResolvedValueOnce(paneWith(buffer()))
      .mockResolvedValue(paneWith(buffer({ focused: true, subject: " A different plan entirely" })));
    const res = await submitPromptFeedback({ ...base, prompt: model(), text: "hi" });
    expect(res.status).toBe("error");
    expect(mockSendKeys.mock.calls.map((c) => c[1])).toEqual([["3"]]);
  });

  it("returns changed when the bound digit write reports prompt_changed", async () => {
    mockFetchPane.mockResolvedValue(paneWith(buffer()));
    mockSendKeys.mockResolvedValueOnce({ ok: false, code: "prompt_changed", error: "moved" });
    expect(await submitPromptFeedback({ ...base, prompt: model(), text: "hi" })).toEqual({
      status: "changed",
    });
    expect(mockSendReply).not.toHaveBeenCalled();
  });
});

describe("submitPromptFeedback — the shared terminal, mid-flight", () => {
  it("types NOTHING if someone at the terminal fills the box between our digit and our paste", async () => {
    // The window this flow runs in is precisely when a human is looking at the same dialog. If they
    // start typing after our digit focused the field, their fragment sits at the HEAD — and the
    // read-back below is tail-windowed, so it cannot see a prefix. Enter would then submit their
    // words and ours as one garbled sentence. The note flow clears the field first; this row cannot
    // be cleared, so the focus poll requires it to still be EMPTY.
    mockFetchPane
      .mockResolvedValueOnce(paneWith(buffer())) // entry guard
      .mockResolvedValue(paneWith(buffer({ focused: true, text: "no wait, I meant" })));
    const res = await submitPromptFeedback({ ...base, prompt: model(), text: "use a switch" });
    expect(res.status).toBe("error");
    expect(mockSendReply).not.toHaveBeenCalled();
    expect(mockSendKeys.mock.calls.map((c) => c[1])).toEqual([["3"]]); // no Enter
  });

  it("does not send the Enter if the dialog moved between the last poll and the write", async () => {
    // The re-read before the Enter is what closes the poll→write window. A dialog that drifted in it
    // aborts here rather than committing a plan denial against a screen that has moved on.
    mockFetchPane
      .mockResolvedValueOnce(paneWith(buffer()))
      .mockResolvedValueOnce(paneWith(buffer({ focused: true })))
      .mockResolvedValueOnce(paneWith(buffer({ focused: true, text: "use a switch" })))
      .mockResolvedValue(paneWith(buffer({ subject: " A different plan entirely" })));
    const res = await submitPromptFeedback({ ...base, prompt: model(), text: "use a switch" });
    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys.mock.calls.map((c) => c[1])).toEqual([["3"]]);
  });

  it("reports changed when the BRIDGE refuses the bound Enter (the screen moved under the write)", async () => {
    mockFetchPane
      .mockResolvedValueOnce(paneWith(buffer()))
      .mockResolvedValueOnce(paneWith(buffer({ focused: true })))
      .mockResolvedValue(paneWith(buffer({ focused: true, text: "use a switch" })));
    mockSendKeys
      .mockResolvedValueOnce({ ok: true }) // the digit
      .mockResolvedValueOnce({ ok: false, code: "prompt_changed", error: "moved" }); // the Enter
    expect(await submitPromptFeedback({ ...base, prompt: model(), text: "use a switch" })).toEqual({
      status: "changed",
    });
  });
});

describe("submitPromptOption — an answer digit is refused while the input has focus", () => {
  it("sends nothing: the terminal would type the digit into the box instead of answering", async () => {
    // The bug in #95's §3. In this state the answer rows still parse as an ordinary menu, so the
    // model is what carries the difference — and this is the layer that actually writes, so it
    // refuses independently of whether the renderer got it right.
    const m = model({ focused: true });
    expect(await submitPromptOption({ ...base, prompt: m, option: m.options[1]! })).toEqual({
      status: "changed",
    });
    expect(mockFetchPane).not.toHaveBeenCalled();
    expect(mockSendKeys).not.toHaveBeenCalled();
  });

  it("still answers normally when the box holds text but the pointer is elsewhere", async () => {
    // Verified live: with `❯` off the input row the digits answer as usual, whatever is in the box.
    const m = model({ text: "half a sentence" });
    mockFetchPane.mockResolvedValue(paneWith(buffer({ text: "half a sentence" })));
    expect(await submitPromptOption({ ...base, prompt: m, option: m.options[1]! })).toEqual({
      status: "sent",
    });
    expect(mockSendKeys.mock.calls).toEqual([["w1:p1", ["2"], undefined, m.signature]]);
  });
});
