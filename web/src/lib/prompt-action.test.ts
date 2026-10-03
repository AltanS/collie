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
import { detectApproval } from "./harness/omp/approval";
import { ompAdapter } from "./harness/omp";
import { opencodeAdapter } from "./harness/opencode";
import { t } from "./i18n";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

  it("refuses a free-text row — that is not Claude's plan-feedback send path", async () => {
    const grokAsk = {
      ...model(),
      family: "select" as const,
      feedback: { key: "z", focused: false, text: "", purpose: "free-text" as const },
    };
    const res = await submitPromptFeedback({ ...base, prompt: grokAsk, text: "navy" });
    expect(res).toEqual({
      status: "error",
      error: t("promptAction.feedback.freeTextUnsupported"),
    });
    expect(mockFetchPane).not.toHaveBeenCalled();
    expect(mockSendKeys).not.toHaveBeenCalled();
    expect(mockSendReply).not.toHaveBeenCalled();
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

// ADR 0080, "walk, verify, commit": a row of a POINTED list is answered `[Down × n, Enter]`, and that
// plan is NOT one batch. The arrows go out bound to the screen the user tapped; Enter goes out only
// after a fresh read shows the pointer on the tapped row, bound to THAT read. Every failure path
// asserts what was NOT sent: a half-walked pointer with nothing committed is harmless, a committed
// wrong row is not.
describe("submitPromptOption — a pointed list is walked, verified, then confirmed", () => {
  function pointed(on: 0 | 1, question = "Is this a project you created or one you trust?") {
    const rows = ["Yes, I trust this folder", "No, exit"];
    return [
      " Accessing workspace:",
      "",
      " /tmp/m34-lab-untrusted",
      "",
      ` Quick safety check: ${question} (Like your own code).`,
      "",
      " Claude Code'll be able to read, edit, and execute files here.",
      "",
      " Security guide",
      "",
      ...rows.map((label, i) => ` ${i === on ? "❯" : " "} ${label}`),
      "",
      " Enter to confirm · Esc to cancel",
    ].join("\n");
  }
  const pointedModel = (on: 0 | 1) => {
    const m = detectPromptSelect(splitLines(parseAnsi(pointed(on))));
    if (!m) throw new Error("synthetic pointed buffer did not detect");
    return m;
  };

  it("sends the arrows bound to the tapped screen, then Enter bound to the FRESH read", async () => {
    const m = pointedModel(0);
    const tapped = m.options[1]!;
    expect(tapped.keys).toEqual(["Down", "Enter"]);
    mockFetchPane
      .mockResolvedValueOnce(paneWith(pointed(0))) // entry guard: the screen the user saw
      .mockResolvedValue(paneWith(pointed(1))); // the poll and the pre-commit read: pointer arrived

    expect(await submitPromptOption({ ...base, prompt: m, option: tapped })).toEqual({
      status: "sent",
    });
    expect(mockSendKeys.mock.calls).toEqual([
      ["w1:p1", ["Down"], undefined, m.signature],
      ["w1:p1", ["Enter"], undefined, pointedModel(1).signature],
    ]);
    expect(pointedModel(1).signature).not.toBe(m.signature); // the Enter is bound to a different screen
  });

  it("sends NO Enter when the pointer never arrives on the tapped row", async () => {
    const m = pointedModel(0);
    mockFetchPane.mockResolvedValue(paneWith(pointed(0))); // every poll still shows the pointer elsewhere
    expect(await submitPromptOption({ ...base, prompt: m, option: m.options[1]! })).toEqual({
      status: "changed",
      why: "timeout",
    });
    expect(mockSendKeys.mock.calls.map((c) => c[1])).toEqual([["Down"]]);
  });

  it("sends NO Enter when the dialog vanishes after the walk", async () => {
    const m = pointedModel(0);
    mockFetchPane
      .mockResolvedValueOnce(paneWith(pointed(0)))
      .mockResolvedValue(paneWith("● Working on it\n  ⎿  running"));
    expect(await submitPromptOption({ ...base, prompt: m, option: m.options[1]! })).toEqual({
      status: "changed",
      why: "vanished",
    });
    expect(mockSendKeys.mock.calls.map((c) => c[1])).toEqual([["Down"]]);
  });

  it("sends NO Enter when a different dialog replaces it mid-walk", async () => {
    const m = pointedModel(0);
    mockFetchPane
      .mockResolvedValueOnce(paneWith(pointed(0)))
      .mockResolvedValue(paneWith(pointed(1, "Is this some other folder you trust?")));
    const refused = await submitPromptOption({ ...base, prompt: m, option: m.options[1]! });
    expect(refused).toMatchObject({ status: "changed" });
    // The refusal names the field that differed, so a drift is a one-line diagnosis.
    expect(refused).toHaveProperty("why", expect.stringMatching(/^drift: (question|coreSignature line \d+:)/));
    expect(mockSendKeys.mock.calls.map((c) => c[1])).toEqual([["Down"]]);
  });

  it("binds Enter to the read that proved the pointer, with no extra read", async () => {
    // The poll hands back the model it accepted, so the commit is bound to that very read. A
    // keystroke at the terminal after it is the bridge's to refuse (the next test), not a second read.
    const m = pointedModel(0);
    mockFetchPane
      .mockResolvedValueOnce(paneWith(pointed(0))) // entry
      .mockResolvedValueOnce(paneWith(pointed(1))) // poll: arrived
      .mockResolvedValue(paneWith(pointed(0))); // anything after the poll must never be read
    expect(await submitPromptOption({ ...base, prompt: m, option: m.options[1]! })).toEqual({
      status: "sent",
    });
    expect(mockFetchPane).toHaveBeenCalledTimes(2);
    expect(mockSendKeys.mock.calls).toEqual([
      ["w1:p1", ["Down"], undefined, m.signature],
      ["w1:p1", ["Enter"], undefined, pointedModel(1).signature],
    ]);
  });

  it("stops after the walk when the bridge refuses it as prompt_changed", async () => {
    const m = pointedModel(0);
    mockFetchPane.mockResolvedValue(paneWith(pointed(0)));
    mockSendKeys.mockResolvedValueOnce({ ok: false, code: "prompt_changed", error: "moved" });
    expect(await submitPromptOption({ ...base, prompt: m, option: m.options[1]! })).toEqual({
      status: "changed",
      why: "bridge",
    });
    expect(mockSendKeys).toHaveBeenCalledTimes(1);
  });

  it("keeps the bridge's own reason as `why` instead of the step's name", async () => {
    const m = pointedModel(0);
    mockFetchPane.mockResolvedValue(paneWith(pointed(0)));
    mockSendKeys.mockResolvedValueOnce({
      ok: false,
      code: "prompt_changed",
      error: "moved",
      reason: "not_in_tail",
    });
    expect(await submitPromptOption({ ...base, prompt: m, option: m.options[1]! })).toEqual({
      status: "changed",
      why: "bridge: not_in_tail",
    });

    mockFetchPane
      .mockReset()
      .mockResolvedValueOnce(paneWith(pointed(0)))
      .mockResolvedValue(paneWith(pointed(1)));
    mockSendKeys
      .mockReset()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, code: "prompt_changed", error: "moved", reason: "style_not_found" });
    expect(await submitPromptOption({ ...base, prompt: m, option: m.options[1]! })).toEqual({
      status: "changed",
      why: "bridge: style_not_found",
    });
  });

  it("reports changed when the bridge refuses the bound Enter", async () => {
    const m = pointedModel(0);
    mockFetchPane
      .mockResolvedValueOnce(paneWith(pointed(0)))
      .mockResolvedValue(paneWith(pointed(1)));
    mockSendKeys
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, code: "prompt_changed", error: "moved" });
    expect(await submitPromptOption({ ...base, prompt: m, option: m.options[1]! })).toEqual({
      status: "changed",
      why: "bridge",
    });
    expect(mockSendKeys).toHaveBeenCalledTimes(2);
  });

  it("walks upward the same way", async () => {
    const m = pointedModel(1);
    const tapped = m.options[0]!;
    expect(tapped.keys).toEqual(["Up", "Enter"]);
    mockFetchPane
      .mockResolvedValueOnce(paneWith(pointed(1)))
      .mockResolvedValue(paneWith(pointed(0)));
    expect(await submitPromptOption({ ...base, prompt: m, option: tapped })).toEqual({
      status: "sent",
    });
    expect(mockSendKeys.mock.calls.map((c) => c[1])).toEqual([["Up"], ["Enter"]]);
  });

  it("a row already under the pointer (plan [Enter]) stays ONE bound write", async () => {
    const m = pointedModel(0);
    const tapped = m.options[0]!;
    expect(tapped.keys).toEqual(["Enter"]);
    mockFetchPane.mockResolvedValue(paneWith(pointed(0)));
    expect(await submitPromptOption({ ...base, prompt: m, option: tapped })).toEqual({
      status: "sent",
    });
    expect(mockSendKeys.mock.calls).toEqual([["w1:p1", ["Enter"], undefined, m.signature]]);
  });

  it("refuses a stale tap at entry: the pointer moved since the render", async () => {
    const m = pointedModel(0);
    mockFetchPane.mockResolvedValue(paneWith(pointed(1))); // someone moved the pointer before the tap
    expect(await submitPromptOption({ ...base, prompt: m, option: m.options[1]! })).toEqual({
      status: "changed",
      why: "entry",
    });
    expect(mockSendKeys).not.toHaveBeenCalled();
  });

  it("leaves a digit plan alone: one bound write, no extra read", async () => {
    const m = model();
    mockFetchPane.mockResolvedValue(paneWith(buffer()));
    expect(await submitPromptOption({ ...base, prompt: m, option: m.options[1]! })).toEqual({
      status: "sent",
    });
    expect(mockSendKeys.mock.calls).toEqual([["w1:p1", ["2"], undefined, m.signature]]);
    expect(mockFetchPane).toHaveBeenCalledTimes(1);
  });
});

