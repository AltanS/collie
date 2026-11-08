import { act, render, renderHook, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HOLD_MS, TricksSettingsCard, placesLine, provenanceLine, slotLine, useTricksPresent } from "@/components/tricks-settings-card";
import { switchTrick } from "@/lib/api";
import { ROOT_ROUTE_ID } from "@/lib/loaders";
import type { TricksReply, WireTrickInfo } from "@/lib/tricks/schema";
import { createTricksStore, type TricksStore } from "@/lib/tricks/store";
import { clearStatus, currentStatus } from "@/lib/status";
import { server } from "@/test/setup";

// The Tricks card (M94 slice 04): absent without a tricks reply, one row per trick in a fixed shape of
// three lines, one switch per row, and a switch that flips at once and goes back when the bridge says no.

const NOW = Date.parse("2026-11-08T09:41:00Z");

const LEGS: WireTrickInfo = {
  host: "bluefin",
  id: "legs",
  name: "Browser leg",
  icon: "flask",
  on: true,
  state: "ok",
  places: ["belt", "session"],
  provenance: { via: "agent", at: "2026-11-08T07:41:00Z" },
};
const TRACKER: WireTrickInfo = {
  host: "bluefin",
  id: "tracker",
  name: "Tracker",
  icon: "list",
  on: false,
  state: "off",
  places: ["session"],
  provenance: { via: "repo", at: "2026-11-08T09:38:00Z", repo: "owner/tracker-trick", sha: "3f2a91c0d4e5" },
};

/** A store that has taken one reply listing `tricks`. */
async function storeWith(tricks: WireTrickInfo[]): Promise<TricksStore> {
  const reply: TricksReply = { rev: 5, tricks, parts: [], present: [] };
  const store = createTricksStore({ fetchTricks: async () => reply, tapTrick: async () => Promise.reject(new Error("no tap")), mintRequestId: () => "r" });
  await store.syncTricks(5);
  return store;
}

function renderCard(store: TricksStore, onSwitch?: (host: string, id: string, on: boolean) => Promise<WireTrickInfo>, readOnly = false) {
  const loader = readOnly ? () => ({ device: { enforced: true, authorized: false } }) : undefined;
  const router = createMemoryRouter(
    [{ id: ROOT_ROUTE_ID, path: "/", element: <TricksSettingsCard store={store} onSwitch={onSwitch} now={NOW} />, loader }],
    { initialEntries: ["/"] },
  );
  return render(<RouterProvider router={router} />);
}

const rowOf = (id: string) => {
  const row = document.querySelector(`[data-trick="${id}"]`);
  if (!(row instanceof HTMLElement)) throw new Error(`no row for ${id}`);
  return row;
};

afterEach(() => {
  clearStatus();
  vi.useRealTimers();
});

describe("TricksSettingsCard: when it shows", () => {
  it("draws nothing before the phone holds a tricks reply", async () => {
    const store = createTricksStore({ fetchTricks: async () => Promise.reject(new Error("no runner")), tapTrick: async () => Promise.reject(new Error("no")), mintRequestId: () => "r" });
    await store.syncTricks(undefined);
    renderCard(store);
    expect(screen.queryByTestId("tricks-settings")).toBeNull();
    const { result } = renderHook(() => useTricksPresent(store));
    expect(result.current).toBe(false);
  });

  it("draws the card once a reply is held", async () => {
    const store = await storeWith([LEGS]);
    renderCard(store);
    expect(await screen.findByTestId("tricks-settings")).toBeInTheDocument();
    const { result } = renderHook(() => useTricksPresent(store));
    expect(result.current).toBe(true);
  });
});

