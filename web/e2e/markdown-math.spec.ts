import { expect, test, type Page } from "@playwright/test";

import { fixtureAgents } from "@/test/handlers";
import { fixtureMathFile, fixtureMathTranscript } from "@/test/math-fixtures";
import type { MathPackStatus } from "@/lib/types";

import { installApiStub } from "./fixtures/api";
import { serveWithShellCsp } from "./fixtures/csp";

const PANE = encodeURIComponent(fixtureAgents[0]!.paneId);
const FILE = `/pane/${PANE}/changes/files?path=README.md`;
/** Long enough for a second reload to show if the guard failed: two of the card's polls. */
const SETTLE_MS = 2500;

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
    test(`equations fit the phone and load only same-origin files in ${theme}`, async ({ page }) => {
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

// THE SERVICE WORKER KEEPS AN ENGINE ONCE IT IS USED. The engines are not in the precache
// (vite.config.ts, `math/**`), so src/sw.ts caches each file the first time a page under its control
// asks for it, and answers from that cache after. Only a real worker can show it, so this case lets
// one run. One viewport: a worker has none.
test.describe("a math engine under the service worker", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "app-phone", "a service worker has no viewport");
    await chooseEngine(page, "katex");
    await installMathStub(page);
  });

  test("is cached on first use and served from the cache after", async ({ page }) => {
    await page.goto(FILE);
    // The first load registers the worker; the engine it fetched went past it. Once the worker
    // controls the page, a reload fetches the engine through it.
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    await page.reload();
    await expect(page.getByRole("math")).toHaveCount(5);
    const cached = await page.evaluate(async () => {
      const cache = await caches.open("collie-math");
      return (await cache.keys()).map((request) => new URL(request.url).pathname);
    });
    expect(cached.some((path) => /^\/math\/katex\/katex-[^/]+\.js$/.test(path))).toBe(true);
    expect(cached.some((path) => /^\/math\/katex\/katex-[^/]+\.css$/.test(path))).toBe(true);
    expect(cached.some((path) => /^\/math\/katex\/KaTeX_Main-Regular-[^/]+\.woff2$/.test(path))).toBe(true);

    const fromWorker: boolean[] = [];
    page.on("response", (response) => {
      if (new URL(response.url()).pathname.startsWith("/math/katex/")) fromWorker.push(response.fromServiceWorker());
    });
    await page.reload();
    await expect(page.getByRole("math")).toHaveCount(5);
    expect(fromWorker.length).toBeGreaterThan(0);
    expect(fromWorker.every(Boolean)).toBe(true);
  });
});

// THE ENGINES ARE A PACK THE HOST DOWNLOADS (ADR 0132). This target serves `web/dist`, which holds
// `math/` the way a host with the pack serves it. A host without the pack answers 404 under `/math/`,
// which only a real dynamic import can show failing; a host with it serves the files a tap fetched.
// The download itself (manifest, hash, unpack) is the bridge's, in bridge/math/store.test.ts.
test.describe("the math pack on the host", () => {
  test.use({ serviceWorkers: "block" });

  /** What the stubbed host holds: the status it answers and how many downloads were asked for. */
  interface HostPack {
    status: MathPackStatus;
    posts: number;
  }

  /** `GET /api/math` answers `state.status`; a `POST` starts the download and counts. */
  async function hostPack(page: Page, initial: MathPackStatus): Promise<HostPack> {
    const state: HostPack = { status: initial, posts: 0 };
    await page.route("**/api/math", async (route) => {
      if (route.request().method() === "POST") {
        state.posts++;
        state.status = { state: "downloading", received: 0, total: 3_994_976 };
        return route.fulfill({ status: 202, json: state.status });
      }
      return route.fulfill({ json: state.status });
    });
    return state;
  }

  test("absent: the card offers the download, and an engine chosen before draws the source", async ({ page }) => {
    await chooseEngine(page, "katex");
    await installMathStub(page);
    const state = await hostPack(page, { state: "absent" });
    const engineRequests: string[] = [];
    await page.route((url) => url.pathname.startsWith("/math/"), (route) => {
      engineRequests.push(route.request().url());
      return route.fulfill({ status: 404, body: "not found" });
    });

    await page.goto(FILE);
    await expect(page.getByText("Prices remain $5 and $10.")).toBeVisible();
    await expect.poll(() => engineRequests.length).toBeGreaterThan(0);
    await expect(page.getByRole("math")).toHaveCount(0);
    await expect(page.getByText(/\\sum_\{i=1\}/).first()).toBeVisible();

    await page.goto("/settings/appearance");
    await expect(page.getByRole("button", { name: /Download the math engines/ })).toBeVisible();
    await expect(page.getByLabel("Engine", { exact: true })).toHaveValue("off");
    expect(state.posts).toBe(0);
  });

  test("downloaded: choosing KaTeX on the card fetches the pack, then equations render", async ({ page }) => {
    await installMathStub(page);
    const state = await hostPack(page, { state: "absent" });

    await page.goto("/settings/appearance");
    await expect(page.getByRole("button", { name: /Download the math engines/ })).toBeVisible();
    await page.getByLabel("Engine", { exact: true }).selectOption("katex");
    await expect(page.getByRole("progressbar", { name: "Math engines download" })).toBeVisible();
    expect(state.posts).toBe(1);

    state.status = { state: "ready", version: "1.29.0", source: "store", bytes: 3_994_976 };
    await expect(page.getByLabel("Engine", { exact: true })).toHaveValue("katex");
    await expect(page.getByRole("button", { name: "Remove the math engines" })).toBeVisible();

    await page.goto(FILE);
    await expect(page.getByRole("math")).toHaveCount(5);
  });

  // Review 2, item 1, in a real engine: Vite's preload helper will not load a stylesheet twice, so an
  // engine that failed on this page comes back by ONE reload when the pack arrives, never a second import.
  test("an engine that failed on this page comes back after the download, by one reload", async ({ page }) => {
    await chooseEngine(page, "katex");
    await installMathStub(page);
    const state = await hostPack(page, { state: "absent" });
    let served = false;
    await page.route((url) => url.pathname.startsWith("/math/"), (route) =>
      served ? route.fallback() : route.fulfill({ status: 404, body: "not found" }),
    );
    let loads = 0;
    page.on("load", () => loads++);

    // The page starts with the stored engine and the host has no pack: KaTeX fails on this page.
    await page.goto("/settings/appearance");
    await page.getByRole("button", { name: /Download the math engines/ }).click();
    await expect(page.getByRole("progressbar", { name: "Math engines download" })).toBeVisible();
    const before = loads;

    served = true;
    state.status = { state: "ready", version: "1.29.0", source: "store", bytes: 3_994_976 };
    await expect.poll(() => loads).toBe(before + 1);
    await expect(page.getByLabel("Engine", { exact: true })).toHaveValue("katex");
    // The reloaded page has KaTeX whole: its stylesheet is in, and nothing reloads again.
    await expect
      .poll(() => page.evaluate(() => [...document.styleSheets].some((sheet) => sheet.href?.includes("/math/katex/") === true)))
      .toBe(true);
    await page.waitForTimeout(SETTLE_MS);
    expect(loads).toBe(before + 1);

    await page.goto(FILE);
    await expect(page.getByRole("math")).toHaveCount(5);
  });
});
