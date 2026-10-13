import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

import { installApiStub } from "./fixtures/api";

// The recipes are the bridge's own (`recipesWire()` in bridge/launcher-adds.ts), asked of Bun at the
// start of the run rather than imported: the bridge's modules are typed under its own tsconfig, which
// the web project does not share. Every harness is reported found, as on a machine with all of them.
const bridgeDir = fileURLToPath(new URL("../../bridge/", import.meta.url));
interface WireRecipe {
  harness: string;
  label: string;
}
const recipes: WireRecipe[] = JSON.parse(
  execFileSync(
    "bun",
    ["-e", "import { recipesWire } from './launcher-adds.ts'; process.stdout.write(JSON.stringify(recipesWire()))"],
    { cwd: bridgeDir, encoding: "utf8" },
  ),
);

// The badge is always in the DOM, held at opacity 0 and aria-hidden while no option skips prompts
// (components/ui/one-of.tsx keeps the cell from shifting), so "shown" is read off the accessibility
// tree, which leaves aria-hidden out, and not off CSS visibility, which counts opacity 0 as visible.
async function badgeShown(page: Page): Promise<boolean> {
  return (await page.locator("body").ariaSnapshot()).includes("No prompts");
}

test.beforeEach(async ({ page }) => {
  await installApiStub(page);
  const harnesses = recipes.map((r) => ({ id: r.harness, label: r.label, found: true }));
  const adding = { adds: true, freeText: true, file: "/home/op/.config/collie/launchers.toml", count: 0, max: 20, recipes, off: [], run: true };
  await page.route((url) => url.pathname === "/api/launchers", (route) =>
    route.fulfill({ json: { launchers: [], home: "/home/op", harnesses, items: [], adding } }),
  );
});

const cases = [
  { agent: "Grok", skip: "Always approve", line: "grok --always-approve", other: "Continue last" },
  { agent: "Antigravity", skip: "Skip permission prompts", line: "agy --dangerously-skip-permissions", other: "Plan mode" },
];

for (const c of cases) {
  test(`Add your own offers ${c.agent}'s options and builds its line`, async ({ page }) => {
    await page.goto("/new/add?kind=agent");
    await page.getByRole("combobox", { name: "Agent" }).selectOption({ label: c.agent });
    const skip = page.getByRole("button", { name: c.skip });
    await expect(skip).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByRole("button", { name: c.other })).toBeVisible();
    expect(await badgeShown(page)).toBe(false);
    await skip.click();
    await expect(skip).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText(c.line, { exact: true })).toBeVisible();
    await expect.poll(() => badgeShown(page)).toBe(true);
  });
}

test("Antigravity's Plan mode replaces Skip permission prompts, and the badge goes", async ({ page }) => {
  await page.goto("/new/add?kind=agent");
  await page.getByRole("combobox", { name: "Agent" }).selectOption({ label: "Antigravity" });
  await page.getByRole("button", { name: "Skip permission prompts" }).click();
  await page.getByRole("button", { name: "Plan mode" }).click();
  await page.getByRole("button", { name: "Continue last" }).click();
  await expect(page.getByRole("button", { name: "Skip permission prompts" })).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByText("agy --mode plan --continue", { exact: true })).toBeVisible();
  await expect.poll(() => badgeShown(page)).toBe(false);
});
