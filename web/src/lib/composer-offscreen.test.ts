import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { postComposerDiag } from "@/lib/api";
import { server } from "@/test/setup";

import {
  buildComposerRecord,
  composerOffscreen,
  DELAYED_CHECKS_MS,
  MAX_PER_PAGE,
  MIN_GAP_MS,
  OFFSCREEN_SLACK_PX,
  resetComposerOffscreenBudget,
  setForegroundAtForTest,
  startComposerOffscreenWatch,
  type ComposerDiagRecord,
  type OffscreenViewState,
  type RecordInput,
} from "./composer-offscreen";
import { startViewportPin } from "./viewport-pin";

// The owner's report: an installed Android app, opened after a break, draws the reply box below the screen.
// jsdom has no layout, so these cases hand the watch the two numbers that matter (the composer's rect and
// the visual viewport) and read what it would send. A device is the only true repro of the stale viewport.

const INSIDE = { top: 760, bottom: 820 };

describe("is the composer off screen (pure)", () => {
  const base = { zen: false, composer: INSIDE, visualBottom: 840, scale: 1 };

  it("is not, when the box sits inside the visible screen", () => {
    expect(composerOffscreen(base)).toBe(false);
  });

  it("is not, within the 8 px tolerance, and is, one pixel past it", () => {
    expect(composerOffscreen({ ...base, composer: { top: 760, bottom: 840 + OFFSCREEN_SLACK_PX } })).toBe(false);
    expect(composerOffscreen({ ...base, composer: { top: 760, bottom: 840 + OFFSCREEN_SLACK_PX + 1 } })).toBe(true);
  });

  it("is, when the box hangs below the screen", () => {
    expect(composerOffscreen({ ...base, composer: { top: 800, bottom: 880 } })).toBe(true);
  });

  it("is, when the top is at or below the bottom edge", () => {
    expect(composerOffscreen({ ...base, composer: { top: 840, bottom: 840 } })).toBe(true);
    expect(composerOffscreen({ ...base, composer: { top: 900, bottom: 960 } })).toBe(true);
  });

  it("is not in zen, even when the box is far below", () => {
    expect(composerOffscreen({ ...base, zen: true, composer: { top: 900, bottom: 960 } })).toBe(false);
  });

  it("is not when there is no composer", () => {
    expect(composerOffscreen({ ...base, composer: null })).toBe(false);
  });

  it("is not while pinch-zoomed, where the visual viewport is small on purpose", () => {
    expect(composerOffscreen({ ...base, scale: 2, composer: { top: 900, bottom: 960 } })).toBe(false);
  });

  it("is not when the visual viewport reads nothing", () => {
    expect(composerOffscreen({ ...base, visualBottom: 0 })).toBe(false);
  });
});

const INPUT: RecordInput = {
  innerHeight: 900.4,
  visualHeight: 839.6,
  visualOffsetTop: 0,
  visualScale: 1,
  screenHeight: 915,
  clientHeight: 900,
  scrollTop: 12.5,
  composerTop: 840.5,
  composerBottom: 920.49,
  scrollerHeight: 900,
  scrollerTop: 0,
  msSinceForeground: 1234.7,
  standalone: true,
  pinRecent: false,
  keyboardOpen: false,
  trigger: "foreground",
  pinAction: "none",
  paneKind: "agent",
};

describe("the record", () => {
  it("holds exactly the allowed keys", () => {
    expect(Object.keys(buildComposerRecord(INPUT)).toSorted()).toEqual(
      [
        "clientHeight", "composerBottom", "composerTop", "innerHeight", "keyboardOpen", "msSinceForeground",
        "paneKind", "pinAction", "pinRecent", "screenHeight", "scrollTop", "scrollerHeight", "scrollerTop",
        "standalone", "trigger", "visualHeight", "visualOffsetTop", "visualScalePct",
      ].toSorted(),
    );
  });

  it("holds only whole numbers, booleans and short enum words, never text", () => {
    const record = buildComposerRecord(INPUT);
    const words = new Set(["foreground", "pageshow", "resize", "delayed", "none", "pinned", "released", "agent", "shell", "screenless"]);
    for (const [key, value] of Object.entries(record)) {
      const allowed = Number.isInteger(value) || value === true || value === false || words.has(String(value));
      expect({ key, allowed }).toEqual({ key, allowed: true });
    }
    expect(record.innerHeight).toBe(900);
    expect(record.visualHeight).toBe(840);
    expect(record.composerBottom).toBe(920);
    expect(record.msSinceForeground).toBe(1235);
    expect(record.visualScalePct).toBe(100);
  });

  it("ignores a field that is not part of the record, so nothing reaches the wire by accident", () => {
    // SAFETY: a deliberately wider object, to prove the builder copies named fields and nothing else.
    const withExtra = { ...INPUT, paneId: "w1:p1", text: "hello" } as RecordInput;
    expect(Object.keys(buildComposerRecord(withExtra))).not.toContain("paneId");
    expect(JSON.stringify(buildComposerRecord(withExtra))).not.toContain("hello");
  });

  it("clamps a stray reading into the range the bridge accepts", () => {
    const record = buildComposerRecord({ ...INPUT, innerHeight: Number.NaN, screenHeight: 1e9, msSinceForeground: -5, composerTop: -1e9 });
    expect(record.innerHeight).toBe(0);
    expect(record.screenHeight).toBe(20_000);
    expect(record.msSinceForeground).toBe(0);
    expect(record.composerTop).toBe(-1_000_000);
  });
});

