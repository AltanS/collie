import { describe, expect, test } from "bun:test";

import { withCurrent, withRule } from "./alerts-control";

describe("withRule", () => {
  test("replaces one metric and keeps the others, so a save never deletes a rule it did not touch", () => {
    const shown = { cpu: { above: 0.9, forMin: 10 }, mem: { above: 0.8, forMin: 5 } };
    expect(withRule(shown, "cpu", { above: 0.95, forMin: 10 })).toEqual({ cpu: { above: 0.95, forMin: 10 }, mem: { above: 0.8, forMin: 5 } });
  });
  test("a null rule removes only that metric", () => {
    const shown = { cpu: { above: 0.9, forMin: 10 }, mem: { above: 0.8, forMin: 5 } };
    expect(withRule(shown, "mem", null)).toEqual({ cpu: { above: 0.9, forMin: 10 } });
  });
});

describe("withCurrent", () => {
  test("a stored value off the shipped list stays selectable, in order", () => {
    expect(withCurrent([5, 10, 30], 7)).toEqual([5, 7, 10, 30]);
  });
  test("a shipped value changes nothing", () => {
    expect(withCurrent([5, 10, 30], 10)).toEqual([5, 10, 30]);
  });
});
