import { expect, type Locator, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";

// THE TWO BACKS OF THE CHANGES ROUTE (1.18.0). A phone draws the header's arrow AND a bottom Back
// bar with the same accessible name and the same move (`routes/changes.tsx`, `BackBar`: a thumb
// cannot reach the header). A bare `getByRole("button", { name })` therefore matches two elements on
// a phone and one on a tablet. These two helpers address each by where it lives: the arrow is the
// banner's, the bottom Back is the one that also carries the word "Back".

/** The header's back arrow, by its accessible name. One element at every width. */
export function headerBack(page: Page, name: string): Locator {
  return page.getByRole("banner").getByRole("button", { name });
}

/** The bottom Back bar's button, by the same accessible name. Phone only. */
export function bottomBack(page: Page, name: string): Locator {
  return page.getByRole("button", { name }).filter({ hasText: en["files.back"] });
}

/** A phone, as the Changes screen draws it: under Tailwind's `md` (768px). */
export function isPhone(page: Page): boolean {
  return page.viewportSize()!.width < 768;
}

/** The bottom Back exists on a phone, with the header arrow's name, and is not drawn on a tablet. */
export async function expectBottomBack(page: Page, name: string): Promise<void> {
  await expect(bottomBack(page, name)).toHaveCount(isPhone(page) ? 1 : 0);
}
