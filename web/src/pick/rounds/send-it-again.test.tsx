import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { Segmented } from "@/playground/layout";
import { __forgetSendAgainMemory } from "@/lib/send-again";
import { __forgetSendIntentMemory } from "@/lib/send-intent";
import ROUND, { CAPTION, FRAME_HEIGHT, KEYBOARD_HEIGHT } from "./send-it-again";

// The round for "Send it again?", drawn the way the design app's round page draws it: one option, ONE Case
// switch, the real composer with a fake bridge behind it.

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => {
  sessionStorage.clear();
  __forgetSendAgainMemory();
  __forgetSendIntentMemory();
});
afterEach(() => cleanup());

const SLOW = { timeout: 12_000 } as const;
/** A case plays its taps one every 700 ms, so a test waits for them. */
const TEST_MS = 20_000;
const useCase = (name: string) => fireEvent.click(within(screen.getByRole("group", { name: "Case" })).getByRole("button", { name }));
const frame = () => document.querySelector<HTMLElement>("[data-option]")!;

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

describe("the Send it again? round", () => {
  it("declares one option, n 1, with a state and the three cases", () => {
    expect(ROUND.options.map((o) => [o.n, o.label, o.state])).toEqual([[1, "Send it again?", "send-it-again"]]);
    expect(ROUND.cases.map((c) => c.label)).toEqual(["Unknown", "Asking", "Sent"]);
    render(<Round />);
    expect(frame().querySelector('[data-state="send-it-again"]')).not.toBeNull();
    expect(screen.getAllByRole("group", { name: "Case" })).toHaveLength(1);
  });

  it("fills the design app's frame: frameHeight 560, no fixed stage height, a 220 px keyboard at the bottom, three short labels", async () => {
    expect(FRAME_HEIGHT).toBe(560);
    expect(ROUND.frameHeight).toBe(560);
    expect(KEYBOARD_HEIGHT).toBe(220);
    expect(CAPTION).toBe("The question stays 3 seconds. Tap Send to see it again.");
    expect(ROUND.cases.map((c) => c.id)).toEqual(["unknown", "asking", "confirmed"]);
    render(<Round />);
    const stage = frame().querySelector<HTMLElement>('[data-slot="send-it-again-stage"]')!;
    // No fixed px height (the old 388): the stage is a flex column that takes what the frame gives.
    expect(stage.style.height).toBe("");
    expect(stage.className).toContain("flex-1");
    expect(stage.className).toContain("min-h-0");
    expect(within(stage).getByText(CAPTION)).toBeInTheDocument();
    // jsdom lays nothing out; the order is what it can show: the composer's Send, then the keyboard last in the stage.
    const send = await within(stage).findByRole("button", { name: "Send" }, SLOW);
    expect(stage.contains(send)).toBe(true);
    // SAFETY: the stage's last child is the keyboard stand-in, a <div>; the next line checks it by its marks.
    const keyboard = stage.lastElementChild as HTMLElement;
    expect(keyboard.getAttribute("aria-hidden")).toBe("true");
    expect(keyboard.textContent).toBe("keyboard");
    expect(keyboard.style.height).toBe("220px");
  }, TEST_MS);

  it("After unknown: a tap of your own on Send asks, and the next tap sends as sent", async () => {
    render(<Round />);
    await waitFor(() => expect(within(frame()).getByText(/cannot tell if this was sent/i)).toBeInTheDocument(), SLOW);
    const box = within(frame()).getByRole<HTMLTextAreaElement>("textbox");
    const send = await within(frame()).findByRole("button", { name: "Send" });
    await waitFor(() => expect(send).toBeEnabled(), SLOW);
    fireEvent.click(send);
    fireEvent.click(await within(frame()).findByRole("button", { name: "Send it again?" }, SLOW));
    await waitFor(() => expect(box.value).toBe(""), SLOW);
  }, TEST_MS);

  it("After unknown: the real composer keeps the text and says it cannot tell", async () => {
    render(<Round />);
    await waitFor(() => expect(within(frame()).getByText(/cannot tell if this was sent/i)).toBeInTheDocument(), SLOW);
    expect(within(frame()).getByRole<HTMLTextAreaElement>("textbox").value).toContain("Run the full test suite");
    expect(within(frame()).queryByRole("button", { name: "Send it again?" })).toBeNull();
  }, TEST_MS);

  it("Asking: the Send slot reads Send it again?", async () => {
    render(<Round />);
    useCase("Asking");
    expect(await within(frame()).findByRole("button", { name: "Send it again?" }, SLOW)).toBeInTheDocument();
  }, TEST_MS);

  it("Asking holds its state: the question runs out after its 3 seconds and the case asks again", async () => {
    render(<Round />);
    useCase("Asking");
    await within(frame()).findByRole("button", { name: "Send it again?" }, SLOW);
    await waitFor(() => expect(within(frame()).queryByRole("button", { name: "Send it again?" })).toBeNull(), SLOW);
    expect(await within(frame()).findByRole("button", { name: "Send it again?" }, SLOW)).toBeInTheDocument();
    // The case never sent: the text is still in the box.
    expect(within(frame()).getByRole<HTMLTextAreaElement>("textbox").value).toContain("Run the full test suite");
  }, TEST_MS);

  it("After the confirm: the text went, the box is empty and the question is gone", async () => {
    render(<Round />);
    useCase("Sent");
    await waitFor(() => expect(within(frame()).getByRole<HTMLTextAreaElement>("textbox").value).toBe(""), SLOW);
    expect(within(frame()).queryByRole("button", { name: "Send it again?" })).toBeNull();
  }, TEST_MS);
});
