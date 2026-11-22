import { expect, test } from "@playwright/test";

import { fixtureKiroChat, fixtureKiroSnapshot, KIRO_PANE_ID } from "@/test/handlers";

import { installApiStub, installPaneWorld, paneCapture, pinLocale } from "./fixtures/api";
import { keepPhoneLayout } from "./fixtures/layout";

// THE "BACK IN THE BOX" CARD'S ROW FITS A NARROW PHONE (ADR 0122, the 2026-11-22 addendum). Edit joined Discard and
// Send, so the row holds three buttons: at 360 and 390 px wide none wraps to a second line, no label is cut, and the
// page does not scroll sideways. The type is never shrunk to make them fit. The widths go into the test's notes.

test.use({ serviceWorkers: "block" });

const RETURNED = { requestId: "req-back-00001", state: "returned", text: "second message, back in the agent's box" };

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "app-phone", "a phone-width case");
  await keepPhoneLayout(page);
  await pinLocale(page, "en");
  await page.addInitScript(() => window.localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ paneView: "chat" })));
  await installApiStub(page);
});

for (const width of [360, 390]) {
  test(`at ${String(width)} px the row Discard, Edit, Send stays on one line, uncut, with no sideways scroll`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await installPaneWorld(page, {
      paneId: KIRO_PANE_ID,
      snapshot: fixtureKiroSnapshot,
      chat: { ...fixtureKiroChat, queuedSends: [RETURNED] },
      screens: { idle: paneCapture("kiro--v3-idle-w120") },
      start: "idle",
    });
    await page.goto(`/pane/${encodeURIComponent(KIRO_PANE_ID)}`);
    const card = page.locator("[data-slot='stream-returned']");
    await expect(card.locator("button")).toHaveText(["Discard", "Edit", "Send"]);
    const measured = await card.evaluate((node) => {
      const buttons = [...node.querySelectorAll("button")];
      const row = buttons[0]!.parentElement!;
      return {
        card: Math.round(node.getBoundingClientRect().width),
        row: Math.round(row.getBoundingClientRect().width),
        buttons: buttons.map((button) => {
          const box = button.getBoundingClientRect();
          return { word: button.textContent ?? "", width: Math.round(box.width), top: Math.round(box.top), height: Math.round(box.height), cut: button.scrollWidth > button.clientWidth };
        }),
        page: document.documentElement.scrollWidth,
        fontSize: getComputedStyle(buttons[1]!).fontSize,
      };
    });
    test.info().annotations.push({ type: "measure", description: `${String(width)} px: ${JSON.stringify(measured)}` });
    console.log(`returned-card row at ${String(width)} px: ${JSON.stringify(measured)}`);
    const tops = new Set(measured.buttons.map((button) => button.top));
    expect(tops.size).toBe(1);
    expect(measured.buttons.every((button) => !button.cut)).toBe(true);
    expect(measured.page).toBeLessThanOrEqual(width);
  });
}
