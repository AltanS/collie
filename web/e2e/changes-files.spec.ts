import { expect, test } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";
import { fixtureAgents, fixtureFileRead } from "@/test/handlers";

import { installApiStub } from "./fixtures/api";
import { serveWithShellCsp } from "./fixtures/csp";

// THE FILES TAB (ADR 0083) IN A REAL ENGINE. jsdom cannot say whether a sandboxed `srcdoc` frame
// renders under the shell's Content-Security-Policy, which is the one claim the HTML preview makes
// that a unit test cannot check. The API is the shared fixture (`src/test/handlers.ts`), routed by
// `fixtures/api.ts`; the CSP is the bridge's own, read from its source (`fixtures/csp.ts`).

test.use({ serviceWorkers: "block" });

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("states"), "the playground has no pane route");
  await installApiStub(page);
});

const PANE = encodeURIComponent(fixtureAgents[0]!.paneId);

test("open Files, enter a folder, open a Markdown file, go back twice", async ({ page }) => {
  await page.goto(`/pane/${PANE}/changes`);
  await page.getByRole("tab", { name: en["changes.tabs.files"] }).click();
  await expect(page).toHaveURL(/\/changes\/files$/);

  await page.getByRole("button", { name: /^docs, folder/ }).click();
  await expect(page).toHaveURL(/\/changes\/files\?dir=docs$/);
  await expect(page.getByRole("button", { name: /^guide\.md/ })).toBeVisible();

  await page.getByRole("button", { name: /^guide\.md/ }).click();
  await expect(page).toHaveURL(/\/changes\/files\?path=docs%2Fguide\.md$/);
  // Markdown opens on its Preview: the sentence is a paragraph, not a source line.
  await expect(page.getByText("Read the cart code first.")).toBeVisible();
  await expect(page.getByRole("radio", { name: en["files.view.preview"] })).toBeChecked();

  // Back, once: the file's folder.
  await page.getByRole("button", { name: en["files.backAria.folder"] }).click();
  await expect(page).toHaveURL(/\/changes\/files\?dir=docs$/);
  // Back, twice: the Files root.
  await page.getByRole("button", { name: en["files.backAria.parent"] }).click();
  await expect(page).toHaveURL(/\/changes\/files$/);
  await expect(page.getByRole("button", { name: /^src, folder/ })).toBeVisible();
});

test("ignored entries are hidden, Show brings them back dimmed, and the name filter narrows the folder", async ({ page }) => {
  await page.goto(`/pane/${PANE}/changes/files`);
  await expect(page.getByRole("button", { name: /^docs, folder/ })).toBeVisible();
  // Hidden by default, with one quiet line that says how many.
  await expect(page.getByRole("button", { name: /^node_modules/ })).toHaveCount(0);
  await expect(page.getByText(en["files.ignored.hidden"].replace("{count}", "2"))).toBeVisible();

  // Show: the rows return, dimmed, and the line goes.
  await page.getByRole("button", { name: en["files.ignored.showAria"] }).click();
  const log = page.getByRole("button", { name: /^debug\.log/ });
  await expect(log).toBeVisible();
  const ink = (name: RegExp) => page.getByRole("button", { name }).locator("span").first().evaluate((el) => getComputedStyle(el).color);
  expect(await ink(/^debug\.log/)).not.toBe(await ink(/^README\.md/));
  await expect(page.getByText(en["files.ignored.hidden"].replace("{count}", "2"))).toHaveCount(0);

  // The filter opens over the list without moving it, the Ignored chip is pressed, and a name narrows.
  const rows = page.locator('[data-slot="file-rows"]');
  const top = (await rows.boundingBox())!.y;
  await page.getByRole("button", { name: en["changes.filter.button"] }).click();
  await expect(page.getByRole("button", { name: en["files.filter.ignored"], exact: true })).toHaveAttribute("aria-pressed", "true");
  expect((await rows.boundingBox())!.y).toBe(top);
  await page.getByPlaceholder(en["files.filter.placeholder"]).fill("DEBUG");
  await expect(rows.getByRole("button")).toHaveCount(1);
  await expect(page.getByText(en["files.filter.shown"].replace("{shown}", "1").replace("{total}", "9"))).toBeVisible();

  // Nothing matches: the sentence and the way out.
  await page.getByPlaceholder(en["files.filter.placeholder"]).fill("zzz");
  await expect(page.getByText(en["changes.filter.none"])).toBeVisible();
  await page.getByPlaceholder(en["files.filter.placeholder"]).fill("");

  // The Ignored choice is the device's: it outlives a reload.
  await page.reload();
  await expect(page.getByRole("button", { name: /^debug\.log/ })).toBeVisible();
});

