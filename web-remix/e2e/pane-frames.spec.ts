import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";

import { CONFIG } from "./fixtures";
import { capture, PANE_SNAPSHOT, PANES } from "./pane-api";

// S2 (`experiments/remix-v3/ACTION-PLAN.md` B): the open pane's Terminal rows and statusline rows are
// two server frames, `pane-screen` and `pane-status`, read once per beat as one poll answer and
// diffed in by `data-rmx-key` (src/routes/pane/pane-frames.ts). `e2e/serve.ts` answers the frames as
// the bridge's frame route does, for the panes this spec posts to `/__pane`; `/api/*` is a stub.
//
//   (a) 304: an unchanged pane writes nothing: no mutation record, no `reloadStart`, no render
//   (b) streaming: only the changed row is touched, and over 30 s no unchanged row is
//   (c) the glide hears the runtime's own `reloadStart`/`reloadComplete` of `pane-screen`
//   (d) a static-shell boot with `crypto.randomUUID` deleted still draws the frames
//   (e) a refused frame shows the notice the JSON read showed for the same refusal
//   (f) a server document's frames are adopted on hydration: same nodes, no animation, no reload
//   (g) the cadence: the same beats as the JSON path (pane-cadence.spec.ts), one request per beat
//   (h) the poll answer carries no text: the card comes from the screen model, a tap's guard reads the
//       JSON route with no ETag of its own, and the polls go on carrying no text
//   (i) Find asks for the text (the token `text` on the poll) and searches it; closing it drops the token

declare global {
  interface Window {
    __collieRenders?: Record<string, number>;
    __collieScreenFrameEvents?: { start: number; complete: number };
    __frameWatch?: { records: number; touched: string[] };
    /** (f): the rows the parser drew, and the motion counted on the screen. */
    __hydrate?: { tagged: number; animations: number; rows: WeakSet<Element> };
  }
}

const PANE = PANES.plain;
const path = (paneId: string, query = "") => `/pane/${encodeURIComponent(paneId)}${query}`;
// Frames are off by default (round 8 verdict, lib/prefs.ts `PANE_FRAMES_DEFAULT`): every load here turns
// them on for the device, as an operator would with `?frames=1`.
const ON = "?frames=1";

/** A screen of `rows` lines; the last one says `tail`. */
function screen(tail: string, rows = 24): string {
  const lines = Array.from({ length: rows - 1 }, (_, i) => `\u001b[32mline ${String(i).padStart(2, "0")}\u001b[0m steady output`);
  return [...lines, tail].join("\n");
}

// The server is shared with the other specs of the run: forget the posted panes after each test.
test.afterEach(async ({ context, baseURL }) => {
  const res = await context.request.post(`${baseURL!}/__pane`, { data: { reset: true } });
  expect(res.status()).toBe(204);
});

async function postPane(context: BrowserContext, baseURL: string, body: { paneId: string; text?: string; status?: number }): Promise<void> {
  const res = await context.request.post(`${baseURL}/__pane`, { data: body });
  expect(res.status()).toBe(204);
}

interface Reads {
  api: Map<string, number>;
  frames: { status: number; poll: string | null }[];
  /** The JSON reads the stub answered for a pane (the dialog guard's), with the ETag each asked with. */
  guard: { ifNoneMatch: string | null }[];
  keys: string[][];
}

/** A pane the API stub answers a JSON read for, as the bridge's `GET /api/pane/:id` does. */
interface GuardPane {
  paneId: string;
  text: string;
}

/** The API stub: the snapshot (the open pane working, so the beat is HOT_MS), the config, nothing else. */
async function stubApi(page: Page, working: boolean, mirror?: { status: number }, guard?: GuardPane): Promise<Reads> {
  const reads: Reads = { api: new Map(), frames: [], guard: [], keys: [] };
  await page.route("**/api/**", async (route: Route) => {
    const url = new URL(route.request().url());
    const sub = /^\/api\/pane\/[^/]+(?:\/(\w+))?$/u.exec(url.pathname);
    const name = sub ? `pane ${sub[1] ?? "screen"}` : url.pathname;
    reads.api.set(name, (reads.api.get(name) ?? 0) + 1);
    if (url.pathname === "/api/snapshot") {
      const agents = PANE_SNAPSHOT.agents.map((a) => (a.paneId === PANE ? { ...a, status: working ? ("working" as const) : ("idle" as const) } : a));
      return route.fulfill({ json: { ...PANE_SNAPSHOT, ts: Date.now(), agents } });
    }
    if (url.pathname === "/api/config") return route.fulfill({ json: { push: false, vapidPublicKey: "" } });
    if (sub && sub[1] === undefined && mirror !== undefined) return route.fulfill({ status: mirror.status, body: "refused" });
    if (sub && sub[1] === undefined && guard !== undefined) {
      reads.guard.push({ ifNoneMatch: route.request().headers()["if-none-match"] ?? null });
      return route.fulfill({ json: { paneId: guard.paneId, text: guard.text, truncated: false, revision: 1 }, headers: { etag: '"guard-1"' } });
    }
    if (sub && sub[1] === "keys" && guard !== undefined) {
      // SAFETY: the shell's own POST body, `{ keys: string[] }`.
      reads.keys.push((JSON.parse(route.request().postData() ?? "{}") as { keys?: string[] }).keys ?? []);
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ status: 404, json: { error: "not stubbed" } });
  });
  page.on("response", (res) => {
    const headers = res.request().headers();
    if (headers["x-remix-frame"] === "true") reads.frames.push({ status: res.status(), poll: headers["x-collie-poll"] ?? null });
  });
  return reads;
}

