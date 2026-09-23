import { expect, test, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";
import { fixtureAgents, fixtureChangeDiff } from "@/test/handlers";

import { installApiStub } from "./fixtures/api";

// THE 5 S RE-READ MOVES NOTHING IT DOES NOT HAVE TO (ADR 0065 rule 8, ADR 0066). The operator saw
// the Changes screens jitter on every beat. With the same answer each time, a beat must change not
// one node: a MutationObserver on the whole body and a `layout-shift` observer are armed, three
// beats pass on the page clock, and both must stay at zero. A diff that DOES change keeps its
// colour: only the new rows and the line numbers that really moved are touched. A beat that falls
// while the operator scrolls waits until they are still.

test.use({ serviceWorkers: "block", viewport: { width: 375, height: 812 } });

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("states"), "the playground has no Changes route");
  test.skip(testInfo.project.name === "app-tablet", "a phone-width case; the tablet run would repeat it");
  await installApiStub(page);
});

const PANE = fixtureAgents[0]!;
const BEAT = 5000;

interface Recorded {
  mutations: string[];
  shift: number;
}

declare global {
  interface Window {
    /** What the observers below saw since `watch` armed them. */
    changesPollRecord?: Recorded;
  }
}

/** Arm a MutationObserver over the body and a layout-shift observer. */
async function watch(page: Page) {
  await page.evaluate(() => {
    const rec: Recorded = { mutations: [], shift: 0 };
    window.changesPollRecord = rec;
    new MutationObserver((list) => {
      for (const m of list) {
        const detail =
          m.type === "attributes" ? `@${m.attributeName}` : m.type === "childList" ? `+${m.addedNodes.length}-${m.removedNodes.length}` : "";
        const target = m.target.nodeType === Node.TEXT_NODE ? `#text "${m.target.textContent ?? ""}"` : m.target.nodeName;
        rec.mutations.push(`${m.type}${detail} on ${target}`);
      }
    }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) rec.shift += "value" in e ? Number(e.value) : 0;
    }).observe({ type: "layout-shift" });
  });
}

const recorded = (page: Page): Promise<Recorded> =>
  page.evaluate(() => window.changesPollRecord ?? { mutations: ["the observers were never armed"], shift: 0 });

/**
 * Advance the page clock in short steps with real time between them, so every fetch the app starts
 * settles inside the step that started it. One jump of 5 s leaves the root poll's own requests out
 * past their timeout and draws the connection banner, which is not what these cases measure.
 */
async function advance(page: Page, ms: number) {
  for (let t = 0; t < ms; t += 250) {
    await page.clock.runFor(250);
    await page.waitForTimeout(15);
  }
}

function counter(page: Page, re: RegExp) {
  let n = 0;
  page.on("request", (r) => {
    if (re.test(r.url())) n++;
  });
  return () => n;
}

/** Three beats with the same answer: each one reads, and none touches the page. */
async function expectQuietBeats(page: Page, reads: () => number) {
  await advance(page, 1000);
  await watch(page);
  for (let i = 0; i < 3; i++) {
    const before = reads();
    await advance(page, BEAT);
    expect(reads(), `beat ${i + 1} read again`).toBeGreaterThan(before);
  }
  await advance(page, 500);
  const { mutations, shift } = await recorded(page);
  expect(mutations).toEqual([]);
  expect(shift).toBe(0);
}

const LIST_READ = /\/api\/pane\/[^/]+\/changes(\?(?!.*path=)|$)/;
const DIFF_READ = /\/api\/pane\/[^/]+\/changes\?.*path=/;

test("the list takes three identical beats without one DOM change, in List and in Tree", async ({ page }) => {
  await page.clock.install();
  const reads = counter(page, LIST_READ);
  await page.goto(`/pane/${encodeURIComponent(PANE.paneId)}/changes`);
  await expect(page.getByText("api · 2 files")).toBeVisible();
  await expectQuietBeats(page, reads);

  await page.getByRole("radio", { name: en["changes.layout.tree"] }).click();
  await expect(page.getByRole("button", { expanded: true }).first()).toBeVisible();
  await expectQuietBeats(page, reads);
});

