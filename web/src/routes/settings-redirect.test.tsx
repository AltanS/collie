import { render, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { OLD_PAGES } from "@/lib/settings/pages";
import { oldIndexTarget, oldSettingsTarget, OldSettingsRedirect } from "./settings-redirect";

// EVERY SETTINGS ADDRESS COLLIE EVER EMITTED STILL LANDS ON ITS THING (ADR 0170). The table is every path the app, the
// bridge, a push and the CLI wrote in a release tag (v1.0.0 to v1.29.1, `git grep` over each tag, 2026-11-21), with
// the page that holds the thing now. A push already delivered and a crew member on an older Collie still send them.

type Old = keyof typeof OLD_PAGES;

/** Old page addresses: [the old page, the part below it, the query, the fragment, where it lands]. */
const OLD_PAGE_PATHS: [Old, string | undefined, string, string, string][] = [
  ["appearance", undefined, "", "", "/settings/look"],
  ["appearance", "character", "", "", "/settings/look/character"],
  ["harnesses", undefined, "", "", "/settings/chat"],
  ["device", undefined, "", "", "/settings/keys"],
  // The Changes link of 1.25 to 1.28 (`settingsSectionPath("device")#changes`).
  ["device", undefined, "", "#changes", "/settings/dashboard#changes"],
  ["alerts", undefined, "", "", "/settings/notifications"],
  ["experiments", undefined, "", "", "/settings/tricks"],
  // The bridge's "Open Settings" on its /auth/ page until 2026-11-21, and the pairing card's home.
  ["system", undefined, "", "", "/settings/devices"],
  ["system", undefined, "?h=lodge", "", "/settings/devices?h=lodge"],
  // The read-only banner of 1.13 to 1.28 (`settingsSectionPath("system")#paired-devices`).
  ["system", undefined, "", "#paired-devices", "/settings/devices#paired-devices"],
  ["system", undefined, "", "#install-count", "/settings/privacy#install-count"],
  ["system", "install-count", "", "", "/settings/privacy/install-count"],
];

describe("the old Settings addresses", () => {
  it.each(OLD_PAGE_PATHS)("/settings/%s (below %s, %s%s) lands on its page", (old, below, search, hash, to) => {
    expect(oldSettingsTarget(old, below, search, hash)).toBe(to);
  });

  // The read-only banner of 1.0 to 1.12 linked the index itself, and so did the Changes link before 1.25.
  it.each([
    ["", "#paired-devices", "/settings/devices#paired-devices"],
    ["?h=lodge", "#paired-devices", "/settings/devices?h=lodge#paired-devices"],
    ["", "#changes", "/settings/dashboard#changes"],
    ["", "#install-count", "/settings/privacy#install-count"],
  ])("/settings%s%s lands on its page", (search, hash, to) => {
    expect(oldIndexTarget(search, hash)).toBe(to);
  });

  it("keeps the index for no fragment and for one that names no old row", () => {
    expect(oldIndexTarget("", "")).toBeNull();
    expect(oldIndexTarget("?pair=AB12", "")).toBeNull();
    expect(oldIndexTarget("", "#theme=x")).toBeNull();
  });

  // A row id as the fragment of an old page opens the page that holds the row now, also when the row split away.
  it.each([
    ["/settings/appearance#chat.toolCalls", "/settings/chat#chat.toolCalls"],
    ["/settings/appearance#look.math", "/settings/look#look.math"],
    ["/settings/system#privacy.telemetry", "/settings/privacy#privacy.telemetry"],
    ["/settings/device#keys.enterSends", "/settings/keys#keys.enterSends"],
    ["/settings/appearance#no.suchRow", "/settings/look#no.suchRow"],
  ])("%s opens %s", async (from, to) => {
    const router = createMemoryRouter(
      [
        { path: "/settings/appearance", element: <OldSettingsRedirect from="appearance" /> },
        { path: "/settings/system", element: <OldSettingsRedirect from="system" /> },
        { path: "/settings/device", element: <OldSettingsRedirect from="device" /> },
        { path: "/settings/:page", element: <p>page</p> },
      ],
      { initialEntries: [from] },
    );
    render(<RouterProvider router={router} />);
    await waitFor(() => expect(`${router.state.location.pathname}${router.state.location.search}${router.state.location.hash}`).toBe(to));
  });
});
