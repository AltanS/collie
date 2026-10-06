/// <reference types="bun" />
import { afterEach, describe, expect, test } from "bun:test";

import { t, whenLocaleReady } from "@web/lib/i18n";
import { de } from "@web/lib/i18n/messages/de";
import { en } from "@web/lib/i18n/messages/en";

import { locale, setLocale } from "./i18n-store";

afterEach(() => {
  setLocale("en");
});

describe("the locale store mirrors web/'s i18n runtime", () => {
  test("it starts at the runtime's snapshot", () => {
    expect(locale.get().locale).toBe("en");
  });

  test("a change notifies at once (English in the gap) and again when the dictionary lands", async () => {
    const seen: string[] = [];
    const stop = locale.subscribe(() => seen.push(`${locale.get().locale}:${t("settings.title")}`));
    setLocale("de");
    expect(locale.get().locale).toBe("de");
    expect(seen[0]).toBe(`de:${en["settings.title"]}`);
    await whenLocaleReady("de");
    stop();
    expect(seen.at(-1)).toBe(`de:${de["settings.title"]}`);
    expect(seen.length).toBe(2);
  });

  test("every change bumps the revision, so the store never skips a repaint", async () => {
    const before = locale.get().revision;
    setLocale("de");
    await whenLocaleReady("de");
    setLocale("en");
    expect(locale.get().revision).toBeGreaterThan(before + 1);
    expect(t("settings.title")).toBe(en["settings.title"]);
  });
});
