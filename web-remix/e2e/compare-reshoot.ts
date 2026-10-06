// The live, read-only reshoot behind the React-vs-Remix comparison (experiments/remix-v3/COMPARE.md): the
// built `dist` served by e2e/serve.ts on 127.0.0.1:5193 with `/api/*` proxied to a running instance (Host
// rewritten), opened at the phone size, one fresh context per shot, service workers blocked, every request
// that is not a GET aborted before it leaves the browser. Output: e2e/shots/compare/remix2-<name>.png.
//
//   bunx vite build --outDir /tmp/collie-remix-reshoot --emptyOutDir
//   DIST=/tmp/collie-remix-reshoot PORT=5193 PROXY=http://127.0.0.1:8792 bun e2e/serve.ts &
//   bun e2e/compare-reshoot.ts [space history tour files changes home settings]
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { chromium, type BrowserContext } from "@playwright/test";

const BASE = process.env.BASE ?? "http://127.0.0.1:5193";
const PANE = process.env.PANE ?? "w2H:p3Y";
const out = join(import.meta.dirname, "shots", "compare");
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const blocked: string[] = [];
const errors: string[] = [];

/** A fresh context, GET only. `seen` marks the first-run tour as seen (`collie:tour:v1` = 2). */
async function fresh(seen: boolean): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    serviceWorkers: "block",
    storageState: seen ? { cookies: [], origins: [{ origin: new URL(BASE).origin, localStorage: [{ name: "collie:tour:v1", value: "2" }] }] } : { cookies: [], origins: [] },
  });
  await context.route(/\/api\//, (route) => {
    if (route.request().method() === "GET") return route.continue();
    blocked.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    return route.abort();
  });
  return context;
}

async function shot(name: string, path: string, seen: boolean): Promise<void> {
  const context = await fresh(seen);
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  const file = join(out, `remix2-${name}.png`);
  await page.screenshot({ path: file });
  console.log(`${name}: ${path} → ${file}`);
  await context.close();
}

const probe = await fresh(true);
const snap = await probe.request.get(`${BASE}/api/snapshot`);
const body: { workspaces?: { workspaceId: string }[] } = await snap.json();
const space = body.workspaces?.[0]?.workspaceId ?? "";
await probe.close();
console.log(`snapshot → ${String(snap.status())}, first space: ${space === "" ? "none" : space}`);

const want = new Set(process.argv.slice(2));
const all = want.size === 0;
if (all || want.has("space")) await shot("space", `/space/${encodeURIComponent(space)}`, true);
if (all || want.has("history")) await shot("history", `/pane/${encodeURIComponent(PANE)}/history`, true);
if (all || want.has("tour")) await shot("tour", "/", false);
if (want.has("files")) await shot("files", `/space/${encodeURIComponent(space)}/changes/files`, true);
if (want.has("changes")) await shot("changes", `/space/${encodeURIComponent(space)}/changes`, true);
if (want.has("home")) await shot("home", "/", true);
if (want.has("settings")) await shot("settings", "/settings", true);

console.log(`pageerrors: ${errors.length === 0 ? "none" : errors.join(" | ")}`);
console.log(`non-GET requests aborted: ${blocked.length === 0 ? "none" : blocked.join(", ")}`);
await browser.close();
