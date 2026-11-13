import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { PickPage } from "../pick-page";
import round from "./walky-deliver-now";

// The round for Deliver now (prototype), on the pick page: three numbered options, ONE Case switch, the real sheet and mark.

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
afterEach(() => cleanup());

const SLOW = { timeout: 12_000 } as const;
const option = (container: HTMLElement, n: number) => container.querySelector<HTMLElement>(`[data-option="${n}"]`)!;
const useCase = (name: string) => fireEvent.click(within(screen.getByRole("group", { name: "Case" })).getByRole("button", { name }));

async function mount() {
  window.history.replaceState(null, "", "/pick.html?round=walky-deliver-now");
  const view = render(<PickPage {...round} />);
  await waitFor(() => expect(option(view.container, 3)).not.toBeNull(), SLOW);
  return view;
}

describe("the Deliver now round", () => {
  it("has three options, each a number and a title of at most five words, and one Case switch", async () => {
    const { container } = await mount();
    expect([...container.querySelectorAll("[data-option]")].map((el) => el.getAttribute("data-option"))).toEqual(["1", "2", "3"]);
    expect(screen.getAllByRole("group", { name: "Case" })).toHaveLength(1);
  });

  it("offers Deliver now on the row of options 1 and 3, and on the mark of option 2; the row's turns the message delivered", async () => {
    const { container } = await mount();
    expect(within(option(container, 1)).getAllByRole("button", { name: /^Deliver the message from/ })).toHaveLength(1);
    expect(within(option(container, 3)).getAllByRole("button", { name: /^Deliver the message from/ })).toHaveLength(1);
    expect(within(option(container, 2)).getByRole("button", { name: "Deliver now" })).toBeInTheDocument();
    fireEvent.click(within(option(container, 1)).getByRole("button", { name: /^Deliver the message from/ }));
    await waitFor(() => expect(option(container, 1)).toHaveTextContent("typed into the pane"), SLOW);
    expect(within(option(container, 1)).queryByRole("button", { name: /^Deliver the message from/ })).toBeNull();
    // The draft stays.
    expect(option(container, 1).querySelector('[data-slot="pg-draft"]')).not.toBeNull();
  });

  it("with three held the mark opens the sheet and carries no button; a session that is not linked shows none anywhere", async () => {
    const { container } = await mount();
    useCase("Three held");
    await waitFor(() => expect(within(option(container, 2)).getByRole("button", { name: "3 messages wait for the box to clear" })).toBeInTheDocument(), SLOW);
    expect(within(option(container, 2)).queryByRole("button", { name: "Deliver now" })).toBeNull();
    useCase("Not linked");
    await waitFor(() => expect(within(option(container, 2)).getByRole("button", { name: "1 message waits for the box to clear" })).toBeInTheDocument(), SLOW);
    for (const n of [1, 2, 3]) expect(container.querySelector(`[data-option="${n}"] [data-slot="walky-deliver"]`)).toBeNull();
  });

  it("answers a refusal with a line, in the case that fails", async () => {
    const { container } = await mount();
    useCase("Fails");
    await waitFor(() => expect(within(option(container, 2)).getByRole("button", { name: "Deliver now" })).toBeInTheDocument(), SLOW);
    fireEvent.click(within(option(container, 2)).getByRole("button", { name: "Deliver now" }));
    expect(await within(option(container, 2)).findByText("Not delivered: The session did not take it.", {}, SLOW)).toBeInTheDocument();
  });
});
