import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { FontSettingsControl } from "./font-settings";

// The Terminal font card now configures TWO sizes — the mirror's and the composer draft field's —
// and they are two settings because they are two questions. These cases pin that they stay two:
// stepping one must not move the other, each keeps its own range, and the row that has a browser
// floor is the one that explains it.

const STORAGE_KEY = "collie:display-prefs:v4";

beforeEach(() => localStorage.clear());

const decreaseDraft = () => screen.getByRole("button", { name: "Decrease draft text size" });
const increaseDraft = () => screen.getByRole("button", { name: "Increase draft text size" });
const decreaseMirror = () => screen.getByRole("button", { name: "Decrease font size" });

/** The number's slot in a stepper row. Found by walking up from the row's own LABEL to the first
 *  ancestor that also holds a number — both rows show a bare integer, so a card-wide text query
 *  would not tell them apart, and the two rows do not share a class to key on. */
function slotIn(label: string): Element {
  let node: HTMLElement | null = screen.getByText(label);
  while (node !== null) {
    const slot = node.querySelector(".tabular-nums");
    if (slot !== null) return slot;
    node = node.parentElement;
  }
  throw new Error(`no stepper value found for row "${label}"`);
}

const valueIn = (label: string): string => slotIn(label).textContent!;

describe("FontSettingsControl — the draft-text size row", () => {
  it("offers its own stepper, starting at the 14px default", () => {
    render(<FontSettingsControl />);
    expect(screen.getByText("Draft text")).toBeInTheDocument();
    expect(valueIn("Draft text")).toBe("14");
  });

  it("steps the draft size without moving the mirror's", async () => {
    const user = userEvent.setup();
    render(<FontSettingsControl />);
    const mirrorBefore = valueIn("Mirror text");

    await user.click(increaseDraft());

    expect(valueIn("Draft text")).toBe("15");
    expect(valueIn("Mirror text")).toBe(mirrorBefore);
    expect(localStorage.getItem(STORAGE_KEY)).toContain('"draftFontSize":15');
  });

  it("stops at its own range, which is narrower than the mirror's at both ends", async () => {
    const user = userEvent.setup();
    render(<FontSettingsControl />);

    await user.click(decreaseDraft()); // 13
    expect(valueIn("Draft text")).toBe("13");
    expect(decreaseDraft()).toBeDisabled(); // …and no further: 13 is the floor for a field you type in

    await user.click(increaseDraft());
    await user.click(increaseDraft());
    await user.click(increaseDraft());
    expect(valueIn("Draft text")).toBe("16");
    expect(increaseDraft()).toBeDisabled();

    // The mirror's own stepper is untouched by all of that and still has room below 13.
    expect(decreaseMirror()).not.toBeDisabled();
  });

  // A stepper whose lower half silently does nothing on the operator's own device is worse than one
  // that says so — and iOS is the device most of them are holding.
  it("says on the row itself that iOS pins the field at 16", () => {
    render(<FontSettingsControl />);
    expect(screen.getByText(/iOS keeps this at 16/i)).toBeInTheDocument();
  });

  // DESIGN.md §6: 44px is the floor for anything tappable. jsdom measures nothing, so the class that
  // states the size is what there is to read.
  it("keeps both new buttons on the 44px tap floor", () => {
    render(<FontSettingsControl />);
    for (const button of [decreaseDraft(), increaseDraft()]) {
      expect(button.className).toMatch(/(?:^|\s)size-11(?=\s|$)/);
    }
  });

  // §2: a state change may repaint, it may not re-lay-out. The number's slot is fixed and its
  // figures are tabular, so stepping 9 → 10 cannot walk the two buttons beside it.
  it("pins the number's slot so stepping it cannot move the buttons", () => {
    render(<FontSettingsControl />);
    expect(slotIn("Draft text").className).toMatch(/(?:^|\s)w-8(?=\s|$)/);
  });
});
