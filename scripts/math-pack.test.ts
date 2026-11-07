import { describe, expect, test } from "bun:test";

import { checkBuild, checkPack, ENGINE_MARKERS } from "./math-pack.ts";

// ADR 0132 Decision 3: the engines are self-contained bundles under `math/<engine>/`, so the one pack
// fits every payload. The pack must hold what the app's loader names and import nothing outside each
// engine's own folder; a payload must carry no engine code outside `math/`, and no `math/` but the pack.

const text = (path: string, body: string) => ({ path, text: body });
const file = (path: string, body: string) => ({ path, data: new TextEncoder().encode(body) });

/** A pack shaped like the one web/vite.math.ts builds today. */
const packTexts = () => [
  text("math/katex/katex.js", `function p(){throw new Error("${ENGINE_MARKERS.katex}")}export{p as typeset}`),
  text("math/katex/katex.css", "@font-face{src:url(./KaTeX_Main-Regular.woff2)}"),
  text("math/katex/KaTeX_Main-Regular.woff2", 'binary from"../../assets/never.js"'),
  text("math/mathjax/mathjax.js", 'import{t}from"./svg.js";const m={"../../../node_modules/x/greek.js":()=>import(`./greek.js`)};export{t as typeset}'),
  text("math/mathjax/svg.js", `const e="${ENGINE_MARKERS.mathjax}";export{e as t}`),
  text("math/mathjax/greek.js", 'import{t as e}from"./svg.js";e.dynamicSetup(``,`greek`)'),
  text("math/mathjax/mathjax.css", "mjx-container{direction:ltr}"),
];

describe("checkPack", () => {
  test("passes a pack whose engines import only their own files", () => {
    expect(checkPack(packTexts())).toBeNull();
  });

  test("fails a pack that lacks an entry or a stylesheet the loader names", () => {
    expect(checkPack(packTexts().filter((f) => f.path !== "math/mathjax/mathjax.js"))).toContain("math/mathjax/mathjax.js");
    expect(checkPack(packTexts().filter((f) => f.path !== "math/katex/katex.css"))).toContain("math/katex/katex.css");
  });

  test("fails an engine that imports the app's entry chunk, the case run 2 of 1.28.0-edge.2 hit", () => {
    const files = [...packTexts(), text("math/katex/extra.js", 'import{_ as r}from"../../assets/index-CQCUTi4-.js";')];
    expect(checkPack(files)).toContain("assets/index-CQCUTi4-.js, outside its own engine folder");
  });

  test("fails an engine that imports the other engine's folder, or a file at math/ itself", () => {
    expect(checkPack([...packTexts(), text("math/katex/x.js", 'import"../mathjax/svg.js";')])).toContain("outside its own engine folder");
    expect(checkPack([...packTexts(), text("math/shared.js", 'import"./katex/katex.js";')])).toContain("outside its own engine folder");
  });

  test("fails an import of its own folder that the pack lacks", () => {
    expect(checkPack([...packTexts(), text("math/mathjax/x.js", 'import(`./fraktur.js`)')])).toContain("math/mathjax/fraktur.js, which the pack lacks");
  });

  test("fails a pack whose engine lost its marker, rather than passing the app check on nothing", () => {
    const files = packTexts().map((f) => (f.path === "math/mathjax/svg.js" ? text(f.path, "export{}") : f));
    expect(checkPack(files)).toContain(ENGINE_MARKERS.mathjax);
  });
});

describe("checkBuild", () => {
  const pack = packTexts().map((f) => file(f.path, f.text));
  const app = [file("index.html", "<html>"), file("assets/index-abc.js", 'const s="settings.math.note.katex";'), file("assets/index-abc.css", ".math-display{}")];

  test("passes a payload with no math/ and no engine code, whatever its chunks are called", () => {
    expect(checkBuild(pack, app)).toBeNull();
    expect(checkBuild(pack, app.map((f) => (f.path.startsWith("assets/") ? { ...f, path: f.path.replace("abc", "xyz") } : f)))).toBeNull();
  });

  test("passes a source build whose math/ is the pack, byte for byte", () => {
    expect(checkBuild(pack, [...app, ...pack])).toBeNull();
  });

  test("fails a build whose math/ differs from the pack in one byte, or one file", () => {
    const changed = pack.map((f) => (f.path === "math/katex/katex.css" ? file(f.path, "@font-face{}") : f));
    expect(checkBuild(pack, [...app, ...changed])).toContain("math/katex/katex.css is not the pack's");
    expect(checkBuild(pack, [...app, ...pack.slice(1)])).toContain("a math/ it carries must be the pack");
  });

  test("fails a build that carries engine code in an app chunk", () => {
    expect(checkBuild(pack, [...app, file("assets/katex-abc.js", `throw new Error("${ENGINE_MARKERS.katex}")`)])).toContain("holds katex code");
    expect(checkBuild(pack, [...app, file("assets/svg-abc.js", `"${ENGINE_MARKERS.mathjax}"`)])).toContain("holds mathjax code");
  });
});
