import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { DESIGN_STORAGE_KEY } from "@/lib/design";
import { COLOUR_MAX, COLOUR_SOURCE, SHIPPED_THEME_IDS, THEME_TOKENS, isColour } from "@/lib/theme/schema";
import { LIBRARY_STORAGE_KEY } from "@/lib/theme/store";

// public/theme-init.js runs before the module graph exists, so it spells the facts the colour theme
// needs: the shipped ids, the closed token list, the colour pattern and the two storage keys. Only a
// test that reads both files can stop them drifting, and the drift is silent: the app keeps working
// and the first frame is simply painted in the wrong colours. Reads the file from disk, like
// fonts.test.ts does for the face.

const init = readFileSync(resolve(import.meta.dirname, "../public/theme-init.js"), "utf8");

/** The quoted strings of `var NAME = [ ... ];`. */
function listOf(name: string): string[] {
  const body = new RegExp(`var ${name} = \\[([^\\]]*)\\];`).exec(init)?.[1] ?? "";
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "");
}

describe("theme-init.js and lib/theme agree", () => {
  it("names the shipped themes that wear an attribute, and not collie", () => {
    expect(listOf("SHIPPED")).toEqual(SHIPPED_THEME_IDS.filter((id) => id !== "collie"));
  });

  it("spells the closed token list, all of it and in order", () => {
    expect(listOf("TOKENS")).toEqual([...THEME_TOKENS]);
    expect(listOf("TOKENS")).toHaveLength(43);
  });

  it("holds the same colour pattern and the same length cap", () => {
    const literal = /var COLOUR = \/(.*)\/;/.exec(init)?.[1];
    expect(literal).toBe(new RegExp(COLOUR_SOURCE).source);
    expect(init).toContain(`v.length <= ${COLOUR_MAX}`);
  });

  it("reads the same two storage keys", () => {
    expect(DESIGN_STORAGE_KEY).toBe("collie:design:v1");
    expect(LIBRARY_STORAGE_KEY).toBe("collie:themes:v1");
    expect(init).toContain(`localStorage.getItem("${DESIGN_STORAGE_KEY}")`);
    expect(init).toContain(`localStorage.getItem("${LIBRARY_STORAGE_KEY}")`);
  });

  it("reads the theme from the design blob's `theme` field, and the library as version 1", () => {
    expect(init).toContain("applyColourTheme(d.theme)");
    expect(init).toContain("lib.version === 1");
  });

  it("takes the property name from its own list and the attribute value from its own list", () => {
    expect(init).toContain('root.style.setProperty("--" + TOKENS[k]');
    expect(init).toContain('root.setAttribute("data-theme", SHIPPED[i])');
    // Nothing of the stored object's own keys or ids reaches a sink: no loop over its keys.
    expect(init).not.toMatch(/for \(var \w+ in /);
    expect(init).not.toContain("Object.keys");
  });

  it("only adds: it removes no class, attribute or property", () => {
    expect(init).not.toMatch(/removeProperty|removeAttribute|classList\.remove/);
  });

  it("adds fewer than 60 lines for the theme job", () => {
    const lines = init.split("\n");
    const start = lines.findIndex((l) => l.includes("IT NOW DOES A THIRD THING")) - 1;
    const fn = lines.findIndex((l) => l.startsWith("  function applyColourTheme"));
    const end = lines.findIndex((l, i) => i > fn && l === "  }");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(fn);
    // The block, the one call site, and the hand-off line that was not there before.
    expect(end - start + 1 + 1).toBeLessThan(60);
  });
});

describe("the colour pattern theme-init.js uses", () => {
  const pre = new RegExp(COLOUR_SOURCE);

  it("accepts what the parser accepts, in the parser's own spelling", () => {
    for (const value of ["#0a0a0a", "#0a0a0a80", "oklch(0.97 0 0)", "oklch(0.5 0.1 120 / 0.5)", "oklch(0.5 0.1 120 / 50%)", "oklch(.5 .1 120)"]) {
      expect(isColour(value), value).toBe(true);
      expect(pre.test(value), value).toBe(true);
    }
  });

  it("refuses every shape the parser refuses", () => {
    for (const value of [
      "red",
      "#fff",
      "#GGGGGG",
      "rgb(0 0 0)",
      "var(--x)",
      "url(https://x.test/a.png)",
      "#000000; color: red",
      "#000000}",
      "oklch(0.5 0.1 120) !important",
      "oklch(0.5 0.1 120 / )",
      "light-dark(#000000, #ffffff)",
      "",
    ]) {
      expect(isColour(value), value).toBe(false);
      expect(pre.test(value), value).toBe(false);
    }
  });
});
