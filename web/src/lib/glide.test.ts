import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ARRIVE_TIMEOUT_MS,
  GLIDE_BACK_CLASS,
  GLIDE_CLASS,
  GLIDE_CROSSFADE_CLASS,
  GLIDE_PAIRS,
  glideBack,
  glideForward,
  glideInFlight,
  glideOwnsMove,
  noteGlideLocation,
} from "./glide";

const KEY = "/space/w1/changes";
const root = document.documentElement;

/** A dashboard Changes tab row, as workspace-changes-list.tsx draws it. */
function row(key = KEY): HTMLElement {
  const button = document.createElement("button");
  button.dataset.glideOrigin = "changes";
  button.dataset.glideKey = key;
  button.innerHTML = '<span data-glide="label">webapp</span><span data-glide="count">5 files</span>';
  document.body.append(button);
  return button;
}

/** The Changes list screen's header text column, as routes/changes.tsx draws it. */
function header(): HTMLElement {
  const div = document.createElement("div");
  div.dataset.glideDestination = "changes";
  div.innerHTML = '<h1 data-glide="label">webapp</h1><span data-glide="count">5 files</span>';
  document.body.append(div);
  return div;
}

const nameOf = (container: HTMLElement, part: string) =>
  container.querySelector<HTMLElement>(`[data-glide="${part}"]`)!.style.viewTransitionName;

/** Put a rect on an element, as layout would in a browser (jsdom has none). */
function place(el: HTMLElement, top: number, height = 52) {
  el.getBoundingClientRect = () => ({ top, bottom: top + height, left: 0, right: 375, width: 375, height, x: 0, y: top, toJSON: () => ({}) });
}

interface FakeTransition {
  update: () => Promise<void>;
  finish: () => void;
  skipped: boolean;
}

/** Give the document a `startViewTransition` of the test's own; returns the transitions it made. */
function installStart(): FakeTransition[] {
  const made: FakeTransition[] = [];
  const start = vi.fn((update: () => Promise<void>) => {
    let finish = () => {};
    const finished = new Promise<void>((r) => (finish = r));
    const t: FakeTransition = { update, finish, skipped: false };
    made.push(t);
    return {
      ready: Promise.resolve(),
      finished,
      updateCallbackDone: Promise.resolve(),
      skipTransition: () => {
        t.skipped = true;
        finish();
      },
    };
  });
  Object.defineProperty(document, "startViewTransition", { configurable: true, writable: true, value: start });
  return made;
}

/** Let a finished transition's cleanup run. */
async function settle() {
  for (let i = 0; i < 3; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.stubGlobal("innerHeight", 812);
  vi.stubGlobal("innerWidth", 375);
});

afterEach(async () => {
  // Nothing may leak into the next case: land or supersede whatever is still in flight.
  noteGlideLocation("/nowhere");
  await settle();
  Reflect.deleteProperty(document, "startViewTransition");
  document.body.innerHTML = "";
  root.className = "";
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the pair registry", () => {
  it("matches the Changes pair's two screens and nothing near them", () => {
    const { origin, destination } = GLIDE_PAIRS.changes;
    expect(origin("/")).toBe(true);
    expect(origin("/settings")).toBe(false);
    expect(destination("/space/w1/changes")).toBe(true);
    expect(destination("/space/w1%3Ax/changes")).toBe(true);
    expect(destination("/space/w1")).toBe(false);
    expect(destination("/space/w1/changes/commit")).toBe(false);
    expect(destination("/pane/w1%3Ap1/changes")).toBe(false);
  });
});

describe("when there is no glide", () => {
  it("just navigates where the browser has no view transitions", () => {
    const go = vi.fn();
    glideForward("changes", KEY, go, row());
    glideBack("changes", KEY, go);
    expect(go).toHaveBeenCalledTimes(2);
    expect(root.classList.contains(GLIDE_CLASS)).toBe(false);
    expect(glideInFlight()).toBe(false);
  });

  it("just navigates under reduced motion, even where the API exists, both ways", () => {
    const made = installStart();
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce") }));
    const go = vi.fn();
    glideForward("changes", KEY, go, row());
    glideBack("changes", KEY, go);
    expect(go).toHaveBeenCalledTimes(2);
    expect(made).toHaveLength(0);
    expect(glideOwnsMove("/")).toBe(false);
  });
});

