// The live read-only look at the dashboard: the built `dist`, served by e2e/serve.ts on
// 127.0.0.1:5195 with `/api/*` proxied to a running instance (Host rewritten), opened at the phone
// size and screenshotted to e2e/shots/home-wave2.png (ignored: it shows real workspace names).
//
//   PORT=5195 PROXY=http://127.0.0.1:8792 bun e2e/serve.ts &
//   bun e2e/home-live.ts
//
// READ-ONLY BY CONSTRUCTION: every request that is not a GET is aborted before it leaves the
// browser, so this can never create, rename, close or focus anything on the instance. The worker
// is blocked, so nothing registers on the instance's behalf either. No hold, no tap on a row.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { chromium } from "@playwright/test";

const BASE = process.env.BASE ?? "http://127.0.0.1:5195";
const out = join(import.meta.dirname, "shots", "home-wave2.png");
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
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
const snapshot = page.waitForResponse((res) => new URL(res.url()).pathname === "/api/snapshot");
await page.goto(`${BASE}/`);
const res = await snapshot;
await page.getByTestId("agent-list").or(page.getByTestId("herd-empty")).first().waitFor();
await page.waitForTimeout(1500);
await page.screenshot({ path: out });
const count = (id: string): Promise<number> => page.getByTestId(id).count();
console.log(`GET /api/snapshot → ${String(res.status())}`);
console.log(
  `groups ${String(await count("workspace-group"))}, rows ${String(await count("pane-row"))}, cache chips ${String(await page.locator('[data-slot="cache-chip"]').count())}, host chips ${String(await page.locator('[data-slot="host-chip"]').count())}, pinned ${String(await count("pinned-group"))}, machine chips ${String(await count("machine-chip"))}`,
);
console.log(`summary: ${(await page.getByTestId("summary-line").innerText().catch(() => "")).replace(/\s+/g, " ")}`);
console.log(`page errors: ${errors.length === 0 ? "none" : errors.join(" | ")}`);
console.log(`non-GET requests aborted: ${blocked.length === 0 ? "none" : blocked.join(", ")}`);
console.log(`screenshot: ${out}`);
await browser.close();
