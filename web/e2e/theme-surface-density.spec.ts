import { expect, test, type Page, type TestInfo } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";

import { installApiStub, installCrewWorld, installMachinesWorld } from "./fixtures/api";
import { collieHalves } from "./fixtures/collie-theme";

// A ROOMY THEME FITS A SMALL PHONE (M57 spec 14). Schema version 2 lets a theme raise the spacing step
// (`density: roomy`), and every `p-*`, `gap-*`, `h-*` and `size-*` grows with it. This walks every page
// the e2e tier already visits, at the two narrowest phones the app is held to, with an imported theme
// that names the largest word of every shape token at once, and checks two things:
//
//   * no horizontal overflow: the page's own scroll width stays within the viewport;
//   * no clipped control: every visible control outside a horizontal scroller sits inside the
//     viewport, and no control's own content overflows its box under roomy unless it already did at
//     the default density (a long name truncated by design is the same at both).
//
// And one more: the header dog renders at the same pixel size under every density, because index.css
// pins icons and the mark box to the default step.

const LARGEST = { radius: "round", shadow: "lifted", density: "roomy", weight: "bold", border: "strong" } as const;

/** A version 2 file: collie's 43 required tokens, never the version 3 `pane-active` (ADR 0120). */
function themeFile(surface: Readonly<Record<string, string>> | undefined) {
  const theme = { version: 2, id: "roomy", name: "Roomy", light: collieHalves.light, dark: collieHalves.dark };
  return surface === undefined ? theme : { ...theme, surface };
}

async function seedTheme(page: Page, surface: Readonly<Record<string, string>> | undefined): Promise<void> {
  await page.addInitScript(
    ([design, library]) => {
      localStorage.setItem("collie:design:v1", design);
      localStorage.setItem("collie:themes:v1", library);
    },
    [
      JSON.stringify({ font: "aldrich", theme: "roomy" }),
      JSON.stringify({ version: 1, themes: [themeFile(surface)] }),
    ] as const,
  );
}

/** Every page the app tier visits elsewhere, with the fixture world it needs. */
const PAGES: ReadonlyArray<{ path: string; world?: "crew" | "machines" }> = [
  { path: "/" },
  { path: "/pane/w1:p1" },
  { path: "/pane/w1:p1/changes" },
  { path: "/space/w1/changes" },
  { path: "/new" },
  { path: "/new/add?kind=agent" },
  { path: "/settings" },
  { path: "/settings/appearance" },
  { path: "/settings/updates" },
  { path: "/settings/system" },
  { path: "/settings/voice" },
  { path: "/settings/voice/model" },
  { path: "/machines", world: "machines" },
  { path: "/machines/workshop", world: "machines" },
  { path: "/crew", world: "crew" },
];

const VIEWPORTS = [
  { width: 360, height: 640 },
  { width: 412, height: 915 },
] as const;

interface Measure {
  scrollWidth: number;
  innerWidth: number;
  /** Controls outside the viewport, by label. */
  outside: string[];
  /** Controls whose own content overflows their box, by label. */
  overflowing: string[];
}

async function open(page: Page, path: string, world: "crew" | "machines" | undefined): Promise<void> {
  if (world === "crew") await installCrewWorld(page);
  if (world === "machines") await installMachinesWorld(page);
  await page.goto(path);
  await expect(page.locator("#root")).not.toBeEmpty();
  await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; animation: none !important; }" });
  // Two frames and a short settle: the pages draw from a stubbed API that answers at once.
  await page.waitForTimeout(400);
}

async function measure(page: Page): Promise<Measure> {
  return page.evaluate(() => {
    const CONTROLS = "button, a[href], input, select, textarea, [role=button], [role=radio], [role=switch], [role=tab], [role=checkbox]";
    const outside: string[] = [];
    const overflowing: string[] = [];
    const all = [...document.querySelectorAll<HTMLElement>(CONTROLS)];
    all.forEach((el, i) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (rect.width === 0 || rect.height === 0 || style.visibility === "hidden" || el.closest("[hidden],[inert]")) return;
      // A control inside a horizontal scroller may sit past the edge on purpose: the strip scrolls.
      let scroller = false;
      for (let p = el.parentElement; p !== null && !scroller; p = p.parentElement) {
        const over = getComputedStyle(p).overflowX;
        scroller = (over === "auto" || over === "scroll") && p.scrollWidth > p.clientWidth;
      }
      if (scroller) return;
      const label = `${el.tagName.toLowerCase()}#${i}:${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 40)}`;
      if (rect.left < -1 || rect.right > window.innerWidth + 1) outside.push(label);
      const clips = style.overflowX !== "visible" || style.overflowY !== "visible";
      if (clips && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)) overflowing.push(label);
    });
    return {
      scrollWidth: document.scrollingElement?.scrollWidth ?? 0,
      innerWidth: window.innerWidth,
      outside,
      overflowing,
    };
  });
}

