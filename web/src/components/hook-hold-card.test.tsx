import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { holdHash, type HoldNote } from "@/lib/surface/hold";
import { HookHoldCard } from "./hook-hold-card";

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
    await userEvent.click(screen.getByRole("button", { name: /No/ }));
    expect(onAnswer).toHaveBeenCalledWith(1);
  });

  it("draws nothing for an adopted hold: the screen card answers it", () => {
    const { container } = render(<HookHoldCard note={{ ...NOTE, adopted: true }} onAnswer={() => undefined} />);
    expect(container.textContent).toBe("");
  });

  it("says how the hold ended", () => {
    const cases: [HoldNote["state"], string][] = [
      ["sent", "Sent. The agent goes on when the tool runs."],
      ["desk", "The desk answered first."],
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
});