test("a changed Markdown file previews from its diff, in Files", async ({ page }) => {
  await page.goto(`/pane/${PANE}/changes?repo=packages%2Fapi&path=notes.md`);
  await page.getByRole("button", { name: en["changes.file.previewAria"] }).click();
  await expect(page).toHaveURL(/\/changes\/files\?path=packages%2Fapi%2Fnotes\.md$/);
});

// LINKS IN A MARKDOWN FILE. A relative link opens the other file in Files, a `#anchor` scrolls in
// place, and a web address still leaves for a new tab. The guide is swapped for one that has all
// three, with enough text under the first heading that the anchor really has to scroll.
test("a Markdown link opens the other file in Files, an anchor scrolls in place, and Back returns", async ({ page }) => {
  const filler = Array.from({ length: 60 }, (_, n) => `Paragraph ${n + 1} of filler, so the page is taller than the screen.`).join("\n\n");
  const guide = `# Guide\n\nRead [the readme](../README.md) or [jump down](#the-end).\n\nA [site](https://example.com/docs "Docs").\n\n${filler}\n\n## The end\n\nLast words.\n`;
  await page.route(/\/api\/pane\/[^/]+\/files\?path=docs%2Fguide\.md$/, (route) => {
    const read = fixtureFileRead("docs/guide.md");
    if (read === null || !read.available) throw new Error("no fixture docs/guide.md");
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...read, text: guide, size: guide.length }),
    });
  });

  await page.goto(`/pane/${PANE}/changes/files?path=docs%2Fguide.md`);
  await expect(page.getByText("Last words.")).toBeAttached();
  await expect(page.getByText("Last words.")).not.toBeInViewport();

  // A web address keeps its new tab; nothing about it changed.
  const site = page.getByRole("link", { name: "site" });
  await expect(site).toHaveAttribute("target", "_blank");
  await expect(site).toHaveAttribute("href", "https://example.com/docs");

  // An anchor scrolls to its heading in place: same address, no new tab, heading on screen.
  await page.getByRole("link", { name: "jump down" }).click();
  const heading = page.getByText("The end", { exact: true });
  await expect(heading).toBeInViewport();
  // Not under the sticky file bar: the heading starts below where the bar ends.
  const bar = await page.locator("main .sticky").first().boundingBox();
  const at = await heading.boundingBox();
  expect(at!.y).toBeGreaterThanOrEqual(bar!.y + bar!.height - 1);
  await expect(page).toHaveURL(/\/changes\/files\?path=docs%2Fguide\.md$/);
  expect(page.context().pages()).toHaveLength(1);

  // A relative link lands on the other file.
  await page.getByRole("link", { name: "the readme" }).click();
  await expect(page).toHaveURL(/\/changes\/files\?path=README\.md$/);
  await expect(page.getByText("Run it")).toBeVisible();

  // The browser's Back, which is also the edge swipe, returns to the first file.
  await page.goBack();
  await expect(page).toHaveURL(/\/changes\/files\?path=docs%2Fguide\.md$/);
  await expect(page.getByRole("link", { name: "the readme" })).toBeVisible();

  // And the arrow, by the back-level rules, goes up from a file to its folder.
  await page.getByRole("link", { name: "the readme" }).click();
  await expect(page).toHaveURL(/\/changes\/files\?path=README\.md$/);
  await page.getByRole("button", { name: en["files.backAria.folder"] }).click();
  await expect(page).toHaveURL(/\/changes\/files$/);
});

