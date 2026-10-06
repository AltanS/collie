// The live read-only look at Settings → Device: the built `dist`, served by e2e/serve.ts on
// 127.0.0.1:5196 with `/api/*` proxied to a running instance, opened at the phone size and
// screenshotted to e2e/shots/settings-live.png (ignored: it shows a real registry).
//
//   PORT=5196 PROXY=http://127.0.0.1:8792 bun e2e/serve.ts &
//   bun e2e/settings-live.ts
//
// READ-ONLY BY CONSTRUCTION: every request that is not a GET is aborted before it leaves the
// browser, so this can never pair, revoke or start anything on the instance. The worker is blocked,
// so nothing is registered on the instance's behalf either.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { chromium } from "@playwright/test";

const BASE = process.env.BASE ?? "http://127.0.0.1:5196";
const out = join(import.meta.dirname, "shots", "settings-live.png");
mkdirSync(join(import.meta.dirname, "shots"), { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
const blocked: string[] = [];
await context.route(/\/api\//, (route) => {
  if (route.request().method() === "GET") return route.continue();
  blocked.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
  return route.abort();
});
const page = await context.newPage();
const devices = page.waitForResponse((res) => res.url().includes("/api/devices"));
await page.goto(`${BASE}/settings/device`);
const res = await devices;
await page.getByTestId("paired-devices").waitFor();
await page.waitForTimeout(500);
await page.screenshot({ path: out });
console.log(`GET /api/devices → ${String(res.status())}`);
console.log(`card: ${(await page.getByTestId("paired-devices").innerText()).replace(/\s+/g, " ").slice(0, 300)}`);
console.log(`non-GET requests aborted: ${blocked.length === 0 ? "none" : blocked.join(", ")}`);
console.log(`screenshot: ${out}`);
await browser.close();
