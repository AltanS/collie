import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CardDock, hasDialogCard } from "@/components/card-dock";
import { claudeBuildBlocks } from "@/lib/harness/claude";
import { fixtureRows } from "@/test/surface-corpus";
import { piAdapter } from "@/lib/harness/pi";
import type { SeenValue } from "@/lib/editor-action";

describe("CardDock native edit lifetime", () => {
  it("warns about a clipped review and reads an unknown global note instead of claiming it is empty", async () => {
    const user = userEvent.setup();
    const blocks = piAdapter.buildBlocks(fixtureRows("pi--rpiv-v2150-submit-clipped--w59.txt"));
    const original = blocks.find((block) => block.kind === "multi-select");
    if (original?.multi.phase !== "review") throw new Error("missing clipped review");
    const seen: SeenValue = { text: "Actual hidden global note", purpose: "global-note", contextSignature: "seen-context",
      origin: { kind: "multi-select", model: original.multi, paneId: "w5:p1", requestedLines: 80, detectedRevision: 0, agent: "pi" } };
    const onReadEditor = vi.fn(async () => seen);
    const { container } = render(<CardDock blocks={blocks} onMultiSelectAction={vi.fn()} onReadEditor={onReadEditor} onSaveEditor={vi.fn(async () => true)} onCancelEditor={vi.fn(async () => true)} />);
    const view = within(container);
    expect(view.getByRole("status")).toHaveTextContent("Some review text is outside this terminal view");
    await user.click(view.getByRole("button", { name: "Note for the whole questionnaire" }));
    expect(onReadEditor).toHaveBeenCalledWith("global-note", { kind: "multi-select", model: original.multi });
    expect(await view.findByRole("textbox", { name: "Note text" })).toHaveValue(seen.text);
  });

  it("opens the shared complete-value note editor for a native review's global note", async () => {
    const user = userEvent.setup();
    const blocks = piAdapter.buildBlocks(fixtureRows("pi--rpiv-v2150-submit-partial.txt"));
    const original = blocks.find((block) => block.kind === "multi-select");
    if (original?.multi.phase !== "review") throw new Error("missing native review");
    const seen: SeenValue = { text: "Complete global\nSecond global", purpose: "global-note", contextSignature: "seen-context",
      origin: { kind: "multi-select", model: original.multi, paneId: "w3:p1", requestedLines: 80, detectedRevision: 0, agent: "pi" } };
    const onReadEditor = vi.fn(async () => seen);
    const { container } = render(<CardDock blocks={blocks} onMultiSelectAction={vi.fn()} onReadEditor={onReadEditor} onSaveEditor={vi.fn(async () => true)} onCancelEditor={vi.fn(async () => true)} />);
    const view = within(container);
    expect(view.getByRole("region", { name: "Note for the whole questionnaire" })).toBeInTheDocument();
    expect(view.getByText(/Own preview plan/, { selector: "dd" })).toHaveClass("whitespace-pre-wrap");
    await user.click(view.getByRole("button", { name: "Add a note to this answer" }));
    expect(onReadEditor).toHaveBeenCalledWith("global-note", { kind: "multi-select", model: original.multi });
    expect(await view.findByRole("textbox", { name: "Note text" })).toHaveValue(seen.text);
  });

  it("uses the same complete-value editor for a native single-choice custom answer", async () => {
    const user = userEvent.setup();
    const blocks = piAdapter.buildBlocks(fixtureRows("pi--rpiv-v2150-single-step.txt"));
    const original = blocks.find((block) => block.kind === "preview-select");
    if (original === undefined) throw new Error("missing native single-choice question");
    const seen: SeenValue = { text: "Existing single value", purpose: "answer", contextSignature: "seen-context",
      origin: { kind: "preview-select", model: original.preview, paneId: "w2:p1", requestedLines: 80, detectedRevision: 0, agent: "pi" } };
    const onReadEditor = vi.fn(async () => seen);
    const { container } = render(<CardDock blocks={blocks} onPreviewAction={vi.fn()} onReadEditor={onReadEditor} onSaveEditor={vi.fn(async () => false)} onCancelEditor={vi.fn(async () => true)} />);
    const view = within(container);
    await user.click(view.getByRole("button", { name: "Type your own answer" }));
    expect(onReadEditor).toHaveBeenCalledWith("answer", { kind: "preview-select", model: original.preview });
    expect(await view.findByRole("textbox", { name: "Answer text" })).toHaveValue(seen.text);
  });

  it("opens a native answer through complete readback and keeps a refused multiline draft", async () => {
    const user = userEvent.setup();
    const blocks = piAdapter.buildBlocks(fixtureRows("pi--rpiv-v2150-multi.txt"));
    const original = blocks.find((block) => block.kind === "multi-select");
    if (original === undefined) throw new Error("missing native question");
    const seen: SeenValue = { text: "Native value", purpose: "answer", contextSignature: "seen-context",
      origin: { kind: "multi-select", model: original.multi, paneId: "w2:p1", requestedLines: 80, detectedRevision: 0, agent: "pi" } };
    const onReadEditor = vi.fn(async () => seen);
    const onSaveEditor = vi.fn(async () => false);
    const { container } = render(<CardDock blocks={blocks} onMultiSelectAction={vi.fn()} onReadEditor={onReadEditor} onSaveEditor={onSaveEditor} onCancelEditor={vi.fn(async () => true)} />);
    const view = within(container);
    await user.click(view.getByRole("button", { name: "Type your own answer" }));
    expect(onReadEditor).toHaveBeenCalledWith("answer", { kind: "multi-select", model: original.multi });
    const field = await view.findByRole("textbox", { name: "Answer text" });
    expect(field).toHaveValue("Native value");
    await user.clear(field);
    await user.type(field, "  First line{enter}  Second line{enter}");
    await user.click(view.getByRole("button", { name: "Send answer" }));
    expect(onSaveEditor).toHaveBeenCalledWith("  First line\n  Second line\n", seen);
    expect(field).toHaveValue("  First line\n  Second line\n");
  });

  it("keeps the asked question, complete note and refused phone draft when the native card becomes raw", async () => {
    const user = userEvent.setup();
    const blocks = piAdapter.buildBlocks(fixtureRows("pi--rpiv-v2150-multi.txt"));
    const original = blocks.find((block) => block.kind === "multi-select");
    if (original === undefined) throw new Error("missing native question");
    let complete!: (seen: SeenValue | null) => void;
    const pending = new Promise<SeenValue | null>((resolve) => { complete = resolve; });
    const onReadEditor = vi.fn(() => pending);
    const onSaveEditor = vi.fn(async () => false);
    const callbacks = { onMultiSelectAction: vi.fn(), onReadEditor, onSaveEditor, onCancelEditor: vi.fn(async () => true) };
    const { container, rerender } = render(<CardDock blocks={blocks} {...callbacks} />);
    const view = within(container);
    await user.click(view.getByRole("button", { name: "Add a note to this answer" }));
    expect(onReadEditor).toHaveBeenCalledWith("question-note", { kind: "multi-select", model: original.multi });
    const raw = piAdapter.buildBlocks(fixtureRows("pi--rpiv-v2150-note-editor-long.txt"));
    rerender(<CardDock blocks={raw} {...callbacks} />);
    expect(view.getByText(original.multi.phase === "checkbox" ? original.multi.question : "bad fixture")).toBeInTheDocument();
    expect(view.queryByRole("checkbox")).not.toBeInTheDocument();
    const seen: SeenValue = { text: "Complete first\nComplete second", purpose: "question-note", contextSignature: "seen-context",
      origin: { kind: "multi-select", model: original.multi, paneId: "w2:p1", requestedLines: 80, detectedRevision: 0, agent: "pi" } };
    await act(async () => complete(seen));
    const field = await view.findByRole("textbox", { name: "Note text" });
    expect(field).toHaveValue(seen.text);
    await user.clear(field);
    await user.type(field, "Thumb-typed draft");
    rerender(<CardDock blocks={raw} {...callbacks} />);
    await user.click(view.getByRole("button", { name: "Save note" }));
    expect(onSaveEditor).toHaveBeenCalledWith("Thumb-typed draft", seen);
    expect(view.getByRole("textbox", { name: "Note text" })).toHaveValue("Thumb-typed draft");
    expect(view.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("shows the complete note before explicit removal and retains it when removal or return refuses", async () => {
    const user = userEvent.setup();
    const blocks = piAdapter.buildBlocks(fixtureRows("pi--rpiv-v2150-submit-global-note.txt"));
    const original = blocks.find((block) => block.kind === "multi-select");
    if (original === undefined) throw new Error("missing native review");
    const seen: SeenValue = { text: "Complete note\nSecond line", purpose: "global-note", contextSignature: "seen-context",
      origin: { kind: "multi-select", model: original.multi, paneId: "w2:p1", requestedLines: 80, detectedRevision: 0, agent: "pi" } };
    const onSaveEditor = vi.fn(async () => false);
    const onCancelEditor = vi.fn(async () => false);
    const { container } = render(<CardDock blocks={blocks} onMultiSelectAction={vi.fn()} onReadEditor={async () => seen} onSaveEditor={onSaveEditor} onCancelEditor={onCancelEditor} />);
    const view = within(container);
    await user.click(view.getByRole("button", { name: "Remove note" }));
    const field = await view.findByRole("textbox", { name: "Note text" });
    expect(field).toHaveValue(seen.text);
    expect(field).toHaveAttribute("readonly");
    expect(onSaveEditor).not.toHaveBeenCalled();
    await user.click(view.getByRole("button", { name: "Remove note" }));
    expect(onSaveEditor).toHaveBeenCalledWith("", seen);
    expect(field).toHaveValue(seen.text);
    await user.click(view.getByRole("button", { name: "Back to the options" }));
    expect(onCancelEditor).toHaveBeenCalledWith(seen);
    expect(field).toHaveValue(seen.text);
  });

  it("explains a refused complete read and offers an acknowledged local close", async () => {
    const user = userEvent.setup();
    const blocks = piAdapter.buildBlocks(fixtureRows("pi--rpiv-v2150-multi.txt"));
    const onSaveEditor = vi.fn(async () => true);
    const { container } = render(<CardDock blocks={blocks} onMultiSelectAction={vi.fn()} onReadEditor={async () => null} onSaveEditor={onSaveEditor} />);
    const view = within(container);
    await user.click(view.getByRole("button", { name: "Add a note to this answer" }));
    expect(view.getByRole("alert")).not.toBeEmptyDOMElement();
    expect(view.queryByRole("textbox")).not.toBeInTheDocument();
    await user.click(view.getByRole("button", { name: "Close" }));
    expect(view.queryByRole("alert")).not.toBeInTheDocument();
    expect(onSaveEditor).not.toHaveBeenCalled();
  });
});

// Only a lifted dialog card can answer the composer's "Answer the dialog" remedy.
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

// A step-1 draft must not be sent into step 2 when the desk advances the mounted wizard.
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
    const { container, rerender } = render(<CardDock blocks={blocks("claude--wizard-q1.txt")} onWizardAction={vi.fn()} onWizardAnswer={onWizardAnswer} />);
    const view = within(container);
    await user.click(view.getByRole("button", { name: "Type your own answer" }));
    await user.type(view.getByRole("textbox", { name: "Answer text" }), "Step one words");
    rerender(<CardDock blocks={blocks("claude--wizard-q2.txt")} onWizardAction={vi.fn()} onWizardAnswer={onWizardAnswer} />);
    await user.click(view.getByRole("button", { name: "Send answer" }));
    expect(onWizardAnswer).not.toHaveBeenCalled();
    const q2 = questionOf("claude--wizard-q2.txt");
    expect(q2).not.toBe(questionOf("claude--wizard-q1.txt"));
    expect(view.getByText(`The terminal moved on to another question: “${q2}”. Nothing was sent. Send again to answer this one.`)).toBeInTheDocument();
    expect(view.getByRole("textbox", { name: "Answer text" })).toHaveValue("Step one words");
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
