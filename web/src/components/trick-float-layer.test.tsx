import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { beginHold, endHold } from "@/lib/hold-flag";
import type { JsonObject } from "@/lib/json";
import { FLOAT_COVER } from "@/lib/tricks/float";
import type { TricksReply, TrickPart, WireTrickInfo, WireTrickPart } from "@/lib/tricks/schema";
import { createTricksStore, type TricksStore } from "@/lib/tricks/store";
import type { AgentView } from "@/lib/types";
import { TrickFloatLayer } from "./trick-float-layer";

// THE FLOAT LAYER: one layer over the app. A picture shows only where it may, hides under a sheet, a card that
// asks, the composer's focus and a hold, never takes a pointer except a parked one that opens a page, and under
// reduced motion a once-shot does not play and a stay picture is a still image.

const nav = { down: vi.fn() };
vi.mock("@/hooks/use-nav", () => ({ useNav: () => nav }));
vi.mock("@/lib/authed-url", () => ({ useAuthedUrl: () => ({ url: "blob:pet", failed: false }) }));
vi.mock("@/hooks/use-float-region", () => ({ useFloatRegion: () => ({ x: 0, y: 92, w: 390, h: 544 }) }));

const AS_OF = new Date().toISOString();
/** A part as the wire stores it: JSON, so no typed part is built here. */
function stored(value: JsonObject): TrickPart {
  return JSON.parse(JSON.stringify(value));
}
function part(trick: string, value: JsonObject, rev = 1): WireTrickPart {
  return { host: "lodge", trick, part: "p", rev, asOf: AS_OF, value: stored({ at: "float", id: "p", ...value }) };
}
const STAY = (extra: JsonObject = {}): JsonObject => ({ mode: "stay", motion: "perch", sprite: { src: "media/pet.png" }, ...extra });
const ONCE = (extra: JsonObject = {}): JsonObject => ({ mode: "once", motion: "pop", sprite: { src: "media/spark.png" }, ...extra });

const PAGE: AgentView = {
  paneId: "trick:lodge:pet:main",
  workspaceId: "trick:lodge",
  workspaceLabel: "Tricks",
  workspaceNumber: 2,
  tabId: "trick:lodge:pet",
  agent: "pet",
  status: "idle",
  cwd: "/m",
  focused: false,
  kind: "trick",
};

interface Rig {
  store: TricksStore;
  replace: (next: WireTrickPart[], rev: number) => Promise<void>;
}

function storeWith(parts: WireTrickPart[], rev = 1): Rig {
  let current = parts;
  let at = rev;
  const reply = (): TricksReply => ({
    rev: at,
    tricks: [...new Set(current.map((p) => p.trick))].map((id): WireTrickInfo => ({ host: "lodge", id, name: `Trick ${id}`, icon: "flask", on: true, state: "ok", places: ["float"] })),
    parts: current,
    present: current.map((p) => `${p.host}/${p.trick}/${p.part}`),
  });
  const store = createTricksStore({ fetchTricks: async () => reply(), tapTrick: async () => ({ rid: "r", code: "ok" as const }), mintRequestId: () => "00000000-0000-4000-8000-000000000001" });
  return {
    store,
    replace: async (next, nextRev) => {
      current = next;
      at = nextRev;
      await store.syncTricks(nextRev);
    },
  };
}

function reduceMotion(on: boolean) {
  const query = (media: string) => ({ matches: on && media.includes("reduce"), media, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, onchange: null, dispatchEvent: () => false });
  Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: query });
}

async function mount(store: TricksStore, path = "/") {
  const view = render(
    <MemoryRouter initialEntries={[path]}>
      <TrickFloatLayer trickSessions={[PAGE]} store={store} />
    </MemoryRouter>,
  );
  await act(async () => {
    await store.syncTricks(1);
  });
  return view;
}

const pets = () => [...document.querySelectorAll<HTMLElement>('[data-slot="float-pet"]')];
const shots = () => [...document.querySelectorAll<HTMLElement>('[data-slot="float-shot"]')];

