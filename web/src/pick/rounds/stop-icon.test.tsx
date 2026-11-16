import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { Segmented } from "@/playground/layout";
import ROUND from "./stop-icon";

// The stop icon's round, drawn the way the design app's round page draws it: four numbered options, ONE Case switch, the real belt.

afterEach(cleanup);

const option = (n: number) => document.querySelector<HTMLElement>(`[data-option="${String(n)}"]`)!;
const useCase = (name: string) => screen.getByRole("group", { name: "Case" }).querySelectorAll("button").forEach((b) => b.textContent === name && b.click());
/** The glyph of the Stop pill of an option: the visible svg, not the hidden original. */
const stopGlyph = (el: HTMLElement) => {
  const pill = el.querySelector<HTMLElement>('[data-slot="belt-stop"]')!;
  return [...pill.querySelectorAll<SVGElement>("svg")].filter((svg) => svg.style.display !== "none");
};

function Round() {
  const [caseId, setCaseId] = useState(ROUND.cases[0]!.id);
  return (
    <>
      <Segmented name="Case" value={caseId} options={ROUND.cases.map((c) => ({ value: c.id, label: c.label }))} onChange={setCaseId} />
      {ROUND.options.map((o) => (
        <section key={o.n} data-option={o.n}>
          <div key={caseId}>{o.render(caseId)}</div>
        </section>
      ))}
    </>
  );
}

describe("the stop icon's round", () => {
  it("has four options under one Case switch", () => {
    render(<Round />);
    expect([...document.querySelectorAll("[data-option]")].map((el) => el.getAttribute("data-option"))).toEqual(["1", "2", "3", "4"]);
    expect(screen.getAllByRole("group", { name: "Case" })).toHaveLength(1);
  });

  it("draws the real Stop pill with a different glyph in each option, and nothing else changes", async () => {
    render(<Round />);
    const classes = ["lucide-circle-stop", "lucide-octagon-x", "lucide-hand"];
    await waitFor(() => expect(stopGlyph(option(1))).toHaveLength(1));
    expect(stopGlyph(option(1))[0]!.getAttribute("data-icon")).toBe("stop");
    expect(stopGlyph(option(1))[0]!.getAttribute("class")).toContain("fill-current");
    for (const [i, name] of classes.entries()) {
      await waitFor(() => expect(stopGlyph(option(i + 2))).toHaveLength(1));
      expect(stopGlyph(option(i + 2))[0]!.getAttribute("class")).toContain(name);
    }
    for (const n of [1, 2, 3, 4]) expect(within(option(n)).getByRole("button", { name: /stop/i })).not.toHaveAttribute("aria-disabled");
  });

  it("dims the pill in the no-turn case", async () => {
    render(<Round />);
    useCase("No turn");
    await waitFor(() => expect(option(2).querySelector('[data-slot="belt-stop"]')).toHaveAttribute("aria-disabled", "true"));
    await waitFor(() => expect(stopGlyph(option(2))).toHaveLength(1));
  });

  it("swaps the program belt's Stop and the recording mic in the third case", async () => {
    render(<Round />);
    useCase("Other places");
    await waitFor(() => expect(option(4).querySelectorAll("svg.lucide-hand")).toHaveLength(2));
    expect(option(3).querySelectorAll("svg.lucide-octagon-x")).toHaveLength(2);
    expect(option(2).querySelectorAll("svg.lucide-circle-stop")).toHaveLength(2);
    expect(option(4).querySelector('[data-slot="composer-mic-expanded"] svg.lucide-hand')).not.toBeNull();
  });
});
