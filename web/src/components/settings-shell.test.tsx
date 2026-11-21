import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsPage } from "@/components/settings-page";
import { settingsExitSteps, settingsSectionOf, SettingsLayout } from "@/components/settings-shell";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import type { UpdateInfo } from "@/lib/types";
import { __resetWideLayoutStore, setWideLayoutMode } from "@/lib/wide-layout-store";
import { SettingsRoute } from "@/routes/settings";
import { withHeaderHost } from "@/test/header-host";

// SETTINGS ON A LARGE SCREEN (components/settings-shell.tsx): the list and the chosen section side by side under one
// header, and on a phone, a tablet and with Large-screen layout Off exactly the pages of before.

/** A window of `width` x `height`, as the media queries of `useWidthClass` answer it. */
function windowOf(width: number, height: number): void {
  vi.stubGlobal("matchMedia", (query: string) => {
    const minW = /min-width:\s*(\d+)px/.exec(query);
    const minH = /min-height:\s*(\d+)px/.exec(query);
    const matches = (minW === null || width >= Number(minW[1])) && (minH === null || height >= Number(minH[1]));
    // SAFETY: a stand-in for the browser's MediaQueryList with every member the app reads.
    return { matches, media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false } as MediaQueryList;
  });
}

function update(over: Partial<UpdateInfo> = {}): UpdateInfo {
  return { current: "1.26.4", latest: "1.26.4", latestUrl: null, releaseAvailable: false, majorAvailable: null, majorUrl: null, bridgeStale: false, checkedAt: 1_700_000_000_000, ...over };
}

function data(over: Partial<HomeData> = {}): HomeData {
  return {
    bridge: "connected",
    device: undefined,
    agents: [],
    shellPanes: [],
    workspaces: [],
    tabs: [],
    sessions: [],
    servers: [],
    ts: 0,
    scope: {},
    viewAll: false,
    snoozedUntil: null,
    update: update(),
    error: false,
    authError: false,
    ...over,
  } satisfies HomeData;
}

/** A section page as every real one draws: through `SettingsPage`. */
function Section({ title }: { title: "settings.page.keys.title" | "settings.section.voice.title" | "settings.page.look.title" | "settings.page.updates.title" }) {
  return (
    <SettingsPage title={title}>
      <p data-testid="section-body">{title}</p>
    </SettingsPage>
  );
}

function renderSettings(at: string, root: HomeData = data()) {
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => root,
        children: [
          { index: true, element: <div data-testid="home" /> },
          {
            path: "settings",
            element: withHeaderHost(<SettingsLayout />),
            children: [
              { index: true, element: <SettingsRoute /> },
              { path: "look", element: <Section title="settings.page.look.title" /> },
              { path: "keys", element: <Section title="settings.page.keys.title" /> },
              { path: "voice", element: <Section title="settings.section.voice.title" /> },
              {
                path: "voice/host",
                element: (
                  <SettingsPage title="settings.voice.hostPage.title" parent="/settings/voice">
                    <p data-testid="section-body">host</p>
                  </SettingsPage>
                ),
              },
              {
                path: "voice/named",
                element: (
                  <SettingsPage title="settings.voice.hostPage.title" heading="Work" parent="/settings/voice" crumbs={["Work", "Change login"]}>
                    <p data-testid="section-body">named</p>
                  </SettingsPage>
                ),
              },
              { path: "updates", element: <Section title="settings.page.updates.title" /> },
            ],
          },
        ],
      },
    ],
    { initialEntries: ["/", at], initialIndex: 1 },
  );
  const view = render(<RouterProvider router={router} />);
  return { router, ...view };
}

const list = (container: HTMLElement) => container.querySelector('[data-slot="settings-list"]');
const row = (container: HTMLElement, id: string) => container.querySelector<HTMLButtonElement>(`[data-settings-row="${id}"]`);
const path = () => document.querySelector('[data-slot="settings-path"]')?.textContent ?? null;

