import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_THEME_ID } from "@/lib/theme/schema";

// index.css imports themes.css AFTER the :root token block, not at the top of the file. Plain CSS
// ignores an @import that follows a rule, so this order works only because the Tailwind v4 Vite
// plugin inlines the file where the @import stands. This test reads the BUILT stylesheet and holds
// that fact: no @import is left, and every shipped theme block other than collie's comes after the
// :root `--background` declaration. It needs a production build (`bun run build` in web/) and
// skips when web/dist is absent, so the ordinary suite stays build-free.
//
// The build minifies `[data-theme="x"]` to `[data-theme=x]`, so both spellings are searched.

const web = resolve(import.meta.dirname, "../..");
const assets = resolve(web, "dist/assets");
const built = existsSync(assets);

function builtCss(): string {
  const sheets = readdirSync(assets)
    .filter((name) => name.endsWith(".css"))
    .map((name) => readFileSync(resolve(assets, name), "utf8"))
    .filter((text) => text.includes("--background:"));
  expect(sheets).toHaveLength(1);
  return sheets[0] ?? "";
}

function shippedIds(): string[] {
  return readdirSync(resolve(web, "src/themes"))
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .filter((id) => id !== DEFAULT_THEME_ID);
}

function blockOffset(css: string, id: string): number {
  const offsets = [`[data-theme=${id}]`, `[data-theme="${id}"]`].map((sel) => css.indexOf(sel)).filter((i) => i >= 0);
  return offsets.length === 0 ? -1 : Math.min(...offsets);
}

describe.skipIf(!built)("the built stylesheet places the theme blocks after the token block", () => {
  it("inlines themes.css and leaves no @import behind", () => {
    expect(builtCss()).not.toContain("@import");
  });

  it.each(shippedIds().length > 0 ? shippedIds() : ["(no shipped theme besides collie)"])(
    "puts the %s block after the :root --background declaration",
    (id) => {
      const css = builtCss();
      const token = css.indexOf("--background:");
      expect(token).toBeGreaterThan(-1);
      if (id.startsWith("(")) return;
      const block = blockOffset(css, id);
      expect({ id, found: block > -1 }).toEqual({ id, found: true });
      expect(block).toBeGreaterThan(token);
    },
  );
});

describe.skipIf(built)("the built stylesheet check", () => {
  it.skip("skipped: web/dist is absent; run `bun run build` in web/ to check the theme block order", () => {});
});
