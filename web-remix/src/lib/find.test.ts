import { describe, expect, test } from "bun:test";

import { createFind, stepMatch } from "./find";

describe("find", () => {
  test("steps wrap at both ends", () => {
    expect(stepMatch(2, 3, 1)).toBe(0);
    expect(stepMatch(0, 3, -1)).toBe(2);
    expect(stepMatch(0, 0, 1)).toBe(0);
  });

  test("a closed bar finds nothing", () => {
    const find = createFind();
    expect(find.measure("abc abc").matches).toEqual([]);
  });

  test("measure clamps the focus and report publishes the count", () => {
    const find = createFind();
    find.open();
    find.setQuery("ab");
    const first = find.measure("ab ab ab");
    expect(first.matches.length).toBe(3);
    expect(first.current).toBe(0);
    find.report(first.matches.length, first.current);
    find.prev();
    expect(find.state.get().current).toBe(2);
    const shrunk = find.measure("ab");
    expect(shrunk.current).toBe(0);
    find.close();
    expect(find.state.get()).toEqual({ open: false, query: "", current: 0, count: 0 });
  });
});
