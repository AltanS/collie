import { inflateSync } from "node:zlib";

import { expect, test } from "@playwright/test";

import { installApiStub } from "./fixtures/api";

// ── A cell-filling character reaches the top and bottom of its row ───────────────────────────────
//
// The defect this guards is a HEIGHT, and no unit test can see one: jsdom lays nothing out. A
// segment's background paints its content box, a glyph paints its em box, and the mirror runs at
// 1.25 leading — so a Powerline cap drawn by the font is a quarter of a row shorter than the chip
// beside it and the pill steps in at both joins (lib/cell-glyphs.ts).
//
// Three properties are asserted here. A BLOCK ELEMENT fills exactly its row: stacked `█` rows meet
// with no gap and overlap by no more than a pixel, a half block splits at half the row, and a bar
// has no seam between its cells. The span's own box is the font's content area, which is not the
// row (13px against a 12.5px row at 10px in Chromium on Linux, and 0.75px above its centre), so
// this is read off the pixels the band paints, against row lines taken from the <pre>'s own line
// pitch. A POWERLINE CAP covers the same rows as the chip beside it, because that chip's
// background is the content area too. And painting moves no column and no row: the text after a
// bar sits where it sits with the paint taken away. A later hand reaching for `display:
// inline-block` with a height in line boxes fails one of these.
//
// The pixel cases read one pixel against another, never against a constant.
//
// The pane is the fixture's SHELL pane, which is where a status tool prints a pill. An agent pane
// with no input box on screen lifts the unread-dialog card (.adr/0053) and mirrors its rows there
// instead — components/raw-mirror.test.tsx covers that path.

const PANE_ID = "w2:p2";
const LEFT_CAP = "\ue0b6";
const RIGHT_CAP = "\ue0b4";
const FULL_BLOCK = "\u2588";
/** Padded, as a pill usually is. The padding is load-bearing for the colour case below: the middle
 *  of a space is the one point of a chip that no font puts ink on. */
const CHIP = " CL ";

const GREEN = "38;2;37;190;106";
const PAGE = "38;2;22;22;22";
const ON_GREEN = "48;2;37;190;106";
const ON_PAGE = "48;2;22;22;22";

/** One quota pill and one bar, the way a status tool emits them: the cap takes the pill's colour as
 *  its foreground, and the letters invert against it. */
const PILL_LINE =
  `\u001b[${GREEN}m\u001b[${ON_PAGE}m${LEFT_CAP}\u001b[0m` +
  `\u001b[${PAGE}m\u001b[${ON_GREEN}m${CHIP}\u001b[0m` +
  `\u001b[${GREEN}m\u001b[${ON_PAGE}m${RIGHT_CAP}\u001b[0m` +
  ` 5h \u001b[${GREEN}m${FULL_BLOCK.repeat(8)}\u001b[0m 91%`;

const ON = `\u001b[${GREEN}m`;
const OFF = "\u001b[0m";
const LOWER_HALF = "\u2584";
const UPPER_HALF = "\u2580";
/** Three rows of `█`, stacked, and a half block on the first and last of them with nothing else in
 *  its column: rows 3 to 5 of the screen. */
const STACK = [
  `${ON}${FULL_BLOCK.repeat(4)}${OFF} ${ON}${LOWER_HALF.repeat(4)}${OFF}`,
  `${ON}${FULL_BLOCK.repeat(4)}${OFF}`,
  `${ON}${FULL_BLOCK.repeat(4)}${OFF} ${ON}${UPPER_HALF.repeat(4)}${OFF}`,
];
const STACK_TOP = 3;

const SCREEN = ["quota:", PILL_LINE, "done", ...STACK].join("\n");

