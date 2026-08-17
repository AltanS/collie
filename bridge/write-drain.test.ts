import { describe, expect, test } from "bun:test";

import { advanceWrite, startWrite, writeComplete, writeRemaining } from "./write-drain.ts";

describe("write cursor", () => {
  test("a fresh cursor owes the whole payload", () => {
    const c = startWrite(100);
    expect(writeRemaining(c)).toEqual({ offset: 0, length: 100 });
    expect(writeComplete(c)).toBe(false);
  });

  test("an empty payload is complete immediately", () => {
    const c = startWrite(0);
    expect(writeRemaining(c)).toBeNull();
    expect(writeComplete(c)).toBe(true);
  });

  test("a short write leaves the tail owed, offset at the resume point", () => {
    const c = advanceWrite(startWrite(1000), 219);
    expect(c.sent).toBe(219);
    expect(writeRemaining(c)).toEqual({ offset: 219, length: 781 });
  });

  test("successive short writes accumulate to completion", () => {
    let c = startWrite(1000);
    for (const n of [400, 300, 300]) c = advanceWrite(c, n);
    expect(writeComplete(c)).toBe(true);
    expect(writeRemaining(c)).toBeNull();
  });

  test("a write that accepts nothing makes no progress and does not lose the cursor", () => {
    const c = advanceWrite(startWrite(1000), 500);
    const stalled = advanceWrite(c, 0);
    expect(stalled).toEqual(c);
    expect(writeRemaining(stalled)).toEqual({ offset: 500, length: 500 });
  });

  test("a negative or non-finite count is treated as zero progress", () => {
    const c = startWrite(10);
    expect(advanceWrite(c, -1)).toEqual(c);
    expect(advanceWrite(c, Number.NaN)).toEqual(c);
    expect(advanceWrite(c, Number.POSITIVE_INFINITY)).toEqual(c);
  });

  test("an impossible over-accept is clamped, never run past the payload", () => {
    const c = advanceWrite(startWrite(10), 99);
    expect(c.sent).toBe(10);
    expect(writeComplete(c)).toBe(true);
  });

  test("a fractional count never advances past a whole byte", () => {
    expect(advanceWrite(startWrite(10), 3.9).sent).toBe(3);
  });

  test("a nonsense total is refused at the source", () => {
    expect(() => startWrite(-1)).toThrow();
    expect(() => startWrite(Number.NaN)).toThrow();
  });
});
