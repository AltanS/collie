import { describe, expect, test } from "bun:test";

import { HISTORY_REFRESH_MS, historyDue } from "./history-data";

describe("historyDue", () => {
  test("the first read is always due", () => {
    expect(historyDue(1_000, 0)).toBe(true);
  });
  test("a read under a minute old is not", () => {
    expect(historyDue(100_000 + HISTORY_REFRESH_MS - 1, 100_000)).toBe(false);
  });
  test("a minute later it is", () => {
    expect(historyDue(100_000 + HISTORY_REFRESH_MS, 100_000)).toBe(true);
  });
});
