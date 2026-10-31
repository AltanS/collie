import { expect, test, type Page } from "@playwright/test";

import { fixtureAgents } from "@/test/handlers";
import { fixtureMathFile, fixtureMathTranscript } from "@/test/math-fixtures";

import { installApiStub } from "./fixtures/api";
import { serveWithShellCsp } from "./fixtures/csp";

const PANE = encodeURIComponent(fixtureAgents[0]!.paneId);
const FILE = `/pane/${PANE}/changes/files?path=README.md`;

async function installMathStub(page: Page) {
  await installApiStub(page);
  await page.route("**/api/**/files?path=README.md", (route) => route.fulfill({ json: fixtureMathFile() }));
  await page.route("**/api/**/history**", (route) => route.fulfill({ json: {
    paneId: fixtureAgents[0]!.paneId,
    available: true,
    entries: fixtureMathTranscript,
    hasMore: false,
    total: fixtureMathTranscript.length,
    fileTruncated: false,
  } }));
  await serveWithShellCsp(page);
}

/** The device's math engine, chosen before the first navigation (lib/design.ts, `collie:design:v1`). */
async function chooseEngine(page: Page, engine: string) {
  await page.addInitScript((value) => localStorage.setItem("collie:design:v1", JSON.stringify({ font: "aldrich", math: value })), engine);
}

test.describe("equations off by default", () => {
  test.use({ serviceWorkers: "block" });
  test.beforeEach(async ({ page }) => installMathStub(page));

  test("draws the source and requests no engine", async ({ page }) => {
    const engineRequests: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.includes("/math/")) engineRequests.push(request.url());
    });
    await page.goto(FILE);
    await expect(page.getByText("Prices remain $5 and $10.")).toBeVisible();
    await expect(page.getByRole("math")).toHaveCount(0);
    expect(engineRequests).toEqual([]);
  });
});

for (const engine of ["katex", "mathjax"]) test.describe(`equations with ${engine} under the bridge CSP`, () => {
  test.use({ serviceWorkers: "block" });
  test.beforeEach(async ({ page }) => {
    await chooseEngine(page, engine);
    await installMathStub(page);
  });

  for (const theme of ["light", "dark"]) {
    test(`equations fit the phone and load only same-origin files in ${theme}`, async ({ page }, testInfo) => {
      await page.addInitScript((value) => localStorage.setItem("collie:theme:v1", value), theme);
      const failed: string[] = [];
      page.on("requestfailed", (request) => failed.push(request.url()));
      const violations: string[] = [];
      page.on("console", (message) => {
        if (/Content.Security.Policy/i.test(message.text())) violations.push(message.text());
      });
      await page.goto(FILE);
      const equations = page.getByRole("math");
      await expect(equations).toHaveCount(5);
      await page.evaluate(() => document.fonts.ready);
      if (engine === "katex") {
        const fonts = await page.evaluate(() => [...document.fonts]
          .filter((font) => font.family.startsWith("KaTeX_") && font.status === "loaded").map((font) => font.family));
        expect(fonts).toContain("KaTeX_Main");
      }
      expect(failed).toEqual([]);
      expect(violations).toEqual([]);

      const widths = await equations.evaluateAll((nodes) => nodes.map((node) => {
        const box = node.closest<HTMLElement>('[data-slot="math"]')!;
        return { width: box.clientWidth, scroll: box.scrollWidth, viewport: window.innerWidth };
      }));
      for (const box of widths) expect(box.width).toBeLessThanOrEqual(box.viewport);
      // Both the wide display and wide inline equation pan inside themselves.
      for (const index of [3, 4]) {
        expect(widths[index]!.scroll).toBeGreaterThan(widths[index]!.width);
        // The formula's first glyph is reachable: at the scroller's start it sits at its left edge.
        const clipped = await equations.nth(index).evaluate((node) => {
          const box = node.closest<HTMLElement>('[data-slot="math"]')!;
          box.scrollLeft = 0;
          const drawn = box.querySelector(".katex-html, svg") ?? node;
          return box.getBoundingClientRect().left - drawn.getBoundingClientRect().left;
        });
        expect(clipped).toBeLessThanOrEqual(1);
        const panned = await equations.nth(index).evaluate((node) => {
          const box = node.closest<HTMLElement>('[data-slot="math"]')!;
          box.scrollLeft = box.scrollWidth;
          return box.scrollLeft;
        });
        expect(panned).toBeGreaterThan(0);
      }
      expect(await page.evaluate(() => document.scrollingElement!.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
      await page.screenshot({ path: testInfo.outputPath(`equations-${engine}.png`), fullPage: true });
    });
  }

  // A display equation that fits is centred under both engines. MathJax draws an svg, which the
  // stylesheet's base rules make a block unless mathjax.css says otherwise; a block ignores the
  // container's `text-align: center` and sits at the left.
  test("a display equation that fits is centred", async ({ page }) => {
    await page.goto(FILE);
    const equations = page.getByRole("math");
    await expect(equations).toHaveCount(5);
    await page.evaluate(() => document.fonts.ready);
    const offsets = await equations.evaluateAll((nodes) => nodes.flatMap((node) => {
      const box = node.closest<HTMLElement>('[data-slot="math"]')!;
      if (getComputedStyle(box).display !== "block" || box.scrollWidth > box.clientWidth) return [];
      const outer = box.getBoundingClientRect();
      // KaTeX's `.katex-html` spans the line, so its glyphs are measured as a range; an svg is its own box.
      const katex = box.querySelector(".katex-html");
      const range = document.createRange();
      if (katex) range.selectNodeContents(katex);
      const drawn = katex ? range.getBoundingClientRect() : (box.querySelector("svg") ?? node).getBoundingClientRect();
      return [{ offset: Math.abs(drawn.left + drawn.width / 2 - (outer.left + outer.width / 2)), width: drawn.width, line: outer.width }];
    }));
    expect(offsets.length).toBeGreaterThan(0);
    for (const { offset, width, line } of offsets) {
      // A formula as wide as its line would pass at any alignment; this fixture's is far narrower.
      expect(width).toBeLessThan(line / 2);
      expect(offset).toBeLessThanOrEqual(2);
    }
  });

  test("the same equations render in History", async ({ page }) => {
    await page.goto(`/pane/${PANE}/history`);
    await expect(page.getByRole("math")).toHaveCount(5);
  });
});
