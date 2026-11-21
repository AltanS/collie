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
// renders it (/settings/devices). The section routes are stubs here: this file tests the index, and
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
    await screen.findByRole("button", { name: /Look and feel/ });
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
      .filter((text) => /Updates|Look and feel|Machines/.test(text));
    expect(rows[0]).toContain("Updates and about");
    expect(rows[1]).toContain("Look and feel");
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

  it("gives Devices and machines the line of what it holds: pairing, devices, machines, the connection", async () => {
    renderSettings();
    const devices = await screen.findByRole("button", { name: /Devices and machines/ });
    expect(devices.textContent).toContain("Pairing, paired devices, your machines, the connection");
    expect(devices.textContent).not.toContain("Updates");
  });
});

// ── THE INDEX ───────────────────────────────────────────────────────────────────────────────────
//
// The index is the registry's eleven pages (ADR 0170), after Updates and about, and nothing else: every page is
// reachable, Machines is a row of Devices and machines, and no setting is rendered here.
const PAGE_TITLES = [
  "Look and feel",
  "Chat and terminal",
  "Keys and touch",
  "Notifications",
  "Voice",
  "Dashboard and projects",
  "Tricks and the Hill",
  "Devices and machines",
  "Privacy and data",
] as const;

describe("SettingsRoute — the index", () => {
  it("offers the pages in the registry's order, each with its line, after Updates and about", async () => {
    writeAnswer("settings-accounts-row", false);
    serveAccountsStatus(404);
    renderSettings();
    await screen.findByRole("button", { name: /Look and feel/ });
    expect(listTitles()).toEqual(["Updates and about", ...PAGE_TITLES]);
    expect(screen.getByRole("button", { name: /^Look and feel/ })).toHaveTextContent("Theme, light or dark, language, fonts, text sizes");
    expect(screen.getByRole("button", { name: /^Voice/ })).toHaveTextContent("Where your speech becomes text, and hands-free.");
  });

  it("wraps a page's line instead of cutting it", async () => {
    renderSettings();
    const row = await screen.findByRole("button", { name: /^Notifications/ });
    const caption = row.querySelector("p");
    expect(caption?.textContent).toBe("Push, cache and load alerts, do not disturb");
    expect(caption?.classList.contains("truncate")).toBe(false);
    expect(caption?.classList.contains("text-pretty")).toBe(true);
  });

  it("opens Voice at /settings/voice", async () => {
    const router = renderSettings();
    await userEvent.click(await screen.findByRole("button", { name: /^Voice/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/voice"));
  });

  it("opens a page as a push, so back returns here rather than home", async () => {
    const router = renderSettings();
    await userEvent.click(await screen.findByRole("button", { name: /Look and feel/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/look"));
    expect(screen.getByTestId("section")).toBeInTheDocument();
  });

  it("has no Machines row and no Experiments row of its own", async () => {
    renderSettings();
    await screen.findByRole("button", { name: /Look and feel/ });
    expect(listTitles()).not.toContain("Machines");
    expect(listTitles()).not.toContain("Experiments");
  });

  it("has the search field on top, and no setting of its own: every switch is behind a row", async () => {
    // The regression this guards is a card being added back to the index out of habit.
    renderSettings();
    await screen.findByRole("button", { name: /Look and feel/ });
    expect(screen.getByRole("textbox", { name: "Search settings" })).toBeInTheDocument();
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
    expect(screen.queryByRole("combobox")).toBeNull();
  });
});

// ── THE CALM FIRST PAINT ────────────────────────────────────────────────────────────────────────
//
// The Profiles row (after Dashboard and projects) depends on a read that ends after the first paint, and sits
// in the middle of the list, so a row that arrived late pushed every row after it down. jsdom has no layout, so these cases read the DOM instead: the order and
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

/** The settled list's row count without the optional Profiles row: Updates and about and the nine steady pages, what the stand-in must hold. */
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

// THE TRICKS ROW STAYS (ADR 0170). The switch for tricks as a whole is on Tricks and the Hill, so the row is there
// with tricks off and on, and the list keeps its length.
describe("SettingsRoute — the Tricks and the Hill row", () => {
  it.each([true, false])("is there with tricks off %s, before Devices and machines", async (tricksOff) => {
    writeAnswer("settings-accounts-row", false);
    serveAccountsStatus(404);
    renderIndex({ tricksOff });
    await screen.findByRole("button", { name: /Look and feel/ });
    const titles = listTitles();
    expect(titles.indexOf("Tricks and the Hill")).toBe(titles.indexOf("Devices and machines") - 1);
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
    await screen.findByRole("button", { name: /Look and feel/ });

    const first = listTitles();
    expect(document.querySelector('[data-slot="settings-list-hold"]')).toBeNull();
    // Profiles right after Dashboard and projects, from the first frame.
    expect(first.indexOf("Profiles")).toBe(first.indexOf("Dashboard and projects") + 1);
    expect(first).toHaveLength(SETTLED_ROWS_WITHOUT_OPTIONAL + 1);

    await act(async () => {
      accounts.open();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(listTitles()).toEqual(first);
  });

  it("a device that remembers no Profiles row paints the list without it, and a 404 changes nothing", async () => {
    writeAnswer("settings-accounts-row", false);
    const accounts = gate();
    server.use(
      http.get("/api/accounts", async () => {
        await accounts.promise;
        return HttpResponse.json({ ok: false, error: "no", code: "accounts.unavailable" }, { status: 404 });
      }),
    );
    renderIndex({ tricks: false });
    await screen.findByRole("button", { name: /Look and feel/ });

    const first = listTitles();
    expect(first).not.toContain("Profiles");
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
    expect(titles.indexOf("Profiles")).toBe(titles.indexOf("Dashboard and projects") + 1);
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
    // One empty row per row the settled list always has (the Updates row and `STEADY_PAGES`), each of the row's
    // exact height, so the card does not collapse and the build stamp below does not jump.
    const rows = [...(hold?.querySelectorAll('[data-slot="list-group"] > *') ?? [])];
    expect(rows).toHaveLength(SETTLED_ROWS_WITHOUT_OPTIONAL);
    for (const row of rows) {
      expect(row.classList.contains("h-11")).toBe(true);
      expect(row.classList.contains("p-4")).toBe(true);
      expect(row.textContent).toBe("");
    }
    expect(screen.queryByRole("button", { name: /Look and feel/ })).toBeNull();

    await act(async () => {
      accounts.open();
    });
    // The answer is in (a 404): the list replaces the stand-in, row for row.
    await screen.findByRole("button", { name: /Look and feel/ });
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
    expect(titles).toContain("Tricks and the Hill");
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