beforeEach(() => __resetWideLayoutStore());
afterEach(() => {
  vi.unstubAllGlobals();
  __resetWideLayoutStore();
});

describe("Settings on a large screen", () => {
  it("opens /settings on the first page that is not an action: Look and feel", async () => {
    windowOf(1440, 900);
    const { router, container } = renderSettings("/settings");
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/look"));
    // A replace: Back from the section is the screen Settings was opened from, not a page that only forwards.
    expect(router.state.historyAction).toBe("REPLACE");
    await waitFor(() => expect(row(container, "look")).toHaveAttribute("aria-current", "page"));
    expect(list(container)).not.toBeNull();
  });

  it("opens /settings on Updates while a release waits", async () => {
    windowOf(1440, 900);
    const { router } = renderSettings("/settings", data({ update: update({ releaseAvailable: true, latest: "1.27.0" }) }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/updates"));
  });

  it("marks the row of the address, and a row opens its section as a push", async () => {
    windowOf(1440, 900);
    const { router, container } = renderSettings("/settings/keys");
    await waitFor(() => expect(row(container, "keys")).toHaveAttribute("aria-current", "page"));
    expect(row(container, "voice")).not.toHaveAttribute("aria-current");
    // One tab stop for the list: the chosen row.
    expect(row(container, "keys")).toHaveAttribute("tabindex", "0");
    expect(row(container, "voice")).toHaveAttribute("tabindex", "-1");
    // The section's own title, once, as the column's h1; the header names Settings and is no heading.
    expect([...container.ownerDocument.querySelectorAll("h1")].map((h) => h.textContent)).toEqual(["Keys and touch"]);
    fireEvent.click(row(container, "voice")!);
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/voice"));
    expect(router.state.historyAction).toBe("PUSH");
    expect(row(container, "voice")).toHaveAttribute("aria-current", "page");
    // The list stayed the same element: its scroll is its own and survives the move.
    expect(container.querySelector('[data-testid="section-body"]')?.textContent).toBe("settings.section.voice.title");
    // The section's title took the focus.
    await waitFor(() => expect(document.activeElement?.tagName).toBe("H1"));
    expect(document.activeElement?.textContent).toBe("Voice");
  });

  it("walks the list with the arrow keys", async () => {
    windowOf(1440, 900);
    const { container } = renderSettings("/settings/keys");
    await waitFor(() => expect(row(container, "keys")).not.toBeNull());
    row(container, "keys")!.focus();
    fireEvent.keyDown(row(container, "keys")!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(row(container, "notifications"));
    expect(row(container, "notifications")).toHaveAttribute("tabindex", "0");
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(row(container, "updates"));
  });

  it("shows the path of a deep page in the header, and a Back beside its title that goes one level up", async () => {
    windowOf(1440, 900);
    const { router, container } = renderSettings("/settings/voice/host");
    await waitFor(() => expect(path()).toBe("/Voice/Host speech"));
    // The list keeps the section chosen.
    await waitFor(() => expect(row(container, "voice")).toHaveAttribute("aria-current", "page"));
    const head = container.ownerDocument.querySelector('[data-slot="settings-page-head"]')!;
    const up = head.querySelector("button")!;
    expect(up).toHaveAccessibleName("Back");
    fireEvent.click(up);
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/voice"));
    // A section's own page has no path in the header.
    await waitFor(() => expect(path()).toBeNull());
  });

  it("takes the page's own path below the section when it names one", async () => {
    windowOf(1440, 900);
    renderSettings("/settings/voice/named");
    await waitFor(() => expect(path()).toBe("/Voice/Work/Change login"));
  });

  it("draws one header, 48px, on the recess with the navigation's edge", async () => {
    windowOf(1440, 900);
    const { container } = renderSettings("/settings/keys");
    await waitFor(() => expect(list(container)).not.toBeNull());
    const headers = container.ownerDocument.querySelectorAll("header");
    expect(headers).toHaveLength(1);
    const header = headers[0]!;
    expect(header.className).toContain("bg-surface-recess");
    expect(header.className).toContain("var(--surface-recess)_70%,var(--border)");
    expect(header.querySelector('[data-slot="header-row"]')?.className).toContain("min-h-12");
    expect(header.querySelector('[data-slot="settings-title"]')?.textContent).toBe("Settings");
    // Its arrow leaves Settings and is named for that, so "Back" is only ever the step up beside a page's title.
    const close = header.querySelector('[data-slot="header-row"] button')!;
    expect(close).toHaveAccessibleName("Close Settings");
    expect(close).toHaveAttribute("title", "Close Settings");
    expect([...header.querySelectorAll("button")].filter((b) => b.getAttribute("aria-label") === "Back")).toHaveLength(0);
  });
});

describe("Settings below the large screen", () => {
  it("is today's phone index at 390px: the header row and the first row unchanged", async () => {
    windowOf(390, 844);
    const { container } = renderSettings("/settings");
    await waitFor(() => expect(container.ownerDocument.querySelector("main [data-slot=list-group] button")).not.toBeNull());
    const doc = container.ownerDocument;
    expect(list(container)).toBeNull();
    expect(doc.querySelector('[data-slot="header-row"]')?.className).toMatchInlineSnapshot(`"flex items-center gap-2 pr-2 min-h-15 py-1 pl-4"`);
    expect(doc.querySelector("header")?.className).toMatchInlineSnapshot(`"sticky top-0 z-20 flex flex-col border-b bg-band-ground [padding-top:env(safe-area-inset-top)] border-band-rule mx-auto w-full max-w-screen-sm"`);
    const main = doc.querySelector("main")!;
    expect(main.parentElement?.className).toMatchInlineSnapshot(`"mx-auto flex min-h-0 w-full max-w-screen-sm flex-1 flex-col"`);
    expect(main.className).toMatchInlineSnapshot(`"relative flex min-h-0 flex-1 flex-col space-y-4 overflow-y-auto p-4"`);
    expect(main.querySelector("[data-slot=list-group] button")?.className).toMatchInlineSnapshot(`"flex w-full items-center gap-3 p-4 text-left active:bg-muted/60"`);
    expect(doc.querySelector("h1")?.textContent).toBe("Settings");
  });

  it("is the phone page at 1440px with Large-screen layout Off", async () => {
    windowOf(1440, 900);
    act(() => setWideLayoutMode("off"));
    const { router, container } = renderSettings("/settings");
    await waitFor(() => expect(container.ownerDocument.querySelector("main [data-slot=list-group] button")).not.toBeNull());
    expect(router.state.location.pathname).toBe("/settings");
    expect(list(container)).toBeNull();
    expect(container.ownerDocument.querySelector('[data-slot="header-row"]')?.className).toContain("min-h-15");
  });
});

describe("settingsExitSteps", () => {
  const trail = (hrefs: string[]) => new Map(hrefs.map((href, i) => [i, href]));

  it("steps back past every Settings entry to the one Settings was opened from", () => {
    expect(settingsExitSteps(trail(["/", "/pane/a", "/settings/look", "/settings/keys", "/settings/voice/host"]), 4)).toEqual({ steps: 3, to: "/pane/a" });
    expect(settingsExitSteps(trail(["/?h=b", "/settings/look?h=b"]), 1)).toEqual({ steps: 1, to: "/?h=b" });
  });

  it("gives up where the trail does not reach (a cold open, a lost entry)", () => {
    expect(settingsExitSteps(trail(["/settings/look"]), 0)).toBeNull();
    expect(settingsExitSteps(new Map([[2, "/settings/keys"]]), 3)).toBeNull();
  });

  it("names the section of an address", () => {
    expect(settingsSectionOf("/settings")).toBeNull();
    expect(settingsSectionOf("/settings/tricks/lodge%3Aci")).toBe("tricks");
  });
});
