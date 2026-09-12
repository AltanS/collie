import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { fixtureSnapshot, fixtureTranscript } from "@/test/handlers";
import { en } from "@/lib/i18n/messages/en";
import type { TranscriptEntry } from "@/lib/types";
import { installApiStub, pinLocale } from "./fixtures/api";

function turns(start = 0) {
  return Array.from({ length: 30 }, (_, index) => {
    const i = start + index;
    return { ...fixtureTranscript[i % fixtureTranscript.length]!, uuid: `turn-${i}`, parts: [{ kind: "text" as const, text: `Persisted turn ${i}\n\n${"Reading context. ".repeat(20)}` }] };
  });
}

// Canvas resolves CSS Color 4 tokens to sRGB. Composite the actual ancestor backgrounds before
// measuring text contrast, including translucent native Notice fills. This is not a pixel baseline.
function contrast(element: HTMLElement | SVGElement) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, 1, 1);
  const ancestors: Element[] = [];
  for (let node: Element | null = element; node; node = node.parentElement) ancestors.unshift(node);
  for (const node of ancestors) {
    ctx.fillStyle = getComputedStyle(node).backgroundColor;
    ctx.fillRect(0, 0, 1, 1);
  }
  const bg = ctx.getImageData(0, 0, 1, 1).data;
  ctx.fillStyle = getComputedStyle(element).color;
  ctx.fillRect(0, 0, 1, 1);
  const fg = ctx.getImageData(0, 0, 1, 1).data;
  const values = [fg, bg].map(bytes => [0.2126, 0.7152, 0.0722].reduce((sum, weight, i) => {
    const v = bytes[i]! / 255;
    return sum + weight * (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  }, 0));
  const a = values[0]!;
  const b = values[1]!;
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test.describe("conversation continuity", () => {
  test.use({ serviceWorkers: "block" });
  test.beforeEach(async ({ page }) => {
    await installApiStub(page);
    await pinLocale(page, "en");
    await page.addInitScript(() => localStorage.setItem("collie:pane-view-mode:v1", "conversation"));
  });

  test("background resume refreshes persisted turns once plus the bounded retry", async ({ page }, info) => {
    let entries = fixtureTranscript;
    let hits = 0;
    await page.route(url => /\/api\/pane\/[^/]+\/history$/.test(url.pathname), route => {
      hits++;
      expect(new URL(route.request().url()).searchParams.get("limit")).toBe("30");
      return route.fulfill({ json: { available: true, entries, hasMore: false, total: entries.length, fileTruncated: false } });
    });
    await page.goto("/pane/w1%3Ap1");
    await expect.poll(() => hits).toBe(2);
    const field = page.getByPlaceholder(en["composer.placeholder.reply"]);
    await field.fill("resume draft");
    // Deterministic browser lifecycle simulation, not a claim of OS backgrounding or Safari testing.
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    entries = [{ ...fixtureTranscript[1]!, uuid: "resumed", parts: [{ kind: "text", text: "Persisted while away" }] }];
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      Object.defineProperty(document, "hidden", { configurable: true, value: false });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(page.getByText("Persisted while away")).toBeVisible();
    await expect(field).toHaveValue("resume draft");
    await expect.poll(() => hits).toBe(4);
    await page.waitForTimeout(2000); // prove the delayed retry does not rearm itself
    expect(hits).toBe(4);
    await page.screenshot({ path: info.outputPath("foreground-resume.png") });
  });

  test("outage and rapid switches preserve the draft; a healthy closed-pane snapshot returns home", async ({ page }, info) => {
    let outage = false;
    let closed = false;
    let failedReads = 0;
    const writes: string[] = [];
    page.on("request", request => {
      if (request.method() === "POST" && /\/(reply|keys|focus)$/.test(new URL(request.url()).pathname)) writes.push(request.url());
    });
    await page.route("**/api/snapshot", route => {
      if (outage) { failedReads++; return route.fulfill({ status: 503, json: { error: "fixture outage" } }); }
      return route.fulfill({ json: { ...fixtureSnapshot, agents: closed ? [] : fixtureSnapshot.agents.map(agent => Object.assign({}, agent, { hasSession: true })) } });
    });
    await page.route(url => /\/api\/pane\/[^/]+\/history$/.test(url.pathname), route => outage
      ? route.fulfill({ status: 503, json: { error: "fixture outage" } })
      : route.fulfill({ json: { available: true, entries: fixtureTranscript, hasMore: false, total: 2, fileTruncated: false } }));
    await page.goto("/pane/w1%3Ap1");
    const field = page.getByPlaceholder(en["composer.placeholder.reply"]);
    await expect(page.getByText("what changed today?", { exact: true })).toBeVisible();
    await field.fill("keep this draft");
    outage = true;
    await page.getByRole("button", { name: en["chat.conversation.refreshAria"] }).click();
    await expect(page.getByText(en["history.unavailable.error"])).toBeVisible();
    await expect.poll(() => failedReads, { timeout: 15000 }).toBeGreaterThan(0);
    for (let i = 0; i < 3; i++) {
      await page.getByRole("button", { name: en["chat.conversation.openTerminalAria"] }).first().click();
      await expect(field).toHaveValue("keep this draft");
      await page.getByRole("button", { name: en["chat.paneMenu.aria"] }).click();
      await page.getByRole("button", { name: en["chat.conversation.label"] }).click();
      await expect(page.getByText("what changed today?", { exact: true })).toBeVisible();
      await expect(field).toHaveValue("keep this draft");
    }
    expect(writes).toEqual([]);
    await expect(page.getByText(en["history.unavailable.error"])).toBeVisible();
    await page.screenshot({ path: info.outputPath("outage-switches.png") });
    outage = false;
    await page.getByRole("button", { name: en["chat.conversation.refreshAria"] }).click();
    await expect(page.getByText(en["history.unavailable.error"])).toHaveCount(0);
    closed = true;
    await expect(page).toHaveURL(/\/$/, { timeout: 20000 });
    await expect(field).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("closed-pane.png") });
  });

  // The whole-effort safety gap, at BOTH viewport projects AND BOTH Raw Terminal settings (the
  // for-loop below runs phone AND tablet per project, so all four viewport/settings combinations
  // run): the unsupported Codex notes screen owns the Terminal-required card, so ordinary free-text
  // Send must refuse BEFORE any terminal-driving write — even while every post-entry pane read
  // fails. The refusal keeps the draft and the local Terminal action. The write endpoints are
  // writable fixtures, so a wrongly-scheduled write would succeed and be RECORDED, not silently
  // lost to a failed request.
  for (const rawTerminal of [false, true] as const) {
    test(`an unsupported Terminal-required state refuses free-text sends with zero writes (raw terminal: ${rawTerminal})`, async ({ page }, info) => {
      const notes = readFileSync(join(process.cwd(), "src/fixtures/panes/codex--ask-notes-focused.txt"), "utf8");
      const writes: string[] = [];
      let failedReads = 0;
      let failReads = false;
      page.on("request", request => {
        if (request.method() === "POST" && /\/(reply|keys|focus)$/.test(new URL(request.url()).pathname)) writes.push(request.url());
      });
      // Pin the Raw Terminal preference BEFORE navigation so the setting is deterministic at load.
      await page.addInitScript(raw => {
        localStorage.setItem("collie:display-prefs:v4", JSON.stringify({
          wrap: true, fontSize: 10, draftFontSize: 14, fontFamily: "system",
          rawTerminal: raw, tapToFocus: true, expandClippedReply: true,
        }));
      }, rawTerminal);
      await page.route("**/api/snapshot", route => route.fulfill({ json: {
        ...fixtureSnapshot,
        agents: fixtureSnapshot.agents.map(agent => Object.assign({}, agent, { agent: "codex", hasSession: true, status: "working" })),
      } }));
      // Writable reply/keys endpoints: any terminal-driving write would 200 and land in `writes`.
      await page.route(url => /\/api\/pane\/[^/]+\/(reply|keys)$/.test(url.pathname), route => {
        writes.push(route.request().url());
        return route.fulfill({ json: { ok: true } });
      });
      await page.route(url => /\/api\/pane\/[^/]+$/.test(url.pathname), route => {
        if (failReads) {
          failedReads++;
          return route.fulfill({ status: 500, json: { error: "injected pane read failure" } });
        }
        return route.fulfill({ json: { paneId: "w1:p1", text: notes, truncated: false, revision: 1 } });
      });
      await page.goto("/pane/w1%3Ap1");
      await expect(page.getByText(en["chat.conversation.requiresTerminal"], { exact: true }).first()).toBeVisible();
      // Every pane read after entry fails, deterministically — not conditional on a read count.
      failReads = true;
      // Observe an actually-failed pane response before the send attempt, so the failed-read half
      // of the matrix is a recorded fact, not an assumption. The refusal gate reads the ALREADY
      // rendered Terminal-required state and requires no fresh read itself.
      await expect.poll(() => failedReads, { timeout: 15000 }).toBeGreaterThan(0);
      const recoveryBefore = await page.getByText(en["chat.conversation.requiresTerminal"], { exact: true }).count();
      const field = page.getByPlaceholder(en["composer.placeholder.reply"]);
      await field.fill("must not reach the pane");
      const send = page.getByRole("button", { name: en["composer.send.sendAria"] });
      // The Send control must be actionable, so an unrelated disabled state cannot explain the
      // refusal that follows.
      await expect(send).toBeEnabled();
      await send.click();
      // The refusal strip is the composer's own fail-closed gate; the draft survives untouched.
      await expect(field).toHaveValue("must not reach the pane");
      await expect.poll(async () =>
        (await page.getByText(en["chat.conversation.requiresTerminal"], { exact: true }).count()),
      ).toBeGreaterThan(recoveryBefore);
      await expect(page.getByRole("button", { name: en["chat.conversation.openTerminalAria"] }).first()).toBeVisible();
      await page.waitForTimeout(1500); // let any wrongly-scheduled write land
      expect(writes).toEqual([]);
      await info.attach("unsupported-refusal", { body: JSON.stringify({ viewport: page.viewportSize(), rawTerminal, failedReads, writes }), contentType: "application/json" });
      await page.screenshot({ path: info.outputPath(`unsupported-refusal-raw-${String(rawTerminal)}.png`) });
    });
  }

  for (const theme of ["light", "dark"] as const) {
    test(`keyboard, live status, reduced motion and contrast in ${theme}`, async ({ page }, info) => {
      let prompt = false;
      const idle = readFileSync(join(process.cwd(), "src/fixtures/panes/claude--fresh-idle.txt"), "utf8");
      const permission = readFileSync(join(process.cwd(), "src/fixtures/panes/claude--permission-bash.txt"), "utf8");
      let keyWrites = 0;
      await page.emulateMedia({ reducedMotion: "reduce", colorScheme: theme });
      await page.route("**/api/snapshot", route => route.fulfill({ json: { ...fixtureSnapshot, agents: fixtureSnapshot.agents.map(agent => Object.assign({}, agent, { hasSession: true, status: "working" })) } }));
      await page.route(url => /\/api\/pane\/[^/]+$/.test(url.pathname), route => route.fulfill({ json: { paneId: "w1:p1", text: prompt ? permission : idle, truncated: false, revision: 1 } }));
      await page.route(url => /\/api\/pane\/[^/]+\/keys$/.test(url.pathname), route => { keyWrites++; return route.fulfill({ json: { ok: true } }); });
      await page.goto("/pane/w1%3Ap1");
      const working = page.getByRole("status").filter({ hasText: en["chat.conversation.working"] });
      await expect(working).toBeVisible();
      const animations = await working.evaluate(el => Array.from(el.querySelectorAll("svg")).map(svg => getComputedStyle(svg).animationName));
      expect(animations.every(name => name === "none")).toBe(true);
      const ratios = {
        user: await page.getByText("what changed today?", { exact: true }).evaluate(contrast),
        working: await page.getByText(en["chat.conversation.working"], { exact: true }).evaluate(contrast),
        terminal: await page.getByRole("button", { name: en["chat.conversation.openTerminalAria"] }).evaluate(contrast),
      };
      for (const value of Object.values(ratios)) expect(value).toBeGreaterThanOrEqual(4.5);
      const refresh = page.getByRole("button", { name: en["chat.conversation.refreshAria"] });
      await refresh.focus();
      await page.keyboard.press("Tab");
      await expect(page.getByRole("button", { name: en["chat.conversation.openTerminalAria"] })).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(page.getByRole("region", { name: en["chat.conversation.title"] })).toBeFocused();
      prompt = true;
      const yes = page.getByRole("button", { name: "Yes", exact: true });
      await expect(yes).toBeVisible({ timeout: 15000 });
      await expect(working).toHaveCount(0);
      await yes.focus();
      await page.keyboard.press("Enter");
      await expect.poll(() => keyWrites).toBeGreaterThan(0);
      await expect(page.getByRole("button", { name: en["composer.controls.keys"], exact: true })).toHaveCount(0);
      await info.attach("accessibility", { body: JSON.stringify({ viewport: page.viewportSize(), theme, ratios, animations, keyWrites }), contentType: "application/json" });
      await page.screenshot({ path: info.outputPath(`accessibility-${theme}.png`) });
    });
  }

  for (const reader of ["scrolled-back", "moved-backscroll", "following"] as const) {
    test(`delayed journal images preserve a ${reader} reader after refresh and retry`, async ({ page }, info) => {
      let entries: TranscriptEntry[] = turns();
      let hits = 0;
      await page.route(url => /\/api\/pane\/[^/]+\/history$/.test(url.pathname), async route => {
        await route.fulfill({ json: { available: true, entries, hasMore: false, total: 30, fileTruncated: false } });
        hits++;
      });
      const png = Buffer.from(await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = 300;
        canvas.height = 384;
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "navy";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        return canvas.toDataURL("image/png").split(",")[1]!;
      }), "base64");
      let imageRequested = false;
      let releaseImage!: () => void;
      const imageGate = new Promise<void>(resolve => { releaseImage = resolve; });
      await page.route("**/api/blobs/*", async route => {
        imageRequested = true;
        await imageGate;
        await route.fulfill({ contentType: "image/png", body: png });
      });
      await page.goto("/pane/w1%3Ap1");
      await expect.poll(() => hits).toBe(2);
      const region = page.getByRole("region", { name: en["chat.conversation.title"] });
      let anchor = page.getByText(/^Persisted turn 12$/);
      await anchor.evaluate(element => {
        const scrollport = element.closest('[role="region"]')!;
        scrollport.scrollTop += element.getBoundingClientRect().top - scrollport.getBoundingClientRect().top - 10;
        scrollport.dispatchEvent(new Event("scroll"));
      });
      const jump = page.getByRole("button", { name: en["common.scrollToLatestAria"] });
      await expect(jump).toBeVisible();
      const before = (await anchor.boundingBox())!.y;
      const imageTurn = reader === "following" ? "turn-28" : "turn-11";
      entries = entries.map(entry => entry.uuid === imageTurn
        ? Object.assign({}, entry, { parts: [...entry.parts, { kind: "image" as const, url: `/api/blobs/${"a".repeat(64)}` }] })
        : entry);
      await page.getByRole("button", { name: en["chat.conversation.refreshAria"] }).click();
      await expect.poll(() => hits).toBe(4);
      const cue = page.getByRole("button", { name: en["chat.conversation.updated"] });
      await expect(cue).toBeVisible();
      await expect.poll(async () => (await anchor.boundingBox())?.y).toBeCloseTo(before, 0);
      if (reader === "moved-backscroll") {
        await expect.poll(() => imageRequested).toBe(true);
        anchor = page.getByText(/^Persisted turn 14$/);
        // No synthetic scroll event here: the browser must notify the list of the new position.
        await anchor.evaluate(element => {
          const scrollport = element.closest('[role="region"]')!;
          scrollport.scrollTop += element.getBoundingClientRect().top - scrollport.getBoundingClientRect().top - 10;
        });
      }
      // The following case jumps AFTER capturing a backscroll anchor, so it also proves that
      // delayed layout cannot restore an obsolete reader position after the explicit jump.
      if (reader === "following") {
        await cue.click();
        await expect(cue).toHaveCount(0);
      }
      await expect.poll(() => imageRequested).toBe(true);
      // Let the jump's native scroll event and the retry's layout finish before releasing bytes.
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const image = page.getByRole("img", { name: en["transcript.attachmentAlt"], exact: true });
      expect(await image.evaluate((el: HTMLImageElement) => el.complete)).toBe(false);
      const beforeLoad = (await anchor.boundingBox())!.y;
      const heightBefore = await region.evaluate(el => el.scrollHeight);
      releaseImage();
      await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.complete && el.naturalHeight === 384)).toBe(true);
      await expect.poll(() => region.evaluate(el => el.scrollHeight)).toBeGreaterThan(heightBefore + 300);
      if (reader !== "following") {
        await expect.poll(async () => (await anchor.boundingBox())?.y).toBeCloseTo(beforeLoad, 0);
        await expect(cue).toBeVisible();
      } else {
        await expect.poll(() => region.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThanOrEqual(1);
        await expect(jump).toHaveCount(0);
      }
      const afterLoad = (await anchor.boundingBox())!.y;
      expect(hits).toBe(4);
      await info.attach("delayed-image-anchor", { body: JSON.stringify({ viewport: page.viewportSize(), reader, before, beforeLoad, afterLoad, heightBefore, heightAfter: await region.evaluate(el => el.scrollHeight), hits }), contentType: "application/json" });
      await page.screenshot({ path: info.outputPath(`delayed-image-${reader}.png`) });
      if (reader !== "following") await cue.click();
      entries = turns(2);
      await page.getByRole("button", { name: en["chat.conversation.refreshAria"] }).click();
      await expect(page.getByText(/^Persisted turn 31$/)).toBeInViewport();
      await expect(jump).toHaveCount(0);
    });
  }

  test("an amendment below the visible part of a tall turn does not move the reader", async ({ page }) => {
    let entries = turns();
    entries[12]!.parts.push({ kind: "text", text: "Tall persisted turn. ".repeat(500) });
    let hits = 0;
    await page.route(url => /\/api\/pane\/[^/]+\/history$/.test(url.pathname), route => {
      hits++;
      return route.fulfill({ json: { available: true, entries, hasMore: false, total: 30, fileTruncated: false } });
    });
    await page.goto("/pane/w1%3Ap1");
    await expect.poll(() => hits).toBe(2);
    const anchor = page.getByText(/^Persisted turn 12$/);
    await anchor.evaluate(element => {
      const region = element.closest('[role="region"]')!;
      region.scrollTop += element.getBoundingClientRect().top - region.getBoundingClientRect().top + 100;
      region.dispatchEvent(new Event("scroll"));
    });
    await expect(page.getByRole("button", { name: en["common.scrollToLatestAria"] })).toBeVisible();
    const before = (await anchor.boundingBox())!.y;
    entries = entries.map(entry => entry.uuid === "turn-12" ? Object.assign({}, entry, { parts: [...entry.parts, { kind: "text" as const, text: "New result below the reader. ".repeat(100) }] }) : entry);
    await page.getByRole("button", { name: en["chat.conversation.refreshAria"] }).click();
    await expect(page.getByText("New result below the reader.", { exact: false })).toHaveCount(1);
    await expect.poll(async () => (await anchor.boundingBox())?.y).toBeCloseTo(before, 0);
  });

  test("reconciles amended UUIDs and a moving window without moving a scrolled-back reader", async ({ page }, info) => {
    let entries = turns();
    let hits = 0;
    await page.route(url => /\/api\/pane\/[^/]+\/history$/.test(url.pathname), route => {
      hits++;
      return route.fulfill({ json: { available: true, entries, hasMore: true, total: 40, fileTruncated: false } });
    });
    await page.goto("/pane/w1%3Ap1");
    await expect.poll(() => hits).toBe(2);
    const anchor = page.getByText(/^Persisted turn 12$/);
    await anchor.scrollIntoViewIfNeeded();
    const before = await anchor.boundingBox();
    expect(before).not.toBeNull();
    entries = turns(2);
    // The same UUID gains more parts above the reader. Both replacement and evicted rows matter.
    entries[0]!.parts.push({ kind: "text", text: "Later journal context. ".repeat(100) });
    await page.getByRole("button", { name: en["chat.conversation.refreshAria"] }).click();
    await expect(page.getByText("Later journal context.", { exact: false })).toHaveCount(1);
    await expect.poll(async () => (await anchor.boundingBox())?.y).toBeCloseTo(before!.y, 0);
    const cue = page.getByRole("button", { name: en["chat.conversation.updated"] });
    await expect(cue).toBeVisible();
    await expect(page.getByText(/^Persisted turn 2$/)).toHaveCount(1);
    await page.screenshot({ path: info.outputPath("scroll-back-refresh.png") });
    await cue.click();
    await expect(cue).toHaveCount(0);
    const tail = page.getByText(/^Persisted turn 31$/);
    await expect(tail).toBeInViewport();
    entries = turns(4);
    await page.getByRole("button", { name: en["chat.conversation.refreshAria"] }).click();
    await expect(page.getByText(/^Persisted turn 33$/)).toBeInViewport();
    await info.attach("scroll-anchor", { body: JSON.stringify({ viewport: page.viewportSize(), anchorY: before!.y, hits }), contentType: "application/json" });
  });
});
