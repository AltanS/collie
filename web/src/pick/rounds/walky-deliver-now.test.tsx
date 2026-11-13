import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { PickPage } from "../pick-page";
import round from "./walky-deliver-now";

// The round for Deliver now, on the pick page: three numbered options, ONE Case switch, the real sheet, mark and note.

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
afterEach(() => cleanup());

const SLOW = { timeout: 12_000 } as const;
const DRAFT = "Also check the retry in sync.ts, and whether the empty list reaches the loader";
const option = (container: HTMLElement, n: number) => container.querySelector<HTMLElement>(`[data-option="${n}"]`)!;
const useCase = (name: string) => fireEvent.click(within(screen.getByRole("group", { name: "Case" })).getByRole("button", { name }));
const rowOf = (el: HTMLElement) => el.querySelector<HTMLElement>('[data-slot="walky-list-row"]')!;
const draftOf = (el: HTMLElement) => within(el).getByRole<HTMLTextAreaElement>("textbox", { name: "Your message" });

async function mount(caseName?: string) {
  window.history.replaceState(null, "", "/pick.html?round=walky-deliver-now");
  const view = render(<PickPage {...round} />);
  await waitFor(() => expect(option(view.container, 3)).not.toBeNull(), SLOW);
  if (caseName !== undefined) useCase(caseName);
  return view;
}

describe("the Deliver now round", () => {
  it("has three options and one Case switch, and every frame holds the person's text in a box", async () => {
    const { container } = await mount();
    expect([...container.querySelectorAll("[data-option]")].map((el) => el.getAttribute("data-option"))).toEqual(["1", "2", "3"]);
    expect(screen.getAllByRole("group", { name: "Case" })).toHaveLength(1);
    for (const n of [1, 2, 3]) expect(draftOf(option(container, n)).value).toBe(DRAFT);
  });

  it("says before the tap what happens: the row's line under the buttons, the question, the mark's second line", async () => {
    const { container } = await mount();
    const one = option(container, 1);
    expect(within(rowOf(one)).getByText("Waiting, because you have unsent text")).toBeInTheDocument();
    expect(within(rowOf(one)).getByText("The agent gets it now and starts on it. Your text stays in the box.")).toBeInTheDocument();
    const two = option(container, 2);
    expect(within(two).queryByText(/^The agent gets it now/)).toBeNull();
    fireEvent.click(within(rowOf(two)).getByRole("button", { name: /^Deliver the message from/ }));
    expect(await within(two).findByText("Send this to the agent now? It starts on it. Your text stays in the box.")).toBeInTheDocument();
    const three = option(container, 3);
    expect(within(three).getByRole("button", { name: "1 message waits while you type" })).toBeInTheDocument();
    expect(within(three).getByRole("button", { name: "Deliver now" })).toBeInTheDocument();
    expect(within(three).getByText("Your text stays in the box.")).toBeInTheDocument();
  });

  it("delivers on the tap: the row says delivered, the note stands above the box, and the text is unchanged", async () => {
    const { container } = await mount();
    const three = option(container, 3);
    fireEvent.change(draftOf(three), { target: { value: `${DRAFT} and more` } });
    fireEvent.click(within(three).getByRole("button", { name: "Deliver now" }));
    expect(within(three).getByRole("button", { name: "Deliver now" })).toBeDisabled();
    expect(await within(three).findByText("Message delivered. Your text stays here.", {}, SLOW)).toBeInTheDocument();
    expect(draftOf(three).value).toBe(`${DRAFT} and more`);
    // The mark folds away with the hold.
    await waitFor(() => expect(within(three).queryByRole("button", { name: "Deliver now" })).toBeNull(), SLOW);
  });

  it("plays the taps in the cases Delivering, Delivered and Failed, in every option", async () => {
    const { container } = await mount("Delivering");
    for (const n of [1, 2, 3]) {
      await waitFor(() => expect(within(option(container, n)).getAllByRole("button", { name: /^Deliver / }).some((b) => b.getAttribute("aria-busy") === "true")).toBe(true), SLOW);
    }
    useCase("Delivered");
    for (const n of [1, 2, 3]) {
      await waitFor(() => expect(within(option(container, n)).getByText("Message delivered. Your text stays here.")).toBeInTheDocument(), SLOW);
      expect(draftOf(option(container, n)).value).toBe(DRAFT);
    }
    expect(await within(rowOf(option(container, 1))).findByText("Delivered. Your text is still in the box.")).toBeInTheDocument();
    expect(within(rowOf(option(container, 1))).queryByText(/typed into the pane/)).toBeNull();
    useCase("Failed");
    for (const n of [1, 2, 3]) {
      await waitFor(
        () => expect(within(option(container, n)).getByText("Not delivered. The message still waits and your text is unchanged. The agent did not take it.")).toBeInTheDocument(),
        SLOW,
      );
      expect(draftOf(option(container, n)).value).toBe(DRAFT);
      expect(within(option(container, n)).queryByText("Message delivered. Your text stays here.")).toBeNull();
    }
    expect(within(rowOf(option(container, 1))).getByText("Waiting, because you have unsent text")).toBeInTheDocument();
  }, 40_000);

  it("with three waiting the mark opens the sheet and carries no button", async () => {
    const { container } = await mount("Three waiting");
    expect(within(option(container, 3)).getByRole("button", { name: "3 messages wait while you type" })).toBeInTheDocument();
    expect(within(option(container, 3)).queryByRole("button", { name: "Deliver now" })).toBeNull();
  });

  it("not linked shows today's actions with the rewritten words, and no Deliver now anywhere", async () => {
    const { container } = await mount("Not linked");
    for (const n of [1, 2, 3]) expect(container.querySelector(`[data-option="${n}"] [data-slot="walky-deliver"]`)).toBeNull();
    expect(within(rowOf(option(container, 1))).getByText("Waiting, because you have unsent text")).toBeInTheDocument();
    expect(within(option(container, 3)).getByRole("button", { name: "1 message waits while you type" })).toBeInTheDocument();
    expect(draftOf(option(container, 3)).value).toBe(DRAFT);
  });
});