test.beforeEach(async ({ page }) => {
  await installApiStub(page);
  // The pane's own text is the only payload this case needs; everything else is the default world.
  await page.route(/\/api\/pane\/w2%3Ap2(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { paneId: PANE_ID, text: SCREEN, truncated: false, revision: 1 } }),
  );
  await page.goto(`/pane/${PANE_ID}`);
  await expect(page.getByText("quota:", { exact: true })).toBeVisible();
  // Every case here measures a box, and the Nerd Font symbol face is wider than the fallback it
  // replaces: a cap is 10px once the webfont lands and 6px before it. Measuring across that swap
  // reads one layout and screenshots another.
  await page.evaluate(() => document.fonts.ready);
});

/** Every pixel of a PNG, as RGB rows. Playwright hands back an encoded screenshot and the cases
 *  here only compare colours, so this reads the PNG itself rather than pulling in a decoder:
 *  8-bit RGB or RGBA, the five scanline filters, nothing else. */
function pixels(png: Buffer): number[][][] {
  let at = 8;
  let width = 0;
  let height = 0;
  let channels = 3;
  const parts: Buffer[] = [];
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const type = png.toString("ascii", at + 4, at + 8);
    if (type === "IHDR") {
      width = png.readUInt32BE(at + 8);
      height = png.readUInt32BE(at + 12);
      channels = png[at + 17] === 6 ? 4 : 3;
    }
    if (type === "IDAT") parts.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * channels;
  const rows: number[][][] = [];
  let previous = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? out[i - channels]! : 0;
      const up = previous[i]!;
      const upLeft = i >= channels ? previous[i - channels]! : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      out[i] = (line[i]! + predicted) & 0xff;
    }
    rows.push(
      Array.from({ length: width }, (_, x) => [...out.subarray(x * channels, x * channels + 3)]),
    );
    previous = out;
  }
  return rows;
}

/** The RGB of a 1x1 PNG. */
function pixel(png: Buffer): number[] {
  return pixels(png)[0]![0]!;
}

test("a Powerline cap covers the same rows as the chip beside it", async ({ page }) => {
  const measured = await page.evaluate(
    ([chip]) => {
      const cap = document.querySelector("pre .cell-glyph")!.getBoundingClientRect();
      const letters = [...document.querySelectorAll("pre span")]
        .find((span) => span.textContent === chip && !span.classList.contains("cell-glyph"))!
        .getBoundingClientRect();
      return {
        cap: { top: cap.top, bottom: cap.bottom },
        letters: { top: letters.top, bottom: letters.bottom },
      };
    },
    [CHIP],
  );

  // Same two edges, top and bottom. A cap that is shorter than this leaves the page background
  // showing above and below it, which is the step the pill used to have. A cap painted to the row
  // instead would miss by the difference between the row and the content area.
  expect(measured.cap.top).toBeCloseTo(measured.letters.top, 1);
  expect(measured.cap.bottom).toBeCloseTo(measured.letters.bottom, 1);
});

test("painting moves no column and no row", async ({ page }) => {
  const measured = await page.evaluate(() => {
    const pre = document.querySelector("pre")!;
    // The text after the bar, measured as text: its left edge is where every column after a
    // painted run lands.
    const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
    let after: Node | null = null;
    while (after === null && walker.nextNode()) {
      if (walker.currentNode.textContent!.includes("91%")) after = walker.currentNode;
    }
    const range = document.createRange();
    range.selectNodeContents(after!);
    const place = () => ({
      after: range.getBoundingClientRect().left,
      height: pre.getBoundingClientRect().height,
      scroll: pre.scrollHeight,
    });
    const painted = place();
    for (const el of pre.querySelectorAll(".cell-glyph")) {
      el.removeAttribute("class");
      el.removeAttribute("data-cell");
    }
    return { painted, typed: place() };
  });

  expect(measured.painted.after).toBeCloseTo(measured.typed.after, 2);
  expect(measured.painted.height).toBeCloseTo(measured.typed.height, 2);
  expect(measured.painted.scroll).toBe(measured.typed.scroll);
});

