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
