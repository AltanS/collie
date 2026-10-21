import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

// The api layer is mocked so a tap can run the real multi-select action against a scripted pane.
vi.mock("@/lib/api", () => ({
  fetchPane: vi.fn(),
  sendKeys: vi.fn(),
  sendReply: vi.fn(),
}));

import { fetchPane, sendKeys } from "@/lib/api";
import { parseAnsi } from "@/lib/ansi";
import { splitLines, type MultiSelectModel } from "@/lib/blocks";
import { detectMultiSelect } from "@/lib/harness/claude/multi-select";
import { submitMultiSelectIntent, type MultiSelectIntent } from "@/lib/multi-select-action";
import { MultiSelectBlock } from "./multi-select-block";

// Anchored on this file's directory (not `new URL(import.meta.url)`, which Vite rewrites to an asset).
const PANES_DIR = join(import.meta.dirname, "..", "fixtures", "panes");
const fixtureText = (name: string) => readFileSync(join(PANES_DIR, name), "utf8");
function fixtureModel(name: string): MultiSelectModel {
  const model = detectMultiSelect(splitLines(parseAnsi(fixtureText(name))));
  if (!model) throw new Error(`fixture ${name} did not detect a multi-select dialog`);
  return model;
}

/** The wizmulti-focused-typed capture after one Up: the pointer off the field, on `3. Basil` above it. */
function pointerOnBasil(text: string): string {
  const lines = text.split("\n");
  // The last match: the prompt echoed above the dialog names the same words.
  const field = lines.findLastIndex((l) => l.includes("❯") && l.includes("Pineapple"));
  const basil = lines.findLastIndex((l) => l.includes("[ ] Basil"));
  if (field < 0 || basil < 0 || !lines[basil]!.startsWith("  ")) throw new Error("capture layout moved");
  lines[field] = lines[field]!.replace("❯", " ");
  lines[basil] = `❯${lines[basil]!.slice(1)}`;
  return lines.join("\n");
}

