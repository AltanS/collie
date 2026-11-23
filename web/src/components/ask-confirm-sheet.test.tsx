import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import { NO_DRAFT, type AskDraft } from "@/lib/hill/asks-drafts";
import { askDecision } from "@/test/asks-fixtures";

import { AskConfirmSheet, draftOf, pickKey, startText, type AskPick } from "./ask-confirm-sheet";

const ASK = askDecision({ id: "ak_ask1" });

function open(pick: AskPick | null, draft: AskDraft = NO_DRAFT, ask = ASK) {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  render(<AskConfirmSheet ask={ask} pick={pick} draft={draft} onConfirm={onConfirm} onClose={onClose} />);
  return { onConfirm, onClose };
}

describe("the draft each pick comes to", () => {
  it("trims the text and names the intent", () => {
    expect(draftOf({ kind: "option", intent: "keep", byKey: false }, "  later ")).toEqual({ intent: "keep", text: "later" });
    expect(draftOf({ kind: "own", byKey: false }, " go ")).toEqual({ intent: "own", text: "go" });
    expect(draftOf({ kind: "words", byKey: false }, "go")).toEqual({ intent: null, text: "go" });
    expect(draftOf({ kind: "more", byKey: true }, "")).toEqual({ intent: "more-context", text: "" });
  });

  it("starts from the draft only when it is the very same answer", () => {
    const draft = { intent: "keep", text: "for now" };
    expect(startText({ kind: "option", intent: "keep", byKey: false }, draft)).toBe("for now");
    expect(startText({ kind: "option", intent: "drop", byKey: false }, draft)).toBe("");
    expect(startText({ kind: "own", byKey: false }, draft)).toBe("");
    expect(startText({ kind: "words", byKey: false }, { intent: null, text: "mine" })).toBe("mine");
  });

  it("keys a pick by its kind and intent", () => {
    expect(pickKey({ kind: "option", intent: "keep", byKey: false })).toBe("option:keep");
    expect(pickKey({ kind: "own", byKey: true })).toBe("own");
  });
});

describe("the confirm sheet", () => {
  it("draws nothing without a pick", () => {
    open(null);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the chosen answer, hides the note behind a toggle, and confirms with no note on a touch tap", async () => {
    const { onConfirm } = open({ kind: "option", intent: "keep", byKey: false });
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Keep both routes");
    expect(dialog).toHaveTextContent("Two code paths until the next minor.");
    expect(screen.getByRole("button", { name: /Add a note/u })).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onConfirm).toHaveBeenCalledWith({ intent: "keep", text: "" });
  });

  it("opens the note and sends it with Confirm", async () => {
    const { onConfirm } = open({ kind: "option", intent: "drop", byKey: false });
    await userEvent.click(await screen.findByRole("button", { name: /Add a note/u }));
    await userEvent.type(screen.getByRole("textbox", { name: /Note for the agent/u }), "keep the flag");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onConfirm).toHaveBeenCalledWith({ intent: "drop", text: "keep the flag" });
  });

  it("draws the note open, and focused, when a key opened the sheet on a pointer that is not a finger", async () => {
    open({ kind: "option", intent: "keep", byKey: true });
    const field = await screen.findByRole("textbox", { name: /Note for the agent/u });
    expect(screen.getByRole("button", { name: /Add a note/u })).toHaveAttribute("aria-expanded", "true");
    await waitFor(() => expect(field).toHaveFocus());
  });

  it("confirms on Enter and writes a new line on Shift+Enter", async () => {
    const { onConfirm } = open({ kind: "option", intent: "keep", byKey: true });
    const field = await screen.findByRole("textbox", { name: /Note for the agent/u });
    await userEvent.type(field, "one{Shift>}{Enter}{/Shift}two");
    expect(onConfirm).not.toHaveBeenCalled();
    expect(field).toHaveValue("one\ntwo");
    await userEvent.keyboard("{Enter}");
    expect(onConfirm).toHaveBeenCalledWith({ intent: "keep", text: "one\ntwo" });
  });

  it("starts an answered pick again with its note filled in and offers Change answer", async () => {
    open({ kind: "option", intent: "keep", byKey: false }, { intent: "keep", text: "for now" });
    expect(await screen.findByRole("button", { name: "Change answer" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /Note for the agent/u })).toHaveValue("for now");
    expect(screen.getByRole("button", { name: /Add a note/u })).toHaveAttribute("aria-expanded", "true");
  });

  it("holds Confirm off on Your own answer until it holds words", async () => {
    const { onConfirm } = open({ kind: "own", byKey: false });
    const confirm = await screen.findByRole("button", { name: "Confirm" });
    expect(confirm).toBeDisabled();
    await userEvent.type(screen.getByRole("textbox", { name: "Your own answer" }), "  Ask me again ");
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith({ intent: "own", text: "Ask me again" });
  });

  it("takes the one card of a words ask as a required field", async () => {
    const { onConfirm } = open({ kind: "words", byKey: false }, NO_DRAFT, askDecision({ words: true }));
    await userEvent.type(await screen.findByRole("textbox", { name: "Your answer" }), "ship it");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onConfirm).toHaveBeenCalledWith({ intent: null, text: "ship it" });
  });

  it("asks back with an optional note", async () => {
    const { onConfirm } = open({ kind: "more", byKey: false });
    expect(await screen.findByRole("dialog")).toHaveTextContent("I need more context");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onConfirm).toHaveBeenCalledWith({ intent: "more-context", text: "" });
  });

  it("closes on Cancel", async () => {
    const { onClose, onConfirm } = open({ kind: "option", intent: "keep", byKey: false });
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
