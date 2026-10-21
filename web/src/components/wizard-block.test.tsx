import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The whole wizard feature end to end: the presentational component, the shared race guard
// (submitWizardKeys), and the wired tap (component → injected handler → api). The api layer is
// mocked so we can drive fresh-fetch revision/wizard outcomes precisely; the detector and status
// channel are the real thing.
vi.mock("@/lib/api", () => ({
  fetchPane: vi.fn(),
  sendKeys: vi.fn(),
}));

import { fetchPane, sendKeys } from "@/lib/api";
import { parseAnsi } from "@/lib/ansi";
import { splitLines, type WizardModel } from "@/lib/blocks";
import { detectWizard } from "@/lib/harness/claude/wizard";
import { submitWizardKeys, wizardsEqual } from "@/lib/wizard-action";
import { clearStatus, setStatus, useStatus } from "@/lib/status";
import { WizardBlock } from "./wizard-block";

const mockFetchPane = vi.mocked(fetchPane);
const mockSendKeys = vi.mocked(sendKeys);

// Anchored on this file's directory (not `new URL(import.meta.url)`, which Vite rewrites to an asset).
const PANES_DIR = join(import.meta.dirname, "..", "fixtures", "panes");
const fixtureText = (name: string) => readFileSync(join(PANES_DIR, name), "utf8");
function fixtureModel(name: string): WizardModel {
  const model = detectWizard(splitLines(parseAnsi(fixtureText(name))));
  if (!model) throw new Error(`fixture ${name} did not detect a wizard`);
  return model;
}

beforeEach(() => {
  clearStatus();
  mockFetchPane.mockReset();
  mockSendKeys.mockReset();
  mockSendKeys.mockResolvedValue({ ok: true });
});

