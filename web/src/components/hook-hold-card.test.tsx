import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { holdHash, type HoldNote } from "@/lib/surface/hold";
import { HOLD_CARD_LINES, HOLD_TAP_GUARD_MS, HookHoldCard } from "./hook-hold-card";

// The hook card (M56 spec 12). For a hold that did not take the screen's dialog as its own (a
// subagent's request, or another dialog on the screen) it is the only way to answer, from the note
// alone. For an adopted hold the screen card answers, and this card adds nothing until the hold ends.
// After the end it says how.

const NOTE: HoldNote = {
  askId: "ask-7",
  state: "held",
  tool: "Bash",
  input: "rm -rf build",
  agent: true,
  options: ["Yes", "No"],
  hash: holdHash("Bash", "rm -rf build", ["Yes", "No"]),
  adopted: false,
  since: 1,
};

describe("HookHoldCard", () => {
  it("draws an unadopted request from the note, and a tap answers by index", async () => {
    const onAnswer = vi.fn(() => Promise.resolve());
    render(<HookHoldCard note={NOTE} onAnswer={onAnswer} />);
    expect(screen.getByText("Permission: Bash")).toBeTruthy();
    expect(screen.getByText("rm -rf build")).toBeTruthy();
    expect(screen.getByText("A subagent asks. Answer it on this card, not on the screen.")).toBeTruthy();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + HOLD_TAP_GUARD_MS);
    await userEvent.click(screen.getByRole("button", { name: /No/ }));
    expect(onAnswer).toHaveBeenCalledWith(1);
    vi.restoreAllMocks();
  });

  it("ignores a tap in the first moments after a new request shows, so a tap meant for the card before lands nowhere", async () => {
    const onAnswer = vi.fn(() => Promise.resolve());
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { rerender } = render(<HookHoldCard note={NOTE} onAnswer={onAnswer} />);
    now += HOLD_TAP_GUARD_MS;
    act(() => rerender(<HookHoldCard note={{ ...NOTE, askId: "ask-8" }} onAnswer={onAnswer} />));
    now += HOLD_TAP_GUARD_MS - 50;
    await userEvent.click(screen.getByRole("button", { name: /Yes/ }));
    expect(onAnswer).not.toHaveBeenCalled();
    // The guarded tap is not silent: it says to tap again (M102 spec 11).
    expect(screen.getByRole("status")).toHaveTextContent("This request just arrived. Tap again to answer it.");
    now += 50;
    await userEvent.click(screen.getByRole("button", { name: /Yes/ }));
    expect(onAnswer).toHaveBeenCalledWith(0);
    vi.restoreAllMocks();
  });

  it("an answer that fails says so, and the options are live again (M102 spec 11)", async () => {
    render(<HookHoldCard note={NOTE} onAnswer={() => Promise.reject(new Error("no answer"))} />);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + HOLD_TAP_GUARD_MS);
    await userEvent.click(screen.getByRole("button", { name: /Yes/ }));
    expect(await screen.findByText("The answer did not go through. Tap again to try once more.")).toBeTruthy();
    for (const button of screen.getAllByRole("button")) expect(button).toBeEnabled();
    vi.restoreAllMocks();
  });

  it("an answer that throws also opens the exit through onExit, and keeps its own words (M102 spec 10)", async () => {
    const onExit = vi.fn();
    render(<HookHoldCard note={NOTE} onAnswer={() => Promise.reject(new Error("no answer"))} onExit={onExit} />);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + HOLD_TAP_GUARD_MS);
    await userEvent.click(screen.getByRole("button", { name: /Yes/ }));
    expect(await screen.findByText("The answer did not go through. Tap again to try once more.")).toBeTruthy();
    expect(onExit).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it("an answer the caller reports as a dead end says so on the card, and the caller's exit is not called twice (M102 spec 10)", async () => {
    const onExit = vi.fn();
    render(<HookHoldCard note={NOTE} onAnswer={() => Promise.resolve(false)} onExit={onExit} />);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + HOLD_TAP_GUARD_MS);
    await userEvent.click(screen.getByRole("button", { name: /No/ }));
    expect(await screen.findByText("The answer did not go through. Tap again to try once more.")).toBeTruthy();
    // The caller already opened the exit for a reply it saw: the card does not raise it again.
    expect(onExit).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("an answer that went leaves no words and raises no exit (M102 spec 10)", async () => {
    const onExit = vi.fn();
    render(<HookHoldCard note={NOTE} onAnswer={() => Promise.resolve(true)} onExit={onExit} />);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + HOLD_TAP_GUARD_MS);
    await userEvent.click(screen.getByRole("button", { name: /Yes/ }));
    expect(screen.queryByText("The answer did not go through. Tap again to try once more.")).toBeNull();
    expect(onExit).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("a disabled card says why under its options (M102 spec 11)", () => {
    const { unmount } = render(<HookHoldCard note={NOTE} onAnswer={vi.fn()} disabled disabledReason="This device may only read. Answer it at the desk." />);
    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
    expect(screen.getByText("This device may only read. Answer it at the desk.")).toBeTruthy();
    unmount();
    render(<HookHoldCard note={NOTE} onAnswer={vi.fn()} disabled />);
    expect(screen.getByText("This card cannot be answered from here. Answer it at the desk.")).toBeTruthy();
  });

  it("says when the input has more lines than the box shows", () => {
    const many = Array.from({ length: HOLD_CARD_LINES + 2 }, (_, i) => `line ${String(i)}`).join("\n");
    render(<HookHoldCard note={{ ...NOTE, input: many }} onAnswer={() => undefined} />);
    expect(screen.getByText(`The input has ${String(HOLD_CARD_LINES + 2)} lines. Scroll the box to read all of them.`)).toBeTruthy();
  });

  it("draws nothing for an adopted hold: the screen card answers it", () => {
    const { container } = render(<HookHoldCard note={{ ...NOTE, adopted: true }} onAnswer={() => undefined} />);
    expect(container.textContent).toBe("");
  });

  it("says how the hold ended", () => {
    const cases: [HoldNote["state"], string][] = [
      ["sent", "Sent. The agent goes on when the tool runs."],
      ["desk", "The desk answered first."],
      ["keys", "The keys on the screen card answered this dialog."],
      ["elsewhere", "Another Collie answered."],
      ["void", "The hook stopped. Answer the dialog on the screen."],
      ["timeout", "The hold timed out. Answer the dialog on the screen."],
      ["mismatch", "The request changed. Collie let the hook go."],
    ];
    for (const [state, text] of cases) {
      const { unmount } = render(<HookHoldCard note={{ ...NOTE, state }} onAnswer={() => undefined} />);
      expect(screen.getByRole("status").textContent).toContain(text);
      unmount();
    }
  });

  it("draws the desk and another-Collie notes in the info blue, not the caution colour", () => {
    for (const state of ["desk", "elsewhere"] as const) {
      const { unmount } = render(<HookHoldCard note={{ ...NOTE, state }} onAnswer={() => undefined} />);
      const cls = screen.getByRole("status").parentElement?.className ?? "";
      expect(cls).toContain("bg-status-info/15");
      expect(cls).not.toContain("status-working");
      unmount();
    }
  });
});