/** Watch the frame's rows: every mutation record, and which row (by its key) each one touched. */
async function watchFrame(page: Page): Promise<void> {
  await page.evaluate(() => {
    const pre = document.querySelector('[data-frame="pane-screen"]');
    if (pre === null) throw new Error("no screen frame");
    const touched: string[] = [];
    const watch = { records: 0, touched };
    window.__frameWatch = watch;
    const keyOf = (node: Node | null): string => {
      const el = node instanceof Element ? node : (node?.parentElement ?? null);
      const row = el?.closest("[data-rmx-key]");
      return row?.getAttribute("data-rmx-key") ?? (el === pre ? "(pre)" : "(other)");
    };
    new MutationObserver((records) => {
      for (const r of records) {
        watch.records++;
        if (r.type === "childList") {
          for (const n of [...r.addedNodes, ...r.removedNodes]) watch.touched.push(n instanceof Element ? (n.getAttribute("data-rmx-key") ?? n.nodeName) : `#${n.nodeName}`);
        } else {
          watch.touched.push(`${r.type}:${keyOf(r.target)}`);
        }
      }
    }).observe(pre, { subtree: true, childList: true, characterData: true, attributes: true });
  });
}

async function frameEvents(page: Page): Promise<{ start: number; complete: number }> {
  return page.evaluate(() => ({ ...(window.__collieScreenFrameEvents ?? { start: -1, complete: -1 }) }));
}

test("(a) an unchanged pane answers 304 and writes nothing: no record, no reload, no render", async ({ page, context, baseURL }) => {
  await postPane(context, baseURL!, { paneId: PANE, text: screen("$ idle") });
  const reads = await stubApi(page, true);
  await page.goto(path(PANE, `${ON}&debug`));
  await expect(page.locator('[data-frame="pane-screen"] [data-rmx-key]').last()).toContainText("$ idle");
  await page.waitForTimeout(2_000);
  await watchFrame(page);
  const before = await frameEvents(page);
  await page.evaluate(() => {
    window.__collieRenders = {};
  });
  reads.frames.length = 0;
  await page.waitForTimeout(10_000);
  const after = await frameEvents(page);
  const watch = await page.evaluate(() => window.__frameWatch);
  const renders = await page.evaluate(() => ({ ...window.__collieRenders }));
  // HOT_MS beats, every one a 304 poll answer, and nothing read as JSON.
  expect(reads.frames.length, JSON.stringify(reads.frames)).toBeGreaterThanOrEqual(5);
  expect(reads.frames.every((f) => f.status === 304 && f.poll !== null)).toBe(true);
  expect(reads.api.get("pane screen") ?? 0).toBe(0);
  expect(watch?.records, JSON.stringify(watch)).toBe(0);
  expect(after).toEqual(before);
  expect(renders.TerminalView ?? 0, JSON.stringify(renders)).toBe(0);
  expect(renders.PaneRoute ?? 0, JSON.stringify(renders)).toBe(0);
});

