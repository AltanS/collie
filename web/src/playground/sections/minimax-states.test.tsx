import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { findEntries } from "../find";
import { ENTRIES } from "../registry";
import { ActionsRowSection } from "./actions-row";
import { MiniMaxChips } from "./add-your-own";

// MiniMax Code in the design reference (cards 74 to 76): the real belt, mark and recipe chips with `mcode` data.

afterEach(cleanup);

describe("the MiniMax Code cards", () => {
  it("draws card 74, the belt's harness section with Plan, Compact, History and Resume and the mark", () => {
    const { container } = render(<ActionsRowSection />);
    const card = container.querySelector<HTMLElement>('[data-state="roomy-mcode"]')!;
    const bar = card.querySelector<HTMLElement>('[data-slot="harness-bar"]')!;
    expect(within(bar).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Plan", "Compact", "History", "Resume"]);
    expect(within(bar).getByRole("img", { hidden: true, name: "mcode logo" })).toBeInTheDocument();
  });

  it("draws card 75, the mark at three sizes", () => {
    const { container } = render(<ActionsRowSection />);
    const card = container.querySelector<HTMLElement>('[data-state="mark-mcode"]')!;
    expect(within(card).getAllByRole("img", { hidden: true, name: "mcode logo" })).toHaveLength(3);
  });

  it("draws card 76, the four start chips, and a tap on a mode replaces the other mode", () => {
    render(<MiniMaxChips />);
    const chips = within(screen.getByRole("group", { name: "Options" }));
    expect(chips.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Continue last",
      "Programmatic Tool Calling",
      "Mode: lightweight",
      "Mode: standard",
    ]);
    fireEvent.click(chips.getByRole("button", { name: "Mode: lightweight" }));
    fireEvent.click(chips.getByRole("button", { name: "Mode: standard" }));
    expect(chips.getByRole("button", { name: "Mode: lightweight" })).toHaveAttribute("aria-pressed", "false");
    expect(chips.getByRole("button", { name: "Mode: standard" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("launcher-add-line")).toHaveTextContent("mcode --mode standard");
  });

  it("finds the states by MiniMax, mcode and harness bar", () => {
    const ids = (query: string) => findEntries(ENTRIES.map((e) => e.def), query).map((d) => d.id);
    expect(ids("MiniMax")).toEqual(["actions-row", "add-your-own"]);
    expect(ids("mcode")).toEqual(["actions-row", "add-your-own"]);
    expect(ids("harness bar")).toEqual(["actions-row"]);
  });
});