describe("glideForward", () => {
  it("names the row's parts, navigates inside the transition, hands the names to the header, and cleans up", async () => {
    const made = installStart();
    const el = row();
    let dest: HTMLElement | null = null;
    const go = vi.fn(() => {
      dest = header();
    });
    glideForward("changes", KEY, go, el);
    expect(root.classList.contains(GLIDE_CLASS)).toBe(true);
    expect(root.classList.contains("glide-changes")).toBe(true);
    expect(root.classList.contains(GLIDE_BACK_CLASS)).toBe(false);
    expect(nameOf(el, "label")).toBe("glide-changes-label");
    expect(nameOf(el, "count")).toBe("glide-changes-count");
    expect(go).not.toHaveBeenCalled();

    await made[0]!.update();
    expect(go).toHaveBeenCalledTimes(1);
    // One element per name: the row gave its names up once the "before" picture was taken.
    expect(nameOf(el, "label")).toBe("");
    expect(nameOf(dest!, "label")).toBe("glide-changes-label");
    expect(nameOf(dest!, "count")).toBe("glide-changes-count");

    made[0]!.finish();
    await settle();
    expect(root.className).toBe("");
    expect(nameOf(dest!, "label")).toBe("");
    expect(glideInFlight()).toBe(false);
  });

  it("finds the row by its key when no element is handed in", () => {
    installStart();
    row("/space/other/changes");
    const el = row();
    glideForward("changes", KEY, () => {});
    expect(nameOf(el, "label")).toBe("glide-changes-label");
  });

  it("owns the move onto its destination until it lands there, and no other move", async () => {
    const made = installStart();
    glideForward("changes", KEY, () => header(), row());
    expect(glideOwnsMove("/space/w1/changes")).toBe(true);
    expect(glideOwnsMove("/settings")).toBe(false);
    await made[0]!.update();
    noteGlideLocation("/space/w1/changes");
    expect(glideOwnsMove("/space/w1/changes")).toBe(false);
    // Landing is not a new navigation: the transition runs on.
    expect(made[0]!.skipped).toBe(false);
  });

  it("gives up waiting for the header after ARRIVE_TIMEOUT_MS and goes without it", async () => {
    vi.useFakeTimers();
    const made = installStart();
    glideForward("changes", KEY, () => {}, row());
    const done = made[0]!.update();
    await vi.advanceTimersByTimeAsync(ARRIVE_TIMEOUT_MS);
    await done;
    expect(root.classList.contains(GLIDE_CROSSFADE_CLASS)).toBe(true);
  });
});

describe("glideBack", () => {
  it("names the header's parts, and lands them on the keyed row when it is on screen", async () => {
    const made = installStart();
    const dest = header();
    let origin: HTMLElement | null = null;
    const go = vi.fn(() => {
      dest.remove();
      row("/space/other/changes");
      origin = row();
      place(origin, 200);
    });
    glideBack("changes", KEY, go);
    expect(root.classList.contains(GLIDE_BACK_CLASS)).toBe(true);
    expect(nameOf(dest, "label")).toBe("glide-changes-label");
    expect(glideOwnsMove("/")).toBe(true);

    await made[0]!.update();
    expect(go).toHaveBeenCalledTimes(1);
    expect(nameOf(origin!, "label")).toBe("glide-changes-label");
    expect(nameOf(origin!, "count")).toBe("glide-changes-count");
    expect(root.classList.contains(GLIDE_CROSSFADE_CLASS)).toBe(false);
  });

  it("crossfades without names when the row is off screen after scroll memory put the scroller back", async () => {
    const made = installStart();
    header();
    let origin: HTMLElement | null = null;
    glideBack("changes", KEY, () => {
      const scroller = document.createElement("div");
      scroller.style.overflowY = "auto";
      place(scroller, 60, 700);
      origin = row();
      scroller.append(origin);
      document.body.append(scroller);
      // Inside the viewport, but below the scroller's clip.
      place(origin, 770);
    });
    await made[0]!.update();
    expect(nameOf(origin!, "label")).toBe("");
    expect(root.classList.contains(GLIDE_CROSSFADE_CLASS)).toBe(true);
  });

  it("crossfades without names when the keyed row is not in the arrived screen", async () => {
    const made = installStart();
    header();
    let other: HTMLElement | null = null;
    glideBack("changes", KEY, () => {
      other = row("/space/other/changes");
      place(other, 200);
    });
    await made[0]!.update();
    expect(nameOf(other!, "label")).toBe("");
    expect(root.classList.contains(GLIDE_CROSSFADE_CLASS)).toBe(true);
  });
});

describe("one glide at a time", () => {
  it("skips the glide in flight, not queues it, when a second one starts", async () => {
    const made = installStart();
    glideForward("changes", KEY, () => header(), row());
    const second = vi.fn();
    glideForward("changes", "/space/w2/changes", second, row("/space/w2/changes"));
    expect(made).toHaveLength(1);
    expect(made[0]!.skipped).toBe(true);
    expect(second).toHaveBeenCalledTimes(1);
    await settle();
    expect(root.className).toBe("");
  });

  it("skips the glide in flight when a navigation other than its own lands", async () => {
    const made = installStart();
    glideBack("changes", KEY, () => {});
    noteGlideLocation("/settings");
    expect(made[0]!.skipped).toBe(true);
    expect(glideOwnsMove("/")).toBe(false);
    await settle();
    expect(glideInFlight()).toBe(false);
  });

  it("does not run its own move when superseded before the transition called back", async () => {
    const made = installStart();
    const go = vi.fn();
    glideBack("changes", KEY, go);
    noteGlideLocation("/settings");
    await made[0]!.update();
    expect(go).not.toHaveBeenCalled();
  });

  it("an unmarked POP meets no glide: without a call, nothing is in flight to own it", () => {
    installStart();
    noteGlideLocation("/");
    expect(glideOwnsMove("/")).toBe(false);
    expect(glideInFlight()).toBe(false);
  });
});
