import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The whole prompt-select feature end to end: the presentational component, the shared race guard
// (submitPromptOption), and the wired tap (component → injected handler → api). The api layer is
// mocked so we can drive fresh-fetch revision/menu outcomes precisely; the detector and status
// channel are the real thing.
vi.mock("@/lib/api", () => ({
  fetchPane: vi.fn(),
  sendKeys: vi.fn(),
  sendReply: vi.fn(),
}));

import { fetchPane, sendKeys, sendReply } from "@/lib/api";
import { parseAnsi } from "@/lib/ansi";
import { splitLines, type PromptModel } from "@/lib/blocks";
import { detectPromptSelect } from "@/lib/harness/claude/prompt-select";
import { submitPromptFeedback, submitPromptOption } from "@/lib/prompt-action";
import { clearStatus, setStatus, useStatus } from "@/lib/status";
import { PromptSelectBlock, type PromptBlockAction } from "./prompt-select-block";

const mockFetchPane = vi.mocked(fetchPane);
const mockSendKeys = vi.mocked(sendKeys);
const mockSendReply = vi.mocked(sendReply);

// Anchored on this file's directory (not `new URL(import.meta.url)`, which Vite rewrites to an asset).
const PANES_DIR = join(import.meta.dirname, "..", "fixtures", "panes");
const fixtureText = (name: string) => readFileSync(join(PANES_DIR, name), "utf8");
function fixtureModel(name: string): PromptModel {
  const model = detectPromptSelect(splitLines(parseAnsi(fixtureText(name))));
  if (!model) throw new Error(`fixture ${name} did not detect a prompt`);
  return model;
}

beforeEach(() => {
  clearStatus();
  mockFetchPane.mockReset();
  mockSendKeys.mockReset();
  mockSendKeys.mockResolvedValue({ ok: true });
  mockSendReply.mockReset();
  mockSendReply.mockResolvedValue({ ok: true });
});

const selectModel: PromptModel = {
  question: "Which color theme should the dashboard use?",
  family: "select",
  options: [
    { label: "Red", description: "A warm, high-energy theme", keys: ["1", "Enter"] },
    { label: "Green", keys: ["2", "Enter"] },
  ],
  signature: "which-color-theme-region",
  coreSignature: "which-color-theme-core",
};

describe("PromptSelectBlock — presentation", () => {
  it("renders each option as a focusable button, labelled by the question", () => {
    render(<PromptSelectBlock prompt={selectModel} onAction={vi.fn()} />);
    expect(
      screen.getByRole("group", { name: "Which color theme should the dashboard use?" }),
    ).toBeInTheDocument();
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(2);
    expect(screen.getByRole("button", { name: /Red/ })).toBeInTheDocument();
    // Description renders as a secondary text node (not markup).
    expect(screen.getByText("A warm, high-energy theme")).toBeInTheDocument();
    // Each row leads with its terminal-menu digit (the KeyBadge affordance).
    expect(within(screen.getByRole("button", { name: /Red/ })).getByText("1")).toBeInTheDocument();
    expect(within(screen.getByRole("button", { name: /Green/ })).getByText("2")).toBeInTheDocument();
    buttons[0]!.focus();
    expect(buttons[0]).toHaveFocus();
  });

  it("calls onAction with the tapped option", async () => {
    const onAction = vi.fn();
    const user = userEvent.setup();
    render(<PromptSelectBlock prompt={selectModel} onAction={onAction} />);
    await user.click(screen.getByRole("button", { name: /Green/ }));
    expect(onAction).toHaveBeenCalledWith({ kind: "option", option: selectModel.options[1] });
  });

  it("disables every button when disabled (read-only device / gone pane)", () => {
    render(<PromptSelectBlock prompt={selectModel} onAction={vi.fn()} disabled />);
    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
  });
});

