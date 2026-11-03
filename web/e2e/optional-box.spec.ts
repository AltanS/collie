import { expect, test } from "@playwright/test";

import { optionalBox } from "./fixtures/layout";

test("optional geometry does not wait for a pin whose accessible name changes", async ({ page }) => {
  await page.setContent("<button>Your prompt: DONE-7</button>");
  const pin = page.getByRole("button", { name: "Your prompt: DONE-7", exact: true });
  await expect(pin).toBeVisible();
  const button = await pin.elementHandle();
  if (button === null) throw new Error("Pin fixture missing");
  // Interleave the real DOM transition after a real visibility result, as the live failure did.
  // No Locator result or browser geometry is mocked.
  const isVisible = pin.isVisible.bind(pin);
  pin.isVisible = async (options) => {
    const visible = await isVisible(options);
    await button.evaluate((element) => { element.textContent = "Asked further back"; });
    return visible;
  };
  const box = await optionalBox(pin);
  expect(box?.width).toBeGreaterThan(0);
  expect(box?.height).toBeGreaterThan(0);
  await button.evaluate((element) => { element.textContent = "Asked further back"; });
  await button.dispose();
  await expect(page.getByRole("button", { name: "Asked further back", exact: true })).toBeVisible();
  expect(await optionalBox(pin)).toBeNull();
});
