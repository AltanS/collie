import type { CDPSession, Page } from "@playwright/test";

// A FINGER, NOT A CLICK. `page.touchscreen.tap` sends touchstart and touchend in one breath, so it
// cannot hold, drift or lift late. These drive Chromium's own touch pipeline through CDP
// (`Input.dispatchTouchEvent`) so a press has a length, a drift and a place, and the browser's
// gesture detection (slop, scroll, fling, tap-down) decides what it becomes, as it would for a finger.
// The same technique as `e2e/pane-nav.touch.spec.ts`.

export interface Finger {
  cdp: CDPSession;
  /**
   * The contact's radius in CSS px, default 8. Chromium snaps a tap to the nearest clickable node within the
   * contact's radius (touch adjustment), so a measurement of what a REACH adds uses a point, radius 1.
   */
  radius?: number;
}

export async function finger(page: Page): Promise<Finger> {
  return { cdp: await page.context().newCDPSession(page) };
}

async function send(f: Finger, type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel", x: number, y: number): Promise<void> {
  await f.cdp.send("Input.dispatchTouchEvent", {
    type,
    // A fingertip is about 9mm: roughly 17 CSS px across at the phone's pixel density. Chromium's
    // own gesture code reads the radius, so a fat contact is not the same as a point.
    touchPoints: type === "touchEnd" || type === "touchCancel" ? [] : [{ x, y, radiusX: f.radius ?? 8, radiusY: f.radius ?? 8, force: 1 }],
  });
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * One press: down at (x, y), the finger drifts `drift` px sideways in three steps while it is down,
 * stays `holdMs` in all, and lifts. `drift` 0 is a still finger.
 */
export async function press(f: Finger, x: number, y: number, opts: { holdMs?: number; drift?: number; driftY?: number } = {}): Promise<void> {
  const hold = opts.holdMs ?? 60;
  const drift = opts.drift ?? 0;
  const driftY = opts.driftY ?? 0;
  await send(f, "touchStart", x, y);
  if (drift !== 0 || driftY !== 0) {
    for (const k of [1, 2, 3]) {
      await send(f, "touchMove", x + (drift * k) / 3, y + (driftY * k) / 3);
      await sleep(Math.max(1, Math.floor(hold / 4)));
    }
    await sleep(Math.max(0, hold - Math.floor((hold / 4) * 3)));
  } else {
    await sleep(hold);
  }
  await send(f, "touchEnd", x + drift, y + driftY);
}

/** A press with a callback that runs at `atMs` after the finger lands, while it is still down. */
export async function pressWith(f: Finger, x: number, y: number, holdMs: number, atMs: number, during: () => Promise<void>): Promise<void> {
  await send(f, "touchStart", x, y);
  const side = (async () => {
    await sleep(atMs);
    await during();
  })();
  await sleep(holdMs);
  await send(f, "touchEnd", x, y);
  await side;
}

/** Start a fling: a quick upward swipe that leaves momentum, from (x, y). Resolves when the finger lifts. */
export async function fling(f: Finger, x: number, y: number, dy: number): Promise<void> {
  await send(f, "touchStart", x, y);
  for (let k = 1; k <= 6; k += 1) {
    await send(f, "touchMove", x, y + (dy * k) / 6);
    await sleep(8);
  }
  await send(f, "touchEnd", x, y + dy);
}