// ── The watch ─────────────────────────────────────────────────────────────────────────────────────

class FakeVisualViewport extends EventTarget {
  height = 840;
  offsetTop = 0;
  width = 412;
  scale = 1;
}

let vv: FakeVisualViewport;
let visibility: DocumentVisibilityState;
interface Edges {
  top: number;
  bottom: number;
}
let rect: Edges;
let composer: HTMLElement | null;
let state: OffscreenViewState;
let sent: ComposerDiagRecord[];
let stops: (() => void)[];

function mountComposer(): HTMLElement {
  const bottom = document.createElement("div");
  bottom.dataset.slot = "pane-bottom";
  const chrome = document.createElement("div");
  chrome.dataset.slot = "chrome-block";
  chrome.getBoundingClientRect = () => ({ ...rect, left: 0, right: 412, width: 412, height: rect.bottom - rect.top, x: 0, y: rect.top, toJSON: () => ({}) });
  bottom.appendChild(chrome);
  document.body.appendChild(bottom);
  return bottom;
}

function watch(): () => void {
  const stop = startComposerOffscreenWatch({ getState: () => state, send: (r) => sent.push(r) });
  stops.push(stop);
  return stop;
}

function returnToForeground() {
  visibility = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-18T09:00:00Z"));
  vv = new FakeVisualViewport();
  visibility = "visible";
  rect = INSIDE;
  state = { zen: false, keyboardOpen: false, paneKind: "agent" };
  sent = [];
  stops = [];
  Object.defineProperty(window, "visualViewport", { configurable: true, value: vv });
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
  resetComposerOffscreenBudget();
  setForegroundAtForTest(Date.now() - 5000);
  composer = mountComposer();
});