describe("submitPromptOption — race guard + per-family keystroke recipe", () => {
  it("select family: sends digit THEN Enter when the fresh menu matches", async () => {
    const model = fixtureModel("claude--select-menu.txt");
    mockFetchPane.mockResolvedValue({
      paneId: "w1:p1",
      text: fixtureText("claude--select-menu.txt"),
      truncated: false,
      revision: 7,
    });
    const res = await submitPromptOption({
      paneId: "w1:p1",
      requestedLines: 600,
      detectedRevision: 7,
      agent: "claude",
      canWrite: () => true,
      prompt: model,
      option: model.options[0]!,
    });
    expect(res).toEqual({ status: "sent" });
    expect(mockSendKeys).toHaveBeenCalledWith(
      "w1:p1",
      ["1", "Enter"],
      undefined,
      model.signature,
    );
  });

  it("permission family: sends the digit ALONE (a trailing Enter would leak)", async () => {
    const model = fixtureModel("claude--permission-edit.txt");
    mockFetchPane.mockResolvedValue({
      paneId: "w1:p1",
      text: fixtureText("claude--permission-edit.txt"),
      truncated: false,
      revision: 3,
    });
    const res = await submitPromptOption({
      paneId: "w1:p1",
      requestedLines: 600,
      detectedRevision: 3,
      agent: "claude",
      canWrite: () => true,
      prompt: model,
      option: model.options[0]!,
    });
    expect(res).toEqual({ status: "sent" });
    expect(mockSendKeys).toHaveBeenCalledWith("w1:p1", ["1"], undefined, model.signature);
  });

  it("rejects (no send) when the fresh revision differs", async () => {
    const model = fixtureModel("claude--select-menu.txt");
    mockFetchPane.mockResolvedValue({
      paneId: "w1:p1",
      text: fixtureText("claude--select-menu.txt"),
      truncated: false,
      revision: 99, // moved on since the menu was detected against revision 7
    });
    const res = await submitPromptOption({
      paneId: "w1:p1",
      requestedLines: 600,
      detectedRevision: 7,
      agent: "claude",
      canWrite: () => true,
      prompt: model,
      option: model.options[0]!,
    });
    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
  });

  it("rejects (no send) when the fresh buffer resolves to a different menu", async () => {
    const model = fixtureModel("claude--select-menu.txt");
    mockFetchPane.mockResolvedValue({
      paneId: "w1:p1",
      text: fixtureText("claude--permission-edit.txt"), // same revision, different dialog
      truncated: false,
      revision: 7,
    });
    const res = await submitPromptOption({
      paneId: "w1:p1",
      requestedLines: 600,
      detectedRevision: 7,
      agent: "claude",
      canWrite: () => true,
      prompt: model,
      option: model.options[0]!,
    });
    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
  });

  it("passes on a 304 whose revision matches AND whose cached text re-derives the same menu", async () => {
    // fetchPane's 304 path returns the cached body (text included), so the re-derivation — which
    // now runs on EVERY path because Herdr 0.7.x's revision is a stub — sees the full buffer.
    const model = fixtureModel("claude--permission-bash.txt");
    mockFetchPane.mockResolvedValue({
      paneId: "w1:p1",
      text: fixtureText("claude--permission-bash.txt"),
      truncated: false,
      revision: 42, // the cached body's revision — matches what the menu was detected against
      notModified: true,
    });
    const res = await submitPromptOption({
      paneId: "w1:p1",
      requestedLines: 600,
      detectedRevision: 42,
      agent: "claude",
      canWrite: () => true,
      prompt: model,
      option: model.options[1]!,
    });
    expect(res).toEqual({ status: "sent" });
    expect(mockSendKeys).toHaveBeenCalledWith("w1:p1", ["2"], undefined, model.signature);
  });

  it("rejects a 304 with MATCHING (stub) revisions when the cached text no longer shows the menu", async () => {
    // The live hole found on 2026-07-05: Herdr 0.7.x returns revision 0 for every read, so the
    // revision gate is inert — a frozen tap whose confirm-fetch 304s against an advanced cache
    // must still be caught by re-deriving the menu from the cached (= latest) text.
    const model = fixtureModel("claude--permission-bash.txt");
    mockFetchPane.mockResolvedValue({
      paneId: "w1:p1",
      text: fixtureText("claude--done.txt"), // menu is long gone; agent moved on
      truncated: false,
      revision: 0, // stub revision — matches detectedRevision, provides no protection
      notModified: true,
    });
    const res = await submitPromptOption({
      paneId: "w1:p1",
      requestedLines: 600,
      detectedRevision: 0,
      agent: "claude",
      canWrite: () => true,
      prompt: model,
      option: model.options[1]!,
    });
    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
  });

  it("rejects a 304 whose revision differs — 'not modified' only means unchanged since the LAST POLL", async () => {
    // Background polling advances the ETag cache while a frozen mirror stands still, so a 304 must
    // NOT bypass the revision check: the tap was made against an older (frozen) snapshot.
    const model = fixtureModel("claude--permission-bash.txt");
    mockFetchPane.mockResolvedValue({
      paneId: "w1:p1",
      text: "",
      truncated: false,
      revision: 43, // the cache moved on; the user tapped the menu detected at revision 42
      notModified: true,
    });
    const res = await submitPromptOption({
      paneId: "w1:p1",
      requestedLines: 600,
      detectedRevision: 42,
      agent: "claude",
      canWrite: () => true,
      prompt: model,
      option: model.options[1]!,
    });
    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
  });

  it("surfaces the bridge error when sendKeys fails", async () => {
    const model = fixtureModel("claude--select-menu.txt");
    mockFetchPane.mockResolvedValue({
      paneId: "w1:p1",
      text: fixtureText("claude--select-menu.txt"),
      truncated: false,
      revision: 5,
    });
    mockSendKeys.mockResolvedValue({ ok: false, error: "agent busy" });
    const res = await submitPromptOption({
      paneId: "w1:p1",
      requestedLines: 600,
      detectedRevision: 5,
      agent: "claude",
      canWrite: () => true,
      prompt: model,
      option: model.options[0]!,
    });
    expect(res).toEqual({ status: "error", error: "agent busy" });
  });

  it("maps a bridge prompt_changed conflict to changed", async () => {
    const model = fixtureModel("claude--select-menu.txt");
    mockFetchPane.mockResolvedValue({
      paneId: "w1:p1",
      text: fixtureText("claude--select-menu.txt"),
      truncated: false,
      revision: 5,
    });
    mockSendKeys.mockResolvedValue({
      ok: false,
      error: "prompt changed",
      code: "prompt_changed",
    });
    const res = await submitPromptOption({
      paneId: "w1:p1",
      requestedLines: 600,
      detectedRevision: 5,
      agent: "claude",
      canWrite: () => true,
      prompt: model,
      option: model.options[0]!,
    });
    expect(res).toEqual({ status: "changed" });
  });
});

