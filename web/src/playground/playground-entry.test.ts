import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import viteConfig from "../../vite.config";

// The design reference is a second HTML page in the Vite ROOT (`design.html`, with the old address
// `playground.html` forwarding to it), and it stays out of the shipped app by the one mechanism that
// needs no maintenance: Vite's default `build.rollupOptions.input` is the root `index.html` alone, so
// `vite build` never walks either page and the PWA precache manifest — which is injected from what
// actually landed in `dist` — can never list them either.
//
// The failure this pins is a one-line one: somebody adds a multi-page `input` (for a preview page, a
// second shell, anything) and quietly ships the reference, its fixtures, and MSW with it. So the
// assertion is on the config, not on a build artefact: it is deterministic, needs no `dist`, and
// fails at the exact edit that would cause the leak.
describe("the design reference is dev-only", () => {
  const web = resolve(import.meta.dirname, "../..");

  it("has an HTML entry sitting in the Vite root", () => {
    expect(existsSync(resolve(web, "design.html"))).toBe(true);
    expect(existsSync(resolve(web, "src/playground/main.tsx"))).toBe(true);
    expect(readFileSync(resolve(web, "design.html"), "utf8")).toContain('src="/src/playground/main.tsx"');
  });

  it("has a page title that names Collie and the design reference", () => {
    const html = readFileSync(resolve(web, "design.html"), "utf8");
    expect(html).toMatch(/<title>[^<]*collie design reference[^<]*<\/title>/i);
  });

  it("keeps the old address, which forwards with the search and the entry", () => {
    const html = readFileSync(resolve(web, "playground.html"), "utf8");
    expect(html).toMatch(/<title>[^<]*collie[^<]*<\/title>/i);
    expect(html).toContain('location.replace("design.html" + location.search + location.hash)');
  });

  it("is absent from the build's rollup input", () => {
    // Undefined means Vite's own default — `<root>/index.html`, and nothing else. If a multi-page
    // `input` is ever introduced, this fails and whoever added it has to say, in one line here,
    // which entries ship.
    expect(viteConfig.build?.rollupOptions?.input).toBeUndefined();
  });
});
