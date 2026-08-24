import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { __resetLocale, whenLocaleReady } from "@/lib/i18n";
import { LanguageControl } from "@/components/language-control";

// The locale store is a module-scope singleton (see hooks/use-locale.ts / lib/i18n/index.ts), not
// re-imported fresh per test the way use-theme's tests do — `__resetLocale` is the seam it exists
// for: forget every loaded bundle and re-read the pin, as if the page had just opened.

const STORAGE_KEY = "collie:locale:v1";

beforeEach(() => {
  localStorage.clear();
  __resetLocale();
});

describe("LanguageControl", () => {
  it("renders every locale's native name, with English checked by default", () => {
    render(<LanguageControl />);

    const group = screen.getByRole("radiogroup", { name: "Language" });
    const options = within(group).getAllByRole("radio");
    expect(options.map((o) => o.textContent)).toEqual([
      "English",
      "Deutsch",
      "Español",
      "한국어",
      "日本語",
      "中文",
    ]);
    expect(screen.getByRole("radio", { name: "English" })).toHaveAttribute("aria-checked", "true");
  });

  it("selects a language, persists it, and checks it going forward", async () => {
    const user = userEvent.setup();
    render(<LanguageControl />);

    await user.click(screen.getByRole("radio", { name: "Deutsch" }));

    expect(screen.getByRole("radio", { name: "Deutsch" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "English" })).toHaveAttribute("aria-checked", "false");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("de");
  });

  it("translates its own title once the chosen bundle lands", async () => {
    render(<LanguageControl />);
    expect(screen.getByText("Language")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: "Deutsch" }));
    await whenLocaleReady("de");

    expect(await screen.findByText("Sprache")).toBeInTheDocument();
  });
});