test("(b) 30 s of streaming: records only for the changed row, none for the unchanged rows", async ({ page, context, baseURL }) => {
  test.setTimeout(60_000);
  await postPane(context, baseURL!, { paneId: PANE, text: screen("tick 0") });
  const reads = await stubApi(page, true);
  await page.goto(path(PANE, ON));
  const rows = page.locator('[data-frame="pane-screen"] [data-rmx-key]');
  await expect(rows.last()).toContainText("tick 0");
  await page.waitForTimeout(1_000);
  const steadyKeys = await rows.evaluateAll((els) => els.slice(0, -1).map((el) => el.getAttribute("data-rmx-key") ?? ""));
  await watchFrame(page);
  // The agent writes one new last line every 1.5 s (the HOT beat), as a working agent's tail moves.
  let tick = 0;
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    tick++;
    await postPane(context, baseURL!, { paneId: PANE, text: screen(`tick ${String(tick)}`) });
    await page.waitForTimeout(1_500);
  }
  await expect(rows.last()).toContainText(`tick ${String(tick)}`);
  const watch = await page.evaluate(() => window.__frameWatch);
  const fresh = reads.frames.filter((f) => f.status === 200).length;
  expect(fresh, JSON.stringify(reads.frames.slice(-5))).toBeGreaterThanOrEqual(10);
  // Every record is the tail row going out and its successor coming in: no steady row is touched.
  const touchedSteady = (watch?.touched ?? []).filter((what) => steadyKeys.includes(what) || steadyKeys.some((k) => what.endsWith(`:${k}`)));
  expect(touchedSteady, JSON.stringify(watch?.touched.slice(0, 20))).toEqual([]);
  expect(watch?.records ?? 0).toBeGreaterThan(0);
  // The tail row is diffed in place (ssr/frames.tsx, THE TAIL): its text node or its span, out and in.
  expect(watch?.touched.length ?? 0, JSON.stringify(watch?.touched.slice(0, 20))).toBeLessThanOrEqual(4 * fresh);
  // The steady rows are the same nodes they were.
  expect(await rows.evaluateAll((els) => els.slice(0, -1).map((el) => el.getAttribute("data-rmx-key") ?? ""))).toEqual(steadyKeys);
});

test("(c) the glide hears the runtime's own reload events of pane-screen", async ({ page, context, baseURL }) => {
  await postPane(context, baseURL!, { paneId: PANE, text: screen("before") });
  const reads = await stubApi(page, true);
  await page.goto(path(PANE, ON));
  await expect(page.locator('[data-frame="pane-screen"] [data-rmx-key]').last()).toContainText("before");
  const before = await frameEvents(page);
  expect(before.start).toBeGreaterThanOrEqual(0);
  await postPane(context, baseURL!, { paneId: PANE, text: screen("after") });
  // Flaky in two full runs on 2026-10-07 (never alone): on a miss, say which beats went out.
  const posted = Date.now();
  try {
    await expect(page.locator('[data-frame="pane-screen"] [data-rmx-key]').last()).toContainText("after");
  } catch (error) {
    const state = await page.evaluate(() => ({ url: location.href, frames: localStorage.getItem("collie:pane-frames:v1"), scroll: document.querySelector('[data-testid="pane-scroller"]')?.scrollTop }));
    throw new Error(`${String(error)}\nDIAG ${JSON.stringify({ sincePost: Date.now() - posted, frames: reads.frames, api: Object.fromEntries(reads.api), events: await frameEvents(page), state })}`, { cause: error });
  }
  await expect.poll(() => frameEvents(page)).toEqual({ start: before.start + 1, complete: before.complete + 1 });
});

test("(d) a static-shell boot with crypto.randomUUID deleted still draws the frames", async ({ page, context, baseURL }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    Reflect.deleteProperty(Crypto.prototype, "randomUUID");
  });
  await postPane(context, baseURL!, { paneId: PANE, text: screen("no uuid here") });
  const reads = await stubApi(page, true);
  await page.goto(path(PANE, ON));
  // Gone from the platform; the shell's polyfill put its own on `crypto` (lib/polyfills.ts).
  expect(await page.evaluate(() => Object.hasOwn(Crypto.prototype, "randomUUID"))).toBe(false);
  expect(await page.evaluate(() => crypto.randomUUID() !== crypto.randomUUID())).toBe(true);
  await expect(page.locator('[data-frame="pane-screen"] [data-rmx-key]').last()).toContainText("no uuid here");
  expect(reads.frames.length).toBeGreaterThan(0);
  expect(reads.api.get("pane screen") ?? 0).toBe(0);
  expect(errors).toEqual([]);
});

