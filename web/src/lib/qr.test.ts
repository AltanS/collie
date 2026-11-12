import { describe, expect, it } from "vitest";

import { encodeQr, type QrErrorLevel } from "./qr";

// The encoder against the standard's own numbers (ISO/IEC 18004): the byte-mode capacity table, the
// fixed patterns every symbol carries, and the format and version words, read back and checked with
// their BCH codes. Module-for-module agreement with an independent encoder, and a real decoder reading
// each code back, live in `scripts/qr-web.test.ts` at the repo root, where those two packages are.

/** The format word a symbol carries next to its top-left finder, unmasked. */
function formatBits(m: readonly (readonly boolean[])[]): number {
  let bits = 0;
  const read = (x: number, y: number, i: number) => {
    if (m[y]![x]) bits |= 1 << i;
  };
  for (let i = 0; i <= 5; i++) read(8, i, i);
  read(8, 7, 6);
  read(8, 8, 7);
  read(7, 8, 8);
  for (let i = 9; i < 15; i++) read(14 - i, 8, i);
  return bits ^ 0x5412;
}

/** The remainder of `data` under the generator `poly` of `degree`, the BCH check the standard uses. */
function bchRemainder(data: number, poly: number, degree: number): number {
  let rem = data << degree;
  for (let i = 31; i >= degree; i--) if ((rem >>> i) & 1) rem ^= poly << (i - degree);
  return rem;
}

/** The level each format value names, by its two bits: 0 is M, 1 is L, 2 is H, 3 is Q. */
const LEVEL_OF_BITS = ["M", "L", "H", "Q"] as const satisfies readonly QrErrorLevel[];

describe("encodeQr", () => {
  it.each([
    // [level, version, the most bytes it holds]: the standard's byte-mode capacity table.
    ["L", 1, 17],
    ["M", 1, 14],
    ["Q", 1, 11],
    ["H", 1, 7],
    ["M", 2, 26],
    ["L", 5, 106],
    ["M", 10, 213],
    ["H", 10, 119],
    ["L", 40, 2953],
  ] as const)("at level %s, version %i holds %i bytes and one more needs the next", (level, version, bytes) => {
    expect(encodeQr("a".repeat(bytes), level).version).toBe(version);
    if (version < 40) expect(encodeQr("a".repeat(bytes + 1), level).version).toBe(version + 1);
    else expect(() => encodeQr("a".repeat(bytes + 1), level)).toThrow("do not fit");
  });

  it("is 17 + 4 modules a version wide", () => {
    for (const version of [1, 2, 7, 10, 25]) {
      const q = encodeQr("x", "M", { version });
      expect(q.size).toBe(17 + 4 * version);
      expect(q.modules).toHaveLength(q.size);
      for (const row of q.modules) expect(row).toHaveLength(q.size);
    }
  });

  it("draws the three finder patterns, the timing lines and the dark module", () => {
    const q = encodeQr("https://collie.example/pair/approve?r=abc", "M");
    const m = q.modules;
    const n = q.size;
    for (const [ox, oy] of [
      [0, 0],
      [n - 7, 0],
      [0, n - 7],
    ] as const) {
      for (let y = 0; y < 7; y++) {
        for (let x = 0; x < 7; x++) {
          const ring = Math.max(Math.abs(x - 3), Math.abs(y - 3));
          expect(m[oy + y]![ox + x]).toBe(ring !== 2);
        }
      }
    }
    for (let i = 8; i < n - 8; i++) {
      expect(m[6]![i]).toBe(i % 2 === 0);
      expect(m[i]![6]).toBe(i % 2 === 0);
    }
    expect(m[n - 8]![8]).toBe(true);
  });

  it("writes a format word whose BCH check holds and which names the level and the mask", () => {
    for (const level of ["L", "M", "Q", "H"] as const) {
      for (let mask = 0; mask < 8; mask++) {
        const q = encodeQr("pair", level, { mask });
        const word = formatBits(q.modules);
        const data = word >>> 10;
        expect(word & 0x3ff).toBe(bchRemainder(data, 0x537, 10));
        expect(LEVEL_OF_BITS[data >>> 3]).toBe(level);
        expect(data & 7).toBe(mask);
        expect(q.mask).toBe(mask);
      }
    }
  });

  it("writes the version word from version 7 on, with its BCH check", () => {
    const q = encodeQr("v", "M", { version: 7 });
    let bits = 0;
    for (let i = 0; i < 18; i++) if (q.modules[Math.floor(i / 3)]![q.size - 11 + (i % 3)]) bits |= 1 << i;
    expect(bits >>> 12).toBe(7);
    expect(bits & 0xfff).toBe(bchRemainder(7, 0x1f25, 12));
    // The standard's table gives version 7's word as 0x07C94.
    expect(bits).toBe(0x07c94);
  });

  it("chooses the same mask every time for the same text", () => {
    const a = encodeQr("https://collie.example/pair/approve?r=Pg0FixtureRequest0001");
    const b = encodeQr("https://collie.example/pair/approve?r=Pg0FixtureRequest0001");
    expect(a.mask).toBe(b.mask);
    expect(a.modules).toEqual(b.modules);
  });

  it("refuses a version that cannot hold the text", () => {
    expect(() => encodeQr("a".repeat(20), "L", { version: 1 })).toThrow("cannot hold");
  });
});
