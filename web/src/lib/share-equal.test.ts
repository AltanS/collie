import { describe, expect, it } from "vitest";

import { shareEqual } from "./share-equal";

describe("shareEqual", () => {
  /** A deep copy that shares no object with `prev`, the way a fresh fetch answers. */
  const copy = () => structuredClone(prev);
  const prev = { root: "/r", repos: [{ name: "a", files: [{ path: "x" }] }, { name: "b", files: [{ path: "y" }] }] };

  it("hands back the old object when the new one is deep-equal", () => {
    const next = copy();
    expect(shareEqual(prev, next)).toBe(prev);
  });

  it("keeps every unchanged part and replaces only what moved", () => {
    const next = copy();
    next.repos[1]!.files[0]!.path = "z";
    const out = shareEqual(prev, next);
    expect(out).not.toBe(prev);
    expect(out).toEqual(next);
    expect(out.repos[0]).toBe(prev.repos[0]);
    expect(out.repos[1]).not.toBe(prev.repos[1]);
  });

  it("sees an added or dropped key and a shorter array", () => {
    expect(shareEqual<Record<string, number>>({ a: 1 }, { a: 1, b: 2 })).toEqual({ a: 1, b: 2 });
    expect(shareEqual<Record<string, number | undefined>>({ a: 1, b: 2 }, { a: 1 })).toEqual({ a: 1 });
    expect(shareEqual([1, 2], [1])).toEqual([1]);
  });

  // The shapes the Changes screens re-read every 5 s arrive as fresh JSON each time; only
  // structure may decide, never identity.
  it("hands back the old answer for a Changes list and a count that were parsed again", () => {
    const again: typeof prev = JSON.parse(JSON.stringify(prev));
    expect(shareEqual(prev, again)).toBe(prev);
    const count = { kind: "changed", files: 3, added: 10, removed: 2 };
    expect(shareEqual(count, { ...count })).toBe(count);
    expect(shareEqual(count, { ...count, added: 11 })).not.toBe(count);
  });

  it("keeps a file's object when only its neighbour's numbers changed", () => {
    const a = { repos: [{ files: [{ path: "x", added: 1 }, { path: "y", added: 1 }] }] };
    const b = structuredClone(a);
    b.repos[0]!.files[1]!.added = 2;
    const out = shareEqual(a, b);
    expect(out.repos[0]!.files[0]).toBe(a.repos[0]!.files[0]);
    expect(out.repos[0]!.files[1]).toEqual({ path: "y", added: 2 });
  });
});