/** One phone project walks both small viewports itself; the others would only repeat it. */
function onlyOnePhone(testInfo: TestInfo): void {
  test.skip(testInfo.project.name !== "app-phone", "one phone project walks both small viewports itself");
}

function contextOptions(testInfo: TestInfo, viewport: { width: number; height: number }) {
  return { viewport, baseURL: testInfo.project.use.baseURL, serviceWorkers: "block" as const, hasTouch: true };
}

for (const { path, world } of PAGES) {
  test(`roomy fits ${path} at 360x640 and 412x915`, async ({ browser }, testInfo) => {
    onlyOnePhone(testInfo);
    for (const viewport of VIEWPORTS) {
      const seen = new Map<"default" | "roomy", Measure>();
      for (const density of ["default", "roomy"] as const) {
        const context = await browser.newContext(contextOptions(testInfo, viewport));
        const page = await context.newPage();
        await installApiStub(page);
        await seedTheme(page, density === "roomy" ? LARGEST : undefined);
        await open(page, path, world);
        if (density === "roomy") {
          expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--spacing").trim())).toBe(
            "0.28rem",
          );
        }
        seen.set(density, await measure(page));
        await context.close();
      }
      const roomy = seen.get("roomy");
      const base = seen.get("default");
      if (roomy === undefined || base === undefined) throw new Error("a density was not measured");
      const at = `${path} at ${viewport.width}x${viewport.height}`;
      expect(roomy.scrollWidth, `${at}: horizontal overflow`).toBeLessThanOrEqual(roomy.innerWidth);
      expect(roomy.outside, `${at}: controls outside the viewport`).toEqual([]);
      expect(
        roomy.overflowing.filter((label) => !base.overflowing.includes(label)),
        `${at}: controls clipped only under roomy`,
      ).toEqual([]);
    }
  });
}

test("the header dog is the same pixel size under every density", async ({ browser }, testInfo) => {
  onlyOnePhone(testInfo);
  const sizes: string[] = [];
  for (const surface of [undefined, { density: "default" }, { density: "roomy" }, LARGEST]) {
    const context = await browser.newContext(contextOptions(testInfo, VIEWPORTS[0]));
    const page = await context.newPage();
    await installApiStub(page);
    await seedTheme(page, surface);
    await open(page, "/", undefined);
    const box = page.locator("[data-slot='collie-mark']");
    await expect(box.locator("svg").first()).toBeVisible();
    sizes.push(
      await box.evaluate((el) => {
        const outer = el.getBoundingClientRect();
        const svg = el.querySelector("svg")?.getBoundingClientRect();
        return `${outer.width}x${outer.height} / ${svg?.width ?? 0}x${svg?.height ?? 0}`;
      }),
    );
    await context.close();
  }
  expect(sizes).toEqual(Array.from({ length: 4 }, () => "44x44 / 40x40"));
});

// THE VOICE TAKEOVER'S RING (reviewer F2). The countdown ring is an svg, and index.css pins an svg's own
// size to the default step, so the ring takes its size from a wrapper that carries the inset. Under roomy
// the OK button grows and the ring must grow with it and stay centred on it. The takeover opens through
// the same fake microphone the voice spec uses: an oscillator behind a gain of 0.
async function fakeMicrophone(page: Page): Promise<void> {
  await page.route("**/api/config", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ push: false, vapidPublicKey: "", stt: { provider: "openai-compatible", available: true } }),
    }),
  );
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        async getUserMedia() {
          const context = new AudioContext();
          await context.resume();
          const oscillator = context.createOscillator();
          const gain = context.createGain();
          gain.gain.value = 0;
          const destination = context.createMediaStreamDestination();
          oscillator.connect(gain).connect(destination);
          oscillator.start();
          return destination.stream;
        },
      },
    });
  });
}

