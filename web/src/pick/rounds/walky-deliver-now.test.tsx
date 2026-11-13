import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { PickPage } from "../pick-page";
import round from "./walky-deliver-now";

// The round for Deliver now, on the pick page: the picked design, one frame, ONE Case switch, the real sheet, mark and note.

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const SLOW = { timeout: 12_000 } as const;
const DRAFT = "Also check the retry in sync.ts, and whether the empty list reaches the loader";
const useCase = (name: string) => fireEvent.click(within(screen.getByRole("group", { name: "Case" })).getByRole("button", { name }));
const frame = () => document.querySelector<HTMLElement>("[data-option]")!;
const draft = () => within(frame()).getByRole<HTMLTextAreaElement>("textbox", { name: "Your message" });
const mark = () => within(frame()).queryByRole("button", { name: /^\d+ messages? (waits?|wait)/ });

function mount(caseName?: string) {
  window.history.replaceState(null, "", "/pick.html?round=walky-deliver-now");
  render(<PickPage {...round} />);
  if (caseName !== undefined) useCase(caseName);
}

describe("the Deliver now round", () => {
  it("has one frame, one Case switch with the ten cases, and the person's text in a box", () => {
    mount();
    expect(document.querySelectorAll("[data-option]")).toHaveLength(1);
    expect(screen.getAllByRole("group", { name: "Case" })).toHaveLength(1);
    const names = within(screen.getByRole("group", { name: "Case" })).getAllByRole("button").map((b) => b.textContent);
    expect(names).toEqual(["Just arrived", "After 20 s", "Delivering", "Delivered", "Failed", "Three waiting", "Busy agent", "Not linked", "Long names, 360 px", "Keyboard up"]);
    expect(draft().value).toBe(DRAFT);
  });

  it("draws no mark for a message that just arrived, and the mark comes by itself at the grace", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    mount();
    expect(mark()).toBeNull();
    act(() => vi.advanceTimersByTime(19_990));
    expect(mark()).toBeNull();
    act(() => vi.advanceTimersByTime(20));
    expect(within(frame()).getByRole("button", { name: "1 message waits while you type" })).toBeInTheDocument();
  });

  it("shows the mark with Deliver now and the line that the text stays, after 20 s", () => {
    mount("After 20 s");
    expect(within(frame()).getByRole("button", { name: "1 message waits while you type" })).toBeInTheDocument();
    expect(within(frame()).getByRole("button", { name: "Deliver now" })).toBeInTheDocument();
    expect(within(frame()).getByText("Your text stays in the box.")).toBeInTheDocument();
  });

  it("delivers on the tap: disabled while it runs, the note above the box, the text unchanged", async () => {
    mount("After 20 s");
    fireEvent.change(draft(), { target: { value: `${DRAFT} and more` } });
    fireEvent.click(within(frame()).getByRole("button", { name: "Deliver now" }));
    expect(within(frame()).getByRole("button", { name: "Deliver now" })).toBeDisabled();
    expect(await within(frame()).findByText("Message delivered. Your text stays here.", {}, SLOW)).toBeInTheDocument();
    expect(draft().value).toBe(`${DRAFT} and more`);
    await waitFor(() => expect(within(frame()).queryByRole("button", { name: "Deliver now" })).toBeNull(), SLOW);
  });

  it("plays the taps in Delivering, Delivered and Failed", async () => {
    mount("Delivering");
    await waitFor(() => expect(within(frame()).getByRole("button", { name: "Deliver now" })).toHaveAttribute("aria-busy", "true"), SLOW);
    useCase("Delivered");
    expect(await within(frame()).findByText("Message delivered. Your text stays here.", {}, SLOW)).toBeInTheDocument();
    expect(draft().value).toBe(DRAFT);
    useCase("Failed");
    expect(await within(frame()).findByText("Not delivered. The message still waits and your text is unchanged. The agent did not take it.", {}, SLOW)).toBeInTheDocument();
    expect(draft().value).toBe(DRAFT);
    expect(within(frame()).queryByText("Message delivered. Your text stays here.")).toBeNull();
  }, 30_000);

  it("counts three waiting with no button, and words a busy agent with no Deliver now", () => {
    mount("Three waiting");
    expect(within(frame()).getByRole("button", { name: "3 messages wait while you type" })).toBeInTheDocument();
    expect(within(frame()).queryByRole("button", { name: "Deliver now" })).toBeNull();
    useCase("Busy agent");
    expect(within(frame()).getByRole("button", { name: "1 message waits for the agent to finish" })).toBeInTheDocument();
    expect(within(frame()).queryByRole("button", { name: "Deliver now" })).toBeNull();
  });

  it("not linked: the mark, no Deliver now anywhere, and the sheet lists the message at once without the action", () => {
    mount("Not linked");
    expect(within(frame()).getByRole("button", { name: "1 message waits while you type" })).toBeInTheDocument();
    expect(frame().querySelector('[data-slot="walky-deliver"]')).toBeNull();
    fireEvent.click(within(frame()).getByRole("button", { name: "1 message waits while you type" }));
    expect(within(frame()).getByText("Waiting, because you have unsent text")).toBeInTheDocument();
    expect(within(frame()).getByRole("button", { name: /^Drop the message/ })).toBeInTheDocument();
  });
});