test("an open diff takes three identical beats without one DOM change and keeps its colour", async ({ page }) => {
  await page.clock.install();
  const reads = counter(page, DIFF_READ);
  await page.goto(`/pane/${encodeURIComponent(PANE.paneId)}/changes`);
  await page.getByRole("button", { name: /checkout\.tsx/ }).click();
  const diff = page.locator('[data-slot="diff"]');
  await expect(diff).toHaveAttribute("data-highlighted", "");
  await expectQuietBeats(page, reads);
  await expect(diff).toHaveAttribute("data-highlighted", "");
});

test("a diff that changes on a beat keeps its colour and touches only what changed", async ({ page }) => {
  await page.clock.install();
  let beat = 0;
  const reads = counter(page, DIFF_READ);
  await page.route(DIFF_READ, async (route) => {
    const answer = fixtureChangeDiff(".", "src/routes/checkout.tsx");
    // Each beat, one more line lands above `return (`: what an agent editing the file looks like.
    if (answer.available) answer.diff = answer.diff.replace("   return (", `${"+  const extra = 1;\n".repeat(beat)}   return (`);
    beat++;
    return route.fulfill({ json: answer });
  });
  await page.goto(`/pane/${encodeURIComponent(PANE.paneId)}/changes`);
  await page.getByRole("button", { name: /checkout\.tsx/ }).click();
  const diff = page.locator('[data-slot="diff"]');
  await expect(diff).toHaveAttribute("data-highlighted", "");
  await advance(page, 1000);
  await watch(page);
  for (let i = 0; i < 3; i++) {
    const before = reads();
    await advance(page, BEAT);
    expect(reads()).toBeGreaterThan(before);
  }
  const { mutations } = await recorded(page);
  // Never back to plain: the attribute that marks a coloured diff is not touched once.
  expect(mutations.filter((m) => m.includes("@data-highlighted"))).toEqual([]);
  // One new row per beat, nothing removed, and otherwise only line numbers re-written.
  expect(mutations.filter((m) => m.startsWith("childList"))).toEqual(Array(3).fill("childList+1-0 on DIV"));
  expect(mutations.every((m) => m.startsWith("childList") || /^characterData on #text "\d+"$/.test(m))).toBe(true);
  await expect(diff.getByText("const extra = 1;")).toHaveCount(3);
  await expect(diff).toHaveAttribute("data-highlighted", "");
});

test("the dashboard's Changes tab takes three identical beats without one DOM change", async ({ page }) => {
  await page.clock.install();
  const reads = counter(page, /\/api\/workspace\/[^/]+\/changes/);
  await page.goto("/");
  await page.getByRole("navigation", { name: en["home.tabs.aria"] }).getByRole("button", { name: new RegExp(`^${en["changes.title"]}$`) }).click();
  const rows = page.getByRole("list", { name: en["home.changes.listAria"] }).getByRole("button");
  await expect(rows.first()).toContainText("files");
  await expectQuietBeats(page, reads);
});

test("a beat that falls while the list scrolls waits until the finger has been still for a second", async ({ page }) => {
  await page.clock.install();
  const reads = counter(page, LIST_READ);
  await page.goto(`/pane/${encodeURIComponent(PANE.paneId)}/changes`);
  await expect(page.getByText("api · 2 files")).toBeVisible();
  const opened = reads();
  // Scroll for two beats' worth of time: a scroll event on the list every 250 ms.
  for (let t = 0; t < 2 * BEAT; t += 250) {
    await page.locator("main").dispatchEvent("scroll");
    await advance(page, 250);
  }
  expect(reads()).toBe(opened);
  // Still: the held beat fires one second after the last scroll.
  await advance(page, 1250);
  expect(reads()).toBe(opened + 1);
});