// A miniature of AgentChat's handler + status surface, so the wired tap is exercised through the
// real component and the "menu changed" notice pattern the app uses.
function StatusSentinel() {
  const status = useStatus();
  return <div data-testid="status">{status?.text ?? ""}</div>;
}

function Harness({ prompt, detectedRevision }: { prompt: PromptModel; detectedRevision: number }) {
  async function onAction(action: PromptBlockAction) {
    const result =
      action.kind === "option"
        ? await submitPromptOption({
            paneId: "w1:p1",
            requestedLines: 600,
            detectedRevision,
            agent: "claude",
            canWrite: () => true,
            prompt,
            option: action.option,
          })
        : await submitPromptFeedback({
            paneId: "w1:p1",
            requestedLines: 600,
            detectedRevision,
            agent: "claude",
            canWrite: () => true,
            prompt,
            text: action.text,
          });
    if (result.status === "sent") setStatus("Sent", "success");
    else if (result.status === "changed") setStatus("Menu changed — refreshing", "warn");
    else setStatus(result.error, "error");
  }
  return (
    <>
      <PromptSelectBlock prompt={prompt} onAction={onAction} />
      <StatusSentinel />
    </>
  );
}

describe("PromptSelectBlock — wired tap (component → handler → api)", () => {
  it("tapping an option runs the guard, sends its keys, and confirms", async () => {
    const model = fixtureModel("claude--select-menu.txt");
    mockFetchPane.mockResolvedValue({
      paneId: "w1:p1",
      text: fixtureText("claude--select-menu.txt"),
      truncated: false,
      revision: 4,
    });
    const user = userEvent.setup();
    render(<Harness prompt={model} detectedRevision={4} />);

    await user.click(screen.getByRole("button", { name: /Red/ }));

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("Sent"));
    expect(mockSendKeys).toHaveBeenCalledWith(
      "w1:p1",
      ["1", "Enter"],
      undefined,
      model.signature,
    );
  });

  it("a stale tap surfaces a 'menu changed' notice and sends nothing", async () => {
    const model = fixtureModel("claude--select-menu.txt");
    mockFetchPane.mockResolvedValue({
      paneId: "w1:p1",
      text: fixtureText("claude--permission-edit.txt"), // the pane moved to a different dialog
      truncated: false,
      revision: 4,
    });
    const user = userEvent.setup();
    render(<Harness prompt={model} detectedRevision={4} />);

    await user.click(screen.getByRole("button", { name: /Green/ }));

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("Menu changed"));
    expect(mockSendKeys).not.toHaveBeenCalled();
  });
});