// ADR 0080 point 6: a list that declares `clampedEnds` commits an edge row with a sticky arrow. The
// models come from omp's approval grammar (the real adapter, agent "omp"), which declares the clamp.
describe("submitPromptOption — a clamped list commits an edge row with a sticky arrow", () => {
  const PANES = join(import.meta.dirname, "..", "fixtures", "panes");
  const ompScreen = (name: string) => readFileSync(join(PANES, name), "utf8");
  const onApprove = ompScreen("omp--v18-4-approval-bash.txt");
  const onDeny = ompScreen("omp--v18-4-approval-bash-moved.txt");
  const ompModel = (screen: string) => {
    const detected = detectApproval(splitLines(parseAnsi(screen)));
    if (!detected) throw new Error("omp approval fixture did not detect");
    return detected;
  };
  const omp = { ...base, agent: "omp" };

  it("the omp approval model declares the clamp", () => {
    expect(ompModel(onApprove).clampedEnds).toBe(true);
  });

  it("Deny tapped with the pointer on Deny: ONE call, Down+Enter, bound to the entry region", async () => {
    const m = ompModel(onDeny);
    const deny = m.options[1]!;
    expect(deny.keys).toEqual(["Enter"]); // the plan is unchanged; only the sent batch differs
    mockFetchPane.mockResolvedValue(paneWith(onDeny));
    expect(await submitPromptOption({ ...omp, prompt: m, option: deny })).toEqual({ status: "sent" });
    expect(mockSendKeys.mock.calls).toEqual([["w1:p1", ["Down", "Enter"], undefined, m.signature]]);
  });

  it("Approve tapped with the pointer on Approve: ONE call, Up+Enter", async () => {
    const m = ompModel(onApprove);
    mockFetchPane.mockResolvedValue(paneWith(onApprove));
    expect(await submitPromptOption({ ...omp, prompt: m, option: m.options[0]! })).toEqual({
      status: "sent",
    });
    expect(mockSendKeys.mock.calls).toEqual([["w1:p1", ["Up", "Enter"], undefined, m.signature]]);
  });

  it("Deny tapped from Approve: walk Down bound to the tapped screen, then Down+Enter bound to the fresh read", async () => {
    const m = ompModel(onApprove);
    const deny = m.options[1]!;
    expect(deny.keys).toEqual(["Down", "Enter"]);
    mockFetchPane
      .mockResolvedValueOnce(paneWith(onApprove)) // entry guard
      .mockResolvedValue(paneWith(onDeny)); // poll and pre-commit read: the pointer arrived
    expect(await submitPromptOption({ ...omp, prompt: m, option: deny })).toEqual({ status: "sent" });
    expect(mockSendKeys.mock.calls).toEqual([
      ["w1:p1", ["Down"], undefined, m.signature],
      ["w1:p1", ["Down", "Enter"], undefined, ompModel(onDeny).signature],
    ]);
  });

  it("Approve tapped from Deny: walk Up, then Up+Enter bound to the fresh read", async () => {
    const m = ompModel(onDeny);
    const approve = m.options[0]!;
    expect(approve.keys).toEqual(["Up", "Enter"]);
    mockFetchPane
      .mockResolvedValueOnce(paneWith(onDeny))
      .mockResolvedValue(paneWith(onApprove));
    expect(await submitPromptOption({ ...omp, prompt: m, option: approve })).toEqual({ status: "sent" });
    expect(mockSendKeys.mock.calls).toEqual([
      ["w1:p1", ["Up"], undefined, m.signature],
      ["w1:p1", ["Up", "Enter"], undefined, ompModel(onApprove).signature],
    ]);
  });

  it("sends nothing past the walk when the pointer never arrives, clamped or not", async () => {
    const m = ompModel(onApprove);
    mockFetchPane.mockResolvedValue(paneWith(onApprove));
    expect(await submitPromptOption({ ...omp, prompt: m, option: m.options[1]! })).toEqual({
      status: "changed",
      why: "timeout",
    });
    expect(mockSendKeys.mock.calls.map((c) => c[1])).toEqual([["Down"]]);
  });

  it("an unclamped model keeps a bare Enter (a Claude pointed list)", async () => {
    // Same two-row shape as the walk tests above, from a grammar that declares no clamp.
    const text = [
      " Accessing workspace:",
      "",
      " /tmp/m34-lab-untrusted",
      "",
      " Quick safety check: Is this a project you created or one you trust? (Like your own code).",
      "",
      " Claude Code'll be able to read, edit, and execute files here.",
      "",
      " Security guide",
      "",
      " ❯ Yes, I trust this folder",
      "   No, exit",
      "",
      " Enter to confirm · Esc to cancel",
    ].join("\n");
    const m = detectPromptSelect(splitLines(parseAnsi(text)))!;
    expect(m.clampedEnds).toBeUndefined();
    mockFetchPane.mockResolvedValue(paneWith(text));
    expect(await submitPromptOption({ ...base, prompt: m, option: m.options[0]! })).toEqual({
      status: "sent",
    });
    expect(mockSendKeys.mock.calls).toEqual([["w1:p1", ["Enter"], undefined, m.signature]]);
  });
});

