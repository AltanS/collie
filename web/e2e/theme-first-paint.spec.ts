import { expect, test } from "@playwright/test";

import { installApiStub } from "./fixtures/api";
import { collieHalves } from "./fixtures/collie-theme";
import { STILL_MARK } from "./fixtures/still-mark";
import { DERIVED_TOKENS } from "../src/lib/theme/derive";

// A PINNED THEME PAINTS IN ITSELF ON THE FIRST FRAME (M57). public/theme-init.js reads the design
// blob and the theme library and sets the inline properties before the bundle's module script runs.
// The case seeds both keys with an imported theme whose dark ground is #123456, blocks every
// /assets/*.js request so the app never starts, and reads the property the stylesheet would
// otherwise take from index.css. If it already holds #123456 with the app dead, nothing the bundle
// does afterwards is what painted it.

test.use({ serviceWorkers: "block", colorScheme: "dark" });

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("states"), "the playground has no theme-init.js");
  await installApiStub(page);
});

// A version 1 file: the 43 required tokens, and not the optional `pane-active` (ADR 0120).
const theme = {
  version: 1,
  id: "midnight",
  name: "Midnight",
  light: collieHalves.light,
  dark: { ...collieHalves.dark, background: "#123456", secondary: "#123456" },
};

// THE INLINE COUNT, from the app's own lists, so the next token does not break a bare number. theme-init.js sets each
// token the theme names, plus the inline `--ground-image: none` an imported theme that names no ground gets
// (d0f225b95); the running app adds the derived tokens (lib/theme/derive.ts), and so does theme-init.js when it holds
// a stored copy of them that is current (ADR 0172). `ring` is both a theme token and a derived one.
const THEME_PROPERTIES = new Set([...Object.keys(theme.light), ...Object.keys(theme.dark), "ground-image"]);
const ONLY_DERIVED = DERIVED_TOKENS.filter((t) => !THEME_PROPERTIES.has(t));
const FIRST_FRAME_INLINE = THEME_PROPERTIES.size;
const RUNNING_INLINE = THEME_PROPERTIES.size + ONLY_DERIVED.length;
/** The key applyTheme stores the derived values under (lib/theme/store.ts; theme-init.test.ts holds the two equal). */
const DERIVED_KEY = "collie:derived:v1";

/** The inline value of each derived token on the root, `""` for one that is not set. */
async function inlineDerived(page: import("@playwright/test").Page): Promise<Record<string, string>> {
  return page.evaluate(
    (names) => Object.fromEntries(names.map((n) => [n, document.documentElement.style.getPropertyValue(`--${n}`)])),
    [...DERIVED_TOKENS],
  );
}

async function seed(page: import("@playwright/test").Page) {
  await page.addInitScript(
    ([design, library]) => {
      localStorage.setItem("collie:design:v1", design);
      localStorage.setItem("collie:themes:v1", library);
    },
    [
      JSON.stringify({ ...STILL_MARK, font: "aldrich", theme: "midnight" }),
      JSON.stringify({ version: 1, themes: [theme] }),
    ] as const,
  );
}

test("an imported theme is on the page before the bundle runs", async ({ page }) => {
  await seed(page);
  await page.route("**/assets/*.js", (route) => route.abort());
  await page.goto("/");
  const seen = await page.evaluate(() => {
    const html = document.documentElement;
    return {
      background: getComputedStyle(html).getPropertyValue("--background"),
      inline: html.style.length,
      paneActive: html.style.getPropertyValue("--pane-active"),
      attribute: html.getAttribute("data-theme"),
      body: getComputedStyle(document.body).backgroundColor,
    };
  });
  expect(seen.background).toContain("#123456");
  // Nothing derived is stored on this device yet, so the first frame holds the theme's own tokens only.
  expect(seen.inline).toBe(FIRST_FRAME_INLINE);
  const derived = await inlineDerived(page);
  for (const name of ONLY_DERIVED) expect(derived[name], name).toBe("");
  // The theme leaves the optional token out, so index.css's pair holds and nothing is set inline.
  expect(seen.paneActive).toBe("");
  expect(seen.attribute).toBeNull();
});

// THE SHAPE PAINTS FIRST TOO (schema version 2). A version 2 file with `radius: round` sets the four
// radius steps before the bundle runs, so a `rounded-md` element is 12px round on the first frame.
// The probe element carries the same utility class the app draws with; the stylesheet is a <link> in
// index.html, so it is in force while every script of the bundle is blocked.
async function firstFrameRadius(page: import("@playwright/test").Page): Promise<string> {
  await page.route("**/assets/*.js", (route) => route.abort());
  await page.goto("/");
  return page.evaluate(() => {
    const probe = document.createElement("div");
    probe.className = "rounded-md";
    document.body.append(probe);
    return getComputedStyle(probe).borderTopLeftRadius;
  });
}