test("the voice takeover's ring stays centred on its button under every density", async ({ browser }, testInfo) => {
  onlyOnePhone(testInfo);
  for (const viewport of VIEWPORTS) {
    for (const surface of [undefined, LARGEST]) {
      const context = await browser.newContext(contextOptions(testInfo, viewport));
      const page = await context.newPage();
      await installApiStub(page);
      await fakeMicrophone(page);
      await seedTheme(page, surface);
      await open(page, "/pane/w1:p1", undefined);
      await page.getByRole("button", { name: en["composer.mic.recordAria"] }).click();
      const slot = page.locator('[data-slot="voice-takeover-ok"]');
      const RING = 'svg[viewBox="-24 -24 48 48"]';
      await expect(slot.locator(RING)).toHaveCount(1);
      const seen = await slot.evaluate((el) => {
        const button = el.querySelector("button")?.getBoundingClientRect();
        const ring = el.querySelector('svg[viewBox="-24 -24 48 48"]')?.getBoundingClientRect();
        if (button === undefined || ring === undefined) return null;
        return {
          dx: ring.x + ring.width / 2 - (button.x + button.width / 2),
          dy: ring.y + ring.height / 2 - (button.y + button.height / 2),
          ratio: ring.width / button.width,
          scrollWidth: document.scrollingElement?.scrollWidth ?? 0,
          innerWidth: window.innerWidth,
        };
      });
      const at = `${surface === undefined ? "default" : "roomy"} at ${viewport.width}x${viewport.height}`;
      expect(seen, at).not.toBeNull();
      expect(Math.abs(seen?.dx ?? 99), `${at}: ring off centre across`).toBeLessThanOrEqual(0.5);
      expect(Math.abs(seen?.dy ?? 99), `${at}: ring off centre down`).toBeLessThanOrEqual(0.5);
      // 48 over 36 at the default step: the ring is the button plus the same inset on every side.
      expect(seen?.ratio ?? 0, `${at}: ring size`).toBeCloseTo(48 / 36, 2);
      expect(seen?.scrollWidth ?? 99999, `${at}: horizontal overflow`).toBeLessThanOrEqual(seen?.innerWidth ?? 0);
      await context.close();
    }
  }
});

// THE THEME SELECT LIES INSIDE ITS CARD. The Theme card picks a theme from one select field, a row
// like Language's and Typeface's, so four shipped themes and the imported ones never wrap or spill.
// The density walk above covers its 44px floor; this checks that the select's box lies inside the
// card's box at 360 and 390 wide under each shipped theme (Daylight is the roomy one), and that its
// options start with the four shipped names in order.
for (const theme of [
  { id: "collie", design: {} },
  { id: "nightwatch", design: { theme: "nightwatch" } },
  { id: "daylight", design: { font: "geist", theme: "daylight" } },
  { id: "harbour", design: { theme: "harbour" } },
] as const) {
  test(`the Theme select lies inside the card under ${theme.id} at 360 and 390`, async ({ browser }, testInfo) => {
    onlyOnePhone(testInfo);
    for (const width of [360, 390]) {
      const context = await browser.newContext(contextOptions(testInfo, { width, height: 844 }));
      const page = await context.newPage();
      await installApiStub(page);
      await page.addInitScript((design) => localStorage.setItem("collie:design:v1", design), JSON.stringify(theme.design));
      await open(page, "/settings/appearance", undefined);
      await page.evaluate(() => document.fonts.ready);
      const select = page.getByRole("combobox", { name: "Theme", exact: true });
      await expect(select).toHaveCount(1);
      await expect(select).toHaveValue(theme.id);
      const seen = await select.evaluate((el) => {
        const card = el.closest('[data-slot="card"]')?.getBoundingClientRect();
        const box = el.getBoundingClientRect();
        return {
          card: card ? { left: card.left, right: card.right, top: card.top, bottom: card.bottom } : null,
          box: { left: box.left, right: box.right, top: box.top, bottom: box.bottom },
          options: el instanceof HTMLSelectElement ? [...el.options].map((option) => option.textContent ?? "") : [],
        };
      });
      const at = `${theme.id} at ${width}px`;
      expect(seen.card, `${at}: the card`).not.toBeNull();
      expect(seen.options.slice(0, 4), `${at}: the four shipped names`).toEqual(["Collie", "Nightwatch", "Daylight", "Harbour"]);
      const card = seen.card ?? { left: 0, right: 0, top: 0, bottom: 0 };
      expect(seen.box.left, `${at}: select left of the card`).toBeGreaterThanOrEqual(card.left);
      expect(seen.box.right, `${at}: select right of the card`).toBeLessThanOrEqual(card.right);
      expect(seen.box.top, `${at}: select above the card`).toBeGreaterThanOrEqual(card.top);
      expect(seen.box.bottom, `${at}: select below the card`).toBeLessThanOrEqual(card.bottom);
      await context.close();
    }
  });
}