// The row itself. The <pre>'s line pitch is `1lh`, and its rows start at its content edge, so row
// k's top is the content edge plus k pitches. A column of device pixels through the stacked bars
// must be painted from the top of row 3 to the bottom of row 5 with no pixel missing and no more
// than a pixel over, a half block must stop at the middle of its row, and a row of pixels through a
// bar must be painted cell to cell with no seam.
test("a block element fills its row exactly", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("collie:theme:v1", "dark"));
  await page.reload();
  await expect(page.getByText("quota:", { exact: true })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);

  const layout = await page.evaluate(() => {
    const pre = document.querySelector("pre")!;
    const style = getComputedStyle(pre);
    const box = pre.getBoundingClientRect();
    const full = [...pre.querySelectorAll('[data-cell="full"]')].map((el) => {
      const rect = el.getBoundingClientRect();
      return { left: rect.left, right: rect.right };
    });
    const [lower, upper] = ["lower-4", "upper-4"].map((name) => {
      const rect = pre.querySelector(`[data-cell="${name}"]`)!.getBoundingClientRect();
      return rect.left + rect.width / 2;
    });
    return {
      pitch: parseFloat(style.lineHeight),
      top:
        box.top + parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop) - pre.scrollTop,
      // The pill's bar holds the first eight full blocks; the stack's rows hold four each.
      bar: { left: full[0]!.left, right: full[7]!.right },
      stack: (full[8]!.left + full[8]!.right) / 2,
      lower: lower!,
      upper: upper!,
    };
  });
  const rowTop = (k: number) => layout.top + k * layout.pitch;

  /** The painted stretch of a one-pixel line of the screen, in CSS px along it: where the paint
   *  starts, where it ends, and how many device pixels between the two are not paint. */
  const painted = async (clip: { x: number; y: number; width: number; height: number }) => {
    const shot = pixels(await page.screenshot({ clip, scale: "device" }));
    const across = clip.height === 1;
    const line = across ? shot[0]! : shot.map((row) => row[0]!);
    const scale = line.length / (across ? clip.width : clip.height);
    // The reference is the middle of the line, which every case puts inside the paint: the paint's
    // own colour, never a constant.
    const ink = line[Math.floor(line.length / 2)]!;
    const isInk = (rgb: number[]) => rgb.every((c, i) => Math.abs(c - ink[i]!) <= 24);
    const first = line.findIndex(isInk);
    const last = line.findLastIndex(isInk);
    const origin = across ? clip.x : clip.y;
    return {
      start: origin + first / scale,
      end: origin + (last + 1) / scale,
      holes: line.slice(first, last + 1).filter((rgb) => !isInk(rgb)).length,
    };
  };
  const down = (x: number, from: number, to: number) =>
    painted({ x: Math.floor(x), y: Math.floor(from), width: 1, height: Math.ceil(to - from) });

  const margin = 4;
  const half = layout.pitch / 2;
  const [top, second, bottom] = [rowTop(STACK_TOP), rowTop(STACK_TOP + 1), rowTop(STACK_TOP + 2)];
  const end = rowTop(STACK_TOP + 3);
  const stack = await down(layout.stack, top - margin, end + margin);
  const lower = await down(layout.lower, top + half / 2, second + margin);
  const upper = await down(layout.upper, bottom - margin, bottom + half * 1.5);
  const bar = await painted({
    x: Math.floor(layout.bar.left) - margin,
    y: Math.floor(rowTop(1) + half),
    width: Math.ceil(layout.bar.right - layout.bar.left) + 2 * margin,
    height: 1,
  });
  // Every number, on every assertion, for a person reading a failure in another engine.
  const seen = JSON.stringify({ top, box: layout.bar, stack, lower, upper, bar });

  expect(stack.holes, seen).toBe(0);
  expect(Math.abs(stack.start - top), seen).toBeLessThanOrEqual(1);
  expect(Math.abs(stack.end - end), seen).toBeLessThanOrEqual(1);

  expect(lower.holes, seen).toBe(0);
  expect(Math.abs(lower.start - (top + half)), seen).toBeLessThanOrEqual(1);
  expect(Math.abs(lower.end - second), seen).toBeLessThanOrEqual(1);

  expect(upper.holes, seen).toBe(0);
  expect(Math.abs(upper.start - bottom), seen).toBeLessThanOrEqual(1);
  expect(Math.abs(upper.end - (bottom + half)), seen).toBeLessThanOrEqual(1);

  expect(bar.holes, seen).toBe(0);
  expect(Math.abs(bar.start - layout.bar.left), seen).toBeLessThanOrEqual(1);
  expect(Math.abs(bar.end - layout.bar.right), seen).toBeLessThanOrEqual(1);
});