test("(e) a refused frame shows the notice the JSON read showed", async ({ browser, baseURL }) => {
  async function notice(frames: boolean): Promise<string> {
    const context = await browser.newContext({ baseURL: baseURL!, serviceWorkers: "block", viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    if (frames) await postPane(context, baseURL!, { paneId: PANE, status: 403 });
    else await postPane(context, baseURL!, { paneId: "nobody", status: 403 });
    await stubApi(page, false, { status: 403 });
    await page.goto(path(PANE, frames ? "?frames=1" : "?frames=0"));
    // Before the first read answers the strip passes through "Connecting…" and "Loading…"; the 403
    // notice is what it settles on, and its whole text must then be the same on both paths.
    const strip = page.locator('[role="status"]').filter({ hasText: /Read-only/ }).first();
    await expect(strip).toBeVisible();
    const text = (await strip.innerText()).trim();
    await context.close();
    return text;
  }
  const viaJson = await notice(false);
  const viaFrames = await notice(true);
  expect(viaFrames).toBe(viaJson);
});

test("(f) a server document's frames are adopted on hydration: same nodes, no motion, no reload", async ({ page, context, baseURL }) => {
  await postPane(context, baseURL!, { paneId: PANE, text: screen("from the document") });
  const res = await context.request.post(`${baseURL!}/__ssr`, { data: { snapshot: { ...PANE_SNAPSHOT, ts: Date.now() }, config: CONFIG } });
  expect(res.status()).toBe(204);
  await context.addCookies([{ name: "e2e-ssr", value: "1", url: baseURL! }]);
  await page.addInitScript(() => {
    // Before any module runs: tag the rows the parser drew, and record every animation that starts.
    const marks = { tagged: 0, animations: 0, rows: new WeakSet<Element>() };
    window.__hydrate = marks;
    document.addEventListener("readystatechange", () => {
      if (document.readyState !== "interactive") return;
      for (const row of document.querySelectorAll('[data-frame="pane-screen"] [data-rmx-key]')) {
        marks.rows.add(row);
        marks.tagged++;
      }
    });
    // Motion on the frames' rows, or the route's entrance (the mark's own loop is not the screen's).
    const count = (event: Event): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest("[data-frame]") !== null || target.getAttribute("data-slot") === "screen-transition") marks.animations++;
    };
    document.addEventListener("animationstart", count, true);
    document.addEventListener("transitionstart", count, true);
  });
  const reads = await stubApi(page, false);
  await page.goto(path(PANE, ON));
  const rows = page.locator('[data-frame="pane-screen"] [data-rmx-key]');
  await expect(rows.last()).toContainText("from the document");
  await page.waitForTimeout(8_000);
  const state = await page.evaluate(() => {
    const marks = window.__hydrate ?? { tagged: -1, animations: -1, rows: new WeakSet<Element>() };
    const now = [...document.querySelectorAll('[data-frame="pane-screen"] [data-rmx-key]')];
    return {
      tagged: marks.tagged,
      animations: marks.animations,
      running: document.getAnimations().filter((a) => {
        const el = a.effect instanceof KeyframeEffect ? a.effect.target : null;
        return el !== null && (el.closest("[data-frame]") !== null || el.getAttribute("data-slot") === "screen-transition");
      }).length,
      adopted: now.filter((row) => marks.rows.has(row)).length,
      rows: now.length,
      move: document.querySelector('[data-slot="screen-transition"]')?.getAttribute("data-move"),
      events: window.__collieScreenFrameEvents,
    };
  });
  expect(state.tagged).toBe(24);
  expect(state.adopted, JSON.stringify(state)).toBe(state.rows);
  expect(state.animations, JSON.stringify(state)).toBe(0);
  expect(state.running, JSON.stringify(state)).toBe(0);
  expect(state.move).toBe("none");
  expect(state.events).toEqual({ start: 0, complete: 0 });
  // The first beat asked with the document's ETag and heard 304.
  expect(reads.frames.length).toBeGreaterThan(0);
  expect(reads.frames.every((f) => f.status === 304)).toBe(true);
  expect(reads.api.get("pane screen") ?? 0).toBe(0);
});

test("(g) the cadence: an idle pane makes the JSON path's beats, one frame request each", async ({ page, context, baseURL }) => {
  // pane-cadence.spec.ts's window and cap: an idle open pane rests at IDLE_MS, the mirror read is
  // the frames' poll answer instead of the JSON read, and nothing else moves.
  await postPane(context, baseURL!, { paneId: PANE, text: screen("$ resting") });
  const reads = await stubApi(page, false);
  const started = Date.now();
  await page.goto(path(PANE, ON));
  await expect(page.locator('[data-frame="pane-screen"] [data-rmx-key]').last()).toContainText("$ resting");
  await page.waitForTimeout(12_000 - (Date.now() - started));
  const api = [...reads.api.values()].reduce((a, b) => a + b, 0);
  const total = api + reads.frames.length;
  expect(total, JSON.stringify({ api: Object.fromEntries(reads.api), frames: reads.frames })).toBeLessThanOrEqual(13);
  expect(reads.api.get("pane screen") ?? 0).toBe(0);
  expect(reads.api.get("/api/config") ?? 0).toBe(1);
  // One mount read, the HOT beat after the first new read, then IDLE_MS: three or four in 12 s.
  expect(reads.frames.length, JSON.stringify(reads.frames)).toBeGreaterThanOrEqual(2);
  expect(reads.frames.length, JSON.stringify(reads.frames)).toBeLessThanOrEqual(4);
  expect(reads.frames.every((f) => f.poll !== null)).toBe(true);
});

