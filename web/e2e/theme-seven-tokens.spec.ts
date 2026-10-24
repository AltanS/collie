import { expect, test, type BrowserContext, type Page, type TestInfo } from "@playwright/test";

import { installApiStub } from "./fixtures/api";
import { collieHalves } from "./fixtures/collie-theme";

// THE SEVEN MORE TOKENS PAINT (M57 spec 17). The unit tier holds every word's declarations equal to
// the table and every default equal to index.css; this tier opens the shipped bundle with an imported
// theme that names a non-default word for each of the seven, and reads what the browser computed:
// the ground on html, the band under the header and the tab bar, rows as cards, the icon stroke, the
// label case, the display face, and the mirror's palette. It also logs every font file the page asks
// for, which is the proof that the default look fetches no new byte and a display face costs exactly
// one file.

const PALETTE = {
  "0": "#000000", "1": "#cd3131", "2": "#0dbc79", "3": "#e5e510", "4": "#2472c8", "5": "#bc3fbc",
  "6": "#11a8cd", "7": "#e5e5e5", "8": "#666666", "9": "#f14c4c", "10": "#23d18b", "11": "#f5f543",
  "12": "#3b8eea", "13": "#d670d6", "14": "#29b8db", "15": "#ffffff", ink: "#fafafa", ground: "#14141e",
};

// A version 2 file: collie's 43 required tokens, never the version 3 `pane-active` (ADR 0120).
const ALL = {
  version: 2,
  id: "seven",
  name: "Seven",
  light: collieHalves.light,
  dark: collieHalves.dark,
  fonts: { display: "geist" },
  surface: { ground: "gradient", chrome: "band", rows: "cards", icons: "heavy", labels: "sentence" },
  ansi: PALETTE,
};

/** The fonts this page fetched: the file names of every `.woff2` request. */
function logFonts(page: Page): string[] {
  const fonts: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (url.endsWith(".woff2")) fonts.push(url.slice(url.lastIndexOf("/") + 1));
  });
  return fonts;
}

async function openWith(context: BrowserContext, theme: typeof ALL | undefined, path: string): Promise<{ page: Page; fonts: string[] }> {
  const page = await context.newPage();
  const fonts = logFonts(page);
  await installApiStub(page);
  if (theme !== undefined) {
    await page.addInitScript(
      ([design, library]) => {
        localStorage.setItem("collie:design:v1", design);
        localStorage.setItem("collie:themes:v1", library);
      },
      [JSON.stringify({ font: "aldrich", theme: "seven" }), JSON.stringify({ version: 1, themes: [theme] })] as const,
    );
  }
  await page.goto(path);
  await expect(page.locator("#root")).not.toBeEmpty();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  return { page, fonts };
}

/** The computed colour of a throwaway box painted with `value`, so a token compares as the browser resolves it. */
async function resolved(page: Page, value: string): Promise<string> {
  return page.evaluate((v) => {
    const probe = document.createElement("div");
    probe.style.background = v;
    document.body.append(probe);
    const out = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return out;
  }, value);
}

/** A computed colour as the sRGB hex a theme-color meta carries, read back from one canvas pixel. */
async function srgbHex(page: Page, colour: string): Promise<string> {
  return page.evaluate((c) => {
    const ctx = document.createElement("canvas").getContext("2d");
    if (ctx === null) return "";
    ctx.fillStyle = c;
    ctx.fillRect(0, 0, 1, 1);
    return `#${Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3), (n) => n.toString(16).padStart(2, "0")).join("")}`;
  }, colour);
}

function onlyPhone(testInfo: TestInfo): void {
  test.skip(testInfo.project.name !== "app-phone", "computed styles, one Chromium phone is enough");
}