// H1 regression (pre-release review): promptsEqual used to compare only family/question/labels, so
// two edit-permission prompts with the same shape but a DIFFERENT subject (a second edit to the same
// file) were "equal" — a frozen tap on prompt A could approve prompt B the user never saw. The region
// `signature` (which folds in the subject above the options) now distinguishes them.
describe("submitPromptOption — same-shaped successor prompt (H1)", () => {
  const RULE = "─".repeat(30);
  const promptFor = (subject: string) =>
    [RULE, `  ${subject}`, RULE, " Do you want to proceed?", " ❯ 1. Yes", "   2. No", "", " Esc to cancel · Tab to amend"].join("\n");
  const modelFor = (subject: string) => {
    const m = detectPromptSelect(splitLines(parseAnsi(promptFor(subject))));
    if (!m) throw new Error("synthetic permission prompt did not detect");
    return m;
  };

  it("rejects the tap when only the subject changed (identical question + labels)", async () => {
    const promptA = modelFor("write hello.txt");
    // The pane advanced: A was answered elsewhere and a same-shaped B is now on screen (stub rev 0).
    mockFetchPane.mockResolvedValue({
      paneId: "w1:p1",
      text: promptFor("delete production.db"),
      truncated: false,
      revision: 0,
    });
    const res = await submitPromptOption({
      paneId: "w1:p1",
      requestedLines: 600,
      detectedRevision: 0,
      agent: "claude",
      canWrite: () => true,
      prompt: promptA,
      option: promptA.options[0]!,
    });
    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
  });

  it("still sends when the whole region (subject included) is unchanged", async () => {
    const same = promptFor("write hello.txt");
    const promptA = modelFor("write hello.txt");
    mockFetchPane.mockResolvedValue({ paneId: "w1:p1", text: same, truncated: false, revision: 0 });
    const res = await submitPromptOption({
      paneId: "w1:p1",
      requestedLines: 600,
      detectedRevision: 0,
      agent: "claude",
      canWrite: () => true,
      prompt: promptA,
      option: promptA.options[0]!,
    });
    expect(res).toEqual({ status: "sent" });
    expect(mockSendKeys).toHaveBeenCalledWith("w1:p1", ["1"], undefined, promptA.signature);
  });
});

