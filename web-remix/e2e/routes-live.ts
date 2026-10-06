// The live read-only look at the wave-4 routes: the built `dist`, served by e2e/serve.ts on
// 127.0.0.1:5193 with `/api/*` proxied to a running instance, opened at the phone size, one
// screenshot per route in e2e/shots/ (ignored: they show a real herd).
//
//   bunx vite build --outDir /tmp/collie-remix-wave4-live --emptyOutDir
//   DIST=/tmp/collie-remix-wave4-live PORT=5193 PROXY=http://127.0.0.1:8792 bun e2e/serve.ts &
//   bun e2e/routes-live.ts
//
// READ-ONLY BY CONSTRUCTION: every request that is not a GET is aborted before it leaves the browser,
// and the service worker is blocked, so this can never write to the instance.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { chromium } from "@playwright/test";

const BASE = process.env.BASE ?? "http://127.0.0.1:5193";
const shots = join(import.meta.dirname, "shots");
mkdirSync(shots, { recursive: true });

interface Probe {
  name: string;
  path: (paneId: string) => string;
}

const PROBES: readonly Probe[] = [
  { name: "crew", path: () => "/crew" },
  { name: "machines", path: () => "/machines" },
  { name: "history", path: (id) => `/pane/${encodeURIComponent(id)}/history` },
  { name: "changes", path: (id) => `/pane/${encodeURIComponent(id)}/changes` },
];

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

const snap = await context.request.get(`${BASE}/api/snapshot`);
const body: { agents?: { paneId: string }[] } = await snap.json();
const paneId = body.agents?.[0]?.paneId ?? "";
console.log(`snapshot → ${String(snap.status())}, first pane: ${paneId === "" ? "none" : "found"}`);

for (const probe of PROBES) {
  await page.goto(`${BASE}${probe.path(paneId)}`);
  await page.getByTestId("header-back").waitFor({ timeout: 8000 }).catch(() => undefined);
  await page.waitForTimeout(1500);
  const h1 = (await page.locator("h1").first().innerText().catch(() => "")).trim();
  const back = await page.getByTestId("header-back").count();
  const out = join(shots, `routes-wave4-${probe.name}.png`);
  await page.screenshot({ path: out });
  console.log(`${probe.name}: h1="${h1}" back=${String(back)} url=${page.url().replace(BASE, "")} → ${out}`);
}
console.log(`pageerrors: ${errors.length === 0 ? "none" : errors.join(" | ")}`);
console.log(`non-GET requests aborted: ${blocked.length === 0 ? "none" : blocked.join(", ")}`);
await browser.close();