// THE REAL PICKER, WALKED. omp's `/switch` picker rewrites two detail rows under the list every time the
// pointer moves. A `coreSignature` that kept them made the verify step see "another dialog" after every
// walk, so a walked tap answered `changed` and never committed (found live, 2026-10-03). These screens
// are real captures of one picker with the pointer on haiku and on fable, read through the real omp
// adapter, so what moves between the two reads is exactly what omp repaints.
describe("submitPromptOption: a walked tap on the real omp model picker commits", () => {
  const PANES = join(import.meta.dirname, "..", "fixtures", "panes");
  const screen = (name: string) => readFileSync(join(PANES, name), "utf8");
  const onHaiku = screen("omp--v18-4-switch-ptr-haiku.txt");
  const onFable = screen("omp--v18-4-switch-ptr-fable.txt");
  const pickerModel = (text: string) => {
    const block = ompAdapter.buildBlocks(splitLines(parseAnsi(text))).find((b) => b.kind === "prompt-select");
    if (block === undefined || block.kind !== "prompt-select") throw new Error("omp picker did not lift");
    return block.prompt;
  };

  it("Down to fable bound to the tapped screen, then Enter bound to the fresh read", async () => {
    const m = pickerModel(onHaiku);
    const tapped = m.options.find((o) => o.label === "anthropic/claude-fable-5-1")!;
    expect(tapped.keys).toEqual(["Down", "Enter"]);
    mockFetchPane
      .mockResolvedValueOnce(paneWith(onHaiku)) // entry guard: the screen the user saw
      .mockResolvedValue(paneWith(onFable)); // the poll and the pre-commit read: the pointer arrived

    expect(await submitPromptOption({ ...base, agent: "omp", prompt: m, option: tapped })).toEqual({
      status: "sent",
    });
    expect(mockSendKeys.mock.calls).toEqual([
      ["w1:p1", ["Down"], undefined, m.signature],
      ["w1:p1", ["Enter"], undefined, pickerModel(onFable).signature],
    ]);
    // The detail rows moved between the two reads, which is why the signatures differ and the
    // identity must not.
    expect(pickerModel(onFable).signature).not.toBe(m.signature);
  });
});

