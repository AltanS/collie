import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TabBar } from "@/components/ui/tab-bar";
import type { PlaceItem, TricksReply, WireTrickInfo, WireTrickPart } from "@/lib/tricks/schema";
import { createTricksStore, type TricksStore } from "@/lib/tricks/store";
import type { AgentView } from "@/lib/types";
import { TrickDashboardStrip, trickTabbarExtras } from "./trick-place-items";

// THE TRICKS' ITEMS ON THE DASHBOARD (2026-11-10): the `dashboard` place's tiles in a strip at the top of
// the Dashboard, and the `tabbar` place's items in the bottom bar's scrolling run. Hidden when empty, in
// manifest order, a tap opens the trick's session, inert without one, each in its own boundary.

const FRESH = new Date().toISOString();
const OLD = new Date(Date.now() - 10 * 60_000).toISOString();

function part(trick: string, at: "dashboard" | "tabbar", item: PlaceItem, asOf = FRESH): WireTrickPart {
  return { host: "bluefin", trick, part: at, rev: 1, asOf, fresh: "30s", value: { at, id: at, item } };
}

/** A part whose `item` throws when it is read: the worst a bad reply can do to the renderer. */
function bomb(trick: string, at: "dashboard" | "tabbar"): WireTrickPart {
  return {
    host: "bluefin",
    trick,
    part: at,
    rev: 1,
    asOf: FRESH,
    value: {
      at,
      id: at,
      get item(): PlaceItem {
        throw new Error("an item that cannot be read");
      },
    },
  };
}

const SESSION: AgentView = {
  paneId: "trick:bluefin:tracker:due",
  workspaceId: "trick:bluefin",
  workspaceLabel: "Tricks",
  workspaceNumber: 2,
  tabId: "trick:bluefin:tracker",
  agent: "tracker",
  status: "idle",
  cwd: "/m",
  focused: false,
  kind: "trick",
};

async function storeOf(parts: WireTrickPart[]): Promise<TricksStore> {
  const tricks = parts.map((p): WireTrickInfo => ({ host: "bluefin", id: p.trick, name: `${p.trick} trick`, icon: "flask", on: true, state: "ok", places: ["dashboard", "tabbar"] }));
  const reply: TricksReply = { rev: 1, tricks, parts, present: parts.map((p) => `${p.host}/${p.trick}/${p.part}`) };
  const store = createTricksStore({ fetchTricks: async () => reply, tapTrick: async () => ({ rid: "r", code: "ok" as const }), mintRequestId: () => "00000000-0000-4000-8000-000000000001" });
  await store.syncTricks(1);
  return store;
}

async function mountStrip(parts: WireTrickPart[], sessions: AgentView[] = []) {
  const store = await storeOf(parts);
  const onOpenSession = vi.fn();
  const view = render(<TrickDashboardStrip sessions={sessions} onOpenSession={onOpenSession} store={store} />);
  return { onOpenSession, store, view };
}

