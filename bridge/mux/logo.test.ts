import { describe, expect, test } from "bun:test";

import { HERDR_LOGO_SVG } from "./herdr/logo.ts";
import { TMUX_LOGO_SVG } from "./tmux/logo.ts";
import { ZELLIJ_LOGO_SVG } from "./zellij/logo.ts";
import { MUX_ADAPTERS } from "./registry.ts";

// WHAT EVERY LOGO IN THIS BUILD MUST BE, asserted per adapter.
//
// An SVG is a document, not a picture. The bridge already serves these under
// `Content-Security-Policy: sandbox` + `nosniff` (bridge/server.ts `muxLogoResponse`), so a script
// inside one could not run — but the transport is the SECOND line, not the first. These bytes ship
// in Collie's own source, and the point of asserting it here is that the file itself is clean, so
// nobody has to reason about a header to know that.
//
// The list is one entry per adapter directory rather than a directory scan: a logo is a named
// export a module makes, and a scan would pass happily on the day someone adds a fourth adapter and
// forgets its logo — which the config test in bridge/server.test.ts catches instead.
const LOGOS: readonly [name: string, svg: string][] = [
  ["herdr", HERDR_LOGO_SVG],
  ["tmux", TMUX_LOGO_SVG],
  ["zellij", ZELLIJ_LOGO_SVG],
];

/** Roughly what a `<img>` in a header should ever cost. Not a limit anyone should need to raise. */
const MAX_BYTES = 4096;

describe("every mux logo is inert, standalone, and small", () => {
  test("one logo per registered adapter — a fourth adapter cannot land unnoticed", () => {
    expect(LOGOS.map(([name]) => name).toSorted()).toEqual(
      MUX_ADAPTERS.map((factory) => factory.mux).toSorted(),
    );
  });

  for (const [name, svg] of LOGOS) {
    describe(name, () => {
      test("carries no script of any kind", () => {
        expect(svg).not.toMatch(/<script/iu);
        expect(svg).not.toMatch(/javascript:/iu);
        // Any event-handler attribute — onload, onclick, onmouseover, …
        expect(svg).not.toMatch(/\son[a-z]+\s*=/iu);
      });

      test("reaches nothing outside itself — no href, no external reference", () => {
        // `href`/`xlink:href` is the whole family at once: a link, an `<image>` pulling a remote
        // bitmap, a `<use>` reaching into another document.
        expect(svg).not.toMatch(/href/iu);
        expect(svg).not.toMatch(/<image\b/iu);
        expect(svg).not.toMatch(/<foreignObject\b/iu);
        expect(svg).not.toMatch(/url\(/iu);
      });

      test("is a viewBox-based SVG root, so it scales to the text line it sits on", () => {
        expect(svg.startsWith("<svg ")).toBe(true);
        expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
        expect(svg).toContain(`xmlns="http://www.w3.org/2000/svg"`);
        expect(svg).toMatch(/viewBox="0 0 \d+ \d+"/u);
        // No fixed width/height: the header sizes it in `em`, and a hard-coded pixel size would
        // fight that on every device where the caption is not the size someone assumed.
        expect(svg).not.toMatch(/<svg[^>]*\swidth=/u);
        expect(svg).not.toMatch(/<svg[^>]*\sheight=/u);
      });

      test("stays small enough to be a header glyph", () => {
        expect(Buffer.byteLength(svg, "utf8")).toBeLessThan(MAX_BYTES);
      });
    });
  }
});
