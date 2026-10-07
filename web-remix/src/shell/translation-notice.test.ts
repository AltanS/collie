/// <reference types="bun" />
import { describe, expect, test } from "bun:test";

import { isTranslated, TRANSLATED_CLASSES } from "./translation-notice";

describe("isTranslated", () => {
  test("is on for either direction class Chrome sets", () => {
    expect(isTranslated(["translated-ltr"])).toBe(true);
    expect(isTranslated(["dark", "translated-rtl"])).toBe(true);
  });
  test("is off without one", () => {
    expect(isTranslated([])).toBe(false);
    expect(isTranslated(["dark", "translated", "translated-ltr-x"])).toBe(false);
  });
  test("goes off when the class leaves", () => {
    const classes = new Set(["translated-ltr"]);
    expect(isTranslated(classes)).toBe(true);
    classes.delete("translated-ltr");
    expect(isTranslated(classes)).toBe(false);
  });
  test("names exactly the two classes", () => {
    expect([...TRANSLATED_CLASSES].toSorted()).toEqual(["translated-ltr", "translated-rtl"]);
  });
});
