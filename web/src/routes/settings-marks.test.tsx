import { render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { isPageId, SETTINGS, settingById } from "@/lib/settings";
import { withHeaderHost } from "@/test/header-host";
import {
  SettingsAlertsRoute,
  SettingsAppearanceRoute,
  SettingsCharacterRoute,
  SettingsDeviceRoute,
  SettingsExperimentsRoute,
  SettingsHarnessesRoute,
  SettingsInstallCountRoute,
  SettingsSystemRoute,
  SettingsTricksRoute,
  SettingsVoiceHostRoute,
  SettingsVoiceModelRoute,
  SettingsVoiceRoute,
} from "./settings-sections";

// EVERY SETTINGS ROW HAS A MARKED PLACE ON A PAGE (ADR 0168). Each page wraps the control that draws a row in a
// `SettingSlot` naming its registry ids. This renders every page and reads the marks: an id no row has fails, and a
// registry row on a Settings page that no page marks fails, unless the list below says why it is not drawn yet.

const PAGES = {
  "/settings/appearance": <SettingsAppearanceRoute />,
  "/settings/appearance/character": <SettingsCharacterRoute />,
  "/settings/harnesses": <SettingsHarnessesRoute />,
  "/settings/device": <SettingsDeviceRoute />,
  "/settings/voice": <SettingsVoiceRoute />,
  "/settings/voice/host": <SettingsVoiceHostRoute />,
  "/settings/voice/model": <SettingsVoiceModelRoute />,
  "/settings/alerts": <SettingsAlertsRoute />,
  "/settings/experiments": <SettingsExperimentsRoute />,
  "/settings/tricks": <SettingsTricksRoute />,
  "/settings/system": <SettingsSystemRoute />,
  "/settings/system/install-count": <SettingsInstallCountRoute />,
} satisfies Record<string, ReactNode>;

/**
 * Rows of a Settings page that today's pages do not draw yet, by why. The restructure of 2026-11-21 empties it: a
 * row named here is a row a person cannot reach from Settings.
 */
const NOT_DRAWN_YET = {
  "look.textSize.chat": "only in a pane's Display sheet today",
  "chat.view": "only in a pane's Display sheet and ⋮ menu today",
  "chat.shortForm": "only in a pane's Display sheet today",
  "chat.wrap": "only in a pane's Display sheet today",
  "chat.wholeReply": "only in a pane's Display sheet today",
  "chat.rawTerminal": "only in a pane's Display sheet today",
  "keys.tapToType": "only in a pane's Display sheet today",
  "keys.pad.edit": "only in the Keys pad's tray today",
  "keys.pad.presets": "only in the Keys pad's tray today",
  "keys.pad.copy": "only in the Keys pad's tray today",
} satisfies Record<string, string>;

/** Rows drawn by a page this test does not render: they have tests of their own. */
const DRAWN_ELSEWHERE = (id: string) =>
  /^(accounts|updates)\./.test(id) || id.startsWith("tricks.trick.") || id.startsWith("notifications.load.");

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