afterEach(() => {
  for (const stop of stops) stop();
  composer?.remove();
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("when the watch looks", () => {
  it("sends nothing when the box is on screen, on any trigger", () => {
    watch();
    returnToForeground();
    window.dispatchEvent(new Event("pageshow"));
    vi.advanceTimersByTime(10_000);
    expect(sent).toEqual([]);
  });

  it("sends one record on a return to the foreground when the box is below the screen", () => {
    rect = { top: 850, bottom: 930 };
    watch();
    returnToForeground();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ trigger: "foreground", composerTop: 850, composerBottom: 930, visualHeight: 840, innerHeight: 900, paneKind: "agent", msSinceForeground: 0 });
  });

  it("names pageshow when a restored page shows", () => {
    rect = { top: 850, bottom: 930 };
    watch();
    window.dispatchEvent(new Event("pageshow"));
    expect(sent.map((r) => r.trigger)).toEqual(["pageshow"]);
  });

  it("looks after a resize settles for 300 ms, not before", () => {
    rect = { top: 850, bottom: 930 };
    watch();
    vv.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(299);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sent.map((r) => r.trigger)).toEqual(["resize"]);
  });

  it("a second resize inside the window restarts the wait", () => {
    rect = { top: 850, bottom: 930 };
    watch();
    window.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(200);
    window.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(200);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(sent).toHaveLength(1);
  });

  it("looks again 1 s and 4 s after the trigger, and names those looks delayed", () => {
    watch();
    returnToForeground();
    expect(sent).toEqual([]);
    // The reading arrives late, as a stale viewport does.
    rect = { top: 850, bottom: 930 };
    vi.advanceTimersByTime(DELAYED_CHECKS_MS[0]!);
    expect(sent.map((r) => r.trigger)).toEqual(["delayed"]);
    expect(sent[0]!.msSinceForeground).toBe(1000);
  });

  it("looks a second and a fourth second after a resize's own look too", () => {
    watch();
    window.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(300);
    rect = { top: 850, bottom: 930 };
    vi.advanceTimersByTime(DELAYED_CHECKS_MS[0]!);
    expect(sent.map((r) => r.trigger)).toEqual(["delayed"]);
  });

  it("reports where the viewport pin stood, from its read-only accessor", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const stopPin = startViewportPin();
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
    vv.height = 840;
    returnToForeground();
    rect = { top: 850, bottom: 930 };
    window.dispatchEvent(new Event("resize"));
    stopPin();
    info.mockRestore();
    rect = { top: 850, bottom: 930 };
    watch();
    window.dispatchEvent(new Event("pageshow"));
    expect(sent[0]).toMatchObject({ pinRecent: true, pinAction: "released" });
  });

  it("sends nothing while the page is hidden", () => {
    rect = { top: 850, bottom: 930 };
    watch();
    returnToForeground();
    sent = [];
    vi.advanceTimersByTime(MIN_GAP_MS);
    visibility = "hidden";
    vi.advanceTimersByTime(10_000);
    window.dispatchEvent(new Event("pageshow"));
    expect(sent).toEqual([]);
  });

  it("sends nothing in zen, and nothing when no composer is in the page", () => {
    rect = { top: 850, bottom: 930 };
    watch();
    state = { ...state, zen: true };
    returnToForeground();
    expect(sent).toEqual([]);
    state = { ...state, zen: false };
    composer?.remove();
    returnToForeground();
    expect(sent).toEqual([]);
  });

  it("sends nothing while pinch-zoomed", () => {
    rect = { top: 850, bottom: 930 };
    vv.scale = 2;
    watch();
    returnToForeground();
    expect(sent).toEqual([]);
  });

  it("carries the keyboard flag and the pane kind the view states", () => {
    rect = { top: 850, bottom: 930 };
    state = { zen: false, keyboardOpen: true, paneKind: "shell" };
    watch();
    returnToForeground();
    expect(sent[0]).toMatchObject({ keyboardOpen: true, paneKind: "shell" });
  });

  it("does nothing in a browser with no visual viewport, and stop removes every listener and timer", () => {
    rect = { top: 850, bottom: 930 };
    const stop = watch();
    returnToForeground();
    stop();
    sent = [];
    returnToForeground();
    window.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(10_000);
    expect(sent).toEqual([]);

    Object.defineProperty(window, "visualViewport", { configurable: true, value: null });
    watch();
    returnToForeground();
    expect(sent).toEqual([]);
  });
});

describe("the rate limits", () => {
  it("is one record per pane view per 60 seconds", () => {
    rect = { top: 850, bottom: 930 };
    watch();
    returnToForeground();
    returnToForeground();
    vi.advanceTimersByTime(MIN_GAP_MS - 1);
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(1);
    returnToForeground();
    expect(sent).toHaveLength(2);
  });

  it("is counted per pane view: a view mounted later is not held by the first one's gap", () => {
    rect = { top: 850, bottom: 930 };
    const first = watch();
    returnToForeground();
    first();
    watch();
    returnToForeground();
    expect(sent).toHaveLength(2);
  });

  it("is twenty per page life, across pane views", () => {
    rect = { top: 850, bottom: 930 };
    watch();
    for (let i = 0; i < MAX_PER_PAGE + 5; i++) {
      returnToForeground();
      vi.advanceTimersByTime(MIN_GAP_MS);
    }
    expect(sent).toHaveLength(MAX_PER_PAGE);
    const later = startComposerOffscreenWatch({ getState: () => state, send: (r) => sent.push(r) });
    stops.push(later);
    returnToForeground();
    expect(sent).toHaveLength(MAX_PER_PAGE);
  });
});

describe("the transport", () => {
  it("posts the record as JSON to the diagnostic route with no query", async () => {
    vi.useRealTimers();
    const seen: { url: string; body: unknown }[] = [];
    server.use(
      http.post("/api/diag/composer", async ({ request }) => {
        seen.push({ url: new URL(request.url).search, body: await request.json() });
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const record = buildComposerRecord(INPUT);
    await postComposerDiag(record);
    expect(seen).toEqual([{ url: "", body: record }]);
  });

  it("ignores a failure silently: a refusal, a missing route and a dead network", async () => {
    vi.useRealTimers();
    for (const answer of [
      () => new HttpResponse("bad composer record", { status: 400 }),
      () => new HttpResponse("not found", { status: 404 }),
      () => HttpResponse.error(),
    ]) {
      server.use(http.post("/api/diag/composer", answer));
      await expect(postComposerDiag(buildComposerRecord(INPUT))).resolves.toBeUndefined();
    }
  });
});
