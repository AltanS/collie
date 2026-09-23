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
// The fix rests on ONE property, and it is the property asserted here: a painted cell is an inline
// box carrying a background, so it paints exactly the same content area as the span beside it. A
// later hand reaching for `display: inline-block` with a height in line boxes is the regression —
// it measures 0.27px short at each end in WebKit — and it fails here and nowhere else.
//
// The geometry cases compare two boxes and the space between them, the same kind of measure
// `codex-padding.spec.ts` takes, so they hold at any font size and in either engine. Only the colour
// case reads pixels, one against another, never against a constant.
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

const SCREEN = ["quota:", PILL_LINE, "done"].join("\n");

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

/** The RGB of a 1x1 PNG. Playwright hands back an encoded screenshot and the comparison that
 *  matters is one colour, so this reads the single pixel rather than pulling in a decoder: one
 *  IDAT, inflated, is a filter byte and then the channels. */
function pixel(png: Buffer): number[] {
  let at = 8;
  const parts: Buffer[] = [];
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    if (png.toString("ascii", at + 4, at + 8) === "IDAT") {
      parts.push(png.subarray(at + 8, at + 8 + length));
    }
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(parts));
  return [raw[1]!, raw[2]!, raw[3]!];
}

test("a painted cell covers the same rows as the text beside it", async ({ page }) => {
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

  // Same two rows, top and bottom. A cap that is shorter than this leaves the page background
  // showing above and below it, which is the step the pill used to have.
  expect(measured.cap.top).toBeCloseTo(measured.letters.top, 1);
  expect(measured.cap.bottom).toBeCloseTo(measured.letters.bottom, 1);
});

test("a run of full blocks meets cell to cell, with no seam", async ({ page }) => {
  const gaps = await page.evaluate(
    ([block]) => {
      const run = [...document.querySelectorAll("pre .cell-glyph")].filter(
        (el) => el.textContent === block,
      );
      const boxes = run.map((el) => el.getBoundingClientRect());
      return {
        count: boxes.length,
        // The distance from one cell's right edge to the next cell's left edge. Anything above
        // zero is a gap the page background shows through — a bar with stripes in it.
        worst: boxes
          .slice(1)
          .reduce((worst, box, i) => Math.max(worst, box.left - boxes[i]!.right), 0),
      };
    },
    [FULL_BLOCK],
  );

  expect(gaps.count).toBe(8);
  expect(gaps.worst).toBeLessThanOrEqual(0.01);
});

test("painting a cell changes none of the text the mirror carries", async ({ page }) => {
  // The character stays in the DOM as a text node: find offsets, link offsets and a clipboard copy
  // are all defined over these nodes, and a replaced glyph would move every one of them. The whole
  // screen is asserted, not a substring, so a duplicated cell fails here as loudly as a dropped one.
  const text = await page.locator("pre").first().textContent();
  expect(text).toBe(
    ["quota:", `${LEFT_CAP}${CHIP}${RIGHT_CAP} 5h ${FULL_BLOCK.repeat(8)} 91%`, "done"].join("\n"),
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