test("a version 2 theme's radius is on the page before the bundle runs", async ({ page }) => {
  const round = { ...theme, version: 2, surface: { radius: "round" } };
  await page.addInitScript(
    ([design, library]) => {
      localStorage.setItem("collie:design:v1", design);
      localStorage.setItem("collie:themes:v1", library);
    },
    [
      JSON.stringify({ ...STILL_MARK, font: "aldrich", theme: "midnight" }),
      JSON.stringify({ version: 1, themes: [round] }),
    ] as const,
  );
  expect(await firstFrameRadius(page)).toBe("12px");
  expect(await page.evaluate(() => document.documentElement.style.getPropertyValue("--radius-md"))).toBe("12px");
});

test("the default theme's radius on the first frame is the sharp 2px", async ({ page }) => {
  await page.addInitScript((blob) => localStorage.setItem("collie:design:v1", blob), JSON.stringify({ ...STILL_MARK, font: "aldrich" }));
  expect(await firstFrameRadius(page)).toBe("2px");
});

test("a device on the default theme gets no attribute and no inline property", async ({ page }) => {
  await page.addInitScript((blob) => localStorage.setItem("collie:design:v1", blob), JSON.stringify({ ...STILL_MARK, font: "aldrich" }));
  await page.route("**/assets/*.js", (route) => route.abort());
  await page.goto("/");
  const seen = await page.evaluate(() => ({
    style: document.documentElement.getAttribute("style"),
    attribute: document.documentElement.getAttribute("data-theme"),
  }));
  expect(seen).toEqual({ style: null, attribute: null });
});

test("a device that stored the retired collie-new paints the default on the first frame", async ({ page }) => {
  await page.addInitScript((blob) => localStorage.setItem("collie:design:v1", blob), JSON.stringify({ ...STILL_MARK, font: "atkinson", theme: "collie-new" }));
  await page.route("**/assets/*.js", (route) => route.abort());
  await page.goto("/");
  const seen = await page.evaluate(() => ({
    style: document.documentElement.getAttribute("style"),
    attribute: document.documentElement.getAttribute("data-theme"),
    band: getComputedStyle(document.documentElement).getPropertyValue("--band-ground"),
    secondary: getComputedStyle(document.documentElement).getPropertyValue("--secondary"),
  }));
  // The stylesheet alone paints the band: --band-ground resolves to --secondary, under the dark scheme here.
  expect(seen).toMatchObject({ style: null, attribute: null });
  expect(seen.band).toBe(seen.secondary);
  expect(seen.band).toContain(".003 80");
});

// THE DEFAULT FACE IS ATKINSON (2026-11-06), on the first frame, with the bundle blocked. Nothing stored
// is a fresh phone; `{ theme: "collie" }` is the same device; a stored `aldrich` is a deliberate pick.
async function firstFrameFace(page: import("@playwright/test").Page, stored: string | null) {
  if (stored !== null) await page.addInitScript((blob) => localStorage.setItem("collie:design:v1", blob), stored);
  await page.route("**/assets/*.js", (route) => route.abort());
  await page.goto("/");
  return page.evaluate(() => ({
    classes: document.documentElement.className,
    stack: getComputedStyle(document.documentElement).getPropertyValue("--font-sans").trim(),
    body: getComputedStyle(document.body).fontFamily,
  }));
}

test("a fresh phone paints Atkinson on the first frame", async ({ page }) => {
  const seen = await firstFrameFace(page, null);
  expect(seen.classes).not.toContain("font-");
  expect(seen.stack).toMatch(/^"Atkinson Hyperlegible Next"/);
  expect(seen.body).toMatch(/^"?Atkinson Hyperlegible Next/);
});

test("a device with only theme collie stored paints Atkinson on the first frame", async ({ page }) => {
  const seen = await firstFrameFace(page, JSON.stringify({ theme: "collie" }));
  expect(seen.classes).not.toContain("font-");
  expect(seen.stack).toMatch(/^"Atkinson Hyperlegible Next"/);
});

test("a device that stored aldrich keeps Aldrich on the first frame", async ({ page }) => {
  const seen = await firstFrameFace(page, JSON.stringify({ ...STILL_MARK, font: "aldrich" }));
  expect(seen.classes).toContain("font-aldrich");
  expect(seen.stack).toMatch(/^"Aldrich"/);
  expect(seen.body).toMatch(/^"?Aldrich/);
});

test("a stored theme with a hostile value paints nothing from that token", async ({ page }) => {
  const hostile = { ...theme, dark: { ...theme.dark, background: "url(https://x.test/a.png)", foreground: "#abcdef" } };
  await page.addInitScript(
    ([design, library]) => {
      localStorage.setItem("collie:design:v1", design);
      localStorage.setItem("collie:themes:v1", library);
    },
    [
      JSON.stringify({ ...STILL_MARK, font: "aldrich", theme: "midnight" }),
      JSON.stringify({ version: 1, themes: [hostile] }),
    ] as const,
  );
  await page.route("**/assets/*.js", (route) => route.abort());
  await page.goto("/");
  const seen = await page.evaluate(() => ({
    background: document.documentElement.style.getPropertyValue("--background"),
    foreground: document.documentElement.style.getPropertyValue("--foreground"),
  }));
  expect(seen.background).toBe("");
  expect(seen.foreground).toContain("#abcdef");
});

test("setting the theme's properties before paint costs well under 5 ms", async ({ page }, testInfo) => {
  await seed(page);
  await page.route("**/assets/*.js", (route) => route.abort());
  await page.goto("/");
  const ms = await page.evaluate(async () => {
    const text = await (await fetch("/theme-init.js")).text();
    document.documentElement.removeAttribute("style");
    const runs: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      document.documentElement.removeAttribute("style");
      const t0 = performance.now();
      new Function(text)();
      runs.push(performance.now() - t0);
    }
    return runs.toSorted((a, b) => a - b)[10] ?? 0;
  });
  testInfo.annotations.push({ type: "median ms", description: ms.toFixed(3) });
  console.log(`theme-init.js median over 20 runs: ${ms.toFixed(3)} ms`);
  expect(ms).toBeLessThan(5);
});

test("the running app keeps the theme and moves the browser-chrome colour with it", async ({ page }) => {
  await seed(page);
  await page.goto("/");
  await expect(page.locator("#root")).not.toBeEmpty();
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')].map((m) => m.content),
      ),
    )
    .toEqual(["#e4e3e0", "#123456"]);
  const inline = await page.evaluate(() => document.documentElement.style.length);
  expect(inline).toBe(RUNNING_INLINE);
  for (const [name, value] of Object.entries(await inlineDerived(page))) expect(value, name).toMatch(/^light-dark\(/);
});

