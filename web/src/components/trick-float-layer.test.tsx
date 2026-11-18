import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { beginHold, endHold } from "@/lib/hold-flag";
import type { JsonObject } from "@/lib/json";
import { FLOAT_AWAY_CAP_MS, FLOAT_COVER } from "@/lib/tricks/float";
import { floatClock } from "@/lib/tricks/float-clock";
import type { TricksReply, TrickPart, WireTrickInfo, WireTrickPart } from "@/lib/tricks/schema";
import { createTricksStore, type TricksStore } from "@/lib/tricks/store";
import type { AgentView } from "@/lib/types";
import { TrickFloatLayer } from "./trick-float-layer";

// THE FLOAT LAYER: one layer over the app. A picture shows only where it may, hides under a sheet, a card that
// asks, the composer's focus and a hold, never takes a pointer except a parked one that opens a page, and under
// reduced motion a once-shot does not play and a stay picture is a still image.

const nav = { down: vi.fn() };
vi.mock("@/hooks/use-nav", () => ({ useNav: () => nav }));
const asked = vi.hoisted(() => ({ paths: new Array<string | null>() }));
vi.mock("@/lib/authed-url", () => ({
  useAuthedUrl: (path: string | null) => {
    asked.paths.push(path);
    return { url: "blob:pet", failed: false };
  },
}));
/** Whether the free area has been measured: a layer that has just been asked to draw has none for a frame. */
const measured = vi.hoisted(() => ({ ready: true }));
vi.mock("@/hooks/use-float-region", () => ({
  useFloatRegion: () => (measured.ready ? { region: { x: 0, y: 92, w: 390, h: 544 }, reach: { x: 0, y: 88, w: 390, h: 552 } } : null),
}));

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

