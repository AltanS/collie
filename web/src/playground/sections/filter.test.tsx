import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";

import { PlaygroundApp } from "../app";

// The round for the look (M97 spec 05): eight numbered options, ONE Case switch, the real components.

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});

const SLOW = { timeout: 12_000 } as const;

const option = (container: HTMLElement, n: number) => container.querySelector<HTMLElement>(`[data-state="filter-option-${n}"]`)!;
const field = (el: HTMLElement) => within(el).queryByRole("textbox", { name: "Filter sessions" });
const rows = (el: HTMLElement) => el.querySelectorAll("button[data-pane-key], button[id^='pane-row-']").length;
const useCase = (name: string) => fireEvent.click(within(screen.getByRole("group", { name: "Case" })).getByRole("button", { name }));

async function mount() {
  const view = render(<PlaygroundApp tab="filter" />);
  await waitFor(() => expect(option(view.container, 8)).not.toBeNull(), SLOW);
  return view;
}

describe("the session filter's round", () => {
  it("has the eight options of the table, each a number and a title of at most five words", async () => {
    const { container } = await mount();
    const handles = [...container.querySelectorAll(".pg-grid > *")].map((el) => el.getAttribute("data-state"));
    expect(handles).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map((n) => `filter-option-${n}`));
    for (let n = 1; n <= 8; n++) {
      const head = option(container, n).firstElementChild!;
      expect(head.firstElementChild!.textContent).toBe(String(n));
      const title = head.lastElementChild!.textContent!;
      expect(title.split(/\s+/u).length).toBeLessThanOrEqual(5);
    }
    cleanup();
  });

  it("has one Case switch, and it types the query into every option", async () => {
    const { container } = await mount();
    expect(screen.getAllByRole("group", { name: "Case" })).toHaveLength(1);
    const every = (value: string) =>
      waitFor(() => {
        for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) expect(field(option(container, n))).toHaveValue(value);
      }, SLOW);
    await every("cw");
    useCase("fix 7");
    await every("fix 7");
    cleanup();
  });

  it("draws the Dashboard's two entries: a magnifier that opens the field, and a field that always stands", async () => {
    const { container } = await mount();
    useCase("none");
    // The router remounts on a new case, so wait for the option to be drawn again before reading it.
    await waitFor(() => expect(within(option(container, 7)).queryByRole("button", { name: "Filter sessions" })).not.toBeNull(), SLOW);
    expect(field(option(container, 7))).toBeNull();
    await waitFor(() => expect(field(option(container, 8))).not.toBeNull(), SLOW);
    expect(within(option(container, 8)).queryByRole("button", { name: "Filter sessions" })).toBeNull();
    expect(field(option(container, 8))).not.toBeNull();
    useCase("cw");
    await waitFor(() => expect(field(option(container, 7))).toHaveValue("cw"), SLOW);
    expect(within(option(container, 7)).getByRole("button", { name: "Filter sessions" })).toHaveAttribute("aria-pressed", "true");
    cleanup();
  });

  it("changes one switch per option: best first is one flat list, drawn only does not search the machine", async () => {
    const { container } = await mount();
    useCase("workshop");
    await waitFor(() => expect(field(option(container, 5))).toHaveValue("workshop"), SLOW);
    // The machine is a field no switcher row draws: option 5 finds its rows, option 6 searches only what is drawn.
    expect(rows(option(container, 5))).toBeGreaterThan(0);
    expect(rows(option(container, 6))).toBe(0);
    useCase("cw");
    await waitFor(() => expect(field(option(container, 4))).toHaveValue("cw"), SLOW);
    expect(within(option(container, 4)).queryAllByRole("heading", { level: 3 })).toHaveLength(0);
    expect(within(option(container, 3)).queryAllByRole("heading", { level: 3 }).length).toBeGreaterThan(0);
    cleanup();
  });
});
