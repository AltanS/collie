import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { installHiddenPause, PAGE_HIDDEN_ATTR } from "./page-hidden";

// Issue 748: a hidden page pauses every animation. The attribute is this module's half; the rule
// that does the pausing is index.css's, and the last case reads it there.

function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

let uninstall: (() => void) | null = null;

afterEach(() => {
  uninstall?.();
  uninstall = null;
  setVisibility("visible");
  document.documentElement.removeAttribute(PAGE_HIDDEN_ATTR);
});

it("marks the root while the page is hidden, and clears it when it is back", () => {
  setVisibility("visible");
  uninstall = installHiddenPause();
  expect(document.documentElement.hasAttribute(PAGE_HIDDEN_ATTR)).toBe(false);
  setVisibility("hidden");
  expect(document.documentElement.hasAttribute(PAGE_HIDDEN_ATTR)).toBe(true);
  setVisibility("visible");
  expect(document.documentElement.hasAttribute(PAGE_HIDDEN_ATTR)).toBe(false);
});

it("marks a page that is already hidden when it installs", () => {
  setVisibility("hidden");
  uninstall = installHiddenPause();
  expect(document.documentElement.hasAttribute(PAGE_HIDDEN_ATTR)).toBe(true);
});

it("stops following the page once uninstalled", () => {
  uninstall = installHiddenPause();
  uninstall();
  uninstall = null;
  setVisibility("hidden");
  expect(document.documentElement.hasAttribute(PAGE_HIDDEN_ATTR)).toBe(false);
});

it("pauses every animation, pseudo-elements included, under the attribute in index.css", () => {
  const css = readFileSync(join(import.meta.dirname, "..", "index.css"), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ");
  const rules = [...css.matchAll(/([^{}]+)\{ animation-play-state: paused !important; \}/g)].map((m) => m[1] ?? "");
  const selectors = rules.flatMap((list) => list.split(",").map((one) => one.trim()));
  for (const want of ["", "::before", "::after"]) {
    expect(selectors).toContain(`:root[${PAGE_HIDDEN_ATTR}] *${want}`);
  }
});
