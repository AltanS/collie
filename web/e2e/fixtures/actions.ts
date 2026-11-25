import { expect, type Locator, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";

// THE ACTIONS DOOR (ADR 0165). The Belt's pinned pill opens the Actions palette, no longer the Switch
// pane sheet, and the header buttons open the same palette. Its name is "Actions", or "Actions, another
// pane needs you" while the needs-you dot is on, so a bare name would also match "Pane actions".

const ACTIONS_NAME = new RegExp(`^${en["actions.open.aria"]}(?:$|,)`, "u");

/** The Actions button: the Belt's pinned pill in a pane on a phone, the header's elsewhere. */
export function actionsButton(page: Page): Locator {
  return page.getByRole("button", { name: ACTIONS_NAME });
}

/** Open the Switch pane sheet the way a phone does without the drag: Actions, then its Switch pane row. */
export async function openSwitcher(page: Page): Promise<void> {
  // Wait for the pane screen first. Its URL is pushed before React has drawn the route, and the header's
  // Actions button is on the screen the tap came from, so a click in that gap opens a palette that
  // closes itself when the route commits (a route change closes the palette). The fixture then types
  // into a field that is gone, or the sheet's own handler is not registered yet. WebKit pinned to one
  // core lost the palette on nearly every run of the five-tile case, and one in twenty of the Pinned case.
  await expect(page.locator('[data-slot="pane-name"]').first()).toBeVisible();
  await actionsButton(page).click();
  const field = page.getByRole("dialog", { name: en["actions.title"] }).getByRole("textbox", { name: en["actions.search.placeholder"] });
  await field.fill(en["chat.switcher.title"]);
  await field.press("Enter");
}
