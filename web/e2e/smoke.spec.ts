import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";
import { fixtureSnapshot, fixtureTranscript, fixtureWorkspaces } from "@/test/handlers";

import { installApiStub, pinLocale } from "./fixtures/api";

/** A bounded page of 30 entries — a normal-length conversation, long enough for tail-follow. */
function longTranscript() {
  return Array.from({ length: 30 }, (_, i) => ({
    ...fixtureTranscript[i % fixtureTranscript.length]!,
    uuid: `u${i}`,
  }));
}

// The one case that must never be skipped. It asserts no feature: it proves the PATH — a real
// `vite build`, a static server over `web/dist`, the API stub, both viewports, and the artefact
// wiring on a failure. Every later case leans on all five.
//
// Selectors are a role and an accessible name, never a CSS class, and the name comes from the app's
// own English dictionary, so a copy edit moves this test with it.

test.beforeEach(async ({ page }) => {
  await installApiStub(page);
  await pinLocale(page, "en");
});

test("the app shell renders on /", async ({ page }) => {
  await page.goto("/");

  // The shell, by role and accessible name: the header's home button (`components/collie-home.tsx`,
  // whose aria-label IS this string) and the route's main region. Both are mounted once for the
  // life of the app, so this is the handle that says "the bundle booted", not "home happened to
  // render".
  await expect(page.getByRole("button", { name: en["nav.home.aria.default"] })).toBeVisible();
  await expect(page.getByRole("main")).toBeVisible();

  // And the shell is showing FIXTURE data, so the stub was reached and `rootLoader` resolved. A
  // workspace label out of `fixtureSnapshot` is the shortest proof of that.
  await expect(page.getByText(fixtureWorkspaces[0]!.label, { exact: false }).first()).toBeVisible();
});

// The reason the service-worker cases can live in this tier at all. Recorded as a case rather than
// only as a comment in the config, so a Chromium change that revokes it fails the suite instead of
// quietly making a later spec meaningless.
test("loopback over plain HTTP is a secure context, so the service worker can register", async ({
  page,
}) => {
  await page.goto("/");

  const secure = await page.evaluate(() => ({
    isSecureContext: window.isSecureContext,
    hasServiceWorker: "serviceWorker" in navigator,
    origin: window.location.origin,
  }));

  expect(secure.origin).toContain("127.0.0.1");
  expect(secure.isSecureContext).toBe(true);
  expect(secure.hasServiceWorker).toBe(true);

  // Not just permitted — actually installed. The bundle registers `/sw.js` itself
  // (`vite.config.ts`, `injectRegister: false` plus `src/lib/pwa.ts`), so waiting on the
  // registration proves the shipped worker, not a test-only one.
  const scope = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return registration.scope;
  });
  expect(scope).toContain("127.0.0.1");
});

