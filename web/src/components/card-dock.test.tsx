import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CardDock, hasDialogCard } from "@/components/card-dock";
import { parseAnsi } from "@/lib/ansi";
import { splitLines } from "@/lib/blocks";
import { buildBlocks } from "@/lib/harness";
import { claudeBuildBlocks } from "@/lib/harness/claude";
import { WRAPPED_CHOICES, wrappedChoiceScreen } from "@/test/pi-wrapped-choice";
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

describe("CardDock: the Authentication box", () => {
  const blocks = (name: string) => claudeBuildBlocks(fixtureRows(name));
  const FILLED = "claude--v2307-auth-refresh-output--w61.txt";
  const DEVICE = "https://example.awsapps.com/start/#/device";

  it("docks the box's text as a card of links with no button, and the card answers no dialog", () => {
    const filled = blocks(FILLED);
    render(<CardDock blocks={filled} />);
    const card = screen.getByRole("group", { name: "Login output" });
    expect(within(card).getByText("Authentication")).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: DEVICE })).toHaveAttribute("href", DEVICE);
    expect(within(card).queryAllByRole("button")).toEqual([]);
    expect(hasDialogCard(filled)).toBe(false);
  });

  it("keeps the link enabled on a read-only device, a stale copy and a gone pane", () => {
    render(<CardDock blocks={blocks(FILLED)} promptDisabled stale />);
    const link = screen.getByRole("link", { name: DEVICE });
    expect(link).toHaveAttribute("href", DEVICE);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).not.toHaveAttribute("aria-disabled");
    expect(screen.queryAllByRole("button")).toEqual([]);
  });

  it("docks the lock message with no link", () => {
    render(<CardDock blocks={blocks("claude--v2309-auth-refresh-locked--w52.txt")} />);
    const card = screen.getByRole("group", { name: "Login output" });
    expect(within(card).getByText(/Another Claude Code process is running your/u)).toBeInTheDocument();
    expect(within(card).queryAllByRole("link")).toEqual([]);
  });
});

// #667: a tall card gives up room before the chat does. The dock shrinks (and scrolls inside itself);
// the reading box above it holds the floor (pinned in agent-chat.test.tsx).
describe("CardDock: the dock shrinks before the chat does", () => {
  const blocks = claudeBuildBlocks(fixtureRows("claude--menu-model-picker.txt"));

  it("shrinks and keeps its height caps, with and without the keyboard", () => {
    const { container, rerender } = render(<CardDock blocks={blocks} />);
    const dock = () => container.querySelector<HTMLElement>('[data-slot="card-dock"]')!;
    expect(dock().className).toMatch(/(?:^|\s)min-h-0(?=\s|$)/);
    expect(dock().className).toMatch(/(?:^|\s)shrink(?=\s|$)/);
    expect(dock().className).not.toMatch(/shrink-0/);
    expect(dock().className).toMatch(/max-h-\[55dvh\]/);
    rerender(<CardDock blocks={blocks} composing />);
    expect(dock().className).toMatch(/max-h-\[40dvh\]/);
  });
});

// The trouble signal (M86 spec 05): the unread-dialog card tells the bridge once per card instance,
// for each pane and dialog it shows. A poll that re-renders the same dialog is not a new signal.
describe("the unread-dialog card signals once per instance", () => {
  const screenText = readFileSync(join(import.meta.dirname, "..", "fixtures", "panes", "claude-lab--menu-status-screen--w82.txt"), "utf8");
  const unreadBlocks = () => buildBlocks(splitLines(parseAnsi(screenText)), { agent: "claude" });

  it("calls onUnreadDialogShown once across re-renders, again for another pane, and again for a new instance", () => {
    const blocks = unreadBlocks();
    expect(blocks.some((block) => block.kind === "unread-dialog")).toBe(true);
    const shown = vi.fn();
    const { rerender, unmount } = render(<CardDock blocks={blocks} paneId="w1:p1" onUnreadDialogShown={shown} />);
    expect(shown).toHaveBeenCalledTimes(1);
    expect(shown.mock.calls[0]?.[0]).toMatchObject({ agent: "claude" });
    // The next poll builds the blocks again from the same screen: the same dialog, no new signal.
    rerender(<CardDock blocks={unreadBlocks()} paneId="w1:p1" onUnreadDialogShown={shown} />);
    rerender(<CardDock blocks={unreadBlocks()} paneId="w1:p1" onUnreadDialogShown={shown} />);
    expect(shown).toHaveBeenCalledTimes(1);
    // Another pane reusing the instance is a new card for it.
    rerender(<CardDock blocks={unreadBlocks()} paneId="w1:p2" onUnreadDialogShown={shown} />);
    expect(shown).toHaveBeenCalledTimes(2);
    unmount();
    render(<CardDock blocks={unreadBlocks()} paneId="w1:p1" onUnreadDialogShown={shown} />);
    expect(shown).toHaveBeenCalledTimes(3);
  });

  it("calls nothing without the handler", () => {
    expect(() => render(<CardDock blocks={unreadBlocks()} paneId="w1:p1" />)).not.toThrow();
  });
});

// Issue 746: a pi question whose option descriptions wrap (gentle-pi's ask_user_choice, built from the
// capture as pi-tui draws a wrapped description, test/pi-wrapped-choice.ts). The Chat card is not a
// button; the answer is the dock's. Before the fix the reader declined the wrapped rows and the dock
// drew no option at all.
describe("CardDock: a pi question whose descriptions wrap", () => {
  const blocks = () => buildBlocks(splitLines(parseAnsi(wrappedChoiceScreen(0))), { agent: "pi" });

  it("draws the options, and a tap on one hands that option to the answer", async () => {
    const onPromptAction = vi.fn(() => true);
    const user = userEvent.setup();
    const shown = blocks();
    expect(hasDialogCard(shown)).toBe(true);
    render(<CardDock blocks={shown} onPromptAction={onPromptAction} />);
    const card = screen.getByRole("group", { name: "Pick a color for the Collie probe" });
    for (const choice of WRAPPED_CHOICES) {
      expect(within(card).getByRole("button", { name: new RegExp(`^${choice.label}`) })).toBeInTheDocument();
    }
    await user.click(within(card).getByRole("button", { name: /^Green/ }));
    expect(onPromptAction).toHaveBeenCalledTimes(1);
    expect(onPromptAction).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "option", option: expect.objectContaining({ label: "Green", keys: ["Down", "Enter"] }) }),
      expect.objectContaining({ question: "Pick a color for the Collie probe" }),
    );
  });
});
