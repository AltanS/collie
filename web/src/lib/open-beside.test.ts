import { afterEach, describe, expect, it } from "vitest";

import { __resetOpenBeside, isOpenBeside, OPEN_BESIDE_TTL_MS, queueOpenBeside, takeOpenBeside } from "@/lib/open-beside";

afterEach(__resetOpenBeside);

describe("open beside", () => {
  it("is for a pane the space did not hold, and for that space only", () => {
    queueOpenBeside("s1", ["a", "b"], 0);
    expect(isOpenBeside("s1", "c", 1)).toBe(true);
    expect(isOpenBeside("s1", "a", 1)).toBe(false);
    expect(isOpenBeside("s2", "c", 1)).toBe(false);
  });

  it("is read without being taken, and forgotten once taken", () => {
    queueOpenBeside("s1", [], 0);
    expect(isOpenBeside("s1", "c", 1)).toBe(true);
    expect(isOpenBeside("s1", "c", 2)).toBe(true);
    takeOpenBeside("s1");
    expect(isOpenBeside("s1", "c", 3)).toBe(false);
  });

  it("expires, so an abandoned start does not wait forever", () => {
    queueOpenBeside("s1", [], 0);
    expect(isOpenBeside("s1", "c", OPEN_BESIDE_TTL_MS)).toBe(true);
    expect(isOpenBeside("s1", "c", OPEN_BESIDE_TTL_MS + 1)).toBe(false);
  });
});
