import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  installPageZoom,
  installPageZoomGuard,
  PAGE_ZOOM_OFF_ATTR,
  pageZoomAllowed,
  setPageZoomAllowed,
} from "./page-zoom";

const touchmove = (fingers: number, cancelable = true) => {
  const e = new Event("touchmove", { cancelable });
  Object.defineProperty(e, "touches", { value: { length: fingers } });
  return e;
};

afterEach(() => {
  setPageZoomAllowed(true);
  vi.restoreAllMocks();
});

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

describe("installPageZoom", () => {
  let uninstall = () => {};
  afterEach(() => uninstall());

  it("reads the setting once and keeps it: sixty pinch moves read no storage", () => {
    const read = vi.fn(() => false);
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    uninstall = installPageZoom(read);
    expect(read).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 60; i++) {
      const pinch = touchmove(2);
      document.dispatchEvent(pinch);
      expect(pinch.defaultPrevented).toBe(true);
    }
    expect(read).toHaveBeenCalledTimes(1);
    expect(getItem).not.toHaveBeenCalled();
  });

  it("follows the switch at once, with no reload", () => {
    uninstall = installPageZoom(() => true);
    expect(pageZoomAllowed()).toBe(true);
    expect(document.documentElement).not.toHaveAttribute(PAGE_ZOOM_OFF_ATTR);

    setPageZoomAllowed(false);
    const pinch = touchmove(2);
    document.dispatchEvent(pinch);
    expect(pinch.defaultPrevented).toBe(true);
    expect(document.documentElement).toHaveAttribute(PAGE_ZOOM_OFF_ATTR);

    setPageZoomAllowed(true);
    const free = touchmove(2);
    document.dispatchEvent(free);
    expect(free.defaultPrevented).toBe(false);
    expect(document.documentElement).not.toHaveAttribute(PAGE_ZOOM_OFF_ATTR);
  });

  it("reads the setting again when another tab changes storage", () => {
    let stored = true;
    uninstall = installPageZoom(() => stored);
    stored = false;
    window.dispatchEvent(new StorageEvent("storage", { key: "collie:dash-prefs:v1" }));
    expect(pageZoomAllowed()).toBe(false);
    expect(document.documentElement).toHaveAttribute(PAGE_ZOOM_OFF_ATTR);
  });

  it("gives the page back on uninstall", () => {
    installPageZoom(() => false)();
    expect(pageZoomAllowed()).toBe(true);
    expect(document.documentElement).not.toHaveAttribute(PAGE_ZOOM_OFF_ATTR);
  });
});

describe("the root touch-action", () => {
  // jsdom runs no stylesheet, so the rule that makes Chrome on Android refuse a pinch whose second
  // finger joins a scroll already running is pinned in the source: on the root, only while the switch is off.
  const css = readFileSync(resolve(import.meta.dirname, "../index.css"), "utf8");

  it("sets pan-x pan-y on the root under the off attribute, and nowhere unconditionally", () => {
    expect(css).toMatch(new RegExp(`:root\\[${PAGE_ZOOM_OFF_ATTR}\\]\\s*\\{[^}]*touch-action:\\s*pan-x pan-y;`));
    expect(css).not.toMatch(/(^|\n)(html|body|:root)\s*\{[^}]*touch-action/);
  });
});