test("the Collie look fetches only its own face, and draws every default", async ({ browser }, testInfo) => {
  onlyPhone(testInfo);
  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL, serviceWorkers: "block" });
  const { page, fonts } = await openWith(context, undefined, "/");
  expect(fonts.filter((f) => !f.startsWith("ui-aldrich") && !f.startsWith("nerd"))).toEqual([]);
  const seen = await page.evaluate(() => {
    const view = window;
    const style = (el: Element | null | undefined) => (el === null || el === undefined ? undefined : view.getComputedStyle(el));
    const row = document.querySelector('[data-slot="list-group"] > :nth-child(2)');
    return {
      ground: style(document.documentElement)?.backgroundImage,
      header: style(document.querySelector("header"))?.backgroundColor,
      page: style(document.documentElement)?.backgroundColor,
      rowGap: style(row)?.marginTop,
      rowEdge: style(row)?.borderLeftWidth,
      rowShadow: style(row)?.boxShadow,
      stroke: style(document.querySelector("svg.lucide"))?.strokeWidth,
      label: style(document.querySelector(".label-caps"))?.textTransform,
      tracking: style(document.querySelector(".label-caps"))?.letterSpacing,
    };
  });
  expect(seen).toEqual({
    ground: "none",
    header: seen.page,
    page: seen.page,
    rowGap: "0px",
    rowEdge: "0px",
    rowShadow: "none",
    stroke: "2px",
    label: "uppercase",
    tracking: seen.tracking,
  });
  // tracking-wide at the label's own size: 0.025em of 11px.
  expect(Number.parseFloat(seen.tracking ?? "0")).toBeCloseTo(0.275, 2);
  await context.close();
});

test("a theme naming all seven paints each one, and its display face costs exactly one file", async ({ browser }, testInfo) => {
  onlyPhone(testInfo);
  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL, serviceWorkers: "block" });
  const { page, fonts } = await openWith(context, ALL, "/");
  expect(fonts.filter((f) => f.startsWith("ui-geist"))).toHaveLength(1);
  expect(fonts.filter((f) => !f.startsWith("ui-aldrich") && !f.startsWith("nerd") && !f.startsWith("ui-geist"))).toEqual([]);

  const secondary = await resolved(page, "var(--secondary)");
  const seen = await page.evaluate(() => {
    const view = window;
    const style = (el: Element | null | undefined) => (el === null || el === undefined ? undefined : view.getComputedStyle(el));
    const group = [...document.querySelectorAll('[data-slot="list-group"]')].find((g) => g.children.length > 1);
    const row = group?.children.item(1) ?? null;
    const meta = [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')].map((m) => m.content);
    return {
      ground: style(document.documentElement)?.backgroundImage,
      header: style(document.querySelector("header"))?.backgroundColor,
      tabBar: style(document.querySelector('[data-slot="tab-bar"]'))?.backgroundColor,
      groupFrame: style(group)?.borderTopWidth,
      rowGap: style(row)?.marginTop,
      rowEdge: style(row)?.borderTopWidth,
      rowShadow: style(row)?.boxShadow,
      stroke: style(document.querySelector("svg.lucide"))?.strokeWidth,
      label: style(document.querySelector(".label-caps"))?.textTransform,
      identity: style(document.querySelector('[data-slot="header-identity"]'))?.fontFamily,
      meta,
    };
  });
  expect(seen.ground).toContain("linear-gradient");
  expect(seen.header).toBe(secondary);
  expect(seen.tabBar).toBe(secondary);
  expect(seen.groupFrame).toBe("0px");
  expect(seen.rowGap).toBe("8px");
  expect(seen.rowEdge).toBe("1px");
  expect(seen.rowShadow).not.toBe("none");
  expect(seen.stroke).toBe("2.5px");
  expect(seen.label).toBe("none");
  expect(seen.identity).toMatch(/^"?Geist"?/);
  // The status bar wears the band: the light meta is secondary's light half as sRGB hex. A canvas
  // pixel turns the computed colour (an oklch() string) into the sRGB bytes the meta carries.
  expect(seen.meta[0]).toBe(await srgbHex(page, secondary));
  expect(seen.meta[0]).not.toBe(await srgbHex(page, await resolved(page, "var(--background)")));

  await page.goto("/pane/w1:p1");
  await expect(page.locator("pre").first()).toBeVisible();
  const mirror = await page.evaluate(() => {
    const pre = [...document.querySelectorAll("pre")].find((p) => p.className.includes("--mirror-ground"));
    return pre === undefined ? undefined : getComputedStyle(pre).backgroundColor;
  });
  expect(mirror).toBe("rgb(20, 20, 30)");

  await page.goto("/settings");
  await expect(page.locator("h1").first()).toBeVisible();
  expect(await page.locator("h1").first().evaluate((h) => getComputedStyle(h).fontFamily)).toMatch(/^"?Geist"?/);
  // The settings index is a list group inside its one card: under `cards` its rows are cards too.
  const index = page.locator('[data-slot="card"] > [data-slot="list-group"]').first();
  expect(await index.evaluate((g) => [getComputedStyle(g).paddingTop, getComputedStyle(g.children[1] ?? g).marginTop])).toEqual(["8px", "8px"]);
  await context.close();
});
