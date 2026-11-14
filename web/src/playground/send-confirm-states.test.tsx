import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { __forgetSendAgainMemory } from "@/lib/send-again";
import { __forgetSendIntentMemory } from "@/lib/send-intent";
import { SendConfirmPhone } from "./composer-states";

// The reference's two send-question cards (composer-states 24 and 25): the real composer with a fake bridge,
// the question armed for you and held on screen past the product's own 3 seconds.

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
const TEST_MS = 25_000;
const COVER = '[data-slot="composer-confirm-cover"]';

describe.each([
  ["really", "Really send?"],
  ["again", "Send it again?"],
] as const)("the %s card", (kind, word) => {
  it(`shows ${word} armed with the fade cover, holds it past the 3 seconds, and keeps the text unsent`, async () => {
    const { container } = render(<SendConfirmPhone kind={kind} />);
    await screen.findByRole("button", { name: word }, SLOW);
    expect(container.querySelector(COVER)).not.toBeNull();
    // The product's question runs out after 3 seconds; the card taps again, so it comes back.
    // The word and the cover go together (read in one callback: the card re-arms within a tenth of a second).
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: word })).toBeNull();
      expect(container.querySelector(COVER)).toBeNull();
    }, SLOW);
    await screen.findByRole("button", { name: word }, SLOW);
    expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).not.toBe("");
  }, TEST_MS);

  it(`a tap of your own on ${word} sends, and the card stops arming`, async () => {
    const { container } = render(<SendConfirmPhone kind={kind} />);
    const button = await screen.findByRole("button", { name: word }, SLOW);
    // "Send it again?" counts a tap only after 700 ms; a person reads it first.
    await new Promise((resolve) => setTimeout(resolve, 750));
    button.click();
    await waitFor(() => expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe(""), SLOW);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(screen.queryByRole("button", { name: word })).toBeNull();
    expect(container.querySelector(COVER)).toBeNull();
  }, TEST_MS);
});
