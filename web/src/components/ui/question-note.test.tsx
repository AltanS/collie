import { act, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { QuestionNote } from "./question-note";
import type { SeenValue } from "@/lib/editor-action";
import { piAdapter } from "@/lib/harness/pi";
import { fixtureRows } from "@/test/surface-corpus";

function completeNote(): SeenValue {
  const card = piAdapter.buildBlocks(fixtureRows("pi--rpiv-v2150-multi.txt")).find((block) => block.kind === "multi-select");
  if (card === undefined) throw new Error("missing native question fixture");
  return { text: "Full first line\nFull second line", purpose: "question-note", contextSignature: "native-context",
    origin: { kind: "multi-select", model: card.multi, paneId: "w2:p1", requestedLines: 80, detectedRevision: 0, agent: "pi" } };
}
const summary = { state: "attached", text: "Full first line …", textComplete: false } as const;

describe("QuestionNote editing ownership", () => {
  it("delegates native editing to its caller without creating a competing local editor", async () => {
    const user = userEvent.setup();
    let complete!: (seen: SeenValue | null) => void;
    const pending = new Promise<SeenValue | null>((resolve) => { complete = resolve; });
    const onRead = vi.fn(() => pending);
    const { container } = render(<QuestionNote note={summary} saving={false} maxLength={300} onRead={onRead} onSave={vi.fn()} />);
    const view = within(container);
    await user.click(view.getByRole("button", { name: "Edit note" }));
    expect(onRead).toHaveBeenCalledWith(false);
    expect(view.queryByRole("textbox")).not.toBeInTheDocument();
    await act(async () => complete(completeNote()));
    expect(view.queryByRole("textbox")).not.toBeInTheDocument();
    await user.click(view.getByRole("button", { name: "Remove note" }));
    expect(onRead).toHaveBeenLastCalledWith(true);
  });

  it("retains legacy local editing and refuses to discard an unacknowledged draft", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => false);
    const { container } = render(<QuestionNote note={{ state: "attached", text: "Existing note" }} saving={false} maxLength={300} onSave={onSave} />);
    const view = within(container);
    await user.click(view.getByRole("button", { name: "Edit note" }));
    const field = await view.findByRole("textbox", { name: "Note text" });
    expect(field).toHaveValue("Existing note");
    await user.clear(field);
    await user.type(field, "Phone draft");
    await user.click(view.getByRole("button", { name: "Save note" }));
    expect(onSave).toHaveBeenCalledWith("Phone draft");
    expect(field).toHaveValue("Phone draft");
  });

  it("does not offer replacement or removal from an incomplete summary without a reader", () => {
    const { container } = render(<QuestionNote note={summary} saving={false} maxLength={300} onSave={vi.fn()} />);
    const view = within(container);
    expect(view.getByRole("button", { name: "Edit note" })).toBeDisabled();
    expect(view.getByRole("button", { name: "Remove note" })).toBeDisabled();
  });
});
