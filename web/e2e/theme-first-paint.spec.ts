import { expect, test } from "@playwright/test";

import { installApiStub } from "./fixtures/api";
import { collieHalves } from "./fixtures/collie-theme";

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
  dark: { ...collieHalves.dark, background: "#123456" },
};

async function seed(page: import("@playwright/test").Page) {
  await page.addInitScript(
    ([design, library]) => {
      localStorage.setItem("collie:design:v1", design);
      localStorage.setItem("collie:themes:v1", library);
    },
    [
      JSON.stringify({ font: "aldrich", theme: "midnight" }),
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
  expect(seen.inline).toBe(43);
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
      JSON.stringify({ font: "aldrich", theme: "midnight" }),
      JSON.stringify({ version: 1, themes: [round] }),
    ] as const,
  );
  expect(await firstFrameRadius(page)).toBe("12px");
  expect(await page.evaluate(() => document.documentElement.style.getPropertyValue("--radius-md"))).toBe("12px");
});

test("the default theme's radius on the first frame is the sharp 2px", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("collie:design:v1", JSON.stringify({ font: "aldrich" })));
  expect(await firstFrameRadius(page)).toBe("2px");
});

test("a device on the default theme gets no attribute and no inline property", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("collie:design:v1", JSON.stringify({ font: "aldrich" })));
  await page.route("**/assets/*.js", (route) => route.abort());
  await page.goto("/");
  const seen = await page.evaluate(() => ({
    style: document.documentElement.getAttribute("style"),
    attribute: document.documentElement.getAttribute("data-theme"),
  }));
  expect(seen).toEqual({ style: null, attribute: null });
});

test("a stored theme with a hostile value paints nothing from that token", async ({ page }) => {
  const hostile = { ...theme, dark: { ...theme.dark, background: "url(https://x.test/a.png)", foreground: "#abcdef" } };
  await page.addInitScript(
    ([design, library]) => {
      localStorage.setItem("collie:design:v1", design);
      localStorage.setItem("collie:themes:v1", library);
    },
    [
      JSON.stringify({ font: "aldrich", theme: "midnight" }),
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

test("setting 43 properties before paint costs well under 5 ms", async ({ page }, testInfo) => {
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
    .toEqual(["#f5f5f5", "#123456"]);
  const inline = await page.evaluate(() => document.documentElement.style.length);
  expect(inline).toBe(43);
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
    expect(seen.inline).toBe(43);
  });
});
