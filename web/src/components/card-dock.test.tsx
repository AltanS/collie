import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CardDock, hasDialogCard } from "@/components/card-dock";
import { claudeBuildBlocks } from "@/lib/harness/claude";
import { fixtureRows } from "@/test/surface-corpus";

// The composer offers "Answer the dialog" on a refusal only when the dock shows a dialog card (the
// 2026-10-16 field case: an unreadable screen with no card offered a way to nothing).
describe("hasDialogCard", () => {
  const blocks = (name: string) => claudeBuildBlocks(fixtureRows(name));

  it("is true on a screen whose dialog a grammar lifts", () => {
    expect(hasDialogCard(blocks("claude--menu-model-picker.txt"))).toBe(true);
  });

  it("is false on a free box with the agents panel under it, and on a completion popup, which answers nothing", () => {
    expect(hasDialogCard(blocks("claude--v2301-synth-agents-panel-walk-fails.txt"))).toBe(false);
    const popup = blocks("claude--autocomplete-slash-short.txt");
    expect(popup.some((block) => block.kind === "autocomplete")).toBe(true);
    expect(hasDialogCard(popup)).toBe(false);
    expect(hasDialogCard([])).toBe(false);
  });
});

// The dock draws one card per dialog kind and does not key it to the dialog, so a wizard the desk
// moves to its next step re-renders the same card, with its answer editor still open. The review of
// PR 441 proved a step-1 draft then went into step 2 (both fields read empty). The editor now keeps
// the question and step it was opened over and refuses a Send once they change.
describe("CardDock: a wizard that moves on under the open answer editor", () => {
  const blocks = (name: string) => claudeBuildBlocks(fixtureRows(name));
  const questionOf = (name: string): string => {
    const block = blocks(name).find((b) => b.kind === "wizard");
    if (block?.kind !== "wizard" || block.wizard.phase !== "question") throw new Error(`${name} is not a wizard question`);
    return block.wizard.question;
  };

  it("a draft written for step 1 is not sent into step 2: Send sends nothing and names the new question", async () => {
    const onWizardAnswer = vi.fn(async () => true);
    const user = userEvent.setup();
    const { rerender } = render(<CardDock blocks={blocks("claude--wizard-q1.txt")} onWizardAction={vi.fn()} onWizardAnswer={onWizardAnswer} />);
    await user.click(screen.getByRole("button", { name: "Type your own answer" }));
    await user.type(screen.getByRole("textbox", { name: "Answer text" }), "Step one words");
    rerender(<CardDock blocks={blocks("claude--wizard-q2.txt")} onWizardAction={vi.fn()} onWizardAnswer={onWizardAnswer} />);
    await user.click(screen.getByRole("button", { name: "Send answer" }));
    expect(onWizardAnswer).not.toHaveBeenCalled();
    const q2 = questionOf("claude--wizard-q2.txt");
    expect(q2).not.toBe(questionOf("claude--wizard-q1.txt"));
    expect(
      screen.getByText(`The terminal moved on to another question: “${q2}”. Nothing was sent. Send again to answer this one.`),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Answer text" })).toHaveValue("Step one words");
  });
});