/** The read inside a poll answer: no text, and the screen model's blocks. */
interface AnsweredRead {
  text?: string;
  screen?: { blocks: { kind: string }[] };
}

function readOf(body: string): AnsweredRead {
  // SAFETY: the e2e server's poll answer, whose first element is the read's JSON.
  return JSON.parse(body.slice(body.indexOf(">") + 1, body.indexOf("</script>"))) as AnsweredRead;
}

test("(h) the poll answer carries no text: the card is the model's, the guard reads JSON with no ETag of its own", async ({ page, context, baseURL }) => {
  const shot = capture("claude--permission-bash.txt");
  await postPane(context, baseURL!, { paneId: PANES.permission, text: shot });
  const reads = await stubApi(page, false, undefined, { paneId: PANES.permission, text: shot });
  const bodies: string[] = [];
  page.on("response", (res) => {
    if (res.request().headers()["x-remix-frame"] === "true" && res.status() === 200) void res.text().then((body) => bodies.push(body));
  });
  await page.goto(path(PANES.permission, ON));
  // The card is drawn from the screen model: three options, the family caption.
  const card = page.locator('[data-slot="dialog-card"]');
  await expect(card.getByTestId("dialog-option")).toHaveCount(3);
  await expect.poll(() => bodies.length).toBeGreaterThan(0);
  // The answer has no text, nor the unwrapped text; it has the model.
  const carrying = bodies.find((body) => readOf(body).screen?.blocks[0]?.kind === "prompt-select");
  expect(carrying, "a poll answer with the dialog's block").toBeDefined();
  expect(readOf(carrying!)).not.toHaveProperty("text");
  expect(readOf(carrying!)).toHaveProperty("screen.blocks.0.kind", "prompt-select");
  // No JSON read of the pane was needed to draw it.
  expect(reads.guard).toEqual([]);
  expect(reads.api.get("pane screen") ?? 0).toBe(0);
  // A tap: the guard reads the pane as JSON with the ETag of nothing (a read without text never reached
  // web's pane cache, whose 304 would hand the guard a body with no text), then the key goes out.
  await card.getByTestId("dialog-option").first().click();
  await expect.poll(() => reads.keys.length).toBeGreaterThan(0);
  expect(reads.guard.length).toBeGreaterThan(0);
  expect(reads.guard[0]?.ifNoneMatch).toBeNull();
  // The polls that went on carry no text either.
  for (const body of bodies) expect(readOf(body), "text-free poll").not.toHaveProperty("text");
});

test("(i) Find asks for the text, searches it, and closing it drops the token", async ({ page, context, baseURL }) => {
  await postPane(context, baseURL!, { paneId: PANE, text: screen("$ findable needle") });
  const reads = await stubApi(page, true);
  await page.goto(path(PANE, ON));
  const rows = page.locator('[data-frame="pane-screen"] [data-rmx-key]');
  await expect(rows.last()).toContainText("findable needle");
  expect(reads.frames.every((f) => f.poll !== null && !f.poll.includes("text"))).toBe(true);
  await page.getByTestId("header-menu").click();
  await page.getByRole("dialog").getByText("Find in output", { exact: true }).click();
  const input = page.getByTestId("find-input");
  await expect(input).toBeVisible();
  await input.fill("needle");
  await expect(page.getByTestId("find-count")).toContainText("1");
  // The poll that fetched the text asked for it, and the bar being open keeps asking.
  expect(reads.frames.some((f) => f.poll?.split(",").includes("text") === true)).toBe(true);
  // Closing the bar: the rows are the server's again, and the polls carry no text.
  await page.getByRole("button", { name: /close/i }).first().click();
  await expect(page.getByTestId("find-bar")).toHaveCount(0);
  await expect(rows.last()).toContainText("findable needle");
  reads.frames.length = 0;
  await page.waitForTimeout(4_000);
  expect(reads.frames.length).toBeGreaterThan(0);
  expect(reads.frames.every((f) => f.poll !== null && !f.poll.includes("text"))).toBe(true);
});
