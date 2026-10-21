import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HOST } from "../host.ts";
import { OTHER_REASON, readRefusals, reasonKey, RefusalCounter, refusalLine, REFUSAL_REASONS_MAX } from "./refusals.ts";

// File modes and Unix sockets are POSIX. Windows has no 0700 or 0600, so those checks sit in a test
// that is skipped there, and the behaviour beside them still runs.
const POSIX_ONLY = HOST.platform === "win32";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function dir(): string {
  const root = mkdtempSync(join(tmpdir(), "walky-refusals-"));
  roots.push(root);
  return join(root, "walky");
}

describe("the refusal counter", () => {
  test("a reason that names an Object property counts like any other", () => {
    const counter = new RefusalCounter(null, () => 1000);
    for (const reason of ["constructor", "toString", "__proto__", "constructor"]) counter.count(reason);
    // Entries, not an object literal: `{ __proto__: 1 }` in a literal sets a prototype, not a key.
    const entries = (counts: Readonly<Record<string, number>>) => Object.entries(counts).toSorted(([a], [b]) => a.localeCompare(b));
    expect(entries(counter.current().counts)).toEqual([["__proto__", 1], ["constructor", 2], ["toString", 1]]);
    expect(entries(readRefusals('{"v":1,"since":1,"counts":{"constructor":3,"__proto__":2}}').counts)).toEqual([["__proto__", 2], ["constructor", 3]]);
  });

  test("counts per reason, keeps the first time, and survives a restart in a file with no body", () => {
    const at = dir();
    const counter = new RefusalCounter(at, () => 1000);
    counter.count("rate limit");
    counter.count("rate limit");
    counter.count("pair limit");
    expect(counter.current()).toEqual({ since: 1000, counts: { "rate limit": 2, "pair limit": 1 } });
    const file = join(at, "refusals.json");
    expect(readFileSync(file, "utf8")).not.toContain("wt_");
    const again = new RefusalCounter(at, () => 9000);
    again.count("rate limit");
    expect(again.current()).toEqual({ since: 1000, counts: { "rate limit": 3, "pair limit": 1 } });
  });

  test.skipIf(POSIX_ONLY)("keeps its file at 0600 in a 0700 folder", () => {
    const at = dir();
    new RefusalCounter(at, () => 1000).count("rate limit");
    expect(statSync(join(at, "refusals.json")).mode & 0o777).toBe(0o600);
    expect(statSync(at).mode & 0o777).toBe(0o700);
  });

  test("a reason is cut at its first colon and to 40 characters, so one cause is one line", () => {
    expect(reasonKey("crew: HTTP 502")).toBe("crew");
    expect(reasonKey("x".repeat(90))).toBe("x".repeat(40));
    expect(reasonKey("")).toBe(OTHER_REASON);
  });

  test("past 32 reasons the rest count under `other`", () => {
    const counter = new RefusalCounter(null);
    for (let n = 0; n < REFUSAL_REASONS_MAX + 5; n += 1) counter.count(`reason ${String(n)}`);
    const counts = counter.current().counts;
    expect(Object.keys(counts).length).toBe(REFUSAL_REASONS_MAX + 1);
    expect(counts[OTHER_REASON]).toBe(5);
  });

  test("a damaged file reads as none, and the line lists the most first", () => {
    expect(readRefusals("{not json")).toEqual({ since: null, counts: {} });
    expect(readRefusals(JSON.stringify({ v: 1, since: 5, counts: { a: 2, b: -1, c: "x" } }))).toEqual({ since: 5, counts: { a: 2 } });
    expect(refusalLine({ "pair limit": 1, "rate limit": 3, stale: 1 })).toBe("rate limit 3, pair limit 1, stale 1");
  });
});
