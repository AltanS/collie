import { afterEach, describe, expect, it, vi } from "vitest";

import { __resetMathEngines, isMathLoadError, loadMathEngine } from "./engine";

// An engine that cannot load (offline with nothing cached) stays unloaded for the page: formulas keep
// their source, and nothing asks the network again on every render.
const imports = vi.hoisted(() => ({ katex: 0 }));
vi.mock("./katex", () => {
  imports.katex++;
  throw new Error("Failed to fetch dynamically imported module: http://phone.test/math/katex/katex-x.js");
});

afterEach(() => __resetMathEngines());

describe("loadMathEngine", () => {
  it("resolves a failed engine to null, and does not import it again", async () => {
    expect(await loadMathEngine("katex")).toBeNull();
    const after = imports.katex;
    expect(await loadMathEngine("katex")).toBeNull();
    expect(imports.katex).toBe(after);
  });

  it("loads nothing for Off", async () => {
    expect(await loadMathEngine("off")).toBeNull();
  });
});

describe("isMathLoadError", () => {
  it("claims an error that names a file under math/", () => {
    expect(isMathLoadError(new Error("Unable to preload CSS for http://phone.test/math/katex/katex-x.css"))).toBe(true);
    expect(isMathLoadError(new Error("Failed to fetch dynamically imported module: http://phone.test/math/mathjax/greek-x.js"))).toBe(true);
  });

  it("leaves an app chunk's error to the reload", () => {
    expect(isMathLoadError(new Error("Failed to fetch dynamically imported module: http://phone.test/assets/de-x.js"))).toBe(false);
  });

  it("claims an error naming no file only while an engine is loading", () => {
    const safari = new TypeError("Importing a module script failed.");
    expect(isMathLoadError(safari)).toBe(false);
    void loadMathEngine("katex");
    expect(isMathLoadError(safari)).toBe(true);
  });
});