const strip = () => document.querySelector<HTMLElement>('[data-slot="trick-dashboard-strip"]');
const tiles = () => [...document.querySelectorAll<HTMLElement>('[data-slot="tile"]')];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the Dashboard's strip of tricks' tiles", () => {
  it("is not drawn at all while no trick has a dashboard part", async () => {
    await mountStrip([part("legs", "tabbar", { label: "Legs" })]);
    expect(strip()).toBeNull();
    expect(document.querySelector('[data-slot="tile-strip"]')).toBeNull();
  });

  it("draws one tile per trick in manifest order, with the face, the name and a quiet badge", async () => {
    await mountStrip([part("legs", "dashboard", { icon: "flask", label: "Legs", badge: 3, tone: "accent" }), part("tracker", "dashboard", { label: "Tracker", badge: "M96" }), part("quiet", "dashboard", { label: "Quiet", badge: 0 })]);
    expect(tiles().map((tile) => tile.dataset.trick)).toEqual(["legs", "tracker", "quiet"]);
    const [legs, tracker, quiet] = tiles();
    expect(legs!.querySelector('[data-slot="tile-face"]')!.className).toMatch(/\brounded-full\b/u);
    expect(legs!.querySelector('[data-slot="tile-badge"]')).toHaveTextContent("3");
    expect(legs!.querySelector('[data-slot="tile-badge"]')!.className).toMatch(/\bborder-border\b/u);
    expect(legs!.querySelector('[data-slot="tile-badge"]')!.className).not.toMatch(/\bbg-status-blocked\b/u);
    // The tone inks the glyph through the tone map, never a status shape.
    expect(legs!.querySelector("svg")!.getAttribute("class")).toContain("text-status-working");
    expect(legs!.querySelector("[data-slot='status-dot'], [data-status]")).toBeNull();
    expect(tracker!.querySelector('[data-slot="tile-badge"]')).toHaveTextContent("M96");
    // 0 draws no badge.
    expect(quiet!.querySelector('[data-slot="tile-badge"]')).toBeNull();
    expect(legs!.textContent).toContain("Legs");
  });

  it("draws no badge on the face for one longer than three characters, and still names it (A5)", async () => {
    await mountStrip([part("legs", "dashboard", { icon: "flask", label: "Legs", badge: "23/34" })]);
    const [legs] = tiles();
    expect(legs!.querySelector('[data-slot="tile-badge"]')).toBeNull();
    expect(legs!.textContent).toContain("23/34");
  });

  it("scrolls sideways with no scrollbar under the house fade, and each tile meets the 44px floor", async () => {
    await mountStrip(Array.from({ length: 9 }, (_, i) => part(`t${i}`, "dashboard", { label: `Trick ${i}` })));
    const scroller = document.querySelector<HTMLElement>('[data-slot="tile-strip-scroller"]')!;
    expect(scroller.className).toMatch(/\boverflow-x-auto\b/u);
    expect(scroller.className).toContain("[scrollbar-width:none]");
    expect(scroller.closest("[data-overflow]")).not.toBeNull();
    expect(tiles()).toHaveLength(9);
    for (const tile of tiles()) expect(tile.className).toContain("w-[60px]");
  });

  it("opens the trick's session on a tap when it has one, and is no control without one", async () => {
    const { onOpenSession } = await mountStrip([part("tracker", "dashboard", { label: "Tracker" }), part("legs", "dashboard", { label: "Legs" })], [SESSION]);
    const [tracker, legs] = tiles();
    expect(tracker!.tagName).toBe("BUTTON");
    expect(tracker).toHaveAccessibleName("tracker trick: Tracker. Open tracker trick");
    fireEvent.click(tracker!);
    expect(onOpenSession).toHaveBeenCalledWith(SESSION);
    expect(legs!.tagName).toBe("SPAN");
    expect(legs!.querySelector("button")).toBeNull();
    expect(legs!.textContent).toContain("legs trick: Legs");
  });

  it("drops its tone once past the fresh window", async () => {
    await mountStrip([part("legs", "dashboard", { label: "Legs", tone: "ok" }, OLD)]);
    expect(tiles()[0]!.dataset.stale).toBe("true");
    expect(tiles()[0]!.querySelector("svg")!.getAttribute("class")).not.toContain("text-status-done");
    expect(tiles()[0]!.querySelector("svg")!.getAttribute("class")).toContain("text-status-unknown");
  });

  it("leaves the other tiles drawn when one throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await mountStrip([part("legs", "dashboard", { label: "Legs" }), bomb("bomb", "dashboard"), part("tracker", "dashboard", { label: "Tracker" })]);
    expect(tiles().map((tile) => tile.dataset.trick)).toEqual(["legs", "tracker"]);
  });

  it("arrives through Collapse when the first tile comes in", async () => {
    const parts = [part("legs", "dashboard", { label: "Legs" })];
    const empty = await storeOf([]);
    const { rerender } = render(<TrickDashboardStrip sessions={[]} onOpenSession={vi.fn()} store={empty} />);
    expect(strip()).toBeNull();
    const full = await storeOf(parts);
    await act(async () => rerender(<TrickDashboardStrip sessions={[]} onOpenSession={vi.fn()} store={full} />));
    expect(strip()!.closest('[data-slot="collapse"]')).not.toBeNull();
  });
});

describe("the bottom bar's tricks' items", () => {
  async function mountBar(parts: WireTrickPart[], sessions: AgentView[] = []) {
    const store = await storeOf(parts);
    const onOpenSession = vi.fn();
    const extras = trickTabbarExtras({ parts, sessions, onOpenSession, store });
    render(<TabBar<"dashboard"> label="Views" active="dashboard" onSelect={vi.fn()} items={[{ value: "dashboard", label: "Dashboard", icon: <span /> }]} extras={extras} />);
    return { onOpenSession };
  }
  const items = () => [...document.querySelectorAll<HTMLElement>('[data-slot="tab-extra"]')];

  it("draws one item per trick in manifest order, in the bar's run, with a quiet badge", async () => {
    await mountBar([part("legs", "tabbar", { icon: "flask", label: "Legs", badge: "23/34" }), part("tracker", "tabbar", { label: "Tracker", badge: 2 })]);
    expect(items().map((el) => el.dataset.trick)).toEqual(["legs", "tracker"]);
    expect(items()[0]!.closest('[data-slot="tab-bar-extras"]')).not.toBeNull();
    const badge = items()[1]!.querySelector('[data-slot="tab-extra-badge"]')!;
    expect(badge).toHaveTextContent("2");
    expect(badge.className).not.toMatch(/\bbg-status-blocked\b/u);
  });

  it("opens the trick's session on a tap when it has one, and is no control without one", async () => {
    const { onOpenSession } = await mountBar([part("tracker", "tabbar", { label: "Tracker" }), part("legs", "tabbar", { label: "Legs" })], [SESSION]);
    const [tracker, legs] = items();
    expect(tracker!.tagName).toBe("BUTTON");
    fireEvent.click(tracker!);
    expect(onOpenSession).toHaveBeenCalledWith(SESSION);
    expect(legs!.tagName).toBe("SPAN");
  });

  it("leaves the other items drawn when one throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await mountBar([part("legs", "tabbar", { label: "Legs" }), bomb("bomb", "tabbar"), part("tracker", "tabbar", { label: "Tracker" })]);
    expect(items().map((el) => el.dataset.trick)).toEqual(["legs", "tracker"]);
  });
});
