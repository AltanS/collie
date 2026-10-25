import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// THE TOP EDGE OF A HOME-SCREEN APP (index.css, "THE TOP EDGE"; #597 after #203). #203 turned off
// the iOS 27 top blur on a phone with `status-bar-style: default`. An iPad kept it, because nothing at
// the top of the page spans the width: the column header stops at 640px and the wide layout opens
// with a rail and a tab row. The page now states the edge itself, one fixed, opaque, real element
// across the whole top. This pins the shape of that element; e2e/top-edge.spec.ts asks a real engine
// to lay it out. Neither can show the blur, which only a Home Screen launch on an iPad draws.
const web = join(import.meta.dirname, "..");
const css = readFileSync(join(import.meta.dirname, "index.css"), "utf8");
const html = readFileSync(join(web, "index.html"), "utf8");
const header = readFileSync(join(import.meta.dirname, "components/app-header.tsx"), "utf8");

/** The text of the rule block that opens at `selector`, up to its closing brace. */
function ruleAfter(selector: string, from = 0): string {
  const open = css.indexOf(selector, from);
  expect(open).toBeGreaterThan(-1);
  return css.slice(open, css.indexOf("}", open));
}

/** Everything the standalone gate holds, from the media query to `@layer base`. */
function gate(): string {
  const start = css.indexOf("[data-slot=\"top-edge\"] {\n  display: none;");
  expect(start).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf("@layer base", start));
}

describe("the top edge element", () => {
  it("is a real element before #root, hidden from assistive tech", () => {
    const edge = html.indexOf('<div data-slot="top-edge" aria-hidden="true"></div>');
    expect(edge).toBeGreaterThan(-1);
    expect(edge).toBeLessThan(html.indexOf('<div id="root">'));
    // Outside #root, so React's createRoot cannot replace it.
    expect(html.indexOf("<body>")).toBeLessThan(edge);
  });

  it("keeps the opaque status bar #203 chose", () => {
    expect(html).toMatch(/name="apple-mobile-web-app-status-bar-style"\s+content="default"/);
  });

  it("is not drawn anywhere but a standalone iOS web view", () => {
    expect(ruleAfter('[data-slot="top-edge"] {')).toContain("display: none;");
    const g = gate();
    expect(g).toContain("@media (display-mode: standalone)");
    expect(g.indexOf("@supports (-webkit-touch-callout: none)")).toBeGreaterThan(g.indexOf("display-mode"));
    expect(g.indexOf("display: block;")).toBeGreaterThan(g.indexOf("-webkit-touch-callout"));
  });

  it("spans the width at the top, as tall as the inset, in the header's own colour", () => {
    const rule = ruleAfter('[data-slot="top-edge"] {', css.indexOf("@supports (-webkit-touch-callout: none)", css.indexOf('[data-slot="top-edge"] {')));
    expect(rule).toContain("position: fixed;");
    // top 0, left 0, right 0: the 80% width and 4px from the top the heuristic asks for.
    expect(rule).toContain("inset: 0 0 auto 0;");
    expect(rule).toContain("height: max(env(safe-area-inset-top, 0px), var(--top-edge-floor));");
    // The token follows the theme, and it is the one the header paints (so the two cannot differ).
    expect(rule).toContain("background: var(--band-ground);");
    expect(header).toContain("bg-band-ground");
    expect(rule).toContain("pointer-events: none;");
  });

  it("sits over the sticky header and under the strip rung, the toasts and the sheets", () => {
    const z = /\[data-slot="top-edge"\] \{[^}]*z-index:\s*(\d+);/.exec(gate())?.[1];
    expect(Number(z)).toBeGreaterThan(20);
    expect(Number(z)).toBeLessThan(30);
  });

  it("has no floor on a phone and 6px from 768px wide", () => {
    const g = gate();
    expect(g).toMatch(/:root\s*\{\s*--top-edge-floor:\s*0px;\s*\}/);
    expect(g).toMatch(/@media \(min-width: 768px\)\s*\{\s*:root\s*\{\s*--top-edge-floor:\s*6px;/);
  });
});
