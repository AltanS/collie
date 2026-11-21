// A hand driver for the rig's phone, for the trick flow (propose, the Decision card, the yes, Settings →
// Tricks). Not a spec: one fresh Pixel 7 context per call, paired with the rig's token, as leg.ts pairs.
//
//   COLLIE_RIG_STATE=<state root> bun e2e/rig/trick-phone.ts <out dir> <step>...
//
// Steps, run in order:
//   goto:<path>            open a path of the app
//   click:<text>           tap the first visible element whose accessible name or text is <text> (exact)
//   clickre:<regex>        the same, by a case-insensitive pattern on the button's name
//   hold:<regex>           press the button found as clickre does and keep the finger down for 3.5 s (the yes
//                          to a trick's code is a hold of three seconds, ADR 0156)
//   scroll                 scroll every scrollable box to its end (cards of a group come into view)
//   fill:<text>            type <text> into the first visible text box (the composer on a pane)
//   wait:<ms>              wait
//   shot:<name>            screenshot to <out dir>/<name>.png (mode 600) and print the page's visible text
//   buttons                print every visible button's name and whether it is enabled
//
// THE RUN OF 2026-11-16 (the trick flow, end to end), with COLLIE_RIG_STATE on a scratch root and
// COLLIE_RIG_LIVE=claude (live, no recording):
//   bun e2e/rig/rig.ts up && bun e2e/rig/rig.ts start claude                     # Claude in w2:p1
//   trick-phone.ts <out> goto:/settings clickre:^Experiments "click:The Hill"    # the Hill on
//   trick-phone.ts <out> goto:/pane/w2%3Ap1 "fill:Make me a small Collie trick that shows the current
//     git branch of this folder on my phone. When it is ready, propose it to me." click:Send
//   trick-phone.ts <out> goto:/hill scroll click:Next scroll click:Next scroll click:Next scroll \
//     "hold:Hold to switch on"                                                   # the yes, a hold since ADR 0156
//   trick-phone.ts <out> goto:/settings clickre:^Tricks click:git-branch         # its switch, off
//   (collie trick remove git-branch; the agent proposes again)
//   trick-phone.ts <out> goto:/hill "clickre:Not now"                            # the no
//   bun e2e/rig/rig.ts down
// A permission dialog of the agent is answered with: goto:/pane/w2%3Ap1 "clickre:^1\s*Yes$".
// SINCE M96 SPEC 14 the Hill-on step is not needed: with the Hill off the card is in Settings, Tricks and the Hill, under
// "Waiting for your yes", and the Dashboard's line opens the oldest (not yet run on the rig):
//   trick-phone.ts <out> goto:/settings clickre:^Tricks "clickre:^Switch on the trick" click:Next \
//     click:Next click:Next "hold:Hold to switch on"
//   trick-phone.ts <out> goto:/ "click:Read it" "clickre:Not now"                 # the no, from the Dashboard
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { chromium, devices, type Locator, type Page } from "@playwright/test";

import { phoneContext, PHONE_DEVICE, Rig } from "./leg";

const [outDir, ...steps] = process.argv.slice(2);
if (outDir === undefined) throw new Error("usage: trick-phone.ts <out dir> <step>...");
mkdirSync(outDir, { recursive: true, mode: 0o700 });

async function firstVisible(page: Page, candidates: readonly Locator[]): Promise<Locator> {
  for (let i = 0; i < 20; i++) {
    for (const loc of candidates) {
      const n = await loc.count();
      for (let k = 0; k < n; k++) if (await loc.nth(k).isVisible()) return loc.nth(k);
    }
    await page.waitForTimeout(250);
  }
  throw new Error("no visible match");
}

const rig = new Rig();
const browser = await chromium.launch();
try {
  const context = await phoneContext(browser, rig, devices[PHONE_DEVICE]);
  const page = await context.newPage();
  page.on("response", (r) => {
    const u = new URL(r.url());
    if (r.request().method() !== "GET" && u.pathname.startsWith("/api/")) void r.text().then((t) => console.log(`[${r.request().method()} ${u.pathname} -> ${String(r.status())}] ${t.slice(0, 400)}`));
  });
  for (const step of steps) {
    const at = step.indexOf(":");
    const verb = at < 0 ? step : step.slice(0, at);
    const arg = at < 0 ? "" : step.slice(at + 1);
    console.log(`== ${step}`);
    if (verb === "goto") {
      await page.goto(arg);
      await page.waitForLoadState("networkidle").catch(() => undefined);
      await page.waitForTimeout(1500);
    } else if (verb === "click") {
      const target = await firstVisible(page, [page.getByRole("button", { name: arg, exact: true }), page.getByRole("switch", { name: arg, exact: true }), page.getByRole("link", { name: arg, exact: true }), page.getByText(arg, { exact: true })]);
      await target.scrollIntoViewIfNeeded();
      await target.click();
      await page.waitForTimeout(1200);
    } else if (verb === "clickre") {
      const re = new RegExp(arg, "i");
      const target = await firstVisible(page, [page.getByRole("button", { name: re }), page.getByRole("switch", { name: re }), page.getByRole("link", { name: re }), page.locator("button", { hasText: re })]);
      await target.scrollIntoViewIfNeeded();
      await target.click();
      await page.waitForTimeout(1200);
    } else if (verb === "hold") {
      const re = new RegExp(arg, "i");
      const target = await firstVisible(page, [page.getByRole("button", { name: re }), page.locator("button", { hasText: re })]);
      await target.scrollIntoViewIfNeeded();
      const box = await target.boundingBox();
      if (box === null) throw new Error("the button has no box");
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(3500);
      await page.mouse.up();
      await page.waitForTimeout(1200);
    } else if (verb === "scroll") {
      for (let i = 0; i < 12; i++) {
        await page.evaluate(() => {
          for (const el of Array.from(document.querySelectorAll<HTMLElement>("*"))) if (el.scrollHeight > el.clientHeight + 4 || el.scrollWidth > el.clientWidth + 4) el.scrollBy(400, 400);
          window.scrollBy(0, 600);
        });
        await page.waitForTimeout(250);
      }
    } else if (verb === "fill") {
      const box = await firstVisible(page, [page.getByRole("textbox")]);
      await box.click();
      await box.fill(arg);
      await page.waitForTimeout(500);
    } else if (verb === "wait") {
      await page.waitForTimeout(Number(arg));
    } else if (verb === "shot") {
      const file = join(outDir, `${arg}.png`);
      await page.screenshot({ path: file, fullPage: true });
      chmodSync(file, 0o600);
      console.log(`shot ${file}`);
      console.log((await page.locator("body").innerText()).replace(/\n{2,}/g, "\n").slice(0, 6000));
    } else if (verb === "buttons") {
      for (const b of await page.getByRole("button").all()) if (await b.isVisible()) console.log(`  [${(await b.isEnabled()) ? "on " : "off"}] ${(await b.getAttribute("aria-label")) ?? (await b.innerText()).replace(/\s+/g, " ").slice(0, 80)}`);
      for (const b of await page.getByRole("switch").all()) if (await b.isVisible()) console.log(`  [switch ${String(await b.getAttribute("aria-checked"))}] ${(await b.getAttribute("aria-label")) ?? ""}`);
    } else throw new Error(`unknown step ${step}`);
  }
  await context.close();
} finally {
  await browser.close();
}
