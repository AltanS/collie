import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Page } from "@playwright/test";
import { transformWithOxc } from "vite";

import { reachMin } from "@/playground/hitbox/verdict";

import { scan } from "../hitbox/inject";
import type { LayoutOptions, RuleId, Violation } from "./page-rules";

export type { RuleId, Violation };

// THE FOUR LAYOUT RULES OF THE SCREEN LIST, as a machine checks them. R1 to R3 are DOM code in `page-rules.ts`, installed into
// the page before its scripts (the way the hitbox scanner is) and returning every break as `{ rule, selector, detail }`; R4
// reads the hitbox scanner's targets (`e2e/hitbox`, the same numbers the census prints) and joins the same shape. A red run
// prints one line per break.
//
//   R1 no-sideways-scroll        the document and the main scroller do not scroll sideways, except a strip.
//   R2 no-cut-text               text wider than its own box has an ellipsis, a fade mask or a scroller around it.
//   R3 nothing-covers-a-label    a hit test at the centre of every text and every control returns it or a relative.
//   R4 targets                   a button, link or tab reaches 24x24 CSS px with a mouse and 44x44 with a finger.

/** The smaller side a target must reach, in CSS px: a mouse needs 24, a finger 44 (DESIGN.md section 6). */
export const FLOOR = { mouse: 24, touch: 44 } as const;

const PAGE_PATH = fileURLToPath(new URL("./page-rules.ts", import.meta.url));

/** Install R1 to R3 before any script of the page runs. Call before the first `page.goto`. */
export async function installRules(page: Page): Promise<void> {
  const out = await transformWithOxc(readFileSync(PAGE_PATH, "utf8"), PAGE_PATH, { lang: "ts", target: "es2022" });
  await page.addInitScript({ content: `${out.code.replaceAll(/^export /gm, "")}\nwindow.__screensCheck = checkLayout;\n` });
}

/** Every break of the four rules on the page as it stands. Run it last: R4 scrolls each target into view. */
export async function runRules(page: Page, width: number): Promise<Violation[]> {
  const touch = width < 600;
  const dialog = (await page.locator('[role="dialog"]').count()) > 0;
  const root = dialog ? '[role="dialog"]' : null;
  const opts: LayoutOptions = { root };
  const found: Violation[] = await page.evaluate((o) => {
    const run = window.__screensCheck;
    if (run === undefined) throw new Error("the rules are not installed: call installRules before the first goto");
    return run(o);
  }, opts);

  const floor = touch ? FLOOR.touch : FLOOR.mouse;
  const { targets } = await scan(page, dialog ? { root: '[role="dialog"]' } : {});
  const view = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  for (const t of targets) {
    // The census leaves out what a finger cannot reach by design: a control with no pointer events, a disabled one,
    // a link inside a paragraph and a sheet's backdrop (a button as large as the screen).
    const pressable = t.tag === "button" || t.tag === "a" || t.role === "button" || t.role === "link" || t.role === "tab";
    if (!pressable || t.pointerEvents === "none" || t.disabled || t.inline || t.opacity === 0) continue;
    if (t.box.w >= view.w * 0.9 && t.box.h >= view.h * 0.9) continue;
    // The box counts when nothing lies over the part that shows: a row cut by the edge of its scroller reaches only what shows,
    // and that is the scroller's doing, not a small target. A covered target keeps the reach the scanner found.
    const side = Math.max(reachMin(t), t.hitShare >= 0.9 ? Math.min(t.box.w, t.box.h) : 0);
    if (side >= floor) continue;
    found.push({ rule: "targets", selector: `${t.selector} "${t.name}"`, detail: `reach ${String(Math.round(side))}px under ${String(floor)} (box ${String(t.box.w)}x${String(t.box.h)})` });
  }
  return found;
}
