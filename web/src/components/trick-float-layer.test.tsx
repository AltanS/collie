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
vi.mock("@/hooks/use-float-region", () => ({ useFloatRegion: () => ({ region: { x: 0, y: 92, w: 390, h: 544 }, reach: { x: 0, y: 88, w: 390, h: 552 } }) }));

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

/** A loaded sheet: jsdom loads no picture, so the test says how big it is and fires the load. */
async function loadSheet(el: Element, w: number, h: number) {
  const img = el.querySelector("img");
  if (img === null) throw new Error("no picture in the element");
  Object.defineProperty(img, "naturalWidth", { configurable: true, value: w });
  Object.defineProperty(img, "naturalHeight", { configurable: true, value: h });
  await act(async () => {
    fireEvent.load(img);
  });
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

describe("the picture's shape and place", () => {
  it("draws a tall frame at the full height of its size, its width from the sheet, and stands it on the landmark below", async () => {
    // Four 74 x 120 frames side by side: a 296 x 120 sheet. Size l is 72 px high.
    const { store } = storeWith([part("pet", STAY({ sprite: { src: "media/pet.png", frames: 4, size: "l" } }))]);
    await mount(store);
    const pet = pets()[0]!;
    await loadSheet(pet, 296, 120);
    const sprite = pet.querySelector<HTMLElement>('[data-slot="float-sprite"]')!;
    expect(sprite.style.height).toBe("72px");
    expect(Number.parseFloat(sprite.style.width)).toBeCloseTo(72 * (74 / 120), 3);
    // Standing on the landmark: the reach ends at y 640, the picture is 72 high.
    expect(pet.style.transform).toContain("translate3d(");
    const moved = /translate3d\(([-\d.]+)px, ([-\d.]+)px/.exec(pet.style.transform);
    const x = Number(moved?.[1]);
    const y = Number(moved?.[2]);
    expect(y + 72).toBe(640);
    // `along` left out is the end: the right side.
    expect(x + Number.parseFloat(sprite.style.width)).toBe(390 - 8);
  });

  it("is not drawn when the region cannot hold it", async () => {
    // A single frame 33 times wider than high is 2400 px wide at 72 px high: wider than the free area.
    const { store } = storeWith([part("pet", STAY({ sprite: { src: "media/pet.png", size: "l" } }))]);
    await mount(store);
    await loadSheet(pets()[0]!, 4000, 120);
    expect(pets()).toEqual([]);
  });
});

describe("a once picture from a pet", () => {
  const PET = (extra: JsonObject = {}): WireTrickPart => ({ ...part("spark", STAY({ sprite: { src: "media/pet.png", size: "m" }, ...extra })), part: "pet" });
  const BEAM = (rev = 1, extra: JsonObject = {}): WireTrickPart => ({ ...part("spark", ONCE({ motion: "fly-across", from: "pet", ...extra }), rev), part: "beam" });
  const MS = 1500;

  /** What the shot's animation was given: the first keyframe's place, and its centre when the sheet is `side` px. */
  const animate = vi.fn();
  beforeEach(() => {
    animate.mockReset();
    animate.mockImplementation(() => ({ finished: new Promise(() => undefined), cancel: () => undefined, pause: () => undefined, play: () => undefined }));
    Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, writable: true, value: animate });
  });
  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(HTMLElement.prototype, "animate");
  });
  const firstFrame = (): { x: number; y: number } | undefined => {
    const call = animate.mock.calls.find((args) => Array.isArray(args[0]) && args[0][0]?.transform?.includes("scale"));
    const match = /translate3d\(([-\d.]+)px, ([-\d.]+)px/.exec(call?.[0][0].transform ?? "");
    return match === null ? undefined : { x: Number(match[1]), y: Number(match[2]) };
  };

  it("starts at the pet when it is on screen", async () => {
    const { store, replace } = storeWith([PET()]);
    await mount(store);
    await loadSheet(pets()[0]!, 48, 48);
    await act(async () => replace([PET(), BEAM()], 2));
    expect(shots().map((el) => el.dataset.from)).toEqual(["pet"]);
  });

  it("waits for a pet printed in the same run, and starts at its hand: the front edge, 40% down", async () => {
    // Nothing is held when the phone first looks; the pet and the shot arrive together.
    const { store, replace } = storeWith([]);
    await mount(store);
    await act(async () => replace([PET(), BEAM()], 2));
    // The pet's sheet has not loaded: it has no place, and the shot holds still, not started.
    expect(shots()).toHaveLength(1);
    expect(shots()[0]?.dataset.from).toBeUndefined();
    await loadSheet(shots()[0]!, 32, 32);
    expect(firstFrame()).toBeUndefined();
    await loadSheet(pets()[0]!, 48, 48);
    expect(shots()[0]?.dataset.from).toBe("pet");
    // The pet is 48 px, perched at the end of the bottom edge: x 334, y 592. It is on the right, so the shot
    // flies left and starts at the pet's left edge, 40% of 48 down; a 32 px shot has its centre there.
    expect(firstFrame()).toEqual({ x: 334 - 16, y: 592 + 0.4 * 48 - 16 });
  });

  it("starts at the pet's right edge when the pet stands on the left half, and flies level to the far side", async () => {
    const { store, replace } = storeWith([]);
    await mount(store);
    await act(async () => replace([PET({ along: "start" }), BEAM()], 2));
    await loadSheet(pets()[0]!, 48, 48);
    await loadSheet(shots()[0]!, 32, 32);
    // Pet at x 8, 48 wide: front edge 56.
    expect(firstFrame()).toEqual({ x: 56 - 16, y: 592 + 0.4 * 48 - 16 });
    // SAFETY: the call was found above by its keyframes, which are objects with a transform.
    const frames = animate.mock.calls.find((args) => Array.isArray(args[0]) && args[0][0]?.transform?.includes("scale"))?.[0] as { transform: string }[];
    const ys = frames.map((frame) => /, ([-\d.]+)px/.exec(frame.transform)?.[1]);
    expect(new Set(ys).size).toBe(1);
  });

  it("falls back to the normal start after the wait when the pet never reports a place", async () => {
    vi.useFakeTimers();
    const { store, replace } = storeWith([]);
    await mount(store);
    await act(async () => replace([PET(), BEAM()], 2));
    await loadSheet(shots()[0]!, 32, 32);
    await act(async () => vi.advanceTimersByTime(MS - 50));
    expect(firstFrame()).toBeUndefined();
    await act(async () => vi.advanceTimersByTime(100));
    expect(shots()).toHaveLength(1);
    expect(shots()[0]?.dataset.from).toBeUndefined();
    expect(firstFrame()).toBeDefined();
  });

  it("falls back to the normal start when the pet is not drawn yet and then never is", async () => {
    vi.useFakeTimers();
    const { store, replace } = storeWith([PET()]);
    await mount(store);
    // The sheet has not loaded, so the pet has no place yet.
    await act(async () => replace([PET(), BEAM()], 2));
    expect(shots()).toHaveLength(1);
    await act(async () => vi.advanceTimersByTime(MS + 10));
    expect(shots()[0]?.dataset.from).toBeUndefined();
  });

  it("does not wait when the part names no stay part on screen", async () => {
    const { store, replace } = storeWith([PET()]);
    await mount(store);
    await loadSheet(pets()[0]!, 48, 48);
    await act(async () => replace([PET(), BEAM(1, { from: "ghost" })], 2));
    await loadSheet(shots()[0]!, 32, 32);
    expect(shots()[0]?.dataset.from).toBeUndefined();
    expect(firstFrame()).toBeDefined();
  });

  it("does not wait for a pet of another trick: it is no origin", async () => {
    const { store, replace } = storeWith([{ ...part("other", STAY({ sprite: { src: "media/pet.png" } })), part: "pet" }]);
    await mount(store);
    await loadSheet(pets()[0]!, 32, 32);
    await act(async () => replace([{ ...part("other", STAY({ sprite: { src: "media/pet.png" } })), part: "pet" }, BEAM()], 2));
    await loadSheet(shots()[0]!, 32, 32);
    expect(shots()[0]?.dataset.from).toBeUndefined();
    expect(firstFrame()).toBeDefined();
  });
});