function storeWith(parts: WireTrickPart[], rev = 1, media?: Record<string, string>): Rig {
  let current = parts;
  let at = rev;
  const info = (id: string): WireTrickInfo => {
    const row: WireTrickInfo = { host: "lodge", id, name: `Trick ${id}`, icon: "flask", on: true, state: "ok", places: ["float"] };
    if (media !== undefined) row.media = media;
    return row;
  };
  const reply = (): TricksReply => ({
    rev: at,
    tricks: [...new Set(current.map((p) => p.trick))].map(info),
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
  floatClock.clear();
  measured.ready = true;
  localStorage.clear();
  reduceMotion(false);
  nav.down.mockClear();
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("a picture's address", () => {
  it("carries the version the trick's row names, for the sheet and the second sprite, and none for an older bridge", async () => {
    asked.paths.length = 0;
    const withAfter = part("pet", STAY({ sprite: { src: "media/pet.png", frames: 4, loop: false, after: { src: "media/pet-after.png", frames: 2 } } }));
    await mount(storeWith([withAfter], 1, { "media/pet.png": "0123456789ab", "media/pet-after.png": "ba9876543210" }).store);
    expect(asked.paths).toContain("/api/tricks/lodge/pet/media/pet.png?rev=1&v=0123456789ab");
    expect(asked.paths).toContain("/api/tricks/lodge/pet/media/pet-after.png?rev=1&v=ba9876543210");
    cleanup();
    asked.paths.length = 0;
    await mount(storeWith([part("pet", STAY())]).store);
    expect(asked.paths).toContain("/api/tricks/lodge/pet/media/pet.png?rev=1");
    expect(asked.paths.filter((path) => path !== null && /[?&]v=/.test(path))).toEqual([]);
  });
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

  it("clips the shot to the free area's width, and the fly-across ends past the far edge at full opacity, over a time set by its path", async () => {
    const { store, replace } = storeWith([]);
    await mount(store);
    await act(async () => replace([PET({ along: "start" }), BEAM()], 2));
    await loadSheet(pets()[0]!, 48, 48);
    await loadSheet(shots()[0]!, 32, 32);
    const clip = shots()[0]?.closest<HTMLElement>('[data-slot="float-clip"]');
    expect(clip).not.toBeNull();
    expect(clip?.className).toContain("overflow-hidden");
    expect(clip?.style.left).toBe("0px");
    expect(clip?.style.width).toBe("390px");
    const call = animate.mock.calls.find((args) => Array.isArray(args[0]) && args[0][0]?.transform?.includes("scale"));
    // SAFETY: the call was found above by its keyframes, which are objects with a transform and an opacity.
    const frames = call?.[0] as { transform: string; opacity: number }[];
    const last = frames.at(-1);
    // The pet is on the left, so the shot flies right: its box starts at the far edge of the region (x 390), still fully visible.
    expect(/translate3d\(([-\d.]+)px/.exec(last?.transform ?? "")?.[1]).toBe("390");
    expect(last?.opacity).toBe(1);
    // From the hand (x 40) to 390 is 350 px at the speed of a 390 px crossing in 3200 ms.
    expect(call?.[1]).toMatchObject({ easing: "linear", duration: Math.round((350 * 3200) / 390) });
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

  it("plays a shot that arrives with the trick's first float part, before the free area is measured, and waits for its pet", async () => {
    measured.ready = false;
    const { store, replace } = storeWith([]);
    const view = await mount(store);
    await act(async () => replace([PET(), BEAM()], 2));
    // The layer wants to draw now but has no free area yet: the shot is held, not dropped.
    expect(shots()).toEqual([]);
    measured.ready = true;
    await act(async () => {
      view.rerender(
        <MemoryRouter initialEntries={["/"]}>
          <TrickFloatLayer trickSessions={[PAGE]} store={store} />
        </MemoryRouter>,
      );
    });
    expect(shots()).toHaveLength(1);
    expect(shots()[0]?.dataset.from).toBeUndefined();
    await loadSheet(shots()[0]!, 32, 32);
    expect(firstFrame()).toBeUndefined();
    await loadSheet(pets()[0]!, 48, 48);
    expect(shots()[0]?.dataset.from).toBe("pet");
    expect(firstFrame()).toEqual({ x: 334 - 16, y: 592 + 0.4 * 48 - 16 });
  });

  it("drops a shot that arrived before the free area and is still without one after the hold", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    measured.ready = false;
    const { store, replace } = storeWith([]);
    const view = await mount(store);
    await act(async () => replace([PET(), BEAM()], 2));
    vi.setSystemTime(Date.now() + 2500);
    measured.ready = true;
    await act(async () => {
      view.rerender(
        <MemoryRouter initialEntries={["/"]}>
          <TrickFloatLayer trickSessions={[PAGE]} store={store} />
        </MemoryRouter>,
      );
    });
    expect(shots()).toEqual([]);
  });
});

describe("a stay picture appears in place", () => {
  const TALL = (extra: JsonObject = {}): WireTrickPart => part("pet", STAY({ along: "start", sprite: { src: "media/pet.png", frames: 2, size: "l" }, ...extra }));

  it("is drawn at its rest spot from the first frame, invisible, and fades in: nothing travels", async () => {
    const { store } = storeWith([TALL()]);
    await mount(store);
    const pet = pets()[0]!;
    // The 72 px frame stands on the landmark below (y 640 - 72), at the start of the edge (x 8).
    const rest = "translate3d(8px, 568px, 0)";
    expect(pet.style.transform).toBe(rest);
    expect(pet.style.opacity).toBe("0");
    // The keyframes of `animate-in` name translate3d(0, 0, 0) as their first frame: the picture would fly in from the corner.
    expect(pet.className).not.toContain("animate-in");
    await loadSheet(pet, 148, 120);
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    });
    expect(pet.style.transform).toBe(rest);
    expect(pet.style.opacity).toBe("1");
    expect(pet.style.transition).toContain("opacity 180ms");
  });

  it("appears at once, with no fade and no glide, under reduced motion", async () => {
    reduceMotion(true);
    const { store } = storeWith([TALL()]);
    await mount(store);
    const pet = pets()[0]!;
    await loadSheet(pet, 148, 120);
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    });
    expect(pet.style.transform).toBe("translate3d(8px, 568px, 0)");
    expect(pet.style.opacity).toBe("1");
    expect(pet.style.transition).toBe("");
  });

  it("does not appear again when the part is printed again with a new asOf and the same value", async () => {
    const first = TALL();
    const { store, replace } = storeWith([first]);
    await mount(store);
    const pet = pets()[0]!;
    await loadSheet(pet, 148, 120);
    await act(async () => replace([{ ...first, rev: 2, asOf: new Date(Date.now() + 5000).toISOString() }], 2));
    expect(pets()[0]).toBe(pet);
  });
});

describe("a sprite that plays once", () => {
  const SHEET = { src: "media/pet.png", frames: 4, fps: 2, size: "m" };
  const ONCEPET = (extra: JsonObject = {}, sprite: JsonObject = {}): WireTrickPart => ({ ...part("spark", STAY({ sprite: { ...SHEET, loop: false, ...sprite }, ...extra })), part: "pet" });
  const BEAM = (rev = 1): WireTrickPart => ({ ...part("spark", ONCE({ motion: "fly-across", from: "pet" }), rev), part: "beam" });
  interface Run {
    frames: Keyframe[];
    options: KeyframeAnimationOptions;
    currentTime: number;
    playState: "running" | "paused" | "finished";
    cancel: () => void;
    pause: () => void;
    play: () => void;
    finished: Promise<unknown>;
  }
  const runs: Run[] = [];
  /** The plays of the sprite (the ones with a finite count or a loop), not the shot's own path. */
  const plays = () => runs.filter((run) => run.options.easing?.startsWith("steps("));
  const sprite = () => plays().at(-1)!;
  beforeEach(() => {
    runs.length = 0;
    Object.defineProperty(HTMLElement.prototype, "animate", {
      configurable: true,
      writable: true,
      value: (frames: Keyframe[], options: KeyframeAnimationOptions): Run => {
        const run: Run = { frames, options, currentTime: 0, playState: "running", cancel: () => undefined, pause: () => undefined, play: () => undefined, finished: new Promise(() => undefined) };
        runs.push(run);
        return run;
      },
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(HTMLElement.prototype, "animate");
  });
  const frameX = (el: Element) => /translate3d\(([-\d.]+)px/.exec(el.querySelector("img")?.style.transform ?? "")?.[1];
  const tick = () => act(async () => vi.advanceTimersByTime(20));

  it("plays the frames once at its fps and holds the last frame", async () => {
    const { store } = storeWith([ONCEPET()]);
    await mount(store);
    await loadSheet(pets()[0]!, 192, 48);
    expect(plays()).toHaveLength(1);
    expect(sprite().options).toMatchObject({ iterations: 1, fill: "forwards", duration: 2000, easing: "steps(4, jump-none)" });
  });

  it("loops by default, and with loop = true", async () => {
    for (const extra of [{ loop: true }, {}]) {
      runs.length = 0;
      const { store } = storeWith([{ ...part("spark", STAY({ sprite: { ...SHEET, ...extra } })), part: "pet" }]);
      const view = await mount(store);
      await loadSheet(pets()[0]!, 192, 48);
      expect(sprite().options.iterations, JSON.stringify(extra)).toBe(Number.POSITIVE_INFINITY);
      view.unmount();
    }
  });

  it("plays again when the part is printed with a changed value, and not for a new asOf alone", async () => {
    const first = ONCEPET();
    const { store, replace } = storeWith([first]);
    await mount(store);
    await loadSheet(pets()[0]!, 192, 48);
    expect(plays()).toHaveLength(1);
    await act(async () => replace([{ ...first, rev: 2, asOf: new Date(Date.now() + 5000).toISOString() }], 2));
    expect(plays()).toHaveLength(1);
    await act(async () => replace([{ ...ONCEPET({ mood: "working" }), rev: 3 }], 3));
    expect(plays()).toHaveLength(2);
    expect(sprite().options.iterations).toBe(1);
  });

  it("shows the last frame as a still under reduced motion, and where nothing can animate", async () => {
    Reflect.deleteProperty(HTMLElement.prototype, "animate");
    for (const calm of [true, false]) {
      reduceMotion(calm);
      const { store } = storeWith([ONCEPET()]);
      const view = await mount(store);
      await loadSheet(pets()[0]!, 192, 48);
      // Four 48 px frames: the last starts 144 px along.
      expect(frameX(pets()[0]!), `reduced ${String(calm)}`).toBe("-144");
      view.unmount();
    }
    reduceMotion(true);
    const { store } = storeWith([{ ...part("spark", STAY({ sprite: SHEET })), part: "pet" }]);
    await mount(store);
    await loadSheet(pets()[0]!, 192, 48);
    expect(frameX(pets()[0]!)).toBe("0");
  });

  describe("and a shot that leaves the pet's hand", () => {
    const shotRuns = () => runs.filter((run) => run.options.easing === "linear");

    it("waits for the pet's last frame, then starts at once", async () => {
      vi.useFakeTimers();
      const { store, replace } = storeWith([ONCEPET()]);
      await mount(store);
      await loadSheet(pets()[0]!, 192, 48);
      // The throw: the pet is printed with a new value and the shot with it, in one run.
      await act(async () => replace([{ ...ONCEPET({ mood: "working" }), rev: 2 }, BEAM(2)], 2));
      expect(shots()).toHaveLength(1);
      await loadSheet(shots()[0]!, 32, 32);
      await tick();
      expect(shotRuns()).toHaveLength(0);
      expect(shots()[0]?.dataset.from).toBeUndefined();
      // The pet gets to its last frame, 1500 ms into the 2000 ms pass.
      sprite().currentTime = 1499;
      await tick();
      expect(shotRuns()).toHaveLength(0);
      sprite().currentTime = 1500;
      await tick();
      expect(shots()[0]?.dataset.from).toBe("pet");
      expect(shotRuns()).toHaveLength(1);
    });

    it("starts anyway 2 s after it arrived when the pet has not got there, and counts the rate from that start", async () => {
      vi.useFakeTimers();
      const { store, replace } = storeWith([ONCEPET()]);
      await mount(store);
      await loadSheet(pets()[0]!, 192, 48);
      await act(async () => replace([{ ...ONCEPET({ mood: "working" }), rev: 2 }, BEAM(2)], 2));
      await loadSheet(shots()[0]!, 32, 32);
      await act(async () => vi.advanceTimersByTime(1990));
      expect(shotRuns()).toHaveLength(0);
      await act(async () => vi.advanceTimersByTime(20));
      expect(shots()[0]?.dataset.from).toBe("pet");
      expect(shotRuns()).toHaveLength(1);
    });

    it("does not wait for a pet whose play is already over", async () => {
      vi.useFakeTimers();
      const { store, replace } = storeWith([ONCEPET()]);
      await mount(store);
      await loadSheet(pets()[0]!, 192, 48);
      sprite().currentTime = 2000;
      await tick();
      // The shot is printed alone: the pet is unchanged and holds its last frame.
      await act(async () => replace([ONCEPET(), BEAM(2)], 2));
      expect(shots()[0]?.dataset.from).toBe("pet");
    });

    it("does not delay a shot for a pet that loops", async () => {
      vi.useFakeTimers();
      const looping = (extra: JsonObject = {}): WireTrickPart => ({ ...part("spark", STAY({ sprite: SHEET, ...extra })), part: "pet" });
      const { store, replace } = storeWith([looping()]);
      await mount(store);
      await loadSheet(pets()[0]!, 192, 48);
      await act(async () => replace([{ ...looping({ mood: "working" }), rev: 2 }, BEAM(2)], 2));
      expect(shots()[0]?.dataset.from).toBe("pet");
    });
  });
  describe("and a tap that opens the Page, then Back", () => {
    const AFTER = { src: "media/pose.png", frames: 3, fps: 4, loop: false };
    const OPENS = (extra: JsonObject = {}): WireTrickPart => ONCEPET({ opens: "page", ...extra }, { after: AFTER });
    const shotRuns = () => runs.filter((run) => run.options.easing === "linear");
    const afterEl = () => pets()[0]!.querySelector<HTMLElement>('[data-slot="float-after"]')!;
    const firstEl = () => pets()[0]!.querySelector<HTMLElement>('[data-slot="float-first"]')!;
    let go: (path: string) => void = () => undefined;
    function Grab() {
      const navigate = useNavigate();
      go = (path) => void navigate(path);
      return null;
    }
    async function mountWithNav(store: TricksStore) {
      render(
        <MemoryRouter initialEntries={["/"]}>
          <Grab />
          <TrickFloatLayer trickSessions={[{ ...PAGE, paneId: "trick:lodge:spark:pet", tabId: "trick:lodge:spark" }]} store={store} />
        </MemoryRouter>,
      );
      await act(async () => {
        await store.syncTricks(1);
      });
    }
    /** Both sheets of the pet that is on screen now. */
    const loadBoth = async () => {
      await loadSheet(pets()[0]!, 192, 48);
      const img = afterEl().querySelector("img");
      Object.defineProperty(img, "naturalWidth", { configurable: true, value: 288 });
      Object.defineProperty(img, "naturalHeight", { configurable: true, value: 48 });
      await act(async () => {
        fireEvent.load(img!);
      });
    };
    const away = async (ms: number) => {
      // The tap, which opens the trick's Page (the route changes), and the time it stays open.
      fireEvent.click(document.querySelector('[data-slot="float-open"]')!);
      expect(nav.down).toHaveBeenCalledTimes(1);
      await act(async () => go("/trick/page"));
      expect(pets()).toEqual([]);
      await act(async () => vi.advanceTimersByTime(ms));
      await act(async () => go("/"));
      expect(pets()).toHaveLength(1);
    };
    /** The throw begins with a shot behind it, half a second in the pet has played 500 ms. */
    async function throwing() {
      vi.useFakeTimers();
      const { store, replace } = storeWith([OPENS()]);
      await mountWithNav(store);
      await loadBoth();
      await act(async () => replace([{ ...OPENS({ mood: "working" }), rev: 2 }, BEAM(2)], 2));
      await loadSheet(shots()[0]!, 32, 32);
      await tick();
      await act(async () => vi.advanceTimersByTime(500));
      sprite().currentTime = 500;
      expect(shotRuns()).toHaveLength(0);
      return { store, replace };
    }

    it("does not change the play: the tap itself restarts nothing", async () => {
      await throwing();
      const before = runs.length;
      const pet = pets()[0];
      fireEvent.click(document.querySelector('[data-slot="float-open"]')!);
      expect(runs).toHaveLength(before);
      expect(pets()[0]).toBe(pet);
      expect(shots()).toHaveLength(1);
    });

    it("takes the throw up where it stopped, fires the shot from the hand when the throw ends, and plays the after strip", async () => {
      await throwing();
      await away(5000);
      await loadBoth();
      await tick();
      // The throw carries on from 500 ms, not from its first frame, and the shot that waited for it is back, still waiting.
      expect(sprite().currentTime).toBeGreaterThanOrEqual(500);
      expect(sprite().currentTime).toBeLessThan(600);
      expect(shots()).toHaveLength(1);
      await loadSheet(shots()[0]!, 32, 32);
      expect(shotRuns()).toHaveLength(0);
      expect(afterEl().style.visibility).toBe("hidden");
      // The throw ends: the shot leaves the hand, and the after strip plays from its first frame.
      sprite().currentTime = 1500;
      await tick();
      expect(shots()[0]?.dataset.from).toBe("pet");
      expect(shotRuns()).toHaveLength(1);
      expect(afterEl().style.visibility).toBe("visible");
      expect(firstEl().style.visibility).toBe("hidden");
      expect(plays().at(-1)?.options).toMatchObject({ duration: 750, easing: "steps(3, jump-none)" });
      expect(plays().at(-1)?.currentTime).toBe(0);
    });

    it("keeps a shot that was on its way, and sends it again from the hand", async () => {
      vi.useFakeTimers();
      const { store, replace } = storeWith([OPENS()]);
      await mountWithNav(store);
      await loadBoth();
      await act(async () => replace([OPENS(), BEAM(2)], 2));
      await loadSheet(shots()[0]!, 32, 32);
      await tick();
      // The throw is over, the shot is on its way.
      await act(async () => vi.advanceTimersByTime(1500));
      sprite().currentTime = 1500;
      await tick();
      expect(shotRuns()).toHaveLength(1);
      await away(3000);
      await loadBoth();
      await loadSheet(shots()[0]!, 32, 32);
      await tick();
      expect(shotRuns()).toHaveLength(2);
      expect(shots()[0]?.dataset.from).toBe("pet");
    });

    it("shows the end state and drops the shot when the layer was away longer than the cap", async () => {
      await throwing();
      await away(FLOAT_AWAY_CAP_MS + 10_000);
      await loadBoth();
      await tick();
      expect(shots()).toEqual([]);
      expect(shotRuns()).toHaveLength(0);
      // The first strip is at its end and the second shows, at its last frame.
      expect(afterEl().style.visibility).toBe("visible");
      expect(firstEl().style.visibility).toBe("hidden");
      expect(plays().at(-1)?.currentTime).toBe(750);
    });

    it("does not play a throw that was over again, and holds the after strip's last frame", async () => {
      vi.useFakeTimers();
      const { store } = storeWith([OPENS()]);
      await mountWithNav(store);
      await loadBoth();
      await act(async () => vi.advanceTimersByTime(2500));
      sprite().currentTime = 1500;
      await tick();
      await act(async () => vi.advanceTimersByTime(1000));
      await away(2000);
      await loadBoth();
      await tick();
      expect(afterEl().style.visibility).toBe("visible");
      expect(plays().map((run) => run.currentTime).at(-1)).toBe(750);
    });

    it("plays again from the first frame when the part's value changed while it was away", async () => {
      const { replace } = await throwing();
      await away(1000);
      await loadBoth();
      await act(async () => replace([{ ...OPENS({ mood: "waiting" }), rev: 3 }], 3));
      await tick();
      expect(sprite().currentTime).toBe(0);
      expect(afterEl().style.visibility).toBe("hidden");
    });

    it("stops a shot's wait while the page is hidden", async () => {
      vi.useFakeTimers();
      const { store, replace } = storeWith([OPENS()]);
      await mountWithNav(store);
      await loadBoth();
      await act(async () => replace([{ ...OPENS({ mood: "working" }), rev: 2 }, BEAM(2)], 2));
      await loadSheet(shots()[0]!, 32, 32);
      await act(async () => vi.advanceTimersByTime(1000));
      const hide = async (state: "hidden" | "visible") => {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
        await act(async () => {
          document.dispatchEvent(new Event("visibilitychange"));
        });
      };
      await hide("hidden");
      await act(async () => vi.advanceTimersByTime(10_000));
      expect(shotRuns()).toHaveLength(0);
      await hide("visible");
      await act(async () => vi.advanceTimersByTime(900));
      expect(shotRuns()).toHaveLength(0);
      await act(async () => vi.advanceTimersByTime(200));
      expect(shotRuns()).toHaveLength(1);
      Reflect.deleteProperty(document, "visibilityState");
    });
  });

  describe("and a second sprite after it (after)", () => {
    const AFTER = { src: "media/pose.png", frames: 3, fps: 4 };
    const WITH_AFTER = (after: JsonObject = AFTER, extra: JsonObject = {}): WireTrickPart => ONCEPET(extra, { after });
    /** The second sprite's own sheet: three 96 px frames, as high as the first (48 px), so twice as wide. */
    const loadBoth = async () => {
      await loadSheet(pets()[0]!, 192, 48);
      const img = pets()[0]!.querySelector('[data-slot="float-after"] img');
      Object.defineProperty(img, "naturalWidth", { configurable: true, value: 288 });
      Object.defineProperty(img, "naturalHeight", { configurable: true, value: 48 });
      await act(async () => {
        fireEvent.load(img!);
      });
    };
    const afterEl = () => pets()[0]!.querySelector<HTMLElement>('[data-slot="float-after"]')!;
    const firstEl = () => pets()[0]!.querySelector<HTMLElement>('[data-slot="float-first"]')!;
    const x = (el: HTMLElement) => /translate3d\(([-\d.]+)px/.exec(el.style.transform)?.[1];
    /** The place the first keyframe of a shot's path names. */
    const startX = (run: Run) => /translate3d\(([-\d.]+)px/.exec(String(run.frames[0]?.["transform"]))?.[1];
    const afterX = () => /translate3d\(([-\d.]+)px/.exec(afterEl().querySelector("img")?.style.transform ?? "")?.[1];
    const reachLast = async () => {
      sprite().currentTime = 1500;
      await tick();
    };

    it("starts the second sprite from its first frame when the first reaches its last, and not before", async () => {
      vi.useFakeTimers();
      const { store } = storeWith([WITH_AFTER()]);
      await mount(store);
      await loadBoth();
      await tick();
      // Only the first strip plays; the second waits, loaded and hidden.
      expect(plays()).toHaveLength(1);
      expect(afterEl().style.visibility).toBe("hidden");
      expect(firstEl().style.visibility).toBe("visible");
      sprite().currentTime = 1499;
      await tick();
      expect(plays()).toHaveLength(1);
      await reachLast();
      expect(plays()).toHaveLength(2);
      expect(sprite().options).toMatchObject({ duration: 750, easing: "steps(3, jump-none)" });
      expect(afterEl().style.visibility).toBe("visible");
      expect(firstEl().style.visibility).toBe("hidden");
      expect(afterX()).toBe("0");
    });

    it("takes the wider box at once, with no glide, and keeps the anchor (the right side, for a perch that stands at its end)", async () => {
      vi.useFakeTimers();
      const { store } = storeWith([WITH_AFTER()]);
      await mount(store);
      await loadBoth();
      await tick();
      const pet = pets()[0]!;
      // 48 px frames in a 390 px wide area, 8 px from the right corner.
      expect(pet.style.width).toBe("48px");
      expect(x(pet)).toBe("334");
      expect(pet.style.transition).toContain("transform");
      await reachLast();
      expect(pet.style.width).toBe("96px");
      expect(pet.style.height).toBe("48px");
      expect(x(pet)).toBe("286");
      // The render that moved it carries no transition, so the move is one step and not a 300 ms slide.
      expect(pet.style.transition).toBe("");
      await tick();
      await tick();
      expect(pet.style.transition).toContain("transform");
    });

    it("keeps the left side for a perch that stands at its start", async () => {
      vi.useFakeTimers();
      const { store } = storeWith([WITH_AFTER(AFTER, { along: "start" })]);
      await mount(store);
      await loadBoth();
      await tick();
      expect(x(pets()[0]!)).toBe("8");
      await reachLast();
      expect(pets()[0]!.style.width).toBe("96px");
      expect(x(pets()[0]!)).toBe("8");
    });

    it("holds the second sprite's last frame with loop = false, and loops it otherwise", async () => {
      for (const [after, iterations, fill] of [
        [{ ...AFTER, loop: false }, 1, "forwards"],
        [AFTER, Number.POSITIVE_INFINITY, "none"],
        [{ ...AFTER, loop: true }, Number.POSITIVE_INFINITY, "none"],
      ] as const) {
        vi.useFakeTimers();
        runs.length = 0;
        const { store } = storeWith([WITH_AFTER(after)]);
        const view = await mount(store);
        await loadBoth();
        await tick();
        await reachLast();
        expect(sprite().options, JSON.stringify(after)).toMatchObject({ iterations, fill });
        view.unmount();
        vi.useRealTimers();
      }
    });

    it("does not switch before the second sheet is there: the first sprite stays on its last frame", async () => {
      vi.useFakeTimers();
      const { store } = storeWith([WITH_AFTER()]);
      await mount(store);
      await loadSheet(pets()[0]!, 192, 48);
      await tick();
      await reachLast();
      expect(plays()).toHaveLength(1);
      expect(pets()[0]!.style.width).toBe("48px");
      expect(firstEl().style.visibility).toBe("visible");
    });

    it("plays both again from the first sprite for a changed value, and restarts nothing for an unchanged re-print", async () => {
      vi.useFakeTimers();
      const first = WITH_AFTER();
      const { store, replace } = storeWith([first]);
      await mount(store);
      await loadBoth();
      await tick();
      await reachLast();
      expect(plays()).toHaveLength(2);
      expect(pets()[0]!.style.width).toBe("96px");
      await act(async () => replace([{ ...first, rev: 2, asOf: new Date(Date.now() + 5000).toISOString() }], 2));
      await tick();
      expect(plays()).toHaveLength(2);
      expect(pets()[0]!.style.width).toBe("96px");
      expect(afterEl().style.visibility).toBe("visible");
      await act(async () => replace([{ ...WITH_AFTER(AFTER, { mood: "working" }), rev: 3 }], 3));
      // Back to the first strip, at its first frame, at once.
      expect(pets()[0]!.style.width).toBe("48px");
      expect(firstEl().style.visibility).toBe("visible");
      expect(afterEl().style.visibility).toBe("hidden");
      await tick();
      expect(plays()).toHaveLength(3);
      expect(sprite().options).toMatchObject({ duration: 2000, easing: "steps(4, jump-none)" });
      await reachLast();
      expect(plays()).toHaveLength(4);
      expect(pets()[0]!.style.width).toBe("96px");
    });

    it("sends a shot after the first strip only, from the first strip's box, whichever sprite shows", async () => {
      vi.useFakeTimers();
      const { store, replace } = storeWith([WITH_AFTER()]);
      await mount(store);
      await loadBoth();
      await tick();
      const shotRuns = () => runs.filter((run) => run.options.easing === "linear");
      await act(async () => replace([{ ...WITH_AFTER(AFTER, { mood: "working" }), rev: 2 }, BEAM(2)], 2));
      await loadSheet(shots()[0]!, 32, 32);
      await tick();
      expect(shotRuns()).toHaveLength(0);
      sprite().currentTime = 1499;
      await tick();
      expect(shotRuns()).toHaveLength(0);
      // The throw ends: the shot leaves at once, and does not wait for the second sprite.
      await reachLast();
      expect(shots()[0]?.dataset.from).toBe("pet");
      expect(shotRuns()).toHaveLength(1);
      expect(pets()[0]!.style.width).toBe("96px");
      // The pet stands on the right half, so the hand is its LEFT edge: the first box's (334), not the wider second box's (286).
      // The shot's centre is on that point: 334 minus half of its 32 px.
      expect(startX(shotRuns()[0]!)).toBe("318");
    });

    it("starts a shot that arrives while the second sprite plays at once, from the first strip's box", async () => {
      vi.useFakeTimers();
      const { store, replace } = storeWith([WITH_AFTER()]);
      await mount(store);
      await loadBoth();
      await tick();
      await reachLast();
      await act(async () => replace([WITH_AFTER(), BEAM(2)], 2));
      expect(shots()[0]?.dataset.from).toBe("pet");
      await loadSheet(shots()[0]!, 32, 32);
      await tick();
      expect(startX(runs.find((run) => run.options.easing === "linear")!)).toBe("318");
    });

    it("shows the second sprite's last frame as a still under reduced motion, and where nothing can animate", async () => {
      Reflect.deleteProperty(HTMLElement.prototype, "animate");
      for (const calm of [true, false]) {
        reduceMotion(calm);
        const { store } = storeWith([WITH_AFTER()]);
        const view = await mount(store);
        await loadBoth();
        // Three 96 px frames: the last starts 192 px along.
        expect(afterEl().style.visibility, `reduced ${String(calm)}`).toBe("visible");
        expect(afterX(), `reduced ${String(calm)}`).toBe("-192");
        expect(pets()[0]!.style.width).toBe("96px");
        expect(plays()).toHaveLength(0);
        view.unmount();
      }
    });
  });
});
