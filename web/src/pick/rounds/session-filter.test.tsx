import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { Segmented } from "@/playground/layout";
import ROUND from "./session-filter";

// The round for the look (M97 spec 05), drawn the way the design app's round page draws it: eight numbered options, ONE Case switch, the
// real components. Moved from the design reference's "Session filter" entry with its cases.

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => window.history.replaceState(null, "", "/"));
afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

const SLOW = { timeout: 12_000 } as const;

const option = (n: number) => document.querySelector<HTMLElement>(`[data-option="${String(n)}"]`)!;
const field = (el: HTMLElement) => within(el).queryByRole("textbox", { name: "Filter sessions" });
const rows = (el: HTMLElement) => el.querySelectorAll("button[data-pane-key], button[id^='pane-row-']").length;
const useCase = (name: string) => fireEvent.click(within(screen.getByRole("group", { name: "Case" })).getByRole("button", { name }));

/** The least of a round page: one Case switch over every option, as the design app draws it. */
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

function mount() {
  return render(<Round />);
}

describe("the session filter's round", () => {
  it("has the eight options of the table under one Case switch", () => {
    mount();
    expect([...document.querySelectorAll("[data-option]")].map((el) => el.getAttribute("data-option"))).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
    expect(screen.getAllByRole("group", { name: "Case" })).toHaveLength(1);
  });

  it("types the case's query into every option", async () => {
    mount();
    const every = (value: string) =>
      waitFor(() => {
        for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) expect(field(option(n))).toHaveValue(value);
      }, SLOW);
    await every("cw");
    useCase("fix 7");
    await every("fix 7");
  });

  it("draws the Dashboard's two entries: a magnifier that opens the field, and a field that always stands", async () => {
    mount();
    useCase("none");
    await waitFor(() => expect(within(option(7)).queryByRole("button", { name: "Filter sessions" })).not.toBeNull(), SLOW);
    expect(field(option(7))).toBeNull();
    await waitFor(() => expect(field(option(8))).not.toBeNull(), SLOW);
    expect(within(option(8)).queryByRole("button", { name: "Filter sessions" })).toBeNull();
    useCase("cw");
    await waitFor(() => expect(field(option(7))).toHaveValue("cw"), SLOW);
    expect(within(option(7)).getByRole("button", { name: "Filter sessions" })).toHaveAttribute("aria-pressed", "true");
  });

  it("changes one switch per option: best first is one flat list, drawn only does not search the machine", async () => {
    mount();
    useCase("workshop");
    await waitFor(() => expect(field(option(5))).toHaveValue("workshop"), SLOW);
    expect(rows(option(5))).toBeGreaterThan(0);
    expect(rows(option(6))).toBe(0);
    useCase("cw");
    await waitFor(() => expect(field(option(4))).toHaveValue("cw"), SLOW);
    expect(within(option(4)).queryAllByRole("heading", { level: 3 })).toHaveLength(0);
    expect(within(option(3)).queryAllByRole("heading", { level: 3 }).length).toBeGreaterThan(0);
  });
});
