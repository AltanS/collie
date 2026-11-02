import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { MathControl } from "@/components/math-control";
import { __resetDesign, designPrefs, mathEngineOf } from "@/lib/design";
import { t } from "@/lib/i18n";

// The Math card: Off by default, the three choices in a fixed order, and a pick that writes the store
// with a note under it that names what the choice costs. Every note stays in the cell and only the
// active one shows, so the card keeps the height of the longest (ui/one-of.tsx).

/** The note on top of the cell, the one a person reads. */
const shownNote = () => document.querySelector("[data-active]")?.textContent;

beforeEach(() => {
  localStorage.clear();
  __resetDesign();
});

describe("MathControl", () => {
  it("offers Off, KaTeX and MathJax, with Off selected on a device that never chose", () => {
    render(<MathControl />);
    const select = screen.getByLabelText(t("settings.math.engine"));
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual([
      t("settings.math.off"),
      "KaTeX",
      "MathJax",
    ]);
    expect(select).toHaveValue("off");
    expect(shownNote()).toBe(t("settings.math.note.off"));
    for (const key of ["settings.math.note.katex", "settings.math.note.mathjax"] as const) {
      expect(screen.getByText(t(key)).closest("[aria-hidden]")).not.toBeNull();
    }
  });

  it("writes the choice to the store and swaps the note", async () => {
    render(<MathControl />);
    const select = screen.getByLabelText(t("settings.math.engine"));
    await userEvent.selectOptions(select, "katex");
    expect(mathEngineOf(designPrefs())).toBe("katex");
    expect(shownNote()).toBe(t("settings.math.note.katex"));
    await userEvent.selectOptions(select, "off");
    expect(designPrefs().math).toBeUndefined();
  });
});
