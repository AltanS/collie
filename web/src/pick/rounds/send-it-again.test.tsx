import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { Segmented } from "@/playground/layout";
import { __forgetSendAgainMemory } from "@/lib/send-again";
import { __forgetSendIntentMemory } from "@/lib/send-intent";
import ROUND from "./send-it-again";

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

  it("After the confirm: the text went, the box is empty and the question is gone", async () => {
    render(<Round />);
    useCase("After the confirm");
    await waitFor(() => expect(within(frame()).getByRole<HTMLTextAreaElement>("textbox").value).toBe(""), SLOW);
    expect(within(frame()).queryByRole("button", { name: "Send it again?" })).toBeNull();
  }, TEST_MS);
});
