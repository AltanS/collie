import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { FONT_URLS } from "@/lib/sw-routes";

// The bundled Nerd Font faces are the only webfont Collie ships, and the design rests on three facts
// that are silent when broken: the stylesheet, the service worker and the disk agree on which files
// exist; each face is range-restricted so it stays lazy; and neither file re-enters the precache. A
// renamed file is a tofu box again (#70); a woff2 back in `globPatterns` charges every install
// ~1.1 MB; a URL the SW doesn't know gets swept out of the font cache on activate.

const root = resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");
const css = read("src/index.css");
const cssUrls = [...css.matchAll(/url\("([^"]+\.woff2)"\)/g)].map((m) => m[1]!);

describe("bundled fonts", () => {
  it("declares one face per private-use plane", () => {
    expect(css).toContain("unicode-range: U+E000-F8FF");
    expect(css).toContain("unicode-range: U+F0000-F1AFF");
    expect(cssUrls).toHaveLength(2);
  });

  // Drift here is the whole failure mode: the SW sweeps every font-cache entry it can't name, so a
  // stylesheet URL missing from FONT_URLS would be re-fetched on every cold load, forever.
  it("names the same files in the stylesheet and the service worker", () => {
    expect(cssUrls).toEqual([...FONT_URLS]);
  });

  it.each(FONT_URLS)("ships %s", (url) => {
    // Throws if the asset is missing — a rename that misses one side lands as tofu, not an error.
    expect(statSync(resolve(root, `public${url}`)).size).toBeGreaterThan(0);
  });

  // `[\s\S]`, not `.`: Prettier is free to wrap that array, and a newline-blind pattern would pass
  // while `woff2` sat back in the precache list.
  it("keeps woff2 out of the precache manifest", () => {
    expect(read("vite.config.ts")).not.toMatch(/globPatterns[\s\S]{0,200}?woff2/);
  });
});
