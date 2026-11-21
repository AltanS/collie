import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { installApiStub } from "./fixtures/api";
import { stillMarkState } from "./fixtures/still-mark";
import { installScanner } from "./hitbox/inject";
import { SCREENS } from "./screens/list";
import { installRules, runRules, type RuleId, type Violation } from "./screens/rules";
import { installFilledReads, installScreenStubs, SETUPS } from "./screens/setups";

// THE SCREEN LIST, WALKED (`e2e/screens/list.ts`). Every entry opens at 1440x900 with a mouse and at 390x844 with a finger
// (its own `widths` replace them), settles, and is checked against the four layout rules of `e2e/screens/rules.ts`. A red
// rule is either waived on its entry with a reason or it fails here, one line per element:
//
//     <screen> @<width> <rule> <selector>: <detail>
//
// Its own set, so it is in no other tier: `cd web && E2E_SET=screens bun run e2e --workers=4`. With
// `SCREENS_SHOTS=<dir>` it also writes `<id>.<width>.png` for every entry (nothing is written when the variable is unset);
// `bun e2e/screens/sheet.ts <dir>` turns the folder into contact sheets.

const SHOTS = process.env.SCREENS_SHOTS;
/** The window height that goes with each width: a laptop, a small laptop and a phone. */
const heightOf = (width: number): number => (width === 1440 ? 900 : width === 390 ? 844 : 800);

/** How many lines of one rule a failure prints: the rest is a count, so a broken primitive does not bury the log. */
const SHOW = 8;

test.use({ serviceWorkers: "block" });

for (const screen of SCREENS) {
  const widths = screen.widths ?? [1440, 390];
  test(`${screen.id}`, async ({ browser }, testInfo) => {
    test.setTimeout(90_000);
    test.skip(testInfo.project.name !== "app-phone", "sets its own viewports and input; one project is enough");
    const baseURL = String(testInfo.project.use.baseURL);
    const lines: string[] = [];
    const used = new Set<string>();
    const waivedKeys = Object.keys(screen.waive ?? {});
    const unstubbed = new Set<string>();

    for (const width of widths) {
      const touch = width < 600;
      const height = heightOf(width);
      const context = await browser.newContext({
        baseURL,
        viewport: { width, height },
        hasTouch: touch,
        deviceScaleFactor: touch ? 2 : 1,
        serviceWorkers: "block",
        storageState: stillMarkState(baseURL),
      });
      try {
        const page = await context.newPage();
        await installScanner(page);
        await installRules(page);
        await installApiStub(page);
        await installScreenStubs(page);
        await installFilledReads(page);
        // A request the fixtures do not answer reads as an error on the page: say which, so the entry's setup can answer it.
        page.on("response", (response) => {
          if (response.status() === 501 && response.url().includes("/api/")) unstubbed.add(`${response.request().method()} ${new URL(response.url()).pathname}`);
        });
        if (screen.setup !== undefined) await SETUPS[screen.setup](page, screen);
        if (page.url() === "about:blank") await page.goto(screen.path);
        await page.waitForSelector("#root *", { timeout: 10_000 });
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(900);
        if (SHOTS !== undefined) {
          mkdirSync(SHOTS, { recursive: true });
          await page.screenshot({ path: join(SHOTS, `${screen.id}.${String(width)}.png`) });
        }
        const found = await runRules(page, width);
        const byRule = new Map<RuleId, Violation[]>();
        for (const v of found) byRule.set(v.rule, [...(byRule.get(v.rule) ?? []), v]);
        for (const [rule, list] of byRule) {
          const waiver = [`${rule}@${String(width)}`, rule].find((key) => waivedKeys.includes(key));
          if (waiver !== undefined) {
            used.add(waiver);
            continue;
          }
          for (const v of list.slice(0, SHOW)) lines.push(`${screen.id} @${String(width)} ${rule} ${v.selector}: ${v.detail}`);
          if (list.length > SHOW) lines.push(`${screen.id} @${String(width)} ${rule} and ${String(list.length - SHOW)} more`);
        }
      } finally {
        await context.close();
      }
    }

    if (unstubbed.size > 0) {
      testInfo.annotations.push({ type: "unstubbed", description: [...unstubbed].join(", ") });
      console.log(`UNSTUBBED ${screen.id}: ${[...unstubbed].join(", ")}`);
    }
    for (const key of Object.keys(screen.waive ?? {})) {
      if (!used.has(key)) lines.push(`${screen.id} waives ${key}, but no width breaks that rule any more: remove the waiver from e2e/screens/list.ts`);
    }
    if (lines.length > 0) throw new Error(`\n${lines.join("\n")}`);
  });
}

// THE RULES CATCH WHAT THEY ARE FOR. A rule that never goes red proves nothing, so this puts the four breaks into one real
// page (a tab drawn over a label, text cut with no sign, a page that scrolls sideways, a small button) and asks each rule
// to find its own. If a change to `rules.ts` makes one of them blind, this case fails before a screen goes quietly green.
test("each rule finds the break it is for", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== "app-phone", "sets its own viewports and input; one project is enough");
  const baseURL = String(testInfo.project.use.baseURL);
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 }, serviceWorkers: "block", storageState: stillMarkState(baseURL) });
  try {
    const page = await context.newPage();
    await installScanner(page);
    await installRules(page);
    await installApiStub(page);
    await page.goto("/settings/look");
    await page.waitForSelector("#root *");
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      const items: [string, string, string][] = [
        ["left:500px;top:300px;font:16px sans-serif", "canary label under a tab", "div"],
        ["left:480px;top:292px;width:220px;height:32px;background:#c33;color:#fff;font:16px sans-serif", "canary tab", "div"],
        ["left:500px;top:400px;width:90px;overflow:hidden;white-space:nowrap;font:16px sans-serif", "canary text that is cut with no sign at all", "div"],
        ["left:0;top:500px;width:2500px;height:4px;background:#0a0", "", "div"],
        ["left:700px;top:600px;width:12px;height:12px;background:#33c;border:0;padding:0", "", "button"],
      ];
      for (const [css, text, tag] of items) {
        const el = document.createElement(tag);
        el.style.cssText = `position:absolute;z-index:50;${css}`;
        el.textContent = text;
        document.body.append(el);
      }
    });
    const found = await runRules(page, 1440);
    const named = (rule: RuleId, text: string) => found.some((v) => v.rule === rule && v.selector.includes(text));
    expect(named("nothing-covers-a-label", "canary label under a tab")).toBe(true);
    expect(named("no-cut-text", "canary text that is cut")).toBe(true);
    expect(found.some((v) => v.rule === "no-sideways-scroll")).toBe(true);
    expect(found.some((v) => v.rule === "targets" && v.detail.includes("box 12x12"))).toBe(true);
  } finally {
    await context.close();
  }
});