// The plan dialog's inline input row (issue #95). Three surfaces, and the state that decides which
// one shows also decides whether the ANSWER buttons work at all — so this block is where the phone
// stops lying about a screen it cannot drive. Fixtures are real captures; PLAN_FEEDBACK_NOTES.md is
// the ground truth for what each state does in the terminal.
describe("PromptSelectBlock — the feedback input row", () => {
  const OFFER = "Tell Claude what to change";

  it("offers the composer when the box is empty and the pointer is elsewhere", () => {
    const model = fixtureModel("claude--plan-approval.txt");
    render(<PromptSelectBlock prompt={model} onAction={vi.fn()} />);
    // The three answers are live buttons, and the row itself is an affordance — never a fourth
    // answer button, because pressing its digit answers nothing.
    expect(screen.getByRole("button", { name: new RegExp(OFFER) })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Yes, and use auto mode/ })).toBeEnabled();
  });

  it("locks every button behind a banner while the terminal's input has FOCUS", async () => {
    // The heart of #95: in this state the answer rows still parse as an ordinary menu, and tapping
    // one types its digit into the box instead of answering. Nothing may be pressable.
    const model = fixtureModel("claude--plan-approval--feedback-focused.txt");
    const onAction = vi.fn();
    const user = userEvent.setup();
    render(<PromptSelectBlock prompt={model} onAction={onAction} />);
    expect(screen.getByText(/has the keyboard in the terminal/)).toBeInTheDocument();
    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /Yes, manually approve edits/ }));
    expect(onAction).not.toHaveBeenCalled();
  });

  it("shows what is in the box instead of offering to type, once it holds text", async () => {
    // Answers still work here (verified live), but Collie must not type: the caret resets to position
    // 0 on re-entry, so our words would be prepended to the sentence already there.
    const model = fixtureModel("claude--plan-approval--feedback-typed.txt");
    const onAction = vi.fn();
    const user = userEvent.setup();
    render(<PromptSelectBlock prompt={model} onAction={onAction} />);
    expect(screen.getByText(/use a guard clause instead/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: new RegExp(OFFER) })).toBeNull();
    await user.click(screen.getByRole("button", { name: /Yes, manually approve edits/ }));
    expect(onAction).toHaveBeenCalledWith({ kind: "option", option: model.options[2] });
  });

  it("the composer sends a feedback action carrying the typed text", async () => {
    const model = fixtureModel("claude--plan-approval.txt");
    const onAction = vi.fn();
    const user = userEvent.setup();
    render(<PromptSelectBlock prompt={model} onAction={onAction} />);
    await user.click(screen.getByRole("button", { name: new RegExp(OFFER) }));
    // The wording has to say what actually happens: this DENIES the plan and hands over the text.
    expect(screen.getByText(/Claude keeps planning instead of starting work/)).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Feedback text" }), "use a switch");
    await user.click(screen.getByRole("button", { name: "Send feedback" }));
    expect(onAction).toHaveBeenCalledWith({ kind: "feedback", text: "use a switch" });
  });

  it("keeps the draft on screen when a send is refused", async () => {
    // Up to FEEDBACK_MAX_LENGTH characters, thumb-typed on a phone. A `changed` refusal must not eat
    // them — this is the longest text the app ever asks anyone to type.
    const model = fixtureModel("claude--plan-approval.txt");
    const user = userEvent.setup();
    render(<PromptSelectBlock prompt={model} onAction={() => false} />);
    await user.click(screen.getByRole("button", { name: new RegExp(OFFER) }));
    await user.type(screen.getByRole("textbox", { name: "Feedback text" }), "keep me");
    await user.click(screen.getByRole("button", { name: "Send feedback" }));
    expect(screen.getByRole("textbox", { name: "Feedback text" })).toHaveValue("keep me");
  });

  it("says WE are sending, not that the terminal is, while our own sequence runs", async () => {
    // Our choreography focuses the row and fills it, so mid-flight the screen is indistinguishable
    // from "someone at the terminal is typing" — which would be a lie told to the person who just
    // pressed Send about their own action.
    const model = fixtureModel("claude--plan-approval.txt");
    let release: () => void = () => {};
    const blocked = new Promise<boolean>((r) => (release = () => r(true)));
    const user = userEvent.setup();
    render(<PromptSelectBlock prompt={model} onAction={() => blocked} />);
    await user.click(screen.getByRole("button", { name: new RegExp(OFFER) }));
    await user.type(screen.getByRole("textbox", { name: "Feedback text" }), "use a switch");
    await user.click(screen.getByRole("button", { name: "Send feedback" }));
    expect(await screen.findByText("Sending feedback…")).toBeInTheDocument();
    expect(screen.queryByText(/in the terminal/)).toBeNull();
    release();
  });

  it("drives the real choreography end to end through the wired handler", async () => {
    const name = "claude--plan-approval--three-row.txt";
    const model = fixtureModel(name);
    // The three real captures the flow actually walks: the dialog as tapped, then focused-and-empty
    // (what the digit produces), then filled — the placeholder swapped for our words, which is
    // exactly what the terminal shows once the paste lands.
    const focusedEmpty = fixtureText("claude--plan-approval--three-row-focused.txt");
    const pane = (text: string) => ({ paneId: "w1:p1", text, truncated: false, revision: 7 });
    mockFetchPane
      .mockResolvedValueOnce(pane(fixtureText(name))) // entry guard
      .mockResolvedValueOnce(pane(focusedEmpty)) // focus poll: focused, box still empty
      .mockResolvedValue(pane(focusedEmpty.replace("Tell Claude what to change", "use a switch")));
    const user = userEvent.setup();
    render(<Harness prompt={model} detectedRevision={7} />);
    await user.click(screen.getByRole("button", { name: new RegExp(OFFER) }));
    await user.type(screen.getByRole("textbox", { name: "Feedback text" }), "use a switch");
    await user.click(screen.getByRole("button", { name: "Send feedback" }));
    // Two verification polls at the real pacing (POLL_DELAY_MS) sit between the tap and the Enter.
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("Sent"), {
      timeout: 5000,
    });
    // `3`, not `4` — this install has no clear-context row, and the key comes off the screen.
    expect(mockSendKeys.mock.calls.map((c) => c[1])).toEqual([["3"], ["Enter"]]);
    expect(mockSendReply).toHaveBeenCalledWith("w1:p1", "use a switch", false, undefined);
  });
});
