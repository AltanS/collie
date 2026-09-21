import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import viteConfigExport from "../../vite.config";

// The config is a function of the command since ADR 0052 (the build's base is relative, the dev
// server's is not); the build's answer is the one this file asks about.
const viteConfig = await viteConfigExport({ command: "build", mode: "production" });

// The playground is a second HTML page in the Vite ROOT, and it stays out of the shipped app by the
// one mechanism that needs no maintenance: Vite's default `build.rollupOptions.input` is the root
// `index.html` alone, so `vite build` never walks `playground.html` and the PWA precache manifest —
// which is injected from what actually landed in `dist` — can never list it either.
//
// The failure this pins is a one-line one: somebody adds a multi-page `input` (for a preview page, a
// second shell, anything) and quietly ships the playground, its fixtures, and MSW with it. So the
// assertion is on the config, not on a build artefact: it is deterministic, needs no `dist`, and
// fails at the exact edit that would cause the leak.
describe("the states playground is dev-only", () => {
  const web = resolve(import.meta.dirname, "../..");

  it("has an HTML entry sitting in the Vite root", () => {
    expect(existsSync(resolve(web, "playground.html"))).toBe(true);
    expect(existsSync(resolve(web, "src/playground/main.tsx"))).toBe(true);
  });

  it("is absent from the build's rollup input", () => {
    // Undefined means Vite's own default — `<root>/index.html`, and nothing else. If a multi-page
    // `input` is ever introduced, this fails and whoever added it has to say, in one line here,
    // which entries ship.
    expect(viteConfig.build?.rollupOptions?.input).toBeUndefined();
  });
});
