import { expect, test } from "@playwright/test";

import { installApiStub } from "./fixtures/api";

// These three dividers occupy column 40 in the terminal, despite different fallback glyph widths.
const SCREEN = [
  "CJK column probe",
  `  1. coffee${" ".repeat(29)}│ details`,
  `\x1b[1m→ 2. 커피\x1b[0m${" ".repeat(31)}│ details`,
  `  3. 中文${" ".repeat(31)}│ details`,
].join("\n");

test.use({ serviceWorkers: "block" });

test("a non-wrapping terminal keeps English, Korean and Chinese dividers in one column", async ({ page }) => {
  await installApiStub(page);
  await page.addInitScript(() => {
    localStorage.setItem("collie:display-prefs:v4", JSON.stringify({ wrap: false }));
  });
  await page.route(/\/api\/pane\/w2%3Ap2(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { paneId: "w2:p2", text: SCREEN, truncated: false, revision: 1 } }),
  );
  await page.goto("/pane/w2:p2");
  const mirror = page.locator("pre").filter({ hasText: "CJK column probe" });
  await expect(mirror).toBeVisible();
  await expect(mirror).toHaveCSS("white-space", "pre");
  await page.evaluate(() => document.fonts.ready);

  const lefts = await mirror.evaluate((pre) => {
    const positions: number[] = [];
    const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const at = node.textContent!.indexOf("│");
      if (at < 0) continue;
      range.setStart(node, at);
      range.setEnd(node, at + 1);
      positions.push(range.getBoundingClientRect().left);
    }
    return positions;
  });

  expect(lefts).toHaveLength(3);
  expect(Math.max(...lefts) - Math.min(...lefts)).toBeLessThan(1);
});
