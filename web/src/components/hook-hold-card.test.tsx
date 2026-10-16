import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { holdAsk, type HoldNote } from "@/lib/surface/hold";
import { HookHoldCard } from "./hook-hold-card";

// The hook card (M56 spec 12). With no dialog on the screen (a subagent's request) it is the only way
// to answer; with a screen card it adds nothing until the hold ends; after the end it says how.

const ASK = holdAsk("ask-7", "Bash", "rm -rf build", ["Yes", "No"]);
const NOTE: HoldNote = { askId: "ask-7", state: "held", tool: "Bash", input: "rm -rf build", agent: true, since: 1 };

describe("HookHoldCard", () => {
  it("draws the request with no screen card, and a tap answers by index", async () => {
    const onAnswer = vi.fn(() => Promise.resolve());
    render(<HookHoldCard note={NOTE} ask={ASK} screenCard={false} onAnswer={onAnswer} />);
    expect(screen.getByText("Permission: Bash")).toBeTruthy();
    expect(screen.getByText("rm -rf build")).toBeTruthy();
    expect(screen.getByText("A subagent asks. The screen shows no dialog for it.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /No/ }));
    expect(onAnswer).toHaveBeenCalledWith(1);
  });

  it("draws nothing while a screen card shows the same request, or the ask is another one", () => {
    const { container, rerender } = render(<HookHoldCard note={NOTE} ask={ASK} screenCard onAnswer={() => undefined} />);
    expect(container.textContent).toBe("");
    rerender(<HookHoldCard note={NOTE} ask={{ ...ASK, id: "ask-8" }} screenCard={false} onAnswer={() => undefined} />);
    expect(container.textContent).toBe("");
    rerender(<HookHoldCard note={NOTE} ask={{ ...ASK, channel: "keys" }} screenCard={false} onAnswer={() => undefined} />);
    expect(container.textContent).toBe("");
  });

  it("says how the hold ended", () => {
    const cases: [HoldNote["state"], string][] = [
      ["sent", "Sent. The agent goes on when the tool runs."],
      ["desk", "Answered at the desk."],
      ["elsewhere", "Answered on another Collie."],
      ["void", "The hook stopped. Answer the dialog on the screen."],
      ["timeout", "The hold timed out. Answer the dialog on the screen."],
      ["mismatch", "The request changed. Collie let the hook go."],
    ];
    for (const [state, text] of cases) {
      const { unmount } = render(<HookHoldCard note={{ ...NOTE, state }} ask={null} screenCard onAnswer={() => undefined} />);
      expect(screen.getByRole("status").textContent).toContain(text);
      unmount();
    }
  });
});
