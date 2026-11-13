import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { Segmented } from "@/playground/layout";
import { __forgetSendAgainMemory } from "@/lib/send-again";
import { __forgetSendIntentMemory } from "@/lib/send-intent";
import ROUND, { CAPTION, FRAME_HEIGHT, STAGE_HEIGHT } from "./send-it-again";

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
    expect(ROUND.cases.map((c) => c.label)).toEqual(["After unknown", "Asking", "After the confirm"]);
    render(<Round />);
    expect(frame().querySelector('[data-state="send-it-again"]')).not.toBeNull();
    expect(screen.getAllByRole("group", { name: "Case" })).toHaveLength(1);
  });

  it("fits a frame 400 high: a stage of at most 400, the caption on one line of words, the send button inside it", async () => {
    expect(FRAME_HEIGHT).toBe(400);
    expect(ROUND.frameHeight).toBe(400);
    expect(STAGE_HEIGHT).toBeLessThanOrEqual(400);
    expect(CAPTION).toBe("The question stays 3 seconds. Tap Send to see it again.");
    render(<Round />);
    const stage = frame().querySelector<HTMLElement>('[data-slot="send-it-again-stage"]')!;
    expect(Number.parseInt(stage.style.height, 10)).toBe(STAGE_HEIGHT);
    expect(within(stage).getByText(CAPTION)).toBeInTheDocument();
    // jsdom lays nothing out, so "the bottom edge lies inside the stage" is checked in a browser (the worker's
    // report); here the send button is a child of the stage and the stage clips: it holds no more than its height.
    const send = await within(stage).findByRole("button", { name: "Send" }, SLOW);
    expect(stage.contains(send)).toBe(true);
    expect(stage.className).toContain("overflow-hidden");
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
    useCase("After the confirm");
    await waitFor(() => expect(within(frame()).getByRole<HTMLTextAreaElement>("textbox").value).toBe(""), SLOW);
    expect(within(frame()).queryByRole("button", { name: "Send it again?" })).toBeNull();
  }, TEST_MS);
});
