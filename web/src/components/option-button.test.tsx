import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { AnsiSegment } from "@/lib/ansi";
import type { StyledLine } from "@/lib/blocks";
import { PromptPanel } from "./option-button";

// PromptPanel's own way back to the terminal (ADR 0056): an optional `raw` region turns on a
// ghost "Terminal" control that swaps the panel's children for a mirror of that region, plus a
// "Back to the card" control that restores them. No `raw` — no control, unchanged from before.

function segment(text: string): AnsiSegment {
  return { text, style: {}, muted: false };
}

const RAW_LINES: StyledLine[] = [
  { segments: [segment("❯ 1. Red")] },
  { segments: [segment("  2. Green")] },
];

describe("PromptPanel", () => {
  it("renders no control when raw is absent", () => {
    render(
      <PromptPanel ariaLabel="Choose a colour">
        <button type="button">Red</button>
      </PromptPanel>,
    );
    expect(screen.getByRole("button", { name: "Red" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /terminal/i })).toBeNull();
  });

  it("renders the Terminal control when raw is given, alongside the children", () => {
    render(
      <PromptPanel ariaLabel="Choose a colour" raw={RAW_LINES}>
        <button type="button">Red</button>
      </PromptPanel>,
    );
    expect(screen.getByRole("button", { name: "Red" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show the terminal instead of this card" }),
    ).toBeInTheDocument();
  });

  it("swaps to the raw rows and the Back control on a tap, hiding the children", async () => {
    const user = userEvent.setup();
    render(
      <PromptPanel ariaLabel="Choose a colour" raw={RAW_LINES}>
        <button type="button">Red</button>
      </PromptPanel>,
    );
    await user.click(screen.getByRole("button", { name: "Show the terminal instead of this card" }));

    expect(screen.queryByRole("button", { name: "Red" })).toBeNull();
    expect(screen.getByText(/Red/)).toBeInTheDocument(); // now the raw mirror text, not the button
    expect(screen.getByRole("button", { name: "Back to the card" })).toBeInTheDocument();
  });

  it("restores the children on Back", async () => {
    const user = userEvent.setup();
    render(
      <PromptPanel ariaLabel="Choose a colour" raw={RAW_LINES}>
        <button type="button">Red</button>
      </PromptPanel>,
    );
    await user.click(screen.getByRole("button", { name: "Show the terminal instead of this card" }));
    await user.click(screen.getByRole("button", { name: "Back to the card" }));

    expect(screen.getByRole("button", { name: "Red" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show the terminal instead of this card" }),
    ).toBeInTheDocument();
  });

  it("keeps role=group and its aria label in every mode", async () => {
    const user = userEvent.setup();
    render(
      <PromptPanel ariaLabel="Choose a colour" raw={RAW_LINES}>
        <button type="button">Red</button>
      </PromptPanel>,
    );
    expect(screen.getByRole("group", { name: "Choose a colour" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show the terminal instead of this card" }));
    expect(screen.getByRole("group", { name: "Choose a colour" })).toBeInTheDocument();
  });

  // Counsel fix #2 (ADR 0056): the control that was just tapped unmounts, so the swap must not
  // drop focus onto the page body — it lands on whichever control replaced it.
  it("moves focus to the Back control after the swap, and back to Terminal after Back", async () => {
    const user = userEvent.setup();
    render(
      <PromptPanel ariaLabel="Choose a colour" raw={RAW_LINES}>
        <button type="button">Red</button>
      </PromptPanel>,
    );

    await user.click(screen.getByRole("button", { name: "Show the terminal instead of this card" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Back to the card" }));

    await user.click(screen.getByRole("button", { name: "Back to the card" }));
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Show the terminal instead of this card" }),
    );
  });

  // Counsel fix #1 (ADR 0056): `rawMode="declutter"` is for the two cards whose mirror is already
  // visible by default — the control only puts their own buttons away, so it must not claim a
  // swap ("Show the terminal instead of this card") that isn't happening.
  it("names the control by what it does when rawMode is declutter", async () => {
    const user = userEvent.setup();
    render(
      <PromptPanel ariaLabel="Choose a colour" raw={RAW_LINES} rawMode="declutter">
        <button type="button">Red</button>
      </PromptPanel>,
    );

    const putAway = screen.getByRole("button", {
      name: "Hide this card's buttons, keep the terminal",
    });
    expect(putAway).toHaveTextContent("Put away");
    expect(screen.queryByRole("button", { name: /show the terminal instead/i })).toBeNull();

    await user.click(putAway);
    expect(screen.getByRole("button", { name: "Show the buttons" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back to the card" })).toBeNull();
  });
});
