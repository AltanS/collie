import { describe, expect, test } from "bun:test";

import { holdStat, RACY_WINDOW_MS, sameStat, settledAt, stillHolds } from "./stat-held.ts";

// The racy-timestamp rule itself. Its users have their own cases: bridge/tricks/racy-caches.test.ts and the
// paired-device registry (pairing.test.ts).

const AT = 1_800_000_000_000;
const INSIDE = AT + RACY_WINDOW_MS / 4;
const AFTER = AT + RACY_WINDOW_MS * 5;

describe("the rule", () => {
  test("a read is kept only when the file was quiet for the window before it, and its stat holds", () => {
    expect(settledAt(AT, AT + RACY_WINDOW_MS)).toBe(true);
    expect(settledAt(AT, AT + RACY_WINDOW_MS - 1)).toBe(false);
    // A file time ahead of the clock (a skew) is never settled.
    expect(settledAt(AT, AT - 10)).toBe(false);
    const facts = { size: 10, mtimeMs: AT, ino: 7, ctimeMs: AT };
    expect(stillHolds(holdStat(facts, AFTER), facts)).toBe(true);
    expect(stillHolds(holdStat(facts, INSIDE), facts)).toBe(false);
    expect(stillHolds(undefined, facts)).toBe(false);
    for (const moved of [{ size: 11 }, { mtimeMs: AT + 1 }, { ino: 8 }, { ctimeMs: AT + 1 }]) expect(stillHolds(holdStat(facts, AFTER), { ...facts, ...moved })).toBe(false);
    // A side with no inode or change time (a test's fake, a platform without one) compares the rest.
    expect(stillHolds(holdStat({ size: 10, mtimeMs: AT }, AFTER), facts)).toBe(true);
    expect(sameStat(holdStat(facts, INSIDE), facts)).toBe(true);
  });
});

