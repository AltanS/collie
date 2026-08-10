import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import jsQR from "jsqr";
import { renderQr } from "./qr.ts";

// A QR test that only asserts "it printed something" would pass on a code no camera can read, which
// is the one failure that matters. So these SCAN what gets printed: the rendered characters are
// parsed back into modules, painted into an RGBA buffer and read by a real decoder.
//
// Polarity gets its own assertion because the scanner can't provide one — jsQR (like most phone
// software) tries both polarities, so an inverted code decodes here and then fails against the
// cameras that don't. It is checked against the encoder's own isDark() matrix instead: the ground
// truth for which modules are meant to be dark. That comparison is what caught the compact
// renderer's assumption of a dark terminal in the first place (see qr.ts).

const require = createRequire(import.meta.url);

/** Half-block glyphs, read with the polarity qr.ts pins: a FILLED glyph half is a LIGHT module. */
function toModules(rendered: string): boolean[][] {
  const rows: boolean[][] = [];
  for (const line of rendered.split("\n")) {
    const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
    if (stripped.length === 0) continue;
    const top: boolean[] = [];
    const bottom: boolean[] = [];
    for (const ch of [...stripped]) {
      // dark = the half is NOT filled
      top.push(!(ch === "█" || ch === "▀"));
      bottom.push(!(ch === "█" || ch === "▄"));
    }
    rows.push(top, bottom);
  }
  return rows;
}

/** The encoder's ground truth — which modules the spec says are dark. */
function truthMatrix(url: string): boolean[][] {
  const QRCode = require("qrcode-terminal/vendor/QRCode");
  const level = require("qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel");
  const qr = new QRCode(-1, level.L);
  qr.addData(url);
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c) as boolean));
}

/** Blow the modules up to a scanner-sized image — one module to SCALE² pixels — and read it. */
function scan(modules: boolean[][], scale = 6): string | null {
  const height = modules.length * scale;
  const width = Math.max(...modules.map((r) => r.length)) * scale;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = modules[Math.floor(y / scale)]?.[Math.floor(x / scale)] ? 0 : 255;
      const i = (y * width + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = value;
      data[i + 3] = 255;
    }
  }
  return jsQR(data, width, height)?.data ?? null;
}

/** Where the symbol sits inside the padded output, or null if it isn't there at the right polarity. */
function locate(modules: boolean[][], truth: boolean[][]): { row: number; col: number } | null {
  const n = truth.length;
  for (let row = 0; row + n <= modules.length; row++) {
    for (let col = 0; col + n <= (modules[row]?.length ?? 0); col++) {
      let match = true;
      for (let r = 0; r < n && match; r++) {
        for (let c = 0; c < n && match; c++) if ((modules[row + r]?.[col + c] ?? false) !== truth[r]![c]) match = false;
      }
      if (match) return { row, col };
    }
  }
  return null;
}

const URLS = [
  "https://my-laptop.tailnet-example.ts.net",      // the shape `tailscale serve` publishes
  "http://host.example:8787",                       // SERVE_MODE=http (Headscale / .internal)
  "https://a-really-long-machine-name-for-good-measure.tail1a2b3c.ts.net", // pushes to a bigger version
];

describe("qr", () => {
  for (const url of URLS) {
    test(`scans back to ${url}`, async () => {
      expect(scan(toModules(await renderQr(url)))).toBe(url);
    });

    // The one a scanner can't check for us: every module dark exactly where the encoder says dark.
    test(`draws ${url} the right way round`, async () => {
      const modules = toModules(await renderQr(url));
      expect(locate(modules, truthMatrix(url))).not.toBeNull();
    });
  }

  // The quiet zone is not decoration — a symbol drawn hard against surrounding terminal output is one
  // many scanners refuse. Spec minimum is 4 modules; the upstream renderer supplies 2 top and 1 left.
  test("keeps a 4-module quiet zone on every side", async () => {
    const url = URLS[0]!;
    const modules = toModules(await renderQr(url));
    const at = locate(modules, truthMatrix(url));
    expect(at).not.toBeNull();
    const size = truthMatrix(url).length;
    const width = Math.max(...modules.map((r) => r.length));
    expect(at!.row).toBeGreaterThanOrEqual(4);
    expect(at!.col).toBeGreaterThanOrEqual(4);
    expect(modules.length - (at!.row + size)).toBeGreaterThanOrEqual(4);
    expect(width - (at!.col + size)).toBeGreaterThanOrEqual(4);
  });

  // Compactness is the whole reason the half-block renderer is used: the full-size one costs ~31 rows
  // and scrolls the status block away. If someone flips it, this fails before an operator notices.
  test("stays short enough not to scroll the terminal", async () => {
    const rendered = await renderQr(URLS[0]!);
    expect(rendered.split("\n").filter((l) => l.length > 0).length).toBeLessThanOrEqual(24);
  });

  // Every line carries its own colours and resets them, so the code can't inherit a stray SGR from
  // whatever printed last — and can't leak one into the shell prompt that follows.
  test("pins colours per line and resets them", async () => {
    for (const line of (await renderQr(URLS[0]!)).split("\n")) {
      expect(line.startsWith("\x1b[97;40m")).toBe(true);
      expect(line.endsWith("\x1b[0m")).toBe(true);
    }
  });

  test("refuses a url too long to encode", async () => {
    await expect(renderQr("https://" + "x".repeat(600))).rejects.toThrow(/too long/);
  });
});