describe("MultiSelectBlock — checkbox screen", () => {
  it("renders the question, each option as a checkbox with its key badge, and the checked state", () => {
    const model = fixtureModel("claude--select-multiselect-checked.txt");
    render(<MultiSelectBlock multi={model} onAction={vi.fn()} />);

    expect(
      screen.getByRole("group", { name: "Which pizza toppings do you want?" }),
    ).toBeInTheDocument();

    // Four checkbox controls; the fixture has Mushrooms + Olives checked.
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(4);
    expect(screen.getByRole("checkbox", { name: /Cheese/ })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("checkbox", { name: /Mushrooms/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("checkbox", { name: /Olives/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("checkbox", { name: /Peppers/ })).toHaveAttribute("aria-checked", "false");

    // Each row leads with its terminal-menu digit (the KeyBadge affordance).
    expect(within(screen.getByRole("checkbox", { name: /Cheese/ })).getByText("1")).toBeInTheDocument();
    expect(within(screen.getByRole("checkbox", { name: /Peppers/ })).getByText("4")).toBeInTheDocument();
    // Descriptions ride along as secondary text nodes.
    expect(screen.getByText("Classic melted cheese topping.")).toBeInTheDocument();
  });

  it("offers a Submit button and the de-emphasised 'Chat about this' escape", () => {
    const model = fixtureModel("claude--select-multiselect-single.txt");
    render(<MultiSelectBlock multi={model} onAction={vi.fn()} />);
    expect(screen.getByRole("button", { name: /^Submit$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Chat about this/ })).toHaveTextContent(/ends the questions/);
  });

  it("routes the right intent for a toggle, Submit, and the escape", async () => {
    const onAction = vi.fn();
    const user = userEvent.setup();
    const model = fixtureModel("claude--select-multiselect-single.txt");
    render(<MultiSelectBlock multi={model} onAction={onAction} />);

    await user.click(screen.getByRole("checkbox", { name: /Olives/ }));
    expect(onAction).toHaveBeenLastCalledWith({ kind: "toggle", n: 3 });

    // A tap locks every control until the (awaited) handler resolves; vi.fn() resolves synchronously,
    // so subsequent taps go through in order.
    await user.click(screen.getByRole("button", { name: /^Submit$/ }));
    expect(onAction).toHaveBeenLastCalledWith({ kind: "advance" });

    await user.click(screen.getByRole("button", { name: /Chat about this/ }));
    expect(onAction).toHaveBeenLastCalledWith({ kind: "escape" });
  });

  it("disables every control when disabled (read-only device / gone pane)", () => {
    const model = fixtureModel("claude--select-multiselect-single.txt");
    render(<MultiSelectBlock multi={model} onAction={vi.fn()} disabled />);
    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
    for (const box of screen.getAllByRole("checkbox")) expect(box).toBeDisabled();
  });
});

describe("MultiSelectBlock — review screen", () => {
  it("shows the confirm prompt, the incomplete warning, and Submit/Cancel routing", async () => {
    const onAction = vi.fn();
    const user = userEvent.setup();
    const model = fixtureModel("claude--select-multiselect-review.txt");
    render(<MultiSelectBlock multi={model} onAction={onAction} />);

    expect(screen.getByRole("group", { name: "Ready to submit your answers?" })).toBeInTheDocument();
    expect(screen.getByText(/not answered all questions/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Submit answers/ }));
    expect(onAction).toHaveBeenLastCalledWith({ kind: "confirm" });
    await user.click(screen.getByRole("button", { name: /^Cancel$/ }));
    expect(onAction).toHaveBeenLastCalledWith({ kind: "cancel" });
  });

  // Muse's cancel row ends the whole turn. The button carries the terminal's own words, so it never
  // promises less than the key does.
  it("labels the cancel button with the terminal's own words when the model carries them", () => {
    const model = fixtureModel("claude--select-multiselect-review.txt");
    if (model.phase !== "review") throw new Error("fixture is not a review screen");
    render(<MultiSelectBlock multi={{ ...model, cancelLabel: "Interrupt turn" }} onAction={vi.fn()} />);
    expect(screen.getByRole("button", { name: /^Interrupt turn$/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Cancel$/ })).not.toBeInTheDocument();
  });
});

// A review screen whose harness declares its own keys (opencode's `Confirm` tab): it echoes the
// answers, offers a way back to the options, names its cancel in the terminal's words, and keeps the
// Terminal escape like every other card.
describe("MultiSelectBlock — a review with declared keys", () => {
  function declaredReview(): MultiSelectModel {
    const model = fixtureModel("claude--select-multiselect-review.txt");
    if (model.phase !== "review") throw new Error("fixture is not a review screen");
    return {
      ...model,
      incomplete: false,
      submit: "keys",
      submitKeys: ["Enter"],
      cancelKeys: ["Escape"],
      backKeys: ["Left"],
      cancelLabel: "Dismiss",
      answers: [
        { question: "Colour", answer: "Red, Blue, mine" },
        { question: "Size", answer: "Small" },
      ],
    };
  }

  it("lists the echoed answers as question → answer pairs", () => {
    render(<MultiSelectBlock multi={declaredReview()} onAction={vi.fn()} />);
    expect(screen.getAllByRole("term").map((e) => e.textContent)).toEqual(["Colour", "Size"]);
    expect(screen.getAllByRole("definition").map((e) => e.textContent)).toEqual([
      "Red, Blue, mine",
      "Small",
    ]);
  });

  it("offers Back above cancel, routes it as back, and shows the terminal's cancel label", async () => {
    const onAction = vi.fn();
    const user = userEvent.setup();
    render(<MultiSelectBlock multi={declaredReview()} onAction={onAction} />);

    const names = screen.getAllByRole("button").map((b) => b.textContent);
    expect(names.indexOf("Back to the options")).toBeGreaterThan(names.indexOf("Submit answers"));
    expect(names.indexOf("Back to the options")).toBeLessThan(names.indexOf("Dismiss"));
    expect(screen.queryByRole("button", { name: /^Cancel$/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Back to the options" }));
    expect(onAction).toHaveBeenLastCalledWith({ kind: "back" });
    await user.click(screen.getByRole("button", { name: "Submit answers" }));
    expect(onAction).toHaveBeenLastCalledWith({ kind: "confirm" });
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onAction).toHaveBeenLastCalledWith({ kind: "cancel" });
  });

  it("offers no Back when the review declares no way back", () => {
    const model = fixtureModel("claude--select-multiselect-review.txt");
    render(<MultiSelectBlock multi={model} onAction={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Back to the options" })).not.toBeInTheDocument();
    expect(screen.queryByRole("term")).not.toBeInTheDocument();
  });

  it("carries the Terminal escape on the review when given the replaced lines", () => {
    const lines = splitLines(parseAnsi(fixtureText("claude--select-multiselect-review.txt")));
    render(<MultiSelectBlock multi={declaredReview()} lines={lines} onAction={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: "Show the terminal instead of this card" }),
    ).toBeInTheDocument();
  });
});

// A checkbox question that is one STEP of a wizard. Everything the parser lifts for this shape —
// the chips, the Left/Right navigation, and the advance row's literal label — has to reach the DOM,
// and none of it is exercised by the single-question fixtures (their `steps` is null).
describe("MultiSelectBlock — as a step of a wizard", () => {
  it("renders the stepper, and names the advance control what the terminal calls it", () => {
    const model = fixtureModel("claude--wizard-multiselect-q1.txt");
    render(<MultiSelectBlock multi={model} onAction={vi.fn()} />);

    const steps = screen.getByRole("list", { name: "Questions" });
    expect(within(steps).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Toppings",
      "Crust",
      "Submit",
    ]);
    // Not "Submit": this is question 1 of 2, and the button must not claim to finish the dialog.
    expect(screen.getByRole("button", { name: "Next" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Submit" })).not.toBeInTheDocument();
  });

  it("says Submit on the last step", () => {
    const model = fixtureModel("claude--wizard-multiselect-final.txt");
    render(<MultiSelectBlock multi={model} onAction={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Submit" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
  });

  it("marks the current question and announces where you are", () => {
    const model = fixtureModel("claude--wizard-multiselect-final.txt");
    render(<MultiSelectBlock multi={model} onAction={vi.fn()} />);
    // aria-current alone moves silently between list items, so the position is also spoken.
    expect(screen.getByRole("status")).toHaveTextContent("Step 2 of 3, Extras");
    const current = within(screen.getByRole("list", { name: "Questions" }))
      .getAllByRole("listitem")
      .filter((li) => li.getAttribute("aria-current") === "step");
    expect(current.map((li) => li.textContent)).toEqual(["Extras"]);
  });

  it("navigates between questions with the wizard's own keys", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(<MultiSelectBlock multi={fixtureModel("claude--wizard-multiselect-final.txt")} onAction={onAction} />);

    await user.click(screen.getByRole("button", { name: "Previous step" }));
    expect(onAction).toHaveBeenLastCalledWith({ kind: "nav", keys: ["Left"] });
    await user.click(screen.getByRole("button", { name: "Next step" }));
    expect(onAction).toHaveBeenLastCalledWith({ kind: "nav", keys: ["Right"] });
  });

  it("disables Back on the first question — there is nothing to its left", () => {
    render(<MultiSelectBlock multi={fixtureModel("claude--wizard-multiselect-q1.txt")} onAction={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Previous step" })).toBeDisabled();
  });

  it("shows no stepper for a standalone single-question dialog", () => {
    render(<MultiSelectBlock multi={fixtureModel("claude--select-multiselect-single.txt")} onAction={vi.fn()} />);
    expect(screen.queryByRole("list", { name: "Questions" })).not.toBeInTheDocument();
  });
});

// The question's own answer field (ADR 0113): a typed answer is one more ticked choice, so the card
// shows it as a checkbox row; while the field has the keyboard in the terminal a digit is typed into
// it and `Left` moves its caret, so a toggle, the escape and a step arrow first move the pointer off it
// (lib/multi-select-action.ts `offField`). Only the field's own row locks: its digit would be typed.
describe("MultiSelectBlock — the answer field", () => {
  const OFFER = "Type your own answer";
  const capture = (name: string) => fixtureModel(`claude--v2299-ask-field-${name}.txt`);

  it("the offer opens the editor, which says the answer becomes a ticked choice", async () => {
    const user = userEvent.setup();
    render(<MultiSelectBlock multi={capture("multi-ticked-empty")} onAction={vi.fn()} onAnswer={vi.fn()} />);
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);
    await user.click(screen.getByRole("button", { name: OFFER }));
    expect(screen.getByRole("textbox", { name: "Answer text" })).toHaveValue("");
    expect(screen.getByText(/Adds your answer as a ticked choice/)).toBeInTheDocument();
  });

  it("a typed field is a checkbox row of its own, and Change opens the editor holding it", async () => {
    const onAction = vi.fn();
    const onAnswer = vi.fn(() => true);
    const user = userEvent.setup();
    render(<MultiSelectBlock multi={capture("multi-pointer-submit")} onAction={onAction} onAnswer={onAnswer} />);
    const row = screen.getByRole("checkbox", { name: /Mushroom/ });
    expect(row).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByText(/In the answer field:/)).not.toBeInTheDocument();
    await user.click(row);
    expect(onAction).toHaveBeenLastCalledWith({ kind: "toggle", n: 4 });
    await user.click(screen.getByRole("button", { name: "Change this answer" }));
    expect(screen.getByRole("textbox", { name: "Answer text" })).toHaveValue("Mushroom");
    await user.click(screen.getByRole("button", { name: "Send answer" }));
    expect(onAnswer).toHaveBeenCalledWith("Mushroom");
  });

  it("a focused field leaves the options, the escape and Next step live, and a tap leaves the field first", async () => {
    const focusedText = fixtureText("claude--v2299-ask-field-wizmulti-focused-typed.txt");
    const offText = pointerOnBasil(focusedText);
    const multi = fixtureModel("claude--v2299-ask-field-wizmulti-focused-typed.txt");
    const queue = [focusedText, offText, offText];
    vi.mocked(fetchPane).mockImplementation(async () => ({
      paneId: "w1:p1",
      text: queue.length > 1 ? queue.shift()! : queue[0]!,
      truncated: false,
      revision: 5,
    }));
    vi.mocked(sendKeys).mockResolvedValue({ ok: true });
    const onAction = async (intent: MultiSelectIntent) => {
      await submitMultiSelectIntent({
        paneId: "w1:p1",
        requestedLines: 600,
        detectedRevision: 5,
        agent: "claude",
        sleep: async () => {},
        multi,
        intent,
      });
    };
    const user = userEvent.setup();
    render(<MultiSelectBlock multi={multi} onAction={onAction} onAnswer={vi.fn()} />);

    expect(screen.queryByText(/The answer field has the keyboard in the terminal/)).not.toBeInTheDocument();
    for (const name of [/Cheese/, /Olives/, /Basil/]) {
      expect(screen.getByRole("checkbox", { name })).toBeEnabled();
    }
    expect(screen.getByRole("checkbox", { name: /Pineapple/ })).toBeDisabled();
    for (const name of [/Chat about this/, /Next step/, /^Next$/, /Change this answer/]) {
      expect(screen.getByRole("button", { name })).toBeEnabled();
    }

    await user.click(screen.getByRole("checkbox", { name: /Olives/ }));
    expect(vi.mocked(sendKeys).mock.calls.map((c) => c[1])).toEqual([["Up"], ["2"]]);
  });

  it("keeps the draft on screen when the answer is refused", async () => {
    const user = userEvent.setup();
    render(<MultiSelectBlock multi={capture("multi-ticked-empty")} onAction={vi.fn()} onAnswer={() => false} />);
    await user.click(screen.getByRole("button", { name: OFFER }));
    await user.type(screen.getByRole("textbox", { name: "Answer text" }), "keep me");
    await user.click(screen.getByRole("button", { name: "Send answer" }));
    expect(screen.getByRole("textbox", { name: "Answer text" })).toHaveValue("keep me");
  });

  // The open editor hides what the field holds, so a desk edit made while it is open was never seen
  // on the phone: Send refuses once, says what the field holds now, and the next Send replaces it.
  describe("the field changes under the open editor", () => {
    function holding(multi: MultiSelectModel, text: string): MultiSelectModel {
      if (multi.phase !== "checkbox" || !multi.field) throw new Error("capture has no answer field");
      return { ...multi, field: { ...multi.field, text } };
    }

    it("text typed at the desk: Send sends nothing and names it; the next Send replaces it", async () => {
      const multi = capture("multi-ticked-empty");
      const onAnswer = vi.fn(() => true);
      const user = userEvent.setup();
      const { rerender } = render(<MultiSelectBlock multi={multi} onAction={vi.fn()} onAnswer={onAnswer} />);
      await user.click(screen.getByRole("button", { name: OFFER }));
      await user.type(screen.getByRole("textbox", { name: "Answer text" }), "Phone words");
      rerender(<MultiSelectBlock multi={holding(multi, "Desk words")} onAction={vi.fn()} onAnswer={onAnswer} />);
      await user.click(screen.getByRole("button", { name: "Send answer" }));
      expect(onAnswer).not.toHaveBeenCalled();
      expect(screen.getByRole("status")).toHaveTextContent(
        "The answer field in the terminal now holds “Desk words”. Send again to replace it.",
      );
      expect(screen.getByRole("textbox", { name: "Answer text" })).toHaveValue("Phone words");
      await user.click(screen.getByRole("button", { name: "Send answer" }));
      expect(onAnswer).toHaveBeenCalledTimes(1);
      expect(onAnswer).toHaveBeenCalledWith("Phone words");
    });

    it("a field emptied at the desk: Send sends nothing and says so; the next Send fills it", async () => {
      const multi = capture("multi-pointer-submit");
      const onAnswer = vi.fn(() => true);
      const user = userEvent.setup();
      const { rerender } = render(<MultiSelectBlock multi={multi} onAction={vi.fn()} onAnswer={onAnswer} />);
      await user.click(screen.getByRole("button", { name: "Change this answer" }));
      rerender(<MultiSelectBlock multi={holding(multi, "")} onAction={vi.fn()} onAnswer={onAnswer} />);
      await user.click(screen.getByRole("button", { name: "Send answer" }));
      expect(onAnswer).not.toHaveBeenCalled();
      expect(screen.getByRole("status")).toHaveTextContent(
        "The answer field in the terminal was emptied. Send again to fill it.",
      );
      expect(screen.getByRole("textbox", { name: "Answer text" })).toHaveValue("Mushroom");
      await user.click(screen.getByRole("button", { name: "Send answer" }));
      expect(onAnswer).toHaveBeenCalledTimes(1);
      expect(onAnswer).toHaveBeenCalledWith("Mushroom");
    });

    it("a re-render that leaves the field's text as it was does not hold Send back", async () => {
      const multi = capture("multi-ticked-empty");
      const onAnswer = vi.fn(() => true);
      const user = userEvent.setup();
      const { rerender } = render(<MultiSelectBlock multi={multi} onAction={vi.fn()} onAnswer={onAnswer} />);
      await user.click(screen.getByRole("button", { name: OFFER }));
      await user.type(screen.getByRole("textbox", { name: "Answer text" }), "Phone words");
      rerender(<MultiSelectBlock multi={holding(multi, "")} onAction={vi.fn()} onAnswer={onAnswer} />);
      await user.click(screen.getByRole("button", { name: "Send answer" }));
      expect(onAnswer).toHaveBeenCalledTimes(1);
      expect(onAnswer).toHaveBeenCalledWith("Phone words");
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });
  });
});
