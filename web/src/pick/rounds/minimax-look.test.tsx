import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { wordCount } from "../types";
import ROUND from "./minimax-look";

// The MiniMax Code round, drawn the way the design app's round page draws it: one numbered option, the
// real belt, mark and recipe chips with `mcode` data.

afterEach(cleanup);

describe("the MiniMax Code round", () => {
  it("has one option of at most five words, with a state, and light and dark cases", () => {
    expect(ROUND.options.map((o) => o.n)).toEqual([1]);
    expect(wordCount(ROUND.options[0]!.label)).toBeLessThanOrEqual(5);
    expect(ROUND.cases.map((c) => c.id)).toEqual(["light", "dark", "light-360"]);
    const { container } = render(<>{ROUND.options[0]!.render("light")}</>);
    expect(container.querySelector(`[data-state="${ROUND.options[0]!.state!}"]`)).not.toBeNull();
  });

  it("draws the belt's harness section with Plan, Compact, History and Resume and the mark", () => {
    const { container } = render(<>{ROUND.options[0]!.render("light")}</>);
    const bar = container.querySelector<HTMLElement>('[data-slot="harness-bar"]')!;
    expect(bar).not.toBeNull();
    expect(within(bar).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Plan", "Compact", "History", "Resume"]);
    expect(within(bar).getByRole("img", { hidden: true, name: "mcode logo" })).toBeInTheDocument();
  });

  it("draws the four start chips, and a tap on a mode replaces the other mode", () => {
    render(<>{ROUND.options[0]!.render("dark")}</>);
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

  it("puts the dark class on the stage in the dark case only", () => {
    const light = render(<>{ROUND.options[0]!.render("light")}</>);
    expect(light.container.querySelector(".dark")).toBeNull();
    light.unmount();
    const dark = render(<>{ROUND.options[0]!.render("dark")}</>);
    expect(dark.container.querySelector(".dark")).not.toBeNull();
  });
});