describe("TricksSettingsCard: the rows", () => {
  it("is one row per trick: the name, the places, the provenance and a switch", async () => {
    renderCard(await storeWith([LEGS, TRACKER]));
    const legs = await screen.findByText("Browser leg");
    expect(legs).toBeInTheDocument();
    const a = within(rowOf("legs"));
    expect(a.getByText("belt, session")).toBeInTheDocument();
    expect(a.getByText("Added by agent · 2 h ago")).toBeInTheDocument();
    expect(a.getByRole("switch", { name: "Browser leg" })).toBeChecked();
    const b = within(rowOf("tracker"));
    expect(b.getByText("session")).toBeInTheDocument();
    expect(b.getByText("From owner/tracker-trick @ 3f2a91c · 3 min ago")).toBeInTheDocument();
    expect(b.getByRole("switch", { name: "Tracker" })).not.toBeChecked();
    expect(screen.getByText("A trick runs as you.")).toBeInTheDocument();
  });

  it("says no parts for a manifest with no places, and the CLI and hand provenances in words", () => {
    expect(placesLine([])).toBe("No parts");
    expect(placesLine(["belt", "belt", "tab-mark", "header.line"])).toBe("belt, tab mark, header");
    expect(provenanceLine({ ...LEGS, provenance: { via: "cli" } }, NOW)).toBe("Added by CLI");
    expect(provenanceLine({ ...LEGS, provenance: { via: "folder" } }, NOW)).toBe("Added by hand");
    expect(provenanceLine({ ...LEGS, provenance: undefined }, NOW)).toBe("Added by hand");
    expect(provenanceLine({ ...LEGS, provenance: { via: "repo", repo: "o/r" } }, NOW)).toBe("From o/r");
    expect(provenanceLine({ ...LEGS, provenance: { via: "repo" } }, NOW)).toBe("Added from a repository");
  });

  it("fills the third line with the masked error for a failing or stopped trick, one line, clipped", async () => {
    const failing: WireTrickInfo = { ...LEGS, state: "failing", error: "legs.sh: exit 2: no such file ~/.cache/collie-lab/browser-leg/last.json and a great deal more besides" };
    const stopped: WireTrickInfo = { ...TRACKER, on: true, id: "stopped", name: "Stopped one", state: "stopped", error: "exit 1, five times" };
    renderCard(await storeWith([failing, stopped]));
    const line = within(rowOf("legs")).getByText(/^legs\.sh: exit 2/);
    expect(line.dataset.line).toBe("slot");
    expect(line.dataset.trouble).toBe("true");
    expect(line.className).toContain("truncate");
    expect(within(rowOf("stopped")).getByText("exit 1, five times")).toBeInTheDocument();
    // The provenance is not drawn beside it: the slot holds one or the other.
    expect(within(rowOf("legs")).queryByText(/Added by agent/)).toBeNull();
  });

  it("says manifest refused with the first reason for a skipped trick", async () => {
    const skipped: WireTrickInfo = {
      ...LEGS,
      state: "skipped",
      on: false,
      refusals: [
        { code: "place", path: "/places/0", reason: 'unknown place "nowhere"' },
        { code: "missing", path: "/run", reason: "run is missing" },
      ],
    };
    renderCard(await storeWith([skipped]));
    expect(within(rowOf("legs")).getByText('Manifest refused: unknown place "nowhere"')).toBeInTheDocument();
    expect(slotLine({ ...skipped, refusals: undefined, error: undefined }, NOW).text).toBe("Manifest refused");
  });

  it("keeps every row the same three lines, whatever the state", async () => {
    const failing: WireTrickInfo = { ...LEGS, id: "bad", name: "Bad", state: "failing", error: "exit 2" };
    renderCard(await storeWith([LEGS, TRACKER, failing]));
    await screen.findByText("Bad");
    for (const id of ["legs", "tracker", "bad"]) {
      const row = rowOf(id);
      expect(row.querySelectorAll("[data-line]").length).toBe(2);
      expect(row.querySelector('[data-line="places"]')?.textContent).not.toBe("");
      expect(row.querySelector('[data-line="slot"]')?.textContent).not.toBe("");
    }
  });

  it("shows one muted row and the init command when the folder holds no trick", async () => {
    renderCard(await storeWith([]));
    expect(await screen.findByText("No tricks yet")).toBeInTheDocument();
    expect(screen.getByText("collie trick init <id>").className).toContain("font-mono");
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
    expect(screen.getByText("A trick runs as you.")).toBeInTheDocument();
  });
});

