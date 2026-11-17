import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";

import { readAnswer, writeAnswer } from "@/lib/remembered-shape";
import { body, serveAccountsStatus } from "@/test/accounts-fixtures";
import { server } from "@/test/setup";

import { withHeaderHost } from "@/test/header-host";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import type { UpdateInfo } from "@/lib/types";
import { LIST_HOLD_MS, SettingsRoute } from "./settings";

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
    expect(row.querySelector("svg[data-icon=\"update-available\"]")).not.toBeNull();
    expect(row.querySelector("svg[data-icon=\"row-go\"]")).not.toBeNull();
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
  // something, because a row that opens an empty page is noise. Chat left in 1.17.0 (ADR 0082); the Hill
  // moved in on 2026-11-13, so the index shows the row again.
  it("shows the Experiments row while the Hill is filed under it", async () => {
    renderSettings();
    await screen.findByRole("button", { name: /Appearance/ });
    expect(screen.getByRole("button", { name: /Experiments/ })).toBeInTheDocument();
  });

  // Machines is a page of its own and not a section, so its row is the one that opens `/machines`. It is
  // always there, solo included: a solo collie is one machine with a load worth watching.
  it("offers Machines on a solo install, after System, and opens its own page", async () => {
    const router = renderSettings();
    const row = await screen.findByRole("button", { name: /Machines/ });
    const all = screen.getAllByRole("button").map((b) => b.textContent ?? "");
    const at = (word: string) => all.findIndex((text) => text.includes(word));
    expect(at("System")).toBeLessThan(at("Machines"));
    // The Experiments row sits after Machines, which is where its section is placed.
    expect(at("Experiments")).toBeGreaterThan(at("Machines"));
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

// ── THE CALM FIRST PAINT ────────────────────────────────────────────────────────────────────────
//
// The Profiles row (after Harnesses) and the Tricks row (before Experiments) depend on reads that end
// after the first paint, and each sits in the middle of the list, so a row that arrived late pushed
// every row after it down. jsdom has no layout, so these cases read the DOM instead: the order and
// length of the rows on the first paint, and again once the reads have landed. Equal lists mean no
// neighbour moved.
function gate() {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open: () => open() };
}

/** The list's rows by title, in order. */
function listTitles(): string[] {
  const group = document.querySelector('[data-slot="list-group"]');
  return [...(group?.querySelectorAll("button") ?? [])].map((b) => b.querySelector(".font-medium")?.textContent ?? "");
}

/** The settled list's row count without the optional Accounts row, with the Tricks row (it shows while tricks are on): what the stand-in must hold. */
const SETTLED_ROWS_WITHOUT_OPTIONAL = 10;

function homeData(over: Partial<HomeData>): HomeData {
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
    update: updateInfo(),
    error: false,
    authError: false,
    ...over,
  };
}

function renderIndex(over: Partial<HomeData>) {
  const data = homeData(over);
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => data,
        children: [{ path: "settings", element: withHeaderHost(<SettingsRoute />) }],
      },
    ],
    { initialEntries: ["/settings"] },
  );
  render(<RouterProvider router={router} />);
}

// THE TRICKS ROW FOLLOWS THE SWITCH (2026-11-18). The switch for tricks as a whole is the Tricks card in Settings,
// Experiments; this row is the way into the list it switched on, so it shows only while the switch is on.
describe("SettingsRoute — the Tricks row follows the switch for tricks", () => {
  it("has no Tricks row while tricks are off, and the list is one row shorter from the first frame", async () => {
    writeAnswer("settings-accounts-row", false);
    serveAccountsStatus(404);
    renderIndex({ tricksOff: true });
    await screen.findByRole("button", { name: /Appearance/ });
    const titles = listTitles();
    expect(titles).not.toContain("Tricks");
    expect(titles).toHaveLength(SETTLED_ROWS_WITHOUT_OPTIONAL - 1);
    expect(titles).toContain("Experiments");
  });

  it("has the Tricks row, right before Experiments, while tricks are on", async () => {
    writeAnswer("settings-accounts-row", false);
    serveAccountsStatus(404);
    renderIndex({ tricksOff: false });
    await screen.findByRole("button", { name: /Appearance/ });
    const titles = listTitles();
    expect(titles.indexOf("Tricks")).toBe(titles.indexOf("Experiments") - 1);
    expect(titles).toHaveLength(SETTLED_ROWS_WITHOUT_OPTIONAL);
  });
});