describe("WizardBlock — question step presentation", () => {
  it("renders the stepper chips, the question, and each answer as a focusable button", () => {
    const model = fixtureModel("claude--wizard-q1.txt");
    render(<WizardBlock wizard={model} onAction={vi.fn()} />);

    expect(
      screen.getByRole("group", { name: "Which focus area should we work on?" }),
    ).toBeInTheDocument();
    // Stepper: the three question chips plus the fixed Submit chip; the current one is marked.
    const chips = screen.getAllByRole("listitem");
    expect(chips.map((c) => c.textContent)).toEqual(["Focus area", "Scope", "Workflow", "Submit"]);
    expect(chips[0]).toHaveAttribute("aria-current", "step");
    expect(chips[3]).not.toHaveAttribute("aria-current");
    // Answers are real buttons; descriptions are secondary text nodes.
    for (const label of ["Parser", "UI", "Tests"]) {
      expect(screen.getByRole("button", { name: new RegExp(label) })).toBeInTheDocument();
    }
    expect(screen.getByText(/parsing logic/)).toBeInTheDocument();
    // Each answer leads with its terminal-menu digit (the KeyBadge affordance).
    expect(within(screen.getByRole("button", { name: /Parser/ })).getByText("1")).toBeInTheDocument();
    expect(within(screen.getByRole("button", { name: /Tests/ })).getByText("3")).toBeInTheDocument();
    const parser = screen.getByRole("button", { name: /Parser/ });
    parser.focus();
    expect(parser).toHaveFocus();
  });

  it("marks answered chips and the TUI's chosen row on a revisited question", () => {
    const model = fixtureModel("claude--wizard-q1-revisit.txt");
    render(<WizardBlock wizard={model} onAction={vi.fn()} />);
    // The revisited (answered) chip shows its answered check.
    expect(screen.getAllByLabelText("Answered").length).toBeGreaterThan(0);
    // The chosen option carries the "current answer" mark, lifted from the trailing ✔.
    const ui = screen.getByRole("button", { name: /Current answer/ });
    expect(ui).toHaveTextContent("UI");
  });

  it("renders 'Chat about this' apart, as a de-emphasised escape (it ends the whole wizard)", () => {
    const model = fixtureModel("claude--wizard-q1.txt");
    render(<WizardBlock wizard={model} onAction={vi.fn()} />);
    const escape = screen.getByRole("button", { name: /Chat about this/ });
    expect(escape).toHaveTextContent(/ends the questions/);
  });

  it("sends ONE digit (no Enter) for a tapped answer; Next navigates; Back is disabled on the first question", async () => {
    const onAction = vi.fn();
    const user = userEvent.setup();
    const model = fixtureModel("claude--wizard-q1.txt"); // first question is the current step
    render(<WizardBlock wizard={model} onAction={onAction} />);

    await user.click(screen.getByRole("button", { name: /UI/ }));
    expect(onAction).toHaveBeenLastCalledWith(["2"]);

    // Left at the first question is a clamped no-op in the TUI, so Back is disabled here.
    expect(screen.getByRole("button", { name: "Previous step" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Next step" }));
    expect(onAction).toHaveBeenLastCalledWith(["Right"]);
  });

  it("sends Left for Back when not on the first question", async () => {
    const onAction = vi.fn();
    const user = userEvent.setup();
    const model = fixtureModel("claude--wizard-q2.txt"); // second question current → Back is valid
    render(<WizardBlock wizard={model} onAction={onAction} />);

    const back = screen.getByRole("button", { name: "Previous step" });
    expect(back).not.toBeDisabled();
    await user.click(back);
    expect(onAction).toHaveBeenLastCalledWith(["Left"]);
  });

  it("disables every control when disabled (read-only device / gone pane)", () => {
    const model = fixtureModel("claude--wizard-q1.txt");
    render(<WizardBlock wizard={model} onAction={vi.fn()} disabled />);
    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
  });
});

// The step's own answer field (ADR 0113): the same states as the single-question card, plus the
// wizard's one extra lock — while the field has the keyboard, `Left`/`Right` move its caret.
describe("WizardBlock — the answer field", () => {
  const OFFER = "Type your own answer";

  it("the offer opens the editor, which says that sending moves on", async () => {
    const user = userEvent.setup();
    render(<WizardBlock wizard={fixtureModel("claude--wizard-q1.txt")} onAction={vi.fn()} onAnswer={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: OFFER }));
    expect(screen.getByRole("textbox", { name: "Answer text" })).toHaveValue("");
    expect(screen.getByText(/moves to the next question/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send answer" })).toBeDisabled();
  });

  it("a typed field shows what it holds, and Change opens the editor holding it", async () => {
    const onAnswer = vi.fn(() => true);
    const user = userEvent.setup();
    render(
      <WizardBlock
        wizard={fixtureModel("claude--v2299-ask-field-wizard-revisit-typed.txt")}
        onAction={vi.fn()}
        onAnswer={onAnswer}
      />,
    );
    expect(screen.getByText(/In the answer field:/)).toHaveTextContent("In the answer field: Mango");
    await user.click(screen.getByRole("button", { name: "Change this answer" }));
    expect(screen.getByRole("textbox", { name: "Answer text" })).toHaveValue("Mango");
    await user.click(screen.getByRole("button", { name: "Send answer" }));
    expect(onAnswer).toHaveBeenCalledWith("Mango");
  });

  it("a focused field locks the options, the escape row AND the step arrows, not the answer editor", () => {
    const onAction = vi.fn();
    render(
      <WizardBlock
        wizard={fixtureModel("claude--v2299-ask-field-wizard-focused-empty.txt")}
        onAction={onAction}
        onAnswer={vi.fn()}
      />,
    );
    expect(screen.getByText(/The answer field has the keyboard in the terminal/)).toBeInTheDocument();
    for (const name of [/Apple/, /Pear/, /Chat about this/, /Previous step/, /Next step/]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
    expect(screen.getByRole("button", { name: OFFER })).toBeEnabled();
  });

  it("keeps the draft on screen when the answer is refused", async () => {
    const user = userEvent.setup();
    render(<WizardBlock wizard={fixtureModel("claude--wizard-q1.txt")} onAction={vi.fn()} onAnswer={() => false} />);
    await user.click(screen.getByRole("button", { name: OFFER }));
    await user.type(screen.getByRole("textbox", { name: "Answer text" }), "keep me");
    await user.click(screen.getByRole("button", { name: "Send answer" }));
    expect(screen.getByRole("textbox", { name: "Answer text" })).toHaveValue("keep me");
  });

  // The open editor hides the field's own card, so a desk edit made while it is open was never seen
  // on the phone: Send refuses once, says what the field holds now, and the next Send replaces it.
  describe("the field changes under the open editor", () => {
    function holding(wizard: WizardModel, text: string): WizardModel {
      if (wizard.phase !== "question" || !wizard.field) throw new Error("fixture has no answer field");
      return { ...wizard, field: { ...wizard.field, text } };
    }

    it("text typed at the desk: Send sends nothing and names it; the next Send replaces it", async () => {
      const wizard = fixtureModel("claude--wizard-q1.txt");
      const onAnswer = vi.fn(() => true);
      const user = userEvent.setup();
      const { rerender } = render(<WizardBlock wizard={wizard} onAction={vi.fn()} onAnswer={onAnswer} />);
      await user.click(screen.getByRole("button", { name: OFFER }));
      await user.type(screen.getByRole("textbox", { name: "Answer text" }), "Phone words");
      rerender(<WizardBlock wizard={holding(wizard, "Desk words")} onAction={vi.fn()} onAnswer={onAnswer} />);
      await user.click(screen.getByRole("button", { name: "Send answer" }));
      expect(onAnswer).not.toHaveBeenCalled();
      // The stepper's own live region is a `status` too, so the notice is found by its words.
      expect(
        screen.getByText("The answer field in the terminal now holds “Desk words”. Send again to replace it."),
      ).toBeInTheDocument();
      expect(screen.getByRole("textbox", { name: "Answer text" })).toHaveValue("Phone words");
      await user.click(screen.getByRole("button", { name: "Send answer" }));
      expect(onAnswer).toHaveBeenCalledTimes(1);
      expect(onAnswer).toHaveBeenCalledWith("Phone words");
    });

    it("a field emptied at the desk: Send sends nothing and says so; the next Send fills it", async () => {
      const wizard = fixtureModel("claude--v2299-ask-field-wizard-revisit-typed.txt");
      const onAnswer = vi.fn(() => true);
      const user = userEvent.setup();
      const { rerender } = render(<WizardBlock wizard={wizard} onAction={vi.fn()} onAnswer={onAnswer} />);
      await user.click(screen.getByRole("button", { name: "Change this answer" }));
      rerender(<WizardBlock wizard={holding(wizard, "")} onAction={vi.fn()} onAnswer={onAnswer} />);
      await user.click(screen.getByRole("button", { name: "Send answer" }));
      expect(onAnswer).not.toHaveBeenCalled();
      expect(screen.getByText("The answer field in the terminal was emptied. Send again to fill it.")).toBeInTheDocument();
      expect(screen.getByRole("textbox", { name: "Answer text" })).toHaveValue("Mango");
      await user.click(screen.getByRole("button", { name: "Send answer" }));
      expect(onAnswer).toHaveBeenCalledTimes(1);
      expect(onAnswer).toHaveBeenCalledWith("Mango");
    });

    it("a re-render that leaves the field's text as it was does not hold Send back", async () => {
      const wizard = fixtureModel("claude--wizard-q1.txt");
      const onAnswer = vi.fn(() => true);
      const user = userEvent.setup();
      const { rerender } = render(<WizardBlock wizard={wizard} onAction={vi.fn()} onAnswer={onAnswer} />);
      await user.click(screen.getByRole("button", { name: OFFER }));
      await user.type(screen.getByRole("textbox", { name: "Answer text" }), "Phone words");
      rerender(<WizardBlock wizard={holding(wizard, "")} onAction={vi.fn()} onAnswer={onAnswer} />);
      await user.click(screen.getByRole("button", { name: "Send answer" }));
      expect(onAnswer).toHaveBeenCalledTimes(1);
      expect(onAnswer).toHaveBeenCalledWith("Phone words");
      expect(screen.queryByText(/The answer field in the terminal/)).not.toBeInTheDocument();
    });
  });
});

describe("WizardBlock — review (Submit) step presentation", () => {
  it("lists the echoed answers and offers Submit answers / Cancel", async () => {
    const onAction = vi.fn();
    const user = userEvent.setup();
    const model = fixtureModel("claude--wizard-submit.txt");
    render(<WizardBlock wizard={model} onAction={onAction} />);

    expect(screen.getByRole("group", { name: "Review your answers" })).toBeInTheDocument();
    // The Submit chip is the current step now.
    const chips = screen.getAllByRole("listitem");
    expect(chips[3]).toHaveTextContent("Submit");
    expect(chips[3]).toHaveAttribute("aria-current", "step");
    // Question → answer pairs, verbatim text nodes.
    expect(screen.getByText("Which focus area should we work on?")).toBeInTheDocument();
    expect(screen.getByText("UI")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Submit answers/ }));
    expect(onAction).toHaveBeenLastCalledWith(["1"]);
    await user.click(screen.getByRole("button", { name: /^Cancel$/ }));
    expect(onAction).toHaveBeenLastCalledWith(["2"]);
  });

  // A harness whose review takes other keys declares them on the model (opencode's `Confirm` tab:
  // Enter submits, Escape dismisses the whole call); its words replace the translated "Cancel".
  it("sends the review's declared plans and shows its cancel label", async () => {
    const onAction = vi.fn();
    const user = userEvent.setup();
    const model = fixtureModel("claude--wizard-submit.txt");
    if (model.phase !== "review") throw new Error("fixture is not a review step");
    render(
      <WizardBlock
        wizard={{ ...model, submitKeys: ["Enter"], cancelKeys: ["Escape"], cancelLabel: "Dismiss" }}
        onAction={onAction}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Submit answers/ }));
    expect(onAction).toHaveBeenLastCalledWith(["Enter"]);
    await user.click(screen.getByRole("button", { name: /^Dismiss$/ }));
    expect(onAction).toHaveBeenLastCalledWith(["Escape"]);
    expect(screen.queryByRole("button", { name: /^Cancel$/ })).not.toBeInTheDocument();
  });

  it("lists every answer when Claude Code bars a wrapped question", () => {
    const model = fixtureModel("claude--v2302-wizard-review-long-q--w140.txt");
    render(<WizardBlock wizard={model} onAction={vi.fn()} />);
    expect(screen.getByText(/^When a user opens the settings page/)).toBeInTheDocument();
    for (const answer of ["Restore with banner", "Save button", "Page footer"]) {
      expect(screen.getByText(answer)).toBeInTheDocument();
    }
  });

  it("surfaces the not-all-answered warning on an incomplete review", () => {
    const model = fixtureModel("claude--wizard-submit-unanswered.txt");
    render(<WizardBlock wizard={model} onAction={vi.fn()} />);
    expect(screen.getByText(/not answered all questions/)).toBeInTheDocument();
  });
});

describe("wizardsEqual", () => {
  it("equal for the same buffer, different across steps and stepper states", () => {
    const q1 = fixtureModel("claude--wizard-q1.txt");
    expect(wizardsEqual(q1, fixtureModel("claude--wizard-q1.txt"))).toBe(true);
    // A different step (question changed, chips advanced).
    expect(wizardsEqual(q1, fixtureModel("claude--wizard-q2.txt"))).toBe(false);
    // Same question on screen but the stepper/chosen state differs (fresh vs revisited).
    expect(wizardsEqual(q1, fixtureModel("claude--wizard-q1-revisit.txt"))).toBe(false);
    // Question step vs review step.
    expect(wizardsEqual(q1, fixtureModel("claude--wizard-submit.txt"))).toBe(false);
    // Review completeness matters.
    expect(
      wizardsEqual(
        fixtureModel("claude--wizard-submit.txt"),
        fixtureModel("claude--wizard-submit-unanswered.txt"),
      ),
    ).toBe(false);
  });

  it("compares the review's declared plans exactly and its cancel label", () => {
    const review = fixtureModel("claude--wizard-submit.txt");
    if (review.phase !== "review") throw new Error("fixture is not a review step");
    const declared: WizardModel = { ...review, submitKeys: ["Enter"], cancelKeys: ["Escape"], cancelLabel: "Dismiss" };
    expect(wizardsEqual(declared, { ...declared })).toBe(true);
    // Absent vs declared, and declared vs a different plan, are different screens.
    expect(wizardsEqual(review, declared)).toBe(false);
    expect(wizardsEqual(declared, { ...declared, submitKeys: ["1"] })).toBe(false);
    expect(wizardsEqual(declared, { ...declared, cancelKeys: ["2"] })).toBe(false);
    expect(wizardsEqual(declared, { ...declared, cancelLabel: undefined })).toBe(false);
  });
});

describe("submitWizardKeys — race guard (one keystroke per tap)", () => {
  it("sends the keystroke when the fresh buffer still shows the same wizard step", async () => {
    const model = fixtureModel("claude--wizard-q2.txt");
    mockFetchPane.mockResolvedValue({
      paneId: "w1:p1",
      text: fixtureText("claude--wizard-q2.txt"),
      truncated: false,
      revision: 7,
    });
    const res = await submitWizardKeys({
      paneId: "w1:p1",
      requestedLines: 600,
      detectedRevision: 7,
      agent: "claude",
      wizard: model,
      keys: ["2"],
    });
    expect(res).toEqual({ status: "sent" });
    expect(mockSendKeys).toHaveBeenCalledWith("w1:p1", ["2"], undefined, model.signature);
  });

  it("rejects (no send) when the wizard advanced to another step underfoot", async () => {
    const model = fixtureModel("claude--wizard-q2.txt");
    mockFetchPane.mockResolvedValue({
      paneId: "w1:p1",
      text: fixtureText("claude--wizard-submit.txt"), // moved on: review step now
      truncated: false,
      revision: 7,
    });
    const res = await submitWizardKeys({
      paneId: "w1:p1",
      requestedLines: 600,
      detectedRevision: 7,
      agent: "claude",
      wizard: model,
      keys: ["2"],
    });
    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
  });

  it("rejects (no send) when the wizard is gone entirely", async () => {
    const model = fixtureModel("claude--wizard-submit.txt");
    mockFetchPane.mockResolvedValue({
      paneId: "w1:p1",
      text: fixtureText("claude--done.txt"), // submitted/cancelled; agent moved on
      truncated: false,
      revision: 0, // Herdr's stub revision matches — the re-derivation must catch it
      notModified: true,
    });
    const res = await submitWizardKeys({
      paneId: "w1:p1",
      requestedLines: 600,
      detectedRevision: 0,
      agent: "claude",
      wizard: model,
      keys: ["1"],
    });
    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
  });

  it("rejects when the fresh revision differs (frozen mirror, advanced pane)", async () => {
    const model = fixtureModel("claude--wizard-q1.txt");
    mockFetchPane.mockResolvedValue({
      paneId: "w1:p1",
      text: fixtureText("claude--wizard-q1.txt"),
      truncated: false,
      revision: 9,
    });
    const res = await submitWizardKeys({
      paneId: "w1:p1",
      requestedLines: 600,
      detectedRevision: 8,
      agent: "claude",
      wizard: model,
      keys: ["1"],
    });
    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
  });

  it("surfaces the bridge error when sendKeys fails", async () => {
    const model = fixtureModel("claude--wizard-q1.txt");
    mockFetchPane.mockResolvedValue({
      paneId: "w1:p1",
      text: fixtureText("claude--wizard-q1.txt"),
      truncated: false,
      revision: 5,
    });
    mockSendKeys.mockResolvedValue({ ok: false, error: "agent busy" });
    const res = await submitWizardKeys({
      paneId: "w1:p1",
      requestedLines: 600,
      detectedRevision: 5,
      agent: "claude",
      wizard: model,
      keys: ["3"],
    });
    expect(res).toEqual({ status: "error", error: "agent busy" });
  });

  it("maps a bridge prompt_changed conflict to changed", async () => {
    const model = fixtureModel("claude--wizard-q1.txt");
    mockFetchPane.mockResolvedValue({
      paneId: "w1:p1",
      text: fixtureText("claude--wizard-q1.txt"),
      truncated: false,
      revision: 5,
    });
    mockSendKeys.mockResolvedValue({
      ok: false,
      error: "prompt changed",
      code: "prompt_changed",
    });
    const res = await submitWizardKeys({
      paneId: "w1:p1",
      requestedLines: 600,
      detectedRevision: 5,
      agent: "claude",
      wizard: model,
      keys: ["3"],
    });
    expect(res).toEqual({ status: "changed" });
  });
});

// A miniature of AgentChat's handler + status surface, so the wired tap is exercised through the
// real component and the "wizard changed" notice pattern the app uses.
function StatusSentinel() {
  const status = useStatus();
  return <div data-testid="status">{status?.text ?? ""}</div>;
}

function Harness({ wizard, detectedRevision }: { wizard: WizardModel; detectedRevision: number }) {
  async function onAction(keys: string[]) {
    const result = await submitWizardKeys({
      paneId: "w1:p1",
      requestedLines: 600,
      detectedRevision,
      agent: "claude",
      wizard,
      keys,
    });
    if (result.status === "sent") setStatus("Sent", "success");
    else if (result.status === "changed") setStatus("Wizard changed — refreshing", "warn");
    else setStatus(result.error, "error");
  }
  return (
    <>
      <WizardBlock wizard={wizard} onAction={onAction} />
      <StatusSentinel />
    </>
  );
}

describe("WizardBlock — wired tap (component → handler → api)", () => {
  it("tapping an answer runs the guard, sends its single digit, and confirms", async () => {
    const model = fixtureModel("claude--wizard-q1.txt");
    mockFetchPane.mockResolvedValue({
      paneId: "w1:p1",
      text: fixtureText("claude--wizard-q1.txt"),
      truncated: false,
      revision: 4,
    });
    const user = userEvent.setup();
    render(<Harness wizard={model} detectedRevision={4} />);

    await user.click(screen.getByRole("button", { name: /Tests/ }));

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("Sent"));
    expect(mockSendKeys).toHaveBeenCalledWith("w1:p1", ["3"], undefined, model.signature);
  });

  it("a stale tap surfaces a 'wizard changed' notice and sends nothing", async () => {
    const model = fixtureModel("claude--wizard-q1.txt");
    mockFetchPane.mockResolvedValue({
      paneId: "w1:p1",
      text: fixtureText("claude--wizard-q2.txt"), // the wizard advanced underfoot
      truncated: false,
      revision: 4,
    });
    const user = userEvent.setup();
    render(<Harness wizard={model} detectedRevision={4} />);

    await user.click(screen.getByRole("button", { name: /Parser/ }));

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("Wizard changed"));
    expect(mockSendKeys).not.toHaveBeenCalled();
  });
});
