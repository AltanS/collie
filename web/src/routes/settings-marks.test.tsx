import { render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { isPageId, SETTINGS, settingById } from "@/lib/settings";
import { withHeaderHost } from "@/test/header-host";
import {
  SettingsCharacterRoute,
  SettingsChatRoute,
  SettingsDashboardRoute,
  SettingsDevicesRoute,
  SettingsInstallCountRoute,
  SettingsKeysRoute,
  SettingsLookRoute,
  SettingsNotificationsRoute,
  SettingsPrivacyRoute,
  SettingsTricksRoute,
  SettingsVoiceHostRoute,
  SettingsVoiceModelRoute,
  SettingsVoiceRoute,
} from "./settings-sections";
import { UpdatesRoute } from "./updates";

// EVERY SETTINGS ROW HAS A MARKED PLACE ON A PAGE (ADR 0170). Each page wraps the control that draws a row in a
// `SettingSlot` naming its registry ids. This renders every page and reads the marks: an id no row has fails, and a
// registry row on a Settings page that no page marks fails.

const PAGES = {
  "/settings/look": <SettingsLookRoute />,
  "/settings/look/character": <SettingsCharacterRoute />,
  "/settings/chat": <SettingsChatRoute />,
  "/settings/keys": <SettingsKeysRoute />,
  "/settings/notifications": <SettingsNotificationsRoute />,
  "/settings/voice": <SettingsVoiceRoute />,
  "/settings/voice/host": <SettingsVoiceHostRoute />,
  "/settings/voice/model": <SettingsVoiceModelRoute />,
  "/settings/dashboard": <SettingsDashboardRoute />,
  "/settings/tricks": <SettingsTricksRoute />,
  "/settings/devices": <SettingsDevicesRoute />,
  "/settings/privacy": <SettingsPrivacyRoute />,
  "/settings/privacy/install-count": <SettingsInstallCountRoute />,
  "/settings/updates": <UpdatesRoute />,
} satisfies Record<string, ReactNode>;

/**
 * Rows of a Settings page that no page draws yet, by why. Empty since the eleven pages (2026-11-21): a row named here
 * would be a row a person cannot reach from Settings.
 */
const NOT_DRAWN_YET = {} satisfies Record<string, string>;

/** Rows drawn by a page this test does not render: they have tests of their own. */
const DRAWN_ELSEWHERE = (id: string) => id.startsWith("accounts.") || id.startsWith("tricks.trick.");

async function marksOf(path: string, page: ReactNode): Promise<string[]> {
  const router = createMemoryRouter([{ path, element: withHeaderHost(page) }], { initialEntries: [path] });
  const { container, unmount } = render(<RouterProvider router={router} />);
  await waitFor(() => expect(container.querySelector("[data-setting]")).not.toBeNull());
  const ids = [...container.querySelectorAll("[data-setting]")].flatMap((el) => (el.getAttribute("data-setting") ?? "").split(" "));
  unmount();
  return ids;
}

describe("the marks on the Settings pages", () => {
  it("name only registry rows, and every row of a Settings page has one", async () => {
    const marked = new Set<string>();
    for (const [path, page] of Object.entries(PAGES)) for (const id of await marksOf(path, page)) marked.add(id);
    expect([...marked].filter((id) => settingById(id) === undefined)).toEqual([]);
    const unmarked = SETTINGS.filter((s) => isPageId(s.page) && !marked.has(s.id) && !DRAWN_ELSEWHERE(s.id)).map((s) => s.id);
    expect(unmarked.toSorted()).toEqual(Object.keys(NOT_DRAWN_YET).toSorted());
  });
});