// THE HTML PREVIEW UNDER THE SHELL'S CSP. The document below tries everything a hostile page would:
// a script, a remote image, a remote stylesheet, a link, a form and a meta refresh. Only the inline
// style may work (the CSP allows it), and nothing may reach the network or the app.
const HOSTILE_HTML = `<!doctype html>
<html><head>
<style>h1 { color: rgb(200, 0, 0); }</style>
<link rel="stylesheet" href="https://stylesheet.invalid/x.css">
<meta http-equiv="refresh" content="1;url=https://refresh.invalid/">
</head><body>
<h1 id="title">Hello from a file</h1>
<img id="remote" src="https://image.invalid/x.png" width="20" height="20">
<img id="inline" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" width="20" height="20">
<a id="link" href="https://link.invalid/">a link</a>
<form id="form" action="https://form.invalid/" method="post"><button id="submit" type="submit">send</button></form>
<script>document.body.setAttribute("data-ran", "yes"); window.top.document.title = "pwned";</script>
</body></html>`;

test("the HTML preview renders in a sandboxed frame under the shell's CSP and nothing escapes it", async ({ page }) => {
  const policy = await serveWithShellCsp(page);
  // What actually ANSWERED from outside the app. A request that the CSP blocks still shows up as a
  // request event in Chromium and never gets a response, so only responses count as "left the machine".
  const answered: string[] = [];
  page.on("response", (res) => answered.push(res.url()));
  // The stub's `index.html` is swapped for the hostile one, for this page only.
  await page.route(/\/api\/pane\/[^/]+\/files\?path=index\.html$/, (route) => {
    const read = fixtureFileRead("index.html");
    if (read === null || !read.available) throw new Error("no fixture index.html");
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...read, text: HOSTILE_HTML, size: HOSTILE_HTML.length }),
    });
  });

  const document = await page.goto(`/pane/${PANE}/changes/files?path=index.html`);
  // The page really carries the policy, so the frame below really inherits it.
  expect(document?.headers()["content-security-policy"]).toBe(policy);
  expect(policy).toContain("default-src 'self'");

  const iframe = page.locator("iframe");
  await expect(iframe).toBeVisible();
  // An empty sandbox: the attribute exists and holds no token.
  expect(await iframe.getAttribute("sandbox")).toBe("");
  await expect(page.getByText(en["files.html.caption"])).toBeVisible();

  // It RENDERS: the srcdoc document is laid out, with its inline style applied.
  const frame = page.frameLocator("iframe");
  const title = frame.locator("#title");
  await expect(title).toHaveText("Hello from a file");
  await expect(title).toHaveCSS("color", "rgb(200, 0, 0)");
  expect((await iframe.boundingBox())!.height).toBeGreaterThan(100);
  // Its ground is white, whatever the theme.
  expect(await iframe.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(255, 255, 255)");

  // An inline (data:) picture is the file's own bytes and draws; a remote one is refused.
  const drawn = (id: string) => frame.locator(id).evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0);
  await expect.poll(() => drawn("#inline")).toBe(true);
  expect(await drawn("#remote")).toBe(false);

  // Scripts are off: the frame's own script neither ran in the frame nor reached the app.
  await expect(frame.locator("body")).not.toHaveAttribute("data-ran", "yes");
  expect(await page.title()).not.toBe("pwned");

  // The meta refresh (1 second) goes nowhere: the document is still there after it would have fired.
  await page.waitForTimeout(1600);
  await expect(title).toHaveText("Hello from a file");

  // A form does nothing: sandboxed without `allow-forms`.
  await frame.locator("#submit").click({ force: true });
  await expect(title).toHaveText("Hello from a file");

  // A link cannot take the frame, the app or a new window anywhere. The shell's CSP has no `frame-src`,
  // so `default-src 'self'` refuses the navigation and the browser may show its own blocked page IN
  // THE FRAME. What must hold is that nothing else moved.
  await frame.locator("#link").click({ force: true });
  await page.waitForTimeout(500);
  expect(page.context().pages()).toHaveLength(1);
  await expect(page).toHaveURL(/\/changes\/files\?path=index\.html$/);
  expect(page.frames().map((f) => f.url()).filter((u) => u.includes(".invalid"))).toEqual([]);

  // Nothing from outside ever answered: not the image, the stylesheet, the link, the form or the refresh.
  expect(answered.filter((url) => /\.invalid\b/.test(url))).toEqual([]);
});
