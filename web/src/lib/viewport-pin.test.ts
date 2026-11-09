import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { pinTarget, startViewportPin } from "./viewport-pin";

// The owner's report (2026-11-07): back from a long break, the installed Android PWA drew the Chat view
// about one composer box too tall with the keyboard down, and only a hard refresh brought the box
// back. jsdom has no layout, so these cases drive the two heights by hand and read the token the
// column's `h-(--app-h)` resolves to. A device is the only true repro of the stale viewport itself.

class FakeVisualViewport extends EventTarget {
  height: number;
  width = 412;
  scale = 1;
  constructor(height: number) {
    super();
    this.height = height;
  }
}

let vv: FakeVisualViewport;
let visibility: DocumentVisibilityState = "visible";
let stop: (() => void) | null = null;
let info: ReturnType<typeof vi.spyOn>;

/** What the app column's `h-(--app-h)` resolves to: the inline pin, else index.css's Android value. */
function columnHeight(): string {
  return document.documentElement.style.getPropertyValue("--app-h") || "100dvh";
}

function setHeights(inner: number, visual: number) {
  Object.defineProperty(window, "innerHeight", { configurable: true, value: inner });
  vv.height = visual;
}

function returnToForeground() {
  visibility = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vv = new FakeVisualViewport(840);
  visibility = "visible";
  Object.defineProperty(window, "visualViewport", { configurable: true, value: vv });
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  setHeights(840, 840);
  info = vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  stop?.();
  stop = null;
  document.documentElement.style.removeProperty("--app-h");
  info.mockRestore();
});

describe("the column after a return from the background", () => {
  it("stays at the stale CSS height with nothing watching (the reported bug)", () => {
    // The layout kept 900px, the glass shows 840px: the column is 60px too tall and the composer
    // paints past the bottom edge. Nothing re-lays it until a resize fires.
    setHeights(900, 840);
    returnToForeground();
    expect(columnHeight()).toBe("100dvh");
  });

  it("is pinned to the visible height when the two disagree", () => {
    stop = startViewportPin();
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    setHeights(900, 840);
    returnToForeground();
    expect(columnHeight()).toBe("840px");
  });

  it("is left alone when the two agree", () => {
    stop = startViewportPin();
    returnToForeground();
    expect(columnHeight()).toBe("100dvh");
    expect(info).not.toHaveBeenCalled();
  });

  it("does nothing on a change to hidden", () => {
    stop = startViewportPin();
    setHeights(900, 840);
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(columnHeight()).toBe("100dvh");
  });

  it.each(["pageshow", "focus"])("also checks on %s", (type) => {
    stop = startViewportPin();
    setHeights(900, 840);
    window.dispatchEvent(new Event(type));
    expect(columnHeight()).toBe("840px");
  });

  it("releases to the CSS value on the next real resize", () => {
    stop = startViewportPin();
    setHeights(900, 840);
    returnToForeground();
    expect(columnHeight()).toBe("840px");
    setHeights(840, 840);
    window.dispatchEvent(new Event("resize"));
    expect(columnHeight()).toBe("100dvh");
  });

  it("checks once more on the next visual-viewport resize, and only once", () => {
    stop = startViewportPin();
    returnToForeground();
    expect(columnHeight()).toBe("100dvh");
    // The stale reading arrives a moment after the page is shown.
    setHeights(900, 840);
    vv.dispatchEvent(new Event("resize"));
    expect(columnHeight()).toBe("840px");
    window.dispatchEvent(new Event("resize"));
    expect(columnHeight()).toBe("100dvh");
    // The one-shot check is spent: a later visual resize does not pin again.
    vv.dispatchEvent(new Event("resize"));
    expect(columnHeight()).toBe("100dvh");
  });

  it("logs one line with the four heights on each pin", () => {
    Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
    stop = startViewportPin();
    setHeights(900, 840);
    returnToForeground();
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toMatch(/^collie: viewport re-pinned inner=900 visual=840 client=\d+ scrollY=0$/);
    // The same disagreement again is not a new pin, so not a new line.
    returnToForeground();
    expect(info).toHaveBeenCalledTimes(1);
  });

  it("removes the pin and its listeners when stopped", () => {
    stop = startViewportPin();
    setHeights(900, 840);
    returnToForeground();
    stop();
    stop = null;
    expect(columnHeight()).toBe("100dvh");
    returnToForeground();
    expect(columnHeight()).toBe("100dvh");
  });
});

describe("pinTarget", () => {
  const base = { innerHeight: 840, visualHeight: 840, scale: 1, appHeight: null };

  it("pins when the layout height is off by more than the slack", () => {
    expect(pinTarget({ ...base, innerHeight: 900 })).toBe(840);
    expect(pinTarget({ ...base, innerHeight: 844 })).toBeNull();
  });

  it("pins when the laid-out --app-h is off even though innerHeight agrees", () => {
    expect(pinTarget({ ...base, appHeight: 900 })).toBe(840);
    expect(pinTarget({ ...base, appHeight: 841 })).toBeNull();
  });

  it("rounds to whole pixels", () => {
    expect(pinTarget({ ...base, innerHeight: 900, visualHeight: 839.6 })).toBe(840);
  });

  it("never pins while pinch-zoomed or with no visual height", () => {
    expect(pinTarget({ ...base, innerHeight: 900, scale: 1.5 })).toBeNull();
    expect(pinTarget({ ...base, innerHeight: 900, visualHeight: 0 })).toBeNull();
  });
});
