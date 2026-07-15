import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { parseAnsi } from "@/lib/ansi";
import { splitLines, type PreviewSelectModel } from "@/lib/blocks";
import { detectPreviewSelect } from "@/lib/harness/claude/preview-select";
import { PreviewSelectBlock } from "./preview-select-block";

// Presentational contract only — the choreography engine has its own tests (preview-action.test.ts)
// and the component never touches the network: taps resolve to intents on the injected handler.

const PANES_DIR = join(import.meta.dirname, "..", "fixtures", "panes");
function fixtureModel(name: string): PreviewSelectModel {
  const text = readFileSync(join(PANES_DIR, name), "utf8");
  const model = detectPreviewSelect(splitLines(parseAnsi(text)));
  if (!model) throw new Error(`fixture ${name} did not detect a preview dialog`);
  return model;
}

describe("PreviewSelectBlock — presentation", () => {
  it("renders options as buttons, the pointed option's preview pane, and the add-note affordance", () => {
    const model = fixtureModel("claude--select-preview.txt");
    render(<PreviewSelectBlock preview={model} onAction={vi.fn()} />);

    expect(
      screen.getByRole("group", { name: "Which widget design should we use?" }),
    ).toBeInTheDocument();
    for (const label of ["Boxy", "Rounded", "Minimal"]) {
      expect(screen.getByRole("button", { name: new RegExp(label) })).toBeInTheDocument();
    }
    // Each option leads with its terminal-menu digit (the KeyBadge affordance).
    expect(within(screen.getByRole("button", { name: /Boxy/ })).getByText("1")).toBeInTheDocument();
    // The preview pane, captioned with the pointed option, verbatim as text.
    expect(screen.getByText(/Preview · Boxy/)).toBeInTheDocument();
    expect(screen.getByText(/WIDGET/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Add a note/ })).toBeInTheDocument();
    // Single-question: no stepper navigation (the question/chip stays in the raw mirror above).
    expect(screen.queryByRole("button", { name: "Next step" })).not.toBeInTheDocument();
  });

  it("shows an attached note with edit and remove controls", () => {
    const model = fixtureModel("claude--select-preview-note-attached.txt");
    render(<PreviewSelectBlock preview={model} onAction={vi.fn()} />);
    expect(screen.getByText("prefer subtle shadows")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit note" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove note" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add a note/ })).not.toBeInTheDocument();
  });

  it("locks everything behind the terminal-editing banner while the TUI input is focused", () => {
    const model = fixtureModel("claude--select-preview-note-input.txt");
    render(<PreviewSelectBlock preview={model} onAction={vi.fn()} />);
    expect(screen.getByText(/being edited in the terminal/)).toBeInTheDocument();
    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
  });

  it("renders the wizard stepper (chips + nav) for a wizard step, question included", () => {
    const model = fixtureModel("claude--wizard-preview-q1.txt");
    render(<PreviewSelectBlock preview={model} onAction={vi.fn()} />);
    const chips = screen.getAllByRole("listitem");
    expect(chips.map((c) => c.textContent)).toEqual(["Card layout", "Dark mode", "Submit"]);
    expect(chips[0]).toHaveAttribute("aria-current", "step");
    expect(screen.getByText("Which card layout should we use?")).toBeInTheDocument();
    // First question current → Back clamps (disabled), Next stays live.
    expect(screen.getByRole("button", { name: "Previous step" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next step" })).not.toBeDisabled();
  });

  it("disables every control when disabled (read-only device / gone pane)", () => {
    const model = fixtureModel("claude--select-preview.txt");
    render(<PreviewSelectBlock preview={model} onAction={vi.fn()} disabled />);
    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
  });
});

describe("PreviewSelectBlock — intents", () => {
  it("tapping an option raises an option intent (the handler owns digit→verify→Enter)", async () => {
    const onAction = vi.fn();
    const user = userEvent.setup();
    const model = fixtureModel("claude--select-preview.txt");
    render(<PreviewSelectBlock preview={model} onAction={onAction} />);

    await user.click(screen.getByRole("button", { name: /Rounded/ }));
    expect(onAction).toHaveBeenCalledWith({ kind: "option", option: model.options[1] });
  });

  it("adding a note opens the editor and saves the typed text as a note intent", async () => {
    const onAction = vi.fn();
    const user = userEvent.setup();
    const model = fixtureModel("claude--select-preview.txt");
    render(<PreviewSelectBlock preview={model} onAction={onAction} />);

    await user.click(screen.getByRole("button", { name: /Add a note/ }));
    const input = screen.getByRole("textbox", { name: "Note text" });
    // Empty notes can't be saved (removal is the attached card's explicit control).
    expect(screen.getByRole("button", { name: /Save note/ })).toBeDisabled();
    await user.type(input, "prefer bolder borders");
    await user.click(screen.getByRole("button", { name: /Save note/ }));
    expect(onAction).toHaveBeenCalledWith({ kind: "note", text: "prefer bolder borders" });
    // The editor closes after the save resolves (the revalidated model shows the truth).
    expect(screen.queryByRole("textbox", { name: "Note text" })).not.toBeInTheDocument();
  });

  it("editing prefills the current note; removing raises an empty note intent", async () => {
    const onAction = vi.fn();
    const user = userEvent.setup();
    const model = fixtureModel("claude--select-preview-note-attached.txt");
    render(<PreviewSelectBlock preview={model} onAction={onAction} />);

    await user.click(screen.getByRole("button", { name: "Edit note" }));
    expect(screen.getByRole("textbox", { name: "Note text" })).toHaveValue(
      "prefer subtle shadows",
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await user.click(screen.getByRole("button", { name: "Remove note" }));
    expect(onAction).toHaveBeenCalledWith({ kind: "note", text: "" });
  });

  it("wizard step navigation raises nav intents with the wizard's Left/Right keys", async () => {
    const onAction = vi.fn();
    const user = userEvent.setup();
    const model = fixtureModel("claude--wizard-preview-q1.txt");
    render(<PreviewSelectBlock preview={model} onAction={onAction} />);

    await user.click(screen.getByRole("button", { name: "Next step" }));
    expect(onAction).toHaveBeenLastCalledWith({ kind: "nav", keys: ["Right"] });
  });
});
