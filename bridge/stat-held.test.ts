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
    // A file time just ahead of the clock, inside the window, is not settled (see the cases below).
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


/** A one-file cache over the helper, as every user builds it: stat, keep or read, count the reads. */
function cache(stat: () => { size: number; mtimeMs: number; ino?: number; ctimeMs?: number }, warn?: (line: string) => void) {
  let held: ReturnType<typeof holdStat> | undefined;
  let reads = 0;
  return {
    look(readAt: number): void {
      const facts = stat();
      if (stillHolds(held, facts)) return;
      reads += 1;
      held = holdStat(facts, readAt, warn === undefined ? undefined : { path: "/state/file.json", kind: "a test file", warn });
    },
    reads: () => reads,
  };
}

describe("a file time far from the read, before or after it", () => {
  const HOURS_10 = 10 * 3600 * 1000;

  test("an mtime 10 hours ahead is kept after the first read", () => {
    const c = cache(() => ({ size: 10, mtimeMs: AT + HOURS_10, ino: 7, ctimeMs: AT }));
    c.look(AT);
    c.look(AT + 1);
    expect(c.reads()).toBe(1);
  });

  test("an mtime 1 s ahead is not kept, and is once the clock is the window past it", () => {
    const ahead = AT + 1000;
    const c = cache(() => ({ size: 10, mtimeMs: ahead, ino: 7, ctimeMs: ahead }));
    c.look(AT);
    c.look(AT + 500);
    expect(c.reads()).toBe(2);
    c.look(ahead + RACY_WINDOW_MS);
    c.look(ahead + RACY_WINDOW_MS + 1);
    expect(c.reads()).toBe(3);
  });

  test("a rewrite of a file whose mtime was far ahead is seen: the new mtime is the present, the same size", () => {
    let mtimeMs = AT + HOURS_10;
    const c = cache(() => ({ size: 10, mtimeMs, ino: 7, ctimeMs: AT }));
    c.look(AT);
    c.look(AT + 10);
    expect(c.reads()).toBe(1);
    mtimeMs = AT + 20;
    c.look(AT + 30);
    expect(c.reads()).toBe(2);
  });

  test("an mtime that is not a number settles on the change time the same way", () => {
    const c = cache(() => ({ size: 10, mtimeMs: Number.NaN, ino: 7, ctimeMs: AT }));
    c.look(INSIDE);
    c.look(INSIDE + 1);
    expect(c.reads()).toBe(2);
    c.look(AFTER);
    c.look(AFTER + 1);
    expect(c.reads()).toBe(3);
    expect(holdStat({ size: 1, mtimeMs: Number.NaN, ctimeMs: AT + 10 * 3600 * 1000 }, AT).settled).toBe(true);
  });

  test("with neither time a number the read is never kept, and that is said once per path", () => {
    const warned: string[] = [];
    const c = cache(() => ({ size: 10, mtimeMs: Number.NaN, ino: 7, ctimeMs: Number.POSITIVE_INFINITY }), (line) => warned.push(line));
    for (let i = 0; i < 4; i += 1) c.look(AFTER + i);
    expect(c.reads()).toBe(4);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("/state/file.json");
  });

  test("with an mtime far ahead, a same-size rewrite that moves the inode or the change time is still seen", () => {
    let ino = 7;
    let ctimeMs = AT;
    const c = cache(() => ({ size: 10, mtimeMs: AT + HOURS_10, ino, ctimeMs }));
    c.look(AT);
    ino = 8;
    c.look(AT + 1);
    expect(c.reads()).toBe(2);
    ctimeMs = AT + 5;
    c.look(AT + 2);
    expect(c.reads()).toBe(3);
  });
});
