import { describe, expect, test } from "bun:test";

import { checkBuild, engineReferences } from "./math-pack.ts";

// ADR 0132 Decision 3: every engine file a payload's bundle names must be in the pack. The bundle's
// spelling is the one Vite emits today (`../math/katex/katex-<hash>.js` inside `assets/index-*.js`).

const pack = new Set(["math/katex/katex-DZ9JTSi9.js", "math/katex/katex-OQtkXlbv.css", "math/math-markup-C88Od698.js"]);
const bundle = (text: string) => [{ name: "assets/index-abc.js", text }];

describe("engineReferences", () => {
  test("reads the relative, the absolute and the bare spelling, once each", () => {
    const text = 'import("../math/katex/katex-DZ9JTSi9.js");m(["../math/katex/katex-OQtkXlbv.css","/math/math-markup-C88Od698.js"]);"math/math-markup-C88Od698.js"';
    expect(engineReferences(text).toSorted()).toEqual([...pack].toSorted());
  });

  test("takes no word that merely ends in math, and no folder without a file", () => {
    expect(engineReferences('const isMathLoadError = e.includes("/math/"); "aftermath/x.js"')).toEqual([]);
  });
});

describe("checkBuild", () => {
  test("passes a build whose every engine file is in the pack", () => {
    expect(checkBuild(pack, bundle('import("../math/katex/katex-DZ9JTSi9.js")'), false)).toBeNull();
  });

  test("fails a build that still carries web/dist/math", () => {
    expect(checkBuild(pack, bundle('import("../math/katex/katex-DZ9JTSi9.js")'), true)).toContain("web/dist/math");
  });

  test("fails a build that names a file the pack lacks", () => {
    expect(checkBuild(pack, bundle('import("../math/katex/katex-OTHER123.js")'), false)).toContain("math/katex/katex-OTHER123.js");
  });

  test("fails a build that names no engine file, rather than passing on nothing", () => {
    expect(checkBuild(pack, bundle("console.log(1)"), false)).toContain("names no engine file");
  });
});
