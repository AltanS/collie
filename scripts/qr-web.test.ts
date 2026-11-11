import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import jsQR from "jsqr";

import { encodeQr, type QrErrorLevel } from "../web/src/lib/qr.ts";

// The app's own QR encoder (web/src/lib/qr.ts, ADR 0139) held to two independent witnesses that live
// in the root's dependencies and not in the web bundle:
//
//   1. `qrcode-terminal`'s vendored encoder, the one `collie pair` prints with (scripts/qr.ts). For the
//      same text, level, version and mask, every module must match. The two pick a mask by different
//      penalty sums, so the mask is forced on both sides and all eight are compared.
//   2. jsQR, a real decoder: every code the app encodes, with the mask it picks itself, reads back to
//      its text. This is the check that matters; the first one says where a failure is.

const require = createRequire(import.meta.url);

const LEVELS = { L: 1, M: 0 } as const;

/** What the vendored encoder drew: the version it chose and its modules, `modules[row][col]`. */
interface VendorSymbol {
  readonly version: number;
  readonly modules: boolean[][];
}

/** The vendored encoder's matrix for `text` at `level` and `mask`, and the version it chose. */
function vendor(text: string, level: "L" | "M", mask: number): VendorSymbol {
  const QRCode = require("qrcode-terminal/vendor/QRCode");
  const qr = new QRCode(-1, LEVELS[level]);
  qr.addData(text);
  qr.make();
  // `make()` picked the version and its own mask; draw again with the mask under test.
  qr.makeImpl(false, mask);
  const n: number = qr.getModuleCount();
  // SAFETY: the vendored QRCode ships no types, so `require` hands back any; `isDark(row, col)` answers
  // a boolean for every in-range cell and `typeNumber` is the version `make()` settled on.
  return {
    version: qr.typeNumber as number,
    modules: Array.from({ length: n }, (_r, r) => Array.from({ length: n }, (_c, c) => qr.isDark(r, c) as boolean)),
  };
}

/** Paint the modules with a four-module quiet zone, one module to `scale`² pixels, and decode. */
function scan(modules: readonly (readonly boolean[])[], scale = 6): string | null {
  const quiet = 4;
  const n = modules.length + quiet * 2;
  const size = n * scale;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const my = Math.floor(y / scale) - quiet;
      const mx = Math.floor(x / scale) - quiet;
      const dark = modules[my]?.[mx] ?? false;
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = dark ? 0 : 255;
      data[i + 3] = 255;
    }
  }
  return jsQR(data, size, size, { inversionAttempts: "dontInvert" })?.data ?? null;
}

const TEXTS = [
  "https://collie.example.ts.net/pair/approve?r=Pg0FixtureRequest0001",
  "http://127.0.0.1:8787/collie/pair/approve?r=AbCdEfGhIjKlMnOpQrStUv",
  "x",
  // Long enough for version 7 and up at M, where the version word is drawn.
  `https://collie.example.ts.net/${"a".repeat(140)}`,
] as const;

describe("web/src/lib/qr.ts against qrcode-terminal", () => {
  for (const level of ["L", "M"] as const) {
    for (const text of TEXTS) {
      test(`level ${level}, ${text.length} bytes: every module of every mask matches`, () => {
        for (let mask = 0; mask < 8; mask++) {
          const theirs = vendor(text, level, mask);
          const ours = encodeQr(text, level, { mask, version: theirs.version });
          expect(ours.version).toBe(theirs.version);
          expect(ours.modules).toEqual(theirs.modules);
        }
      });
    }
  }

  test("picks the smallest version the vendored encoder picks", () => {
    for (const level of ["L", "M"] as const) {
      for (const text of TEXTS) expect(encodeQr(text, level).version).toBe(vendor(text, level, 0).version);
    }
  });
});

describe("web/src/lib/qr.ts read by a real decoder", () => {
  const levels: QrErrorLevel[] = ["L", "M", "Q", "H"];
  for (const level of levels) {
    test(`level ${level}: every text reads back, at the mask the encoder picks`, () => {
      for (const text of TEXTS) expect(scan(encodeQr(text, level).modules)).toBe(text);
    });
  }

  test("a link with every byte a request id can hold reads back", () => {
    const id = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const text = `https://collie.example.ts.net/pair/approve?r=${id}`;
    expect(scan(encodeQr(text, "M").modules)).toBe(text);
  });
});
