import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { UpdateScreenSection } from "./update-screen";

// The Update mode tab of the playground (ADR 0064). Altan reviews UI here, and he reviews by number,
// so the card has to be real: the real component, the real reducer, one stable `data-state` handle,
// and a numbered list of states that each render without an error boundary.

describe("the Update mode playground section", () => {
  it("renders one stepper card with its handle", () => {
    const { container } = render(<UpdateScreenSection />);
    const cards = [...container.querySelectorAll(".pg-grid > *")];
    expect(cards.map((card) => card.getAttribute("data-state"))).toEqual(["update-mode-stepper"]);
  });

  it("numbers every state and renders each one through the real component", async () => {
    const user = userEvent.setup();
    render(<UpdateScreenSection />);
    const list = screen.getByRole("group", { name: "Update mode states" });
    const buttons = within(list).getAllByRole("button");
    expect(buttons.length).toBeGreaterThanOrEqual(20);
    for (const [index, button] of buttons.entries()) {
      await user.click(button);
      expect(screen.getByText(`State ${index + 1} of ${buttons.length}`)).toBeInTheDocument();
      expect(screen.queryByText(/unexpected application error/i)).toBeNull();
    }
  });

  it("walks Altan's two states: one unreachable member, then the phone downloading", async () => {
    const user = userEvent.setup();
    render(<UpdateScreenSection />);
    const list = screen.getByRole("group", { name: "Update mode states" });
    await user.click(within(list).getByRole("button", { name: /Members, one unreachable/ }));
    expect(screen.getByRole("button", { name: "Skip cellar" })).toBeInTheDocument();
    await user.click(within(list).getByRole("button", { name: /Phone downloading/ }));
    expect(screen.getByRole("dialog", { name: "Updating this phone" })).toBeInTheDocument();
    expect(screen.getAllByText("132 of 214 files", { exact: false }).length).toBeGreaterThan(0);
  });
});