beforeEach(() => {
  localStorage.clear();
  reduceMotion(false);
  nav.down.mockClear();
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("a stay picture", () => {
  it("draws on the Dashboard from a part with no sessions, and takes no pointer", async () => {
    const { store } = storeWith([part("pet", STAY())]);
    await mount(store);
    expect(pets().map((el) => el.dataset.trick)).toEqual(["pet"]);
    expect(document.querySelector('[data-slot="float-layer"]')?.className).toContain("pointer-events-none");
    expect(pets()[0]?.className).toContain("pointer-events-none");
    expect(document.querySelector('[data-slot="float-open"]')).toBeNull();
  });

  it("draws nowhere else: not on Settings, not on the zoomed output", async () => {
    const { store } = storeWith([part("pet", STAY())]);
    await mount(store, "/settings");
    expect(pets()).toEqual([]);
    cleanup();
    await mount(store, "/pane/p1/zoom");
    expect(pets()).toEqual([]);
  });

  it("takes a tap only when its part opens the page and it rests, and the tap opens the trick's page", async () => {
    const { store } = storeWith([part("pet", STAY({ opens: "page" }))]);
    await mount(store);
    const button = document.querySelector<HTMLElement>('[data-slot="float-open"]');
    expect(button?.className).toContain("pointer-events-auto");
    expect(button?.getAttribute("aria-label")).toBe("Open Trick pet");
    fireEvent.click(button!);
    expect(nav.down).toHaveBeenCalledWith(expect.stringContaining("trick"));
  });

  it("takes a tap while it idles in place, when its part asks", async () => {
    const { store } = storeWith([part("pet", STAY({ motion: "idle", opens: "page" }))]);
    await mount(store);
    expect(document.querySelector('[data-slot="float-open"]')).not.toBeNull();
  });

  it("shows at most two stay pictures", async () => {
    const { store } = storeWith(["a", "b", "c"].map((trick) => part(trick, STAY())));
    await mount(store);
    expect(pets().map((el) => el.dataset.trick)).toEqual(["a", "b"]);
  });

  it("is off when Floating things is off on this device", async () => {
    localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ floatingThings: false }));
    const { store } = storeWith([part("pet", STAY())]);
    await mount(store);
    expect(document.querySelector('[data-slot="float-layer"]')).toBeNull();
  });

  it("is a still image under reduced motion: the same picture, no animation, no transition", async () => {
    reduceMotion(true);
    const { store } = storeWith([part("pet", STAY({ motion: "wander", mood: "working" }))]);
    await mount(store);
    const pet = pets()[0]!;
    expect(pet.dataset.mood).toBe("working");
    expect(pet.style.transition).toBe("");
  });
});

describe("what hides the pictures", () => {
  async function shown() {
    const { store } = storeWith([part("pet", STAY())]);
    await mount(store);
    expect(pets()).toHaveLength(1);
  }

  it.each([...FLOAT_COVER])("hides while %s is in the page, and returns after", async (selector) => {
    await shown();
    const el = document.createElement("div");
    if (selector.startsWith("[role=")) el.setAttribute("role", selector.slice(7, -2));
    else el.setAttribute("data-slot", selector.slice(12, -2));
    await act(async () => {
      document.body.append(el);
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });
    expect(pets()).toEqual([]);
    await act(async () => {
      el.remove();
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });
    expect(pets()).toHaveLength(1);
  });

  it("hides while the composer has focus, and returns when it loses it", async () => {
    await shown();
    const box = document.createElement("textarea");
    document.body.append(box);
    await act(async () => box.focus());
    expect(pets()).toEqual([]);
    await act(async () => box.blur());
    expect(pets()).toHaveLength(1);
  });

  it("hides during a hold, and returns after", async () => {
    await shown();
    await act(async () => beginHold());
    expect(pets()).toEqual([]);
    await act(async () => endHold());
    expect(pets()).toHaveLength(1);
  });
});

describe("a once picture", () => {
  it("does not play for a part that was there at load, plays when a part arrives or changes, and never takes a pointer", async () => {
    const old = part("spark", ONCE());
    const { store, replace } = storeWith([old]);
    await mount(store);
    expect(shots()).toEqual([]);
    await act(async () => replace([old, part("new", ONCE())], 2));
    expect(shots().map((el) => el.dataset.trick)).toEqual(["new"]);
    expect(shots()[0]?.className).toContain("pointer-events-none");
    expect(document.querySelector('[data-slot="float-shot"] button')).toBeNull();
    expect(document.querySelector('[data-slot="float-shot"] [data-slot="float-open"]')).toBeNull();
  });

  it("plays again when the part's value changes", async () => {
    const { store, replace } = storeWith([part("spark", ONCE())]);
    await mount(store);
    await act(async () => replace([part("spark", ONCE({ sprite: { src: "media/other.png" } }), 2)], 2));
    expect(shots().map((el) => el.dataset.trick)).toEqual(["spark"]);
  });

  it("does not play under reduced motion", async () => {
    reduceMotion(true);
    const { store, replace } = storeWith([part("spark", ONCE())]);
    await mount(store);
    await act(async () => replace([part("spark", ONCE({ motion: "arc" }), 2)], 2));
    expect(shots()).toEqual([]);
  });

  it("is dropped while a sheet or card covers the screen", async () => {
    const { store, replace } = storeWith([part("spark", ONCE())]);
    await mount(store);
    const dock = document.createElement("div");
    dock.setAttribute("data-slot", "card-dock");
    await act(async () => {
      document.body.append(dock);
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });
    await act(async () => replace([part("spark", ONCE({ motion: "arc" }), 2)], 2));
    expect(shots()).toEqual([]);
  });
});
