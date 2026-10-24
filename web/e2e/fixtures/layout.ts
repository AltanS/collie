import type { Page } from "@playwright/test";

// THE PHONE LAYOUT AT EVERY WIDTH (ADR 0120). From 600px wide and 480px tall the pane screen is a
// sidebar beside a strip: no Switch pill on the belt, no tab row, no pane row, no fold bar, and the
// sidebar's cards draw their own cache chips. `app-tablet` (820x1180) is past that line. A case that
// measures the phone pane screen's own chrome sets this device's Large-screen layout to Off, the
// documented way back to the phone layout, so it measures the same screen at both sizes.
// `e2e/wide-layout.spec.ts` holds that Auto does draw the sidebar on the tablet.

/** The device setting `lib/wide-layout-store.ts` reads, a bare string. */
const MODE_KEY = "collie:wide-layout-mode:v1";

export async function keepPhoneLayout(page: Page): Promise<void> {
  await page.addInitScript((key) => localStorage.setItem(key, "off"), MODE_KEY);
}
