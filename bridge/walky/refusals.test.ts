import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OTHER_REASON, readRefusals, reasonKey, RefusalCounter, refusalLine, REFUSAL_REASONS_MAX } from "./refusals.ts";

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
  test("counts per reason, keeps the first time, and survives a restart in a 0600 file with no body", () => {
    const at = dir();
    const counter = new RefusalCounter(at, () => 1000);
    counter.count("rate limit");
    counter.count("rate limit");
    counter.count("pair limit");
    expect(counter.current()).toEqual({ since: 1000, counts: { "rate limit": 2, "pair limit": 1 } });
    const file = join(at, "refusals.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(at).mode & 0o777).toBe(0o700);
    expect(readFileSync(file, "utf8")).not.toContain("wt_");
    const again = new RefusalCounter(at, () => 9000);
    again.count("rate limit");
    expect(again.current()).toEqual({ since: 1000, counts: { "rate limit": 3, "pair limit": 1 } });
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