// THE DERIVED COLOURS ARE ON THE FIRST FRAME (ADR 0172). The running app stores what it derived, keyed by the theme
// id, a hash of its halves and DERIVE_VERSION; theme-init.js sets that copy before the bundle runs, with no
// derivation of its own. The first visit runs the app and stores it; the second blocks the bundle.
async function runOnceAndStore(page: import("@playwright/test").Page): Promise<Record<string, string>> {
  await seed(page);
  await page.goto("/");
  await expect(page.locator("#root")).not.toBeEmpty();
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key) !== null, DERIVED_KEY)).toBe(true);
  const running = await inlineDerived(page);
  for (const [name, value] of Object.entries(running)) expect(value, name).toMatch(/^light-dark\(/);
  return running;
}

test("a stored, current copy of the derived colours is on the page before the bundle runs", async ({ page }) => {
  const running = await runOnceAndStore(page);
  await page.route("**/assets/*.js", (route) => route.abort());
  await page.reload();
  // Every /assets/*.js request is aborted, so no line of the bundle ran: theme-init.js alone set what follows.
  expect(await inlineDerived(page)).toEqual(running);
  expect(await page.evaluate(() => document.documentElement.style.length)).toBe(RUNNING_INLINE);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--background"))).toContain("#123456");
});

test("a stale stored copy is ignored, and the theme still paints", async ({ page }) => {
  await runOnceAndStore(page);
  // Another theme's halves: the hash no longer matches what the library holds.
  await page.evaluate((key) => {
    // The stored record is an object (runOnceAndStore waited for it); only its hash is replaced.
    localStorage.setItem(key, (localStorage.getItem(key) ?? "").replace(/"hash":"[0-9a-f]{8}"/, '"hash":"00000000"'));
  }, DERIVED_KEY);
  await page.route("**/assets/*.js", (route) => route.abort());
  await page.reload();
  const seen = await inlineDerived(page);
  for (const name of ONLY_DERIVED) expect(seen[name], name).toBe("");
  expect(await page.evaluate(() => document.documentElement.style.length)).toBe(FIRST_FRAME_INLINE);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--background"))).toContain("#123456");
});

// UNDER A MOUNT (ADR 0052). theme-init.js holds no path, so it should not care, but the shell has to
// name it `/collie/theme-init.js` for it to load at all, and that rewrite is the bridge's. 4175 is
// the bundle served by the bridge's own `serveStatic` under `/collie/` (`e2e/serve-mount.ts`).
test.describe("under /collie/", () => {
  test.use({ baseURL: "http://127.0.0.1:4175" });

  test("theme-init.js loads from the mount and paints the theme before the bundle runs", async ({ page }) => {
    await seed(page);
    await page.route("**/assets/*.js", (route) => route.abort());
    const loaded = page.waitForResponse((r) => new URL(r.url()).pathname === "/collie/theme-init.js");
    await page.goto("/collie/");
    expect((await loaded).status()).toBe(200);
    const seen = await page.evaluate(() => ({
      background: getComputedStyle(document.documentElement).getPropertyValue("--background"),
      inline: document.documentElement.style.length,
      script: document.querySelector("script[src$='theme-init.js']")?.getAttribute("src"),
    }));
    expect(seen.script).toBe("/collie/theme-init.js");
    expect(seen.background).toContain("#123456");
    expect(seen.inline).toBe(FIRST_FRAME_INLINE);
  });
});
