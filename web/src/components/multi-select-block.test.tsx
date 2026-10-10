import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { parseAnsi } from "@/lib/ansi";
import { splitLines, type MultiSelectModel } from "@/lib/blocks";
import { detectMultiSelect } from "@/lib/harness/claude/multi-select";
import { MultiSelectBlock } from "./multi-select-block";

// Anchored on this file's directory (not `new URL(import.meta.url)`, which Vite rewrites to an asset).
const PANES_DIR = join(import.meta.dirname, "..", "fixtures", "panes");
const fixtureText = (name: string) => readFileSync(join(PANES_DIR, name), "utf8");
function fixtureModel(name: string): MultiSelectModel {
  const model = detectMultiSelect(splitLines(parseAnsi(fixtureText(name))));
  if (!model) throw new Error(`fixture ${name} did not detect a multi-select dialog`);
  return model;
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

describe("MultiSelectBlock — advanceNeedsChecked opt-in flag", () => {
  function makeCheckboxModel(opts: {
    advanceNeedsChecked?: boolean;
    checked?: boolean[];
    pointer?: "option" | "other" | "advance" | "chat" | null;
  }): MultiSelectModel {
    const base = fixtureModel("claude--select-multiselect-single.txt");
    if (base.phase !== "checkbox") throw new Error("not a checkbox fixture");
    const checked = opts.checked ?? [false, false, false, false];
    return {
      ...base,
      advanceNeedsChecked: opts.advanceNeedsChecked,
      pointer: opts.pointer ?? "option",
      options: base.options.map((opt, i) => Object.assign({}, opt, { checked: checked[i] ?? false })),
    };
  }

  it("disables Confirm when advanceNeedsChecked is true and 0 options are checked", () => {
    const m = makeCheckboxModel({
      advanceNeedsChecked: true,
      checked: [false, false, false, false],
      pointer: "option",
    });
    render(<MultiSelectBlock multi={m} onAction={vi.fn()} />);
    expect(screen.getByRole("button", { name: /^Submit$/ })).toBeDisabled();
  });

  it("disables Confirm when advanceNeedsChecked is true and pointer sits on 'other'", () => {
    const m = makeCheckboxModel({
      advanceNeedsChecked: true,
      checked: [true, false, false, false],
      pointer: "other",
    });
    render(<MultiSelectBlock multi={m} onAction={vi.fn()} />);
    expect(screen.getByRole("button", { name: /^Submit$/ })).toBeDisabled();
  });

  it("enables Confirm when advanceNeedsChecked is true, >=1 option is checked, and pointer is on an option", async () => {
    const onAction = vi.fn();
    const user = userEvent.setup();
    const m = makeCheckboxModel({
      advanceNeedsChecked: true,
      checked: [true, false, false, false],
      pointer: "option",
    });
    render(<MultiSelectBlock multi={m} onAction={onAction} />);
    const submitButton = screen.getByRole("button", { name: /^Submit$/ });
    expect(submitButton).not.toBeDisabled();

    await user.click(submitButton);
    expect(onAction).toHaveBeenCalledWith({ kind: "advance" });
  });

  it("leaves Confirm enabled without advanceNeedsChecked even with 0 checked options", () => {
    const m = makeCheckboxModel({
      advanceNeedsChecked: undefined,
      checked: [false, false, false, false],
      pointer: "other",
    });
    render(<MultiSelectBlock multi={m} onAction={vi.fn()} />);
    expect(screen.getByRole("button", { name: /^Submit$/ })).not.toBeDisabled();
  });
});