// The Conversation mode path at both viewports: the pane's ⋮ menu offers the switch (the stubbed
// pane reports an agent session), the thread renders the persisted transcript, and the one-tap
// fallback returns to the terminal mirror. The service worker is BLOCKED for the same reason
// issue-180.spec.ts states: `page.route` cannot see a request the shipped worker answers, so the
// history stub would be raced — and this case is about the mode's path, not the worker's.
test.describe("conversation mode smoke", () => {
  test.use({ serviceWorkers: "block" });

  test("a pane opens in Conversation and one tap returns to the terminal", async ({ page }) => {
    // The stub serves a solo snapshot whose only agent carries `hasSession`, so the pane route is
    // the conversation-eligible one. The agent address mirrors issue-180's.
    await page.goto(`/pane/${encodeURIComponent("w1:p1")}`);

    await page.getByRole("button", { name: en["chat.paneMenu.aria"] }).click();
    await page.getByRole("button", { name: en["chat.conversation.label"] }).click();
    await expect(page.getByText("what changed today?").first()).toBeVisible();

    await page
      .getByRole("button", { name: en["chat.conversation.openTerminalAria"] })
      .first()
      .click();
    await expect(page.getByText("hello from the pane")).toBeVisible();
  });

  test("terminal reading controls disappear in Conversation and retain their settings on return", async ({ page }, testInfo) => {
    await page.goto(`/pane/${encodeURIComponent("w1:p1")}`);
    await page.getByRole("button", { name: en["composer.controls.displayAria"] }).click();
    const wrap = page.getByRole("switch", { name: en["settings.display.wrap.label"] });
    const increase = page.getByRole("button", { name: en["settings.display.textSize.increase"] });
    const decrease = page.getByRole("button", { name: en["settings.display.textSize.decrease"] });
    await expect(wrap).toBeChecked();
    await wrap.click();
    await increase.click();
    const stored = await page.evaluate(() => localStorage.getItem("collie:display-prefs:v4"));

    await page.getByRole("button", { name: en["chat.paneMenu.aria"] }).click();
    await expect(page.getByRole("button", { name: en["chat.find.label"] })).toBeVisible();
    await page.getByRole("button", { name: en["chat.conversation.label"] }).click();
    await expect(page.getByText("what changed today?").first()).toBeVisible();
    await expect(wrap).toHaveCount(0);
    await expect(page.getByText(en["settings.display.wrap.label"], { exact: true })).toHaveCount(0);
    await expect(page.getByText(en["settings.display.textSize.label"], { exact: true })).toHaveCount(0);
    await expect(increase).toHaveCount(0);
    await expect(decrease).toHaveCount(0);
    await page.getByRole("button", { name: en["chat.paneMenu.aria"] }).click();
    await expect(page.getByRole("button", { name: en["chat.find.label"] })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.screenshot({ path: testInfo.outputPath("conversation-reading-controls.png") });

    await page.getByRole("button", { name: en["chat.conversation.openTerminalAria"] }).first().click();
    await expect(wrap).not.toBeChecked();
    await expect(increase).toBeVisible();
    await expect(decrease).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("collie:display-prefs:v4"))).toBe(stored);
    await decrease.click();
    await wrap.click();
    await expect(wrap).toBeChecked();
    await page.getByRole("button", { name: en["chat.paneMenu.aria"] }).click();
    await page.getByRole("button", { name: en["chat.find.label"] }).click();
    await page.getByRole("textbox", { name: en["chat.find.label"] }).fill("hello");
    await expect(page.getByText("1/1", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: en["find.nextAria"] })).toBeEnabled();
  });

  test("journal recovery closes open terminal Find and returning starts a fresh search", async ({ page }) => {
    let available = false;
    await page.route((url) => /\/api\/pane\/[^/]+\/history$/.test(url.pathname), (route) => route.fulfill({
      json: { available, reason: available ? undefined : "no-log", entries: available ? fixtureTranscript : [], hasMore: false, total: 0, fileTruncated: false },
    }));
    await page.addInitScript(() => localStorage.setItem("collie:pane-view-mode:v1", "conversation"));
    await page.goto(`/pane/${encodeURIComponent("w1:p1")}`);
    await expect(page.getByText("hello from the pane")).toBeVisible();
    await page.getByRole("button", { name: en["chat.paneMenu.aria"] }).click();
    await page.getByRole("button", { name: en["chat.find.label"] }).click();
    const find = page.getByRole("textbox", { name: en["chat.find.label"] });
    await find.fill("hello");
    await expect(page.getByText("1/1", { exact: true })).toBeVisible();
    available = true;
    await page.getByRole("button", { name: en["chat.conversation.refreshAria"] }).click();
    await expect(page.getByText("what changed today?").first()).toBeVisible();
    await expect(find).toHaveCount(0);
    await expect(page.getByRole("button", { name: en["find.closeAria"] })).toHaveCount(0);
    await expect(page.getByRole("button", { name: en["chat.paneMenu.aria"] })).toBeVisible();
    await page.getByRole("button", { name: en["chat.conversation.openTerminalAria"] }).first().click();
    await expect(find).toHaveCount(0);
    await page.getByRole("button", { name: en["chat.paneMenu.aria"] }).click();
    await page.getByRole("button", { name: en["chat.find.label"] }).click();
    await expect(find).toHaveValue("");
    await expect(page.getByRole("button", { name: en["find.nextAria"] })).toBeDisabled();
    await expect(page.getByRole("button", { name: en["find.prevAria"] })).toBeDisabled();
    await find.fill("hello");
    await expect(page.getByText("1/1", { exact: true })).toBeVisible();
  });

  // ── The issue's required browser matrix (review finding F6), one case per behaviour. Every case
  // below runs once per project (phone AND tablet), so each assertion is viewport evidence.

  test("a full-length thread keeps the one-tap Terminal action on screen while following the tail", async ({
    page,
  }) => {
    await page.route((url) => /\/api\/pane\/[^/]+\/history$/.test(url.pathname), (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          paneId: "w1:p1",
          available: true,
          entries: longTranscript(),
          hasMore: false,
          total: 30,
          fileTruncated: false,
        }),
      }),
    );
    await page.goto(`/pane/${encodeURIComponent("w1:p1")}`);
    await page.getByRole("button", { name: en["chat.paneMenu.aria"] }).click();
    await page.getByRole("button", { name: en["chat.conversation.label"] }).click();
    await expect(page.getByText("what changed today?").first()).toBeVisible();

    await expect(page.getByText("what changed today?", { exact: true })).toHaveCount(15);

    // The review's finding F3 was an intersection ratio of ZERO for the only Terminal button once
    // tail-follow pinned a 30-entry thread: the controls had scrolled away with the transcript.
    // The header is a non-scrolling sibling of the scroller now, so the button must sit fully
    // inside the viewport at BOTH viewports — measured, not merely "visible".
    const button = page.getByRole("button", { name: en["chat.conversation.openTerminalAria"] }).first();
    await expect(button).toBeVisible();
    const box = (await button.boundingBox()) ?? { x: -1, y: -1, width: 0, height: 0 };
    const viewport = page.viewportSize() ?? { width: 0, height: 0 };
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    // And it works from wherever the thread was left.
    await button.click();
    await expect(page.getByText("hello from the pane")).toBeVisible();
  });

  test("a reply typed in Conversation goes through the guarded reply path and clears the draft", async ({
    page,
  }) => {
    await page.goto(`/pane/${encodeURIComponent("w1:p1")}`);
    await page.getByRole("button", { name: en["chat.paneMenu.aria"] }).click();
    await page.getByRole("button", { name: en["chat.conversation.label"] }).click();
    await expect(page.getByText("what changed today?").first()).toBeVisible();

    const replyPromise = page.waitForRequest(
      (r) => r.method() === "POST" && /\/api\/pane\/[^/]+\/reply$/.test(new URL(r.url()).pathname),
    );
    const field = page.getByPlaceholder(en["composer.placeholder.reply"]);
    await field.fill("sent from the thread");
    await page.getByRole("button", { name: en["composer.send.sendAria"] }).click();
    const request = await replyPromise;
    // SAFETY: `lib/api.ts` is the only caller of this endpoint and posts exactly `{ text, submit }`.
    const body = request.postDataJSON() as { text?: string };
    expect(body.text).toBe("sent from the thread");
    await expect(field).toHaveValue("");
  });

  test("an attachment picked in Conversation is uploaded through the existing path", async ({ page }) => {
    const uploadPromise = page.waitForRequest(
      (r) => r.method() === "POST" && /\/api\/pane\/[^/]+\/upload$/.test(new URL(r.url()).pathname),
    );
    await page.route("**/api/pane/**/upload", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, path: "/tmp/shot.png" }) }),
    );
    await page.goto(`/pane/${encodeURIComponent("w1:p1")}`);
    await page.getByRole("button", { name: en["chat.paneMenu.aria"] }).click();
    await page.getByRole("button", { name: en["chat.conversation.label"] }).click();
    await expect(page.getByText("what changed today?").first()).toBeVisible();

    await page
      .locator('input[data-testid="attach-files"]')
      .setInputFiles({ name: "shot.png", mimeType: "image/png", buffer: Buffer.from("png") });
    const request = await uploadPromise;
    expect(request.method()).toBe("POST");
  });

  test("a mode switch preserves the reply draft in both directions", async ({ page }) => {
    await page.goto(`/pane/${encodeURIComponent("w1:p1")}`);
    const writes: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && /\/(reply|keys|focus)$/.test(new URL(request.url()).pathname)) writes.push(request.url());
    });
    const field = page.getByPlaceholder(en["composer.placeholder.reply"]);
    await field.fill("draft survives the switch");

    await page.getByRole("button", { name: en["chat.paneMenu.aria"] }).click();
    await page.getByRole("button", { name: en["chat.conversation.label"] }).click();
    await expect(page.getByText("what changed today?").first()).toBeVisible();
    await expect(page.getByPlaceholder(en["composer.placeholder.reply"])).toHaveValue(
      "draft survives the switch",
    );

    await page
      .getByRole("button", { name: en["chat.conversation.openTerminalAria"] })
      .first()
      .click();
    await expect(page.getByText("hello from the pane")).toBeVisible();
    await expect(page.getByPlaceholder(en["composer.placeholder.reply"])).toHaveValue(
      "draft survives the switch",
    );
    expect(writes).toEqual([]);
  });

  test("a pane with no journal falls back to Terminal and keeps the stored Conversation preference", async ({
    page,
  }) => {
    // Opt THIS device into Conversation before the app boots, then present a pane whose snapshot
    // carries no session: the pane must render Terminal, and the preference must survive it.
    await page.route("**/api/snapshot", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...fixtureSnapshot,
          agents: fixtureSnapshot.agents.map((a) => Object.assign({}, a)),
        }),
      }),
    );
    await page.addInitScript(() => {
      window.localStorage.setItem("collie:pane-view-mode:v1", "conversation");
    });
    await page.goto(`/pane/${encodeURIComponent("w1:p1")}`);
    await expect(page.getByText("hello from the pane")).toBeVisible();
    expect(await page.evaluate(() => window.localStorage.getItem("collie:pane-view-mode:v1"))).toBe(
      "conversation",
    );
  });

  test("a confirmed missing journal file falls back locally and can recover", async ({ page }) => {
    let available = false;
    await page.route((url) => /\/api\/pane\/[^/]+\/history$/.test(url.pathname), (route) => route.fulfill({
      json: { available, reason: available ? undefined : "no-log", entries: available ? fixtureTranscript : [], hasMore: false, total: 0, fileTruncated: false },
    }));
    await page.addInitScript(() => localStorage.setItem("collie:pane-view-mode:v1", "conversation"));
    await page.goto(`/pane/${encodeURIComponent("w1:p1")}`);
    await expect(page.getByText(en["history.unavailable.noLog"])).toBeVisible();
    await expect(page.getByText("hello from the pane")).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("collie:pane-view-mode:v1"))).toBe("conversation");
    available = true;
    await page.getByRole("button", { name: en["chat.conversation.refreshAria"] }).click();
    await expect(page.getByText("what changed today?").first()).toBeVisible();
    await expect(page.getByText("hello from the pane")).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem("collie:pane-view-mode:v1"))).toBe("conversation");
  });

  test("scrolled-back Conversation keeps live refresh and unsupported-dialog recovery with Raw Terminal enabled", async ({ page }, testInfo) => {
    const idle = readFileSync(join(process.cwd(), "src/fixtures/panes/codex--fresh-idle.txt"), "utf8");
    const dialog = readFileSync(join(process.cwd(), "src/fixtures/panes/codex--ask-notes-focused.txt"), "utf8");
    let text = idle;
    let historyHits = 0;
    let liveReads = 0;
    await page.route("**/api/snapshot", (route) => route.fulfill({ json: {
      ...fixtureSnapshot,
      agents: fixtureSnapshot.agents.map((a) => Object.assign({}, a, { hasSession: true, agent: "codex" })),
    } }));
    await page.route((url) => /\/api\/pane\/[^/]+$/.test(url.pathname), (route) => {
      liveReads++;
      return route.fulfill({ json: { paneId: "w1:p1", text, truncated: false, revision: liveReads } });
    });
    await page.route((url) => /\/api\/pane\/[^/]+\/history$/.test(url.pathname), (route) => {
      historyHits++;
      return route.fulfill({ json: { available: true, entries: longTranscript(), hasMore: false, total: 30, fileTruncated: false } });
    });
    await page.addInitScript(() => {
      localStorage.setItem("collie:pane-view-mode:v1", "conversation");
      localStorage.setItem("collie:display-prefs:v4", JSON.stringify({ rawTerminal: true }));
    });
    await page.goto(`/pane/${encodeURIComponent("w1:p1")}`);
    const thread = page.getByRole("list").filter({ hasText: "what changed today?" }).first();
    await expect(thread).toBeVisible();
    await expect.poll(() => historyHits).toBe(2);
    await thread.evaluate((element) => {
      const scroller = element.parentElement!;
      scroller.scrollTop = 100;
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await expect(page.getByRole("button", { name: en["common.scrollToLatestAria"] })).toBeVisible();
    text = dialog;
    await expect(page.getByText(en["chat.conversation.requiresTerminal"])).toBeVisible();
    await expect.poll(() => historyHits, { timeout: 10000 }).toBeGreaterThan(2);
    const position = await thread.evaluate((element) => element.parentElement!.scrollTop);
    expect(position).toBe(100);

    // Measurements and screenshots are evidence, not pixel baselines. The native primitive tests
    // pin tap-floor classes, radius tokens and Collapse ownership at the component seam.
    const measurements = await page.getByRole("button", { name: en["chat.conversation.openTerminalAria"] }).evaluateAll((buttons) => buttons.map((button) => {
      const box = button.getBoundingClientRect();
      return { height: box.height, width: box.width, y: box.y, radius: getComputedStyle(button).borderRadius };
    }));
    const refresh = await page.getByRole("button", { name: en["chat.conversation.refreshAria"] }).boundingBox();
    const userRadius = await page.getByText("what changed today?", { exact: true }).first().evaluate((element) => {
      const bubble = element.closest("li")!.firstElementChild!;
      return getComputedStyle(bubble).borderRadius;
    });
    await testInfo.attach("conversation-native-measurements", { body: JSON.stringify({ viewport: page.viewportSize(), terminal: measurements, refresh, userRadius, position, historyHits, liveReads }, null, 2), contentType: "application/json" });
    await page.screenshot({ path: testInfo.outputPath("conversation-native.png") });
    await page.getByRole("button", { name: en["chat.conversation.openTerminalAria"] }).last().click();
    await expect(page.getByRole("button", { name: en["composer.controls.keys"] })).toBeVisible();
  });

  test("a supported prompt renders inline in the thread and answers through the guarded keys path", async ({ page }, testInfo) => {
    // The default fixture agent is Claude, so its permission prompt is the supported family here
    // (the fixture's tail is the "Do you want to proceed?" select menu).
    const permission = readFileSync(join(process.cwd(), "src/fixtures/panes/claude--permission-bash.txt"), "utf8");
    let keyWrites = 0;
    await page.route((url) => /\/api\/pane\/[^/]+$/.test(url.pathname), (route) =>
      route.fulfill({ json: { paneId: "w1:p1", text: permission, truncated: false, revision: 1 } }),
    );
    await page.route((url) => /\/api\/pane\/[^/]+\/keys$/.test(url.pathname), (route) => {
      keyWrites++;
      return route.fulfill({ json: { ok: true } });
    });
    await page.goto(`/pane/${encodeURIComponent("w1:p1")}`);
    await page.getByRole("button", { name: en["chat.paneMenu.aria"] }).click();
    await page.getByRole("button", { name: en["chat.conversation.label"] }).click();
    await expect(page.getByText("what changed today?").first()).toBeVisible();

    // The prompt lives INSIDE the thread, and no terminal-required card stands over it.
    await expect(page.locator('[data-slot="conversation-inline-prompts"]')).toBeVisible();
    await expect(page.getByText(en["chat.conversation.requiresTerminal"])).toHaveCount(0);

    // Answering it sends the option's keys through the same guarded write the terminal uses.
    await page.locator('[data-slot="conversation-inline-prompts"]').getByRole("button", { name: "Yes", exact: true }).first().click();
    await expect.poll(() => keyWrites).toBeGreaterThan(0);

    await page.screenshot({ path: testInfo.outputPath("conversation-inline-prompt.png") });
  });

  for (const [fixture, question, detail, answer] of [
    ["claude--permission-edit.txt", "Do you want to create hello.txt?", "1 hello", "Yes"],
    ["claude--select-preview.txt", "Which widget design should we use?", "Which widget design should we use?", "Rounded"],
  ]) {
    test(`inline context stays visible and stale actions refuse: ${fixture}`, async ({ page }, testInfo) => {
      const initial = readFileSync(join(process.cwd(), "src/fixtures/panes", fixture!), "utf8");
      let text = initial;
      let reads = 0;
      let holdReads: Promise<void> | undefined;
      const writes: unknown[] = [];
      await page.route((url) => /\/api\/pane\/[^/]+$/.test(url.pathname), async (route) => {
        reads++;
        if (holdReads) await holdReads;
        return route.fulfill({ json: { paneId: "w1:p1", text, truncated: false, revision: 1 } });
      });
      await page.route((url) => /\/api\/pane\/[^/]+\/(reply|keys)$/.test(url.pathname), (route) => {
        writes.push(route.request().postDataJSON());
        return route.fulfill({ json: { ok: true } });
      });
      await page.addInitScript(() => localStorage.setItem("collie:pane-view-mode:v1", "conversation"));
      await page.goto(`/pane/${encodeURIComponent("w1:p1")}`);
      await expect(page.getByText("what changed today?", { exact: true })).toBeVisible();
      const visibleQuestion = page.getByText(question!, { exact: true });
      await expect(visibleQuestion).toBeVisible();
      await expect(page.getByText(detail!, { exact: false }).first()).toBeVisible();
      const action = page.getByRole("button", { name: answer!, exact: true });
      await action.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath("inline-context.png") });
      // Hold read responses until AFTER the tap. Polling must not adopt the changed prompt while
      // Playwright waits for actionability, which would turn this into a legitimate fresh tap.
      let release!: () => void;
      holdReads = new Promise<void>((resolve) => { release = resolve; });
      // Change the subject without advancing revision. The shared content guard must still refuse.
      text = initial.replaceAll("hello.txt", "other.txt").replaceAll("widget design", "toolbar design");
      const before = reads;
      await action.click();
      release();
      await expect.poll(() => reads).toBeGreaterThan(before);
      await expect(page.getByRole("button", { name: answer!, exact: true })).toBeEnabled();
      expect(writes).toEqual([]);
      await expect(page.getByText(question!.replace("hello.txt", "other.txt").replace("widget design", "toolbar design"), { exact: true })).toBeVisible();
      await testInfo.attach("context-and-stale-result", {
        body: JSON.stringify({ viewport: page.viewportSize(), fixture, reads, writes }), contentType: "application/json",
      });
    });
  }

  for (const rawTerminal of [false, true]) {
    test(`known dialog keeps its send lock after failed reads with Raw Terminal=${rawTerminal}`, async ({ page }, testInfo) => {
      const text = readFileSync(join(process.cwd(), "src/fixtures/panes/claude--permission-bash.txt"), "utf8");
      let failReads = false;
      let failedReads = 0;
      const writes: unknown[] = [];
      await page.route((url) => /\/api\/pane\/[^/]+$/.test(url.pathname), (route) => {
        if (failReads) {
          failedReads++;
          return route.fulfill({ status: 500, json: { error: "injected pane read failure" } });
        }
        return route.fulfill({ json: { paneId: "w1:p1", text, truncated: false, revision: 1 } });
      });
      await page.route((url) => /\/api\/pane\/[^/]+\/(reply|keys)$/.test(url.pathname), (route) => {
        writes.push(route.request().postDataJSON());
        return route.fulfill({ json: { ok: true } });
      });
      await page.addInitScript((raw) => {
        localStorage.setItem("collie:pane-view-mode:v1", "conversation");
        localStorage.setItem("collie:display-prefs:v4", JSON.stringify({ rawTerminal: raw }));
      }, rawTerminal);
      await page.goto(`/pane/${encodeURIComponent("w1:p1")}`);
      await expect(page.getByText("what changed today?", { exact: true })).toBeVisible();
      const draft = page.getByPlaceholder(en["composer.placeholder.reply"]);
      await draft.fill("do not type into this modal");
      failReads = true;
      await expect.poll(() => failedReads, { timeout: 15000 }).toBeGreaterThan(0);
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await expect(page.getByText(en["composer.status.dialogWaiting"])).toBeVisible();
      expect(writes).toEqual([]);
      await expect(draft).toHaveValue("do not type into this modal");
      await testInfo.attach("known-dialog-lock-result", {
        body: JSON.stringify({ viewport: page.viewportSize(), rawTerminal, failedReads, writes }), contentType: "application/json",
      });
    });
  }

  test("live work appears as the distinct working bubble", async ({ page }) => {
    await page.route("**/api/snapshot", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...fixtureSnapshot,
          agents: fixtureSnapshot.agents.map((a) => Object.assign({}, a, { hasSession: true, status: "working" })),
        }),
      }),
    );
    await page.goto(`/pane/${encodeURIComponent("w1:p1")}`);
    await page.getByRole("button", { name: en["chat.paneMenu.aria"] }).click();
    await page.getByRole("button", { name: en["chat.conversation.label"] }).click();
    await expect(page.getByText("what changed today?").first()).toBeVisible();
    await expect(page.getByText(en["chat.conversation.working"])).toBeVisible();
  });
});
