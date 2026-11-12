import { afterEach, describe, expect, it } from "vitest";

import { installPageZoomGuard } from "./page-zoom";

const touchmove = (fingers: number) => {
  const e = new Event("touchmove", { cancelable: true });
  Object.defineProperty(e, "touches", { value: { length: fingers } });
  return e;
};

describe("installPageZoomGuard", () => {
  let uninstall = () => {};
  afterEach(() => uninstall());

  it("cancels a pinch only while zoom is not allowed, and never a one-finger move", () => {
    let allowed = false;
    uninstall = installPageZoomGuard(document, () => allowed);

    const pinch = touchmove(2);
    document.dispatchEvent(pinch);
    expect(pinch.defaultPrevented).toBe(true);

    const gesture = new Event("gesturestart", { cancelable: true });
    document.dispatchEvent(gesture);
    expect(gesture.defaultPrevented).toBe(true);

    const scroll = touchmove(1);
    document.dispatchEvent(scroll);
    expect(scroll.defaultPrevented).toBe(false);

    allowed = true;
    const allowedPinch = touchmove(2);
    document.dispatchEvent(allowedPinch);
    expect(allowedPinch.defaultPrevented).toBe(false);
  });

  it("does nothing once uninstalled", () => {
    installPageZoomGuard(document, () => false)();
    const pinch = touchmove(2);
    document.dispatchEvent(pinch);
    expect(pinch.defaultPrevented).toBe(false);
  });
});