describe("SettingsRoute — the list does not move while the page loads", () => {
  afterEach(() => vi.useRealTimers());

  it("a device that remembers both rows paints them on the first frame, and the reads change nothing", async () => {
    writeAnswer("settings-accounts-row", true);
    const accounts = gate();
    server.use(
      http.get("/api/accounts", async () => {
        await accounts.promise;
        return HttpResponse.json(body());
      }),
    );
    renderIndex({ tricks: true });
    await screen.findByRole("button", { name: /Appearance/ });

    const first = listTitles();
    expect(document.querySelector('[data-slot="settings-list-hold"]')).toBeNull();
    // Profiles right after Harnesses, Tricks right before Experiments, from the first frame.
    expect(first.indexOf("Profiles")).toBe(first.indexOf("Harness configurations") + 1);
    expect(first.indexOf("Tricks")).toBe(first.indexOf("Experiments") - 1);
    expect(first).toHaveLength(SETTLED_ROWS_WITHOUT_OPTIONAL + 1);

    await act(async () => {
      accounts.open();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(listTitles()).toEqual(first);
  });

  it("a device that remembers no Accounts row paints the list without it and with Tricks, and a 404 changes nothing", async () => {
    writeAnswer("settings-accounts-row", false);
    const accounts = gate();
    server.use(
      http.get("/api/accounts", async () => {
        await accounts.promise;
        return HttpResponse.json({ ok: false, error: "no", code: "accounts.unavailable" }, { status: 404 });
      }),
    );
    renderIndex({ tricks: false });
    await screen.findByRole("button", { name: /Appearance/ });

    const first = listTitles();
    expect(first).not.toContain("Profiles");
    // Tricks shows while the switch is on (the snapshot says so from the first frame), with no tricks reply and no remembered answer.
    expect(first.indexOf("Tricks")).toBe(first.indexOf("Experiments") - 1);
    expect(first).toHaveLength(SETTLED_ROWS_WITHOUT_OPTIONAL);

    await act(async () => {
      accounts.open();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(listTitles()).toEqual(first);
    expect(readAnswer("settings-accounts-row")).toBe(false);
  });

  it("a row the device did not remember goes into its place when it arrives, and is remembered", async () => {
    writeAnswer("settings-accounts-row", false);
    server.use(http.get("/api/accounts", () => HttpResponse.json(body())));
    renderIndex({ tricks: false });
    const row = await screen.findByRole("button", { name: /Profiles/ });
    const titles = listTitles();
    expect(titles.indexOf("Profiles")).toBe(titles.indexOf("Harness configurations") + 1);
    expect(row).toHaveTextContent("One login per agent");
    await waitFor(() => expect(readAnswer("settings-accounts-row")).toBe(true));
  });

  it("a first visit holds a quiet stand-in of the list's height, with the header painted, until both reads land", async () => {
    const accounts = gate();
    server.use(
      http.get("/api/accounts", async () => {
        await accounts.promise;
        return HttpResponse.json({ ok: false, error: "no", code: "accounts.unavailable" }, { status: 404 });
      }),
    );
    renderIndex({ tricks: false });
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    const hold = document.querySelector('[data-slot="settings-list-hold"]');
    expect(hold).not.toBeNull();
    expect(hold?.getAttribute("aria-hidden")).toBe("true");
    // One empty row per row the settled list always has (the Updates row and `ROWS`), each of the row's
    // exact height, so the card does not collapse and the build stamp below does not jump.
    const rows = [...(hold?.querySelectorAll('[data-slot="list-group"] > *') ?? [])];
    expect(rows).toHaveLength(SETTLED_ROWS_WITHOUT_OPTIONAL);
    for (const row of rows) {
      expect(row.classList.contains("h-11")).toBe(true);
      expect(row.classList.contains("p-4")).toBe(true);
      expect(row.textContent).toBe("");
    }
    expect(screen.queryByRole("button", { name: /Appearance/ })).toBeNull();

    await act(async () => {
      accounts.open();
    });
    // Both answers are in (a 404 and a snapshot with no tricks): the list replaces the stand-in, row for row.
    await screen.findByRole("button", { name: /Appearance/ });
    expect(document.querySelector('[data-slot="settings-list-hold"]')).toBeNull();
    expect(listTitles()).toHaveLength(SETTLED_ROWS_WITHOUT_OPTIONAL);
  });

  it("a first visit whose reads never land draws the list at 400 ms, with the rows it has", async () => {
    vi.useFakeTimers();
    // The accounts read never answers; there is no snapshot, so the tricks answer is unknown too.
    server.use(http.get("/api/accounts", () => new Promise<never>(() => undefined)));
    const router = createMemoryRouter(
      [{ path: "/settings", element: withHeaderHost(<SettingsRoute />) }],
      { initialEntries: ["/settings"] },
    );
    render(<RouterProvider router={router} />);
    expect(document.querySelector('[data-slot="settings-list-hold"]')).not.toBeNull();
    expect(listTitles()).toHaveLength(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIST_HOLD_MS - 1);
    });
    expect(document.querySelector('[data-slot="settings-list-hold"]')).not.toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(document.querySelector('[data-slot="settings-list-hold"]')).toBeNull();
    const titles = listTitles();
    expect(titles).toHaveLength(SETTLED_ROWS_WITHOUT_OPTIONAL);
    expect(titles).not.toContain("Profiles");
    expect(titles).toContain("Tricks");
  });

  it("the Updates caption changes its words on its own line and moves no row", async () => {
    writeAnswer("settings-accounts-row", false);
    serveAccountsStatus(404);
    const check = gate();
    server.use(
      http.get("/api/update/check", async () => {
        await check.promise;
        return HttpResponse.json({
          ...updateInfo(),
          preflight: null,
          crew: [{ name: "badger", version: "1.25.0", verdict: "green", reasons: [], asOf: null }],
        });
      }),
    );
    renderIndex({ tricks: false });
    const row = await screen.findByRole("button", { name: /^Updates/ });
    const caption = row.querySelector("p");
    const first = listTitles();
    expect(caption?.textContent).toBe("Up to date · 1.26.4");
    // One line that truncates, in a row whose height is its title plus that line: a longer or shorter
    // sentence has nowhere to push, so no reserved slot is needed.
    expect(caption?.classList.contains("truncate")).toBe(true);

    await act(async () => {
      check.open();
    });
    await waitFor(() => expect(caption?.textContent).toBe("1 peer behind"));
    expect(row.querySelector("p")).toBe(caption);
    expect(listTitles()).toEqual(first);
  });
});
