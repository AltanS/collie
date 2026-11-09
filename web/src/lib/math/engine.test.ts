import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { MAX_MATH_CHARS } from "@/lib/markdown-math";

import { __resetMathEngines, __setMathEngineImport, isMathLoadError, loadMathEngine } from "./engine";

// An engine that cannot load (offline with nothing cached) stays unloaded for the page: formulas keep
// their source, and nothing asks the network again on every render.
const imports = { katex: 0 };
__setMathEngineImport(() => {
  imports.katex++;
  return Promise.reject(new TypeError("Failed to fetch dynamically imported module: http://phone.test/math/katex/katex.js"));
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

// THE CONTRACT (engine-contract.ts): an engine's module exports `typeset`, which answers a hast tree or
// null. The renderer around it caps the length, makes React elements, and turns a throw into source.
describe("the renderer around an engine's typeset", () => {
  const tree = (value: string) => ({
    type: "root" as const,
    children: [{ type: "element" as const, tagName: "b", properties: { className: ["x"] }, children: [{ type: "text" as const, value }] }],
  });

  afterEach(() => __setMathEngineImport(null));

  it("draws the tree as React elements, sync or awaited, and null as source", async () => {
    __setMathEngineImport(() =>
      Promise.resolve({ typeset: (tex: string) => (tex === "bad" ? null : tex === "later" ? Promise.resolve(tree(tex)) : tree(tex)) }),
    );
    const renderer = (await loadMathEngine("mathjax"))!;
    expect(renderToStaticMarkup(await renderer.render("now", false))).toBe('<b class="x">now</b>');
    expect(renderToStaticMarkup(await renderer.render("later", true))).toBe('<b class="x">later</b>');
    expect(renderer.render("bad", false)).toBeNull();
  });

  it("answers null past the length cap and for an engine that throws, without calling it twice", async () => {
    let calls = 0;
    __setMathEngineImport(() =>
      Promise.resolve({
        typeset: () => {
          calls++;
          throw new Error("boom");
        },
      }),
    );
    const renderer = (await loadMathEngine("katex"))!;
    expect(renderer.render("x".repeat(MAX_MATH_CHARS + 1), false)).toBeNull();
    expect(calls).toBe(0);
    expect(renderer.render("x", false)).toBeNull();
    expect(calls).toBe(1);
  });
});
