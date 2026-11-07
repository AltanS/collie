import { describe, expect, test } from "bun:test";

import { checkBuild, checkPackImports, engineReferences, packImports } from "./math-pack.ts";

// ADR 0132 Decision 3: every engine file a payload's bundle names must be in the pack. The bundle's
// spelling is the one Vite emits today (`../math/katex/katex.js` inside `assets/index-*.js`): the engine
// files carry no content hash, and only the shell's files they import do.

const pack = new Set(["math/katex/katex.js", "math/katex/katex.css", "math/math-markup.js"]);
const bundle = (text: string) => [{ name: "assets/index-abc.js", text }];

describe("engineReferences", () => {
  test("reads the relative, the absolute and the bare spelling, once each", () => {
    const text = 'import("../math/katex/katex.js");m(["../math/katex/katex.css","/math/math-markup.js"]);"math/math-markup.js"';
    expect(engineReferences(text).toSorted()).toEqual([...pack].toSorted());
  });

  test("takes no word that merely ends in math, and no folder without a file", () => {
    expect(engineReferences('const isMathLoadError = e.includes("/math/"); "aftermath/x.js"')).toEqual([]);
  });
});

describe("checkBuild", () => {
  test("passes a build whose every engine file is in the pack", () => {
    expect(checkBuild(pack, bundle('import("../math/katex/katex.js")'), false)).toBeNull();
  });

  test("fails a build that still carries web/dist/math", () => {
    expect(checkBuild(pack, bundle('import("../math/katex/katex.js")'), true)).toContain("web/dist/math");
  });

  test("fails a build that names a file the pack lacks", () => {
    expect(checkBuild(pack, bundle('import("../math/katex/katex-other.js")'), false)).toContain("math/katex/katex-other.js");
  });

  test("fails a build that names no engine file, rather than passing on nothing", () => {
    expect(checkBuild(pack, bundle("console.log(1)"), false)).toContain("names no engine file");
  });
});

describe("packImports", () => {
  test("resolves what an engine file imports against its own folder, once each", () => {
    const files = [
      { path: "math/math-markup.js", text: 'import{n as e}from"../assets/rolldown-runtime-QTnfLwEv.js";import{_ as r}from"../assets/index-Bo8qjcMF.js";' },
      { path: "math/katex/katex.js", text: 'import"../../assets/index-Bo8qjcMF.js";import{t}from"../math-markup.js";' },
      { path: "math/katex/katex.css", text: "@font-face{src:url(./KaTeX_Main-Regular.woff2)}" },
      { path: "math/katex/KaTeX_Main-Regular.woff2", text: 'binary from"../assets/never.js"' },
      { path: "math/mathjax/greek.js", text: 'const dynamic = "../node_modules/@mathjax/font/mjs/svg/dynamic/PUA.js";' },
    ];
    expect(packImports(files).toSorted()).toEqual([
      "assets/index-Bo8qjcMF.js",
      "assets/rolldown-runtime-QTnfLwEv.js",
      "math/katex/KaTeX_Main-Regular.woff2",
      "math/math-markup.js",
    ]);
  });
});

describe("checkPackImports", () => {
  const imports = ["assets/index-Bo8qjcMF.js", "math/math-markup.js"];
  const packSet = new Set(["math/math-markup.js"]);

  test("passes when the build holds the shell files and the pack holds its own", () => {
    expect(checkPackImports(imports, packSet, (rel) => rel === "assets/index-Bo8qjcMF.js")).toBeNull();
  });

  test("fails when the build's entry chunk has another name, the case a per-build hash makes", () => {
    expect(checkPackImports(imports, packSet, () => false)).toContain("assets/index-Bo8qjcMF.js");
  });

  test("fails when the pack imports one of its own files it does not hold", () => {
    expect(checkPackImports(imports, new Set(), () => true)).toContain("math/math-markup.js");
  });
});
