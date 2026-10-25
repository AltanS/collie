import { expect, test } from "@playwright/test";

import { installApiStub } from "./fixtures/api";

// THE TOP EDGE OF A HOME-SCREEN APP, laid out by the engine (index.css, "THE TOP EDGE"; #597).
// Playwright cannot emulate a Home Screen launch, an `-webkit-touch-callout` WebView or a safe-area
// inset, and it cannot draw the iOS 27 blur, so this cannot show the iPad case itself. What it does
// prove, in WebKit and Chromium at phone and tablet width: with the standalone gate lifted from the
// SHIPPED stylesheet (read back through the CSSOM, so a rule that moves or breaks fails here), the
// element is a real, fixed, full-width, opaque box at y=0 in the header's own colour, as tall as the
// floor (the inset is 0 in a browser), never in the way of a tap, and it moves nothing.

// NO SERVICE WORKER: `page.route` cannot see a request the worker makes (see composer-clear.spec.ts).
test.use({ serviceWorkers: "block" });

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("states"), "the playground has no shell");
  await installApiStub(page);
});

/** Re-adds the shipped rules that sit behind the standalone iOS gate, without the gate. */
async function liftGate(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => {
    const out: string[] = [];
    const walk = (rules: CSSRuleList, wrap: string[]): void => {
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSStyleRule) {
          if (rule.selectorText.includes("top-edge") || rule.cssText.includes("--top-edge-floor")) {
            out.push(wrap.reduceRight((inner, outer) => `${outer} { ${inner} }`, rule.cssText));
          }
        } else if (rule instanceof CSSMediaRule || rule instanceof CSSSupportsRule) {
          const cond = rule instanceof CSSMediaRule ? rule.conditionText : "";
          const sup = rule instanceof CSSSupportsRule ? rule.conditionText : "";
          if (/display-mode|-webkit-touch-callout/u.test(cond + sup)) walk(rule.cssRules, wrap);
          else walk(rule.cssRules, [...wrap, `@media ${cond}`]);
        }
      }
    };
    for (const sheet of Array.from(document.styleSheets)) walk(sheet.cssRules, []);
    const style = document.createElement("style");
    style.dataset.lifted = "top-edge";
    style.textContent = out.join("\n");
    document.head.appendChild(style);
  });
}

test("outside a Home Screen app the element draws nothing", async ({ page }) => {
  await page.goto("/");
  const edge = page.locator('[data-slot="top-edge"]');
  await expect(edge).toHaveCount(1);
  expect(await edge.evaluate((el) => getComputedStyle(el).display)).toBe("none");
});

test("with the gate lifted it is a fixed, opaque, full-width strip at the top in the header colour", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("banner")).toBeVisible();
  const before = await page.getByRole("banner").boundingBox();
  await liftGate(page);

  const m = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-slot="top-edge"]');
    const header = document.querySelector("header");
    if (el === null || header === null) throw new Error("no strip or no header");
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      display: s.display,
      position: s.position,
      pointerEvents: s.pointerEvents,
      zIndex: s.zIndex,
      bg: s.backgroundColor,
      headerBg: getComputedStyle(header).backgroundColor,
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      innerWidth: window.innerWidth,
    };
  });
  expect(m.display).toBe("block");
  expect(m.position).toBe("fixed");
  expect(m.pointerEvents).toBe("none");
  expect(Number(m.zIndex)).toBeGreaterThan(20);
  expect(m.y).toBe(0);
  expect(m.x).toBe(0);
  expect(m.width).toBe(m.innerWidth);
  // Opaque, and the header's own paint, so the two cannot show a seam.
  expect(m.bg).toBe(m.headerBg);
  expect(m.bg).not.toMatch(/rgba\(.*,\s*0\)$/u);
  // No inset in a browser: a phone gets no floor, a tablet gets the smallest height WebKit accepts.
  expect(m.height).toBe(m.innerWidth >= 768 ? 6 : 0);

  // It moves nothing: the banner sits where it sat.
  const after = await page.getByRole("banner").boundingBox();
  expect(after).toEqual(before);
});