// ADR 0080 for a HORIZONTAL list. opencode's permission dialog is a row of chips; its plans are
// `[Right × d, Enter]` and its pointer is a background colour, so two captures with the pointer on
// different chips carry the SAME text. These are real captures read through the real adapter.
describe("submitPromptOption: a walked tap on the real opencode permission chips", () => {
  const PANES = join(import.meta.dirname, "..", "fixtures", "panes");
  const screen = (name: string) => readFileSync(join(PANES, name), "utf8");
  const onOnce = screen("oc--permission-bash.txt");
  const onAlways = screen("oc--permission-bash--moved.txt");
  const dialogModel = (text: string) => {
    const block = opencodeAdapter.buildBlocks(splitLines(parseAnsi(text))).find((b) => b.kind === "prompt-select");
    if (block === undefined || block.kind !== "prompt-select") throw new Error("opencode dialog did not lift");
    return block.prompt;
  };
  const opencode = { ...base, agent: "opencode" };

  it("Right bound to the tapped screen, then Enter bound to the fresh read", async () => {
    const m = dialogModel(onOnce);
    const tapped = m.options.find((o) => o.label === "Allow always")!;
    expect(tapped.keys).toEqual(["Right", "Enter"]);
    mockFetchPane
      .mockResolvedValueOnce(paneWith(onOnce)) // entry guard: the screen the user saw
      .mockResolvedValue(paneWith(onAlways)); // the poll and the pre-commit read: the chip arrived

    expect(await submitPromptOption({ ...opencode, prompt: m, option: tapped })).toEqual({ status: "sent" });
    // Both writes carry the styled lines too (ADR 0080 point 7): the arrow the screen the user tapped,
    // the Enter the read that proved the chip. The text region is the same string either time.
    expect(mockSendKeys.mock.calls).toEqual([
      ["w1:p1", ["Right"], undefined, m.signature, m.styledSignature],
      ["w1:p1", ["Enter"], undefined, dialogModel(onAlways).signature, dialogModel(onAlways).styledSignature],
    ]);
    // The text binding cannot see a style: both text bindings are the same string. The styled lines
    // are what tells the bridge the chip moved.
    expect(dialogModel(onAlways).signature).toBe(m.signature);
    expect(m.styledSignature).toBeDefined();
    expect(dialogModel(onAlways).styledSignature).not.toBe(m.styledSignature);
  });

  it("sends NO Enter when the chip never arrives on the tapped option", async () => {
    const m = dialogModel(onOnce);
    mockFetchPane.mockResolvedValue(paneWith(onOnce)); // every read still shows the pointer on the first chip
    expect(
      await submitPromptOption({ ...opencode, prompt: m, option: m.options.find((o) => o.label === "Allow always")! }),
    ).toEqual({ status: "changed", why: "timeout" });
    expect(mockSendKeys.mock.calls.map((c) => c[1])).toEqual([["Right"]]);
  });

  it("refuses a stale tap at entry: the text is the same, the chip is not, and nothing is sent", async () => {
    const m = dialogModel(onOnce); // the user saw the chip on Allow once and tapped Reject
    mockFetchPane.mockResolvedValue(paneWith(onAlways)); // the chip has since moved at the desk
    expect(
      await submitPromptOption({ ...opencode, prompt: m, option: m.options.find((o) => o.label === "Reject")! }),
    ).toEqual({ status: "changed", why: "entry" });
    expect(mockSendKeys).not.toHaveBeenCalled();
  });

  it("a tap on the pointed chip is one guarded Enter", async () => {
    const m = dialogModel(onOnce);
    mockFetchPane.mockResolvedValue(paneWith(onOnce));
    expect(await submitPromptOption({ ...opencode, prompt: m, option: m.options[0]! })).toEqual({ status: "sent" });
    expect(mockSendKeys.mock.calls).toEqual([["w1:p1", ["Enter"], undefined, m.signature, m.styledSignature]]);
  });

  it("the bridge refusing the bound Enter answers changed, and says it was the bridge", async () => {
    // A keystroke at the desk after the proof moved the chip: the bridge sees the colours differ.
    const m = dialogModel(onOnce);
    const tapped = m.options.find((o) => o.label === "Allow always")!;
    mockFetchPane.mockResolvedValueOnce(paneWith(onOnce)).mockResolvedValue(paneWith(onAlways));
    mockSendKeys
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, code: "prompt_changed", error: "moved" });
    expect(await submitPromptOption({ ...opencode, prompt: m, option: tapped })).toEqual({
      status: "changed",
      why: "bridge",
    });
  });
});