describe("TricksSettingsCard: the switch", () => {
  it("posts the new position, flips at once and keeps it", async () => {
    const user = userEvent.setup();
    const onSwitch = vi.fn(async (_host: string, _id: string, on: boolean) => ({ ...TRACKER, on, state: "ok" as const }));
    renderCard(await storeWith([LEGS, TRACKER]), onSwitch);
    const sw = await screen.findByRole("switch", { name: "Tracker" });
    expect(sw).not.toBeChecked();
    await user.click(sw);
    expect(onSwitch).toHaveBeenCalledWith("bluefin", "tracker", true);
    expect(screen.getByRole("switch", { name: "Tracker" })).toBeChecked();
    // The other trick's switch is untouched.
    expect(screen.getByRole("switch", { name: "Browser leg" })).toBeChecked();
    expect(currentStatus()).toBeNull();
  });

  it("flips before the bridge answers", async () => {
    const user = userEvent.setup();
    let release: (info: WireTrickInfo) => void = () => {};
    const onSwitch = vi.fn(() => new Promise<WireTrickInfo>((resolve) => (release = resolve)));
    renderCard(await storeWith([LEGS]), onSwitch);
    await user.click(await screen.findByRole("switch", { name: "Browser leg" }));
    expect(screen.getByRole("switch", { name: "Browser leg" })).not.toBeChecked();
    // A second tap while the first is in flight sends nothing.
    await user.click(screen.getByRole("switch", { name: "Browser leg" }));
    expect(onSwitch).toHaveBeenCalledTimes(1);
    await act(async () => release({ ...LEGS, on: false, state: "off" }));
    expect(screen.getByRole("switch", { name: "Browser leg" })).not.toBeChecked();
  });

  it("goes back and says so when the bridge refuses", async () => {
    const user = userEvent.setup();
    const onSwitch = vi.fn(async () => Promise.reject(new Error("/api/tricks/bluefin/legs/switch → 404")));
    renderCard(await storeWith([LEGS]), onSwitch);
    const sw = await screen.findByRole("switch", { name: "Browser leg" });
    await user.click(sw);
    expect(await screen.findByRole("switch", { name: "Browser leg" })).toBeChecked();
    expect(currentStatus()).toMatchObject({ text: "Could not switch Browser leg. Try again.", tone: "error" });
  });

  it("lets go of the held position once the list agrees, and after a while if it never does", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const reply = (tricks: WireTrickInfo[], rev: number): TricksReply => ({ rev, tricks, parts: [], present: [] });
    let served = reply([LEGS], 5);
    const store = createTricksStore({ fetchTricks: async () => served, tapTrick: async () => Promise.reject(new Error("no")), mintRequestId: () => "r" });
    await store.syncTricks(5);
    renderCard(store, async () => ({ ...LEGS, on: false, state: "off" }));
    await user.click(await screen.findByRole("switch", { name: "Browser leg" }));
    expect(screen.getByRole("switch", { name: "Browser leg" })).not.toBeChecked();
    // The list is still the old one: the held position stands.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOLD_MS - 1000);
    });
    expect(screen.getByRole("switch", { name: "Browser leg" })).not.toBeChecked();
    // The bridge's list moves to agree.
    served = reply([{ ...LEGS, on: false, state: "off" }], 6);
    await act(async () => {
      await store.syncTricks(6);
    });
    expect(screen.getByRole("switch", { name: "Browser leg" })).not.toBeChecked();
    // And later the bridge turns it on from the CLI: the card follows the store, not a stale hold.
    served = reply([LEGS], 7);
    await act(async () => {
      await store.syncTricks(7);
    });
    expect(screen.getByRole("switch", { name: "Browser leg" })).toBeChecked();
  });

  it("gives the switch back to the list when it never agrees within the hold", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderCard(await storeWith([LEGS]), async () => ({ ...LEGS, on: false, state: "off" }));
    await user.click(await screen.findByRole("switch", { name: "Browser leg" }));
    expect(screen.getByRole("switch", { name: "Browser leg" })).not.toBeChecked();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOLD_MS + 1);
    });
    expect(screen.getByRole("switch", { name: "Browser leg" })).toBeChecked();
  });

  it("disables the switches on a device that may only read", async () => {
    renderCard(await storeWith([LEGS]), undefined, true);
    expect(await screen.findByRole("switch", { name: "Browser leg" })).toBeDisabled();
  });

  it("switchTrick posts { on } to the trick's switch route and reads the trick back", async () => {
    let seen: { path: string; body: unknown } | null = null;
    server.use(
      http.post(/\/api\/tricks\/[^/]+\/[^/]+\/switch$/, async ({ request }) => {
        seen = { path: new URL(request.url).pathname, body: await request.json() };
        return HttpResponse.json({ ...TRACKER, on: true, state: "ok" });
      }),
    );
    const info = await switchTrick("blue fin", "tracker", true);
    expect(seen).toEqual({ path: "/api/tricks/blue%20fin/tracker/switch", body: { on: true } });
    expect(info).toMatchObject({ id: "tracker", on: true });
    server.use(http.post(/\/switch$/, () => HttpResponse.json({ nope: 1 })));
    await expect(switchTrick("bluefin", "tracker", true)).rejects.toThrow(/not a trick/);
    server.use(http.post(/\/switch$/, () => HttpResponse.json({ error: "unknown-trick" }, { status: 404 })));
    await expect(switchTrick("bluefin", "gone", true)).rejects.toThrow();
  });
});

beforeEach(() => {
  clearStatus();
});
