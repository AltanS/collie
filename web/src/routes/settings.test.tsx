import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";

import { withHeaderHost } from "@/test/header-host";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import type { UpdateInfo } from "@/lib/types";
import { SettingsRoute } from "./settings";

// Settings' HEADER, and only its header.
//
// This route used to hand-roll its own `<header>` beneath a comment claiming "one header treatment
// app-wide". It was not one: the hand-rolled bar carried no <AlphaBar/> and had its own padding
// recipe, so it stood 20px short of every other route's header and silently dropped the "you are on
// a prerelease build" strip on the way in. It fills the one hoisted header shell now, and these cases pin
// that — a false comment in the code is worse than no comment, so the claim is asserted rather than
// written down.

// The index carries NO loader now — the paired-device registry belongs to the one page that
// renders it (/settings/system). The section routes are stubs here: this file tests the index, and
// what each section mounts is that section's own business.
function renderSettings() {
  const router = createMemoryRouter(
    [
      { path: "/settings", element: withHeaderHost(<SettingsRoute />) },
      { path: "/settings/:section", element: <div data-testid="section" /> },
      { path: "/machines", element: <div data-testid="machines" /> },
      { path: "/", element: <div data-testid="home" /> },
    ],
    { initialEntries: ["/settings"] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe("SettingsRoute — the shared header shell", () => {
  it("mounts exactly one header, and it is the shell that carries the prerelease strip", async () => {
    // vitest's define stamps BUILD.version as "0.0.0-test", which IS a prerelease — so the real
    // shell shows the strip here. A hand-rolled header cannot.
    renderSettings();
    expect(await screen.findByText(/TEST/)).toBeInTheDocument();
    expect(document.querySelectorAll("header")).toHaveLength(1);
  });

  it("leads with a 44px back button where every other route puts the Collie mark", async () => {
    renderSettings();
    const back = await screen.findByRole("button", { name: "Back" });
    expect(back.className).toContain("size-11");
    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    // The mark is NOT here — this route leads with the way out, not with the way home.
    expect(screen.queryByRole("button", { name: /^Collie/ })).toBeNull();
  });
});

// ── THE FOOTER, AFTER THE UPDATE CHIP LEFT IT (M16/01) ──────────────────────────────────────────
//
// Settings used to end with three update surfaces for one subject. Updating has a page of its own
// now, and the index leads with one row that links to it — and the footer keeps the build stamp,
// which is a diagnostic and was never an update surface.
describe("SettingsRoute — the update surfaces", () => {
  it("keeps the build stamp and drops the footer update chip", async () => {
    renderSettings();
    // The build stamp is the vitest define — `v<version> · <sha> · <time> UTC`.
    expect(await screen.findByText(/^v0\.0\.0-test · .* UTC$/)).toBeInTheDocument();
    // Nothing on this page nudges an update any more: no chip line, no copyable command.
    expect(screen.queryByText(/Bridge restart needed/)).toBeNull();
    expect(screen.queryByRole("button", { name: /^Copy command/ })).toBeNull();
  });

  it("holds no update card or check control: the update subject is one row, and a page", async () => {
    renderSettings();
    await screen.findByRole("button", { name: /Appearance/ });
    expect(screen.queryByText("Update Collie")).toBeNull();
    expect(screen.queryByRole("button", { name: "Check for updates" })).toBeNull();
  });
});

// ── THE UPDATES ROW (first on the index) ────────────────────────────────────────────────────────
//
// Updating is the one subject whose answer changes without a touch, so its row leads the index and
// carries the live status. A release waiting leads the caption with a 6px dot.
function updateInfo(over: Partial<UpdateInfo> = {}): UpdateInfo {
  return {
    current: "1.26.4",
    latest: "1.26.4",
    latestUrl: null,
    releaseAvailable: false,
    majorAvailable: null,
    majorUrl: null,
    bridgeStale: false,
    checkedAt: 1_700_000_000_000,
    ...over,
  };
}

function renderWithUpdate(update: UpdateInfo | undefined) {
  const data = {
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
    update,
    error: false,
    authError: false,
  } satisfies HomeData;
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => data,
        children: [
          { path: "settings", element: withHeaderHost(<SettingsRoute />) },
          { path: "settings/updates", element: <div data-testid="updates" /> },
          { path: "settings/:section", element: <div data-testid="section" /> },
        ],
      },
    ],
    { initialEntries: ["/settings"] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe("SettingsRoute — the Updates row", () => {
  it("is the first row, in the same style, and says it is up to date with the version", async () => {
    renderWithUpdate(updateInfo());
    const row = await screen.findByRole("button", { name: /^Updates/ });
    const rows = screen
      .getAllByRole("button")
      .map((b) => b.textContent ?? "")
      .filter((text) => /Updates|Appearance|Machines/.test(text));
    expect(rows[0]).toContain("Updates");
    expect(rows[1]).toContain("Appearance");
    expect(row.textContent).toContain("Up to date · 1.26.4");
    expect(row.querySelector("svg.lucide-circle-arrow-up")).not.toBeNull();
    expect(row.querySelector("svg.lucide-chevron-right")).not.toBeNull();
    // Nothing is waiting, so no dot.
    expect(row.querySelector('[data-slot="update-dot"]')).toBeNull();
  });

  it("names the waiting version behind a 6px primary dot", async () => {
    renderWithUpdate(updateInfo({ releaseAvailable: true, latest: "1.27.0" }));
    const row = await screen.findByRole("button", { name: /^Updates/ });
    expect(row.textContent).toContain("1.27.0 available");
    const dot = row.querySelector('[data-slot="update-dot"]');
    expect(dot).not.toBeNull();
    expect(dot?.className).toContain("bg-primary");
    expect(dot?.className).toContain("size-1.5");
    // The dot leads the caption: it is the caption's first child, before the words.
    expect(within(row).getByText(/1\.27\.0 available/).firstElementChild).toBe(dot);
  });

  it("opens the Updates page as a push", async () => {
    const router = renderWithUpdate(updateInfo());
    await userEvent.click(await screen.findByRole("button", { name: /^Updates/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/updates"));
    expect(router.state.location.state).toMatchObject({ from: "/settings" });
  });

  it("says it cannot tell when the snapshot never arrived", async () => {
    renderSettings();
    const row = await screen.findByRole("button", { name: /^Updates/ });
    expect(row.textContent).toContain("Unknown, can’t reach Collie");
    expect(row.querySelector('[data-slot="update-dot"]')).toBeNull();
  });

  it("gives System the caption of what it holds now: devices, crew, connection", async () => {
    renderSettings();
    const system = await screen.findByRole("button", { name: /System/ });
    expect(system.textContent).toContain("Devices, crew, connection");
    expect(system.textContent).not.toContain("Updates");
  });
});

// ── THE INDEX ───────────────────────────────────────────────────────────────────────────────────
//
// Settings was one column of seventeen cards. The page is five rows now, and these cases pin the
// two things that makes true: every section is reachable, and no setting is still rendered here.
describe("SettingsRoute — the index", () => {
  it("offers the five sections, in the order of how standing a choice is", async () => {
    renderSettings();
    await screen.findByRole("button", { name: /Appearance/ });
    const rows = screen
      .getAllByRole("button")
      .map((b) => b.textContent ?? "")
      .filter((text) => /Appearance|Device|Voice|Alerts|System/.test(text));
    expect(rows).toHaveLength(5);
    expect(rows[0]).toContain("Appearance");
    expect(rows[1]).toContain("Device");
    // Voice sits between Device and Alerts, and is always offered: a host with no speech gets a page that says so.
    expect(rows[2]).toContain("Voice");
    expect(rows[2]).toContain("Where your speech becomes text, and hands-free.");
    expect(rows[3]).toContain("Alerts");
    expect(rows[4]).toContain("System");
  });

  it("opens Voice at /settings/voice", async () => {
    const router = renderSettings();
    await userEvent.click(await screen.findByRole("button", { name: /Voice/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/voice"));
  });

  it("no longer mentions voice in the Device row's blurb", async () => {
    renderSettings();
    const device = await screen.findByRole("button", { name: /^Device/ });
    expect(device.textContent).not.toMatch(/voice/i);
  });

  it("opens a section as a push, so back returns here rather than home", async () => {
    const router = renderSettings();
    await userEvent.click(await screen.findByRole("button", { name: /Appearance/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/appearance"));
    expect(screen.getByTestId("section")).toBeInTheDocument();
  });

  // The fifth row, and the only one that can be absent: it renders while `lib/experiments.ts` holds
  // something, because a row that opens an empty page is noise. Chat was the last thing filed
  // there and left in 1.17.0 (ADR 0082), so the index shows four rows.
  it("shows no Experiments row while nothing is filed under it", async () => {
    renderSettings();
    await screen.findByRole("button", { name: /Appearance/ });
    expect(screen.queryByRole("button", { name: /Experiments/ })).toBeNull();
  });

  // Machines is a page of its own and not a section, so its row is the one that opens `/machines`. It is
  // always there, solo included: a solo collie is one machine with a load worth watching.
  it("offers Machines on a solo install, after System, and opens its own page", async () => {
    const router = renderSettings();
    const row = await screen.findByRole("button", { name: /Machines/ });
    const all = screen.getAllByRole("button").map((b) => b.textContent ?? "");
    const at = (word: string) => all.findIndex((text) => text.includes(word));
    expect(at("System")).toBeLessThan(at("Machines"));
    // No Experiments row exists while the list is empty (ADR 0082), so Machines closes the index. When
    // one returns it sits after Machines, which is where its section is placed.
    expect(at("Experiments")).toBe(-1);
    await userEvent.click(row);
    await waitFor(() => expect(router.state.location.pathname).toBe("/machines"));
    expect(router.state.location.state).toMatchObject({ from: "/settings" });
  });

  it("renders no setting of its own: every switch moved behind a row", async () => {
    // The regression this guards is a card being added back to the index out of habit. The index
    // has exactly one interactive element per section and nothing else with a switch role.
    renderSettings();
    await screen.findByRole("button", { name: /Appearance/ });
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
    expect(screen.queryByRole("combobox")).toBeNull();
  });
});
