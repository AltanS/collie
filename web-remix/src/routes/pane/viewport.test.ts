import { describe, expect, test } from "bun:test";

import { nextKeyboardOpen } from "./viewport";

describe("keyboard hysteresis", () => {
  test("opens past 150 px, not before", () => {
    expect(nextKeyboardOpen(false, 844, 700)).toBe(false);
    expect(nextKeyboardOpen(false, 844, 690)).toBe(true);
  });
  test("stays open until the loss drops under 100 px", () => {
    expect(nextKeyboardOpen(true, 844, 730)).toBe(true);
    expect(nextKeyboardOpen(true, 844, 750)).toBe(false);
  });
});
