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
  it("renders every locale's native name, with English selected by default", () => {
    render(<LanguageControl />);

    const select = screen.getByRole("combobox", { name: "Language" });
    const options = within(select).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "English",
      "Deutsch",
      "Español",
      "한국어",
      "日本語",
      "简体中文",
      "繁體中文",
    ]);
    expect(select).toHaveValue("en");
  });

  it("selects a language, persists it, and keeps it selected going forward", async () => {
    const user = userEvent.setup();
    render(<LanguageControl />);

    const select = screen.getByRole("combobox", { name: "Language" });
    await user.selectOptions(select, "de");

    expect(select).toHaveValue("de");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("de");
  });

  it("translates its own title once the chosen bundle lands", async () => {
    render(<LanguageControl />);
    expect(screen.getByText("Language")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.selectOptions(screen.getByRole("combobox", { name: "Language" }), "de");
    await whenLocaleReady("de");

    expect(await screen.findByText("Sprache")).toBeInTheDocument();
  });

  it("loads Traditional Chinese independently from Simplified Chinese", async () => {
    const user = userEvent.setup();
    render(<LanguageControl />);

    await user.selectOptions(screen.getByRole("combobox", { name: "Language" }), "zh-TW");
    await whenLocaleReady("zh-TW");

    expect(await screen.findByText("語言")).toBeInTheDocument();
    expect(localStorage.getItem(STORAGE_KEY)).toBe("zh-TW");
  });
});
