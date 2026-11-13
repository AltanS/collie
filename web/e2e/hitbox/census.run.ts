import { test } from "@playwright/test";


import type { ScanOptions, Target } from "@/playground/hitbox/scan";
import { judge } from "@/playground/hitbox/verdict";
import type { AgentView } from "@/lib/types";

import { installScanner, scan } from "./inject";
import { writeKey } from "./out";
import { SCREENS, setUpWorld } from "./screens";
import { HERD, richSnapshot } from "./world";

// THE CENSUS. One run walks every screen in `screens.ts` at the two phone sizes, scans each for tap
// targets (`src/playground/hitbox/scan.ts`) and writes ONE file, `src/playground/fixtures/hitbox-census.json`,
// which `bun run hitbox:check` reads. Run it again after any UI change:
//
//     cd web && bunx vite build && bunx playwright test -c e2e/hitbox/playwright.config.ts census
//
// It lives under `e2e/hitbox/` and not under `scripts/` because it needs Playwright, the stub world
// of `e2e/fixtures/api.ts` and the unit layer's fixtures, which `web/` already resolves and the repo
// root does not. It is not collected by `bun run e2e`: the files end in `.run.ts`.

const SIZES = [
  { name: "390x844", width: 390, height: 844 },
  { name: "360x780", width: 360, height: 780 },
] as const;

/** What the playground needs of one target: the numbers the table prints and the verdict, not the probe detail. */
export type CensusRow = {
  screen: string;
  group: string;
  size: string;
  name: string;
  selector: string;
  tag: string;
  /** Box and hit area as [w, h] in CSS px; the hit is null when nothing on the box answers. */
  box: [number, number];
  hit: [number, number] | null;
  hitShare: number;
  gap: number | null;
  gapTo: string | null;
  events: string[];
  /** How far the target moved when a needs-you pane arrived above it; null where that was not tried. */
  shiftPx: number | null;
  verdict: string;
  flags: string[];
  severity: number;
};

const r1 = (n: number): number => Math.round(n * 10) / 10;

/** Two rows can share a name ("claude idle"), so a target is matched by its place among the same names. */
function keyed(targets: Target[]): { key: string; t: Target }[] {
  const count = new Map<string, number>();
  return targets.map((t) => {
    const base = `${t.selector}|${t.name}`;
    const n = count.get(base) ?? 0;
    count.set(base, n + 1);
    return { key: `${base}|${String(n)}`, t };
  });
}

/** A pane that arrives in the needs-you section, above everything the Dashboard holds under it. */
const ARRIVAL: AgentView = { ...HERD[0]!, paneId: "w1:p99", tabId: "w1:t99", status: "blocked" };

const rows: CensusRow[] = [];
let deaf = 0;
const reached: { screen: string; size: string; targets: number }[] = [];
const notReached: { screen: string; size: string; why: string }[] = [];

test.describe.configure({ mode: "serial" });

for (const size of SIZES) {
  for (const recipe of SCREENS) {
    test(`census ${recipe.id} at ${size.name}`, async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      await installScanner(page);
      const control = await setUpWorld(page, recipe);
      try {
        await page.goto(recipe.path ?? "/");
        await page.waitForSelector("#root *", { timeout: 8000 });
        await page.waitForTimeout(1200);
        await recipe.open?.(page);
        await page.waitForTimeout(300);
        // A look at what was scanned, for the person reading a surprising row. Off unless asked for.
        if (process.env.HITBOX_SHOTS !== undefined && size.name === "390x844") {
          await page.screenshot({ path: `${process.env.HITBOX_SHOTS}/${recipe.id}.png` });
        }
        // A sheet is the only thing a finger can reach while it is open, so it is scanned alone (its
        // backdrop is part of it). Everything else under it would read as covered, which is true and says nothing.
        const sheet = (await page.locator('[role="dialog"]').count()) > 0;
        const scanOpts: ScanOptions = {};
        if (sheet) scanOpts.root = '[role="dialog"]';
        if (recipe.still === true) scanOpts.scroll = false;
        const result = await scan(page, scanOpts);
        reached.push({ screen: recipe.id, size: size.name, targets: result.targets.length });
        // THE SHIFT PROBE, on the Dashboard only: a pane arrives above the list through the real poll
        // (a focus event asks for one at once), and every target is looked up again by name and selector.
        const shifts = new Map<string, number>();
        if (recipe.id === "dashboard" && control !== null) {
          control.body = () => richSnapshot(2, (a) => [ARRIVAL, ...a]);
          await page.evaluate(() => window.dispatchEvent(new Event("focus")));
          await page.waitForTimeout(1800);
          const after = await scan(page, {});
          const seen = new Map(keyed(after.targets).map(({ key, t }) => [key, t.box.y]));
          for (const { key, t } of keyed(result.targets)) {
            const y = seen.get(key);
            if (y !== undefined) shifts.set(key, Math.abs(y - t.box.y));
          }
        }
        const own = new Map<string, number>();
        for (const t of result.targets) {
          // A control that is deaf by design at rest (a `⋯` that shows on a long press) is not a target a finger can miss.
          // The same for a sheet's backdrop: a button the size of the screen that lies under its own sheet.
          const backdrop = t.box.w >= size.width * 0.9 && t.box.h >= size.height * 0.9;
          if (t.pointerEvents === "none" || backdrop) {
            deaf += 1;
            continue;
          }
          const base = `${t.selector}|${t.name}`;
          const n = own.get(base) ?? 0;
          own.set(base, n + 1);
          const shiftKey = `${base}|${String(n)}`;
          const shiftPx = shifts.get(shiftKey) ?? null;
          const j = judge(t, { shiftPx });
          rows.push({
            screen: recipe.id,
            group: recipe.group,
            size: size.name,
            name: t.name,
            selector: t.selector,
            tag: t.tag,
            box: [r1(t.box.w), r1(t.box.h)],
            hit: t.hit === null ? null : [r1(t.hit.w), r1(t.hit.h)],
            hitShare: Math.round(t.hitShare * 100) / 100,
            gap: t.gap === null ? null : r1(t.gap),
            gapTo: t.gapTo,
            events: t.events,
            shiftPx: shiftPx === null ? null : r1(shiftPx),
            verdict: j.verdict,
            flags: j.flags,
            severity: j.severity,
          });
        }
      } catch (error) {
        notReached.push({ screen: recipe.id, size: size.name, why: error instanceof Error ? error.message.split("\n")[0] ?? "" : "unknown" });
      }
    });
  }
}

test.afterAll(() => {
  // This run owns `rows`, `reached` and `notReached`; the Dashboard experiments own `part1`.
  writeKey("rows", rows);
  writeKey("reached", reached);
  writeKey("notReached", notReached);
  writeKey("deafSkipped", deaf);
  console.log(`census: ${String(rows.length)} rows, ${String(reached.length)} screens reached, ${String(notReached.length)} not reached`);
  for (const n of notReached) console.log(`  not reached: ${n.screen} @ ${n.size}: ${n.why}`);
});
