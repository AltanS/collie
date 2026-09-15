import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { AnsiSegment } from "@/lib/ansi";
import { MUSE_MIRROR, segmentClassName, segmentStyle, styleFor } from "./mirror-space";

function seg(over: Partial<AnsiSegment>): AnsiSegment {
  return { text: "x", style: {}, muted: false, ...over };
}

describe("segmentStyle", () => {
  it("keeps bright marks behind a var() the light theme overrides, raw as fallback", () => {
    const style = segmentStyle(
      seg({ fg: "rgb(250,250,249)", style: { color: "rgb(250,250,249)" }, lightDarkFg: true }),
    );
    expect(style.color).toBe("var(--terminal-light-dark-fg, rgb(250,250,249))");
  });

  it("passes unmarked spans through untouched", () => {
    const s = seg({ fg: "rgb(111,114,122)", style: { color: "rgb(111,114,122)" } });
    expect(segmentStyle(s).color).toBe("rgb(111,114,122)");
  });

  it("resolves muted chrome behind its own var(), dark-space grey as fallback", () => {
    const style = styleFor(seg({ muted: true }));
    expect(style.color).toBe("var(--terminal-muted-fg, #a1a1a1)");
    expect(style).toMatchObject({ fontWeight: 400, opacity: 1 });
  });

  it("passes non-muted spans through styleFor by reference", () => {
    const s = seg({ style: { color: "rgb(1,2,3)" } });
    expect(styleFor(s)).toBe(s.style);
  });
});

describe("MUSE_MIRROR", () => {
  it("grounds light on the probed reference bg, not the page", () => {
    // #fffbf8 is Herdr 0.9.0's light background, probed live via OSC 11 — the ground Muse's
    // light palette was authored against. Page ground (#f5f5f5) compressed authored fills
    // past visibility (prompt fill at 1.08:1); the reference restores the authored 1.15 edge.
    expect(MUSE_MIRROR).toContain("bg-[#fffbf8]");
    expect(MUSE_MIRROR).not.toContain("bg-[#f5f5f5]");
    expect(MUSE_MIRROR).toContain("dark:bg-[#0a0a0a]");
  });
});

describe("segmentClassName", () => {
  it("emits nothing without a mark", () => {
    expect(segmentClassName(seg({}))).toBeUndefined();
  });

  it.each([
    [{ mobileTransparentBg: true as const }, "terminal-mobile-transparent-bg"],
    [{ lightDarkFg: true as const }, "terminal-light-dark-fg"],
    [{ muted: true }, "terminal-muted"],
  ])("emits one marker alone", (over, cls) => {
    expect(segmentClassName(seg(over))).toBe(cls);
  });

  it("joins combined marks with single spaces", () => {
    expect(
      segmentClassName(seg({ mobileTransparentBg: true, lightDarkFg: true, muted: true })),
    ).toBe("terminal-mobile-transparent-bg terminal-light-dark-fg terminal-muted");
  });
});

// The light half of the native-mirror mechanism lives in the stylesheet, where no render test can
// see it: deleting either rule block below keeps every suite green while brights (or muted chrome)
// render raw on white. Pin the selectors, the scope, and the values. [\s\S], not newlines:
// Prettier is free to wrap these declarations.
describe("native-mirror stylesheet rules", () => {
  const css = readFileSync(join(import.meta.dirname, "..", "index.css"), "utf8");

  it.each([
    ["bright foregrounds", "terminal-light-dark-fg", "terminal-light-dark-fg", "#0a0a0a"],
    ["muted chrome", "terminal-muted", "terminal-muted-fg", "#5d5d5d"],
  ])("defines %s for pinned light, scoped to muse mirrors", (_label, cls, prop, value) => {
    expect(css).toMatch(
      new RegExp(
        `:root\\.light\\s+pre\\.terminal-muse\\s+\\.${cls}\\s*\\{[\\s\\S]*?--${prop}:\\s*${value};`,
      ),
    );
  });

  it.each([
    ["bright foregrounds", "terminal-light-dark-fg", "terminal-light-dark-fg", "#0a0a0a"],
    ["muted chrome", "terminal-muted", "terminal-muted-fg", "#5d5d5d"],
  ])("defines %s for system-follows-OS light, scoped to muse mirrors", (_label, cls, prop, value) => {
    expect(css).toMatch(
      new RegExp(
        `@media\\s*\\(prefers-color-scheme:\\s*light\\)\\s*\\{[\\s\\S]*?:root:not\\(\\.dark\\)\\s+pre\\.terminal-muse\\s+\\.${cls}\\s*\\{[\\s\\S]*?--${prop}:\\s*${value};`,
      ),
    );
  });
});