test("painting a cell changes none of the text the mirror carries", async ({ page }) => {
  // The character stays in the DOM as a text node: find offsets, link offsets and a clipboard copy
  // are all defined over these nodes, and a replaced glyph would move every one of them. The whole
  // screen is asserted, not a substring, so a duplicated cell fails here as loudly as a dropped one.
  const text = await page.locator("pre").first().textContent();
  expect(text).toBe(
    [
      "quota:",
      `${LEFT_CAP}${CHIP}${RIGHT_CAP} 5h ${FULL_BLOCK.repeat(8)} 91%`,
      "done",
      `${FULL_BLOCK.repeat(4)} ${LOWER_HALF.repeat(4)}`,
      FULL_BLOCK.repeat(4),
      `${FULL_BLOCK.repeat(4)} ${UPPER_HALF.repeat(4)}`,
    ].join("\n"),
  );
});

// The light theme is where a painted cell could go wrong invisibly. The `<pre>` carries
// `filter: invert(1) hue-rotate(180deg)` there (.adr/0002), and a filter rasterises the subtree, so
// it cannot tell a background pixel from a glyph pixel. Paint in `currentColor` is therefore the
// same colour as the ink it replaces, before and after the filter — argued in the CSS comment, and
// measured here.
//
// The pill makes the assertion exact: the cap's foreground and the chip's background are emitted as
// the SAME green, so one painted pixel and one span-background pixel must come out of the filter
// identical. A literal colour, a theme token, or `color: transparent` in that rule breaks this in
// light and leaves dark passing.
//
// The background pixel is the middle of the chip's leading SPACE, not a point near its letters: on
// Linux the fallback face's antialiasing reaches the top row of the chip, so a point that is clear
// of ink on one platform is not clear on another. A space has no ink in any face.
for (const theme of ["dark", "light"]) {
  test(`a painted cell and the background beside it land on one colour (${theme})`, async ({
    page,
  }) => {
    await page.addInitScript((value) => localStorage.setItem("collie:theme:v1", value), theme);
    await page.reload();
    await expect(page.getByText("quota:", { exact: true })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);

    const spots = await page.evaluate(
      ([chip, block]) => {
        const cell = [...document.querySelectorAll("pre .cell-glyph")]
          .find((el) => el.textContent === block)!
          .getBoundingClientRect();
        const letters = [...document.querySelectorAll("pre span")]
          .find((span) => span.textContent === chip && !span.classList.contains("cell-glyph"))!
          .getBoundingClientRect();
        const space = letters.width / chip.length;
        return {
          // The middle of a full block is solid paint.
          painted: { x: cell.left + cell.width / 2, y: cell.top + cell.height / 2 },
          background: { x: letters.left + space / 2, y: letters.top + letters.height / 2 },
        };
      },
      [CHIP, FULL_BLOCK],
    );

    const shoot = (spot: { x: number; y: number }) =>
      page.screenshot({
        clip: { x: Math.floor(spot.x), y: Math.floor(spot.y), width: 1, height: 1 },
        scale: "css",
      });
    expect(pixel(await shoot(spots.painted))).toEqual(pixel(await shoot(spots.background)));
  });
}
