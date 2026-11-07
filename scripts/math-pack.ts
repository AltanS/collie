#!/usr/bin/env bun
// ── THE MATH PACK'S RELEASE CHECK (ADR 0132 Decisions 2 and 3) ───────────────────────────────
//
//   bun scripts/math-pack.ts check --pack <collie-math-<version>.tar.gz> <web/dist> [<web/dist> …]
//
// The release job builds the pack from its own `web/dist/math`, and every payload builds `web/dist` on
// its own runner. The engines are self-contained bundles (web/vite.math.ts): nothing under `math/`
// imports a file outside it, and the app loads an engine by a fixed URL (web/src/lib/math/
// engine-files.ts). So the pack fits a payload whatever that payload's own chunks are called, and
// this check proves the two halves of that, failing the release before anything is published when:
//
//   • the pack is not one the host would accept (the same reader, bridge/math/tar.ts);
//   • the pack lacks an entry file or a stylesheet the app's loader names;
//   • a file under `math/<engine>/` imports a file outside `math/<engine>/`, or one the pack lacks:
//     an engine that leans on the app's build, or on the other engine, is the coupling ruled out;
//   • an engine's own marker string is missing from the pack, so the next rule would prove nothing;
//   • a payload's `web/dist` carries engine code outside `math/`: the app bundle holds none;
//   • a payload's `web/dist` holds a `math/` folder that is not the pack, byte for byte. The payloads
//     drop it (release.yml, build-windows-payload.ps1); a source build keeps the one it built.
//
// Each `<web/dist>` is a folder the workflow extracted from a payload tarball, the Windows zip or the
// `web-dist` asset. Exit 0 and one line per folder, or exit 1 and the reason.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";

import { readPackTar, type PackFile } from "../bridge/math/tar.ts";
import { MATH_ENGINE_NAMES, mathEngineFiles, type MathEngineName } from "../web/src/lib/math/engine-files.ts";

/**
 * A string each engine's code holds and the app's never does: KaTeX's parse error and MathJax's
 * "a font range is still loading" error. The app names the engines (Settings says "KaTeX"), so the
 * engine's name alone would not do.
 */
export const ENGINE_MARKERS = {
  katex: "KaTeX parse error",
  mathjax: "MathJax retry",
} satisfies Record<MathEngineName, string>;

/**
 * A relative file a pack file imports or points a `url()` at. A bare string that merely looks like a
 * path (MathJax names its font ranges so) is not a reference.
 * For example: `from"./svg.js"`, `import(\`./greek.js\`)`, `url(./a.woff2)`. */
const RELATIVE_REFERENCE =
  /(?:\b(?:from|import)\s*\(?\s*["'`]|\burl\(\s*["']?)((?:\.\.?\/)[A-Za-z0-9_@+./-]+\.(?:js|css|woff2))(?=["'`)\s])/g;

/** Every relative file one pack file names, resolved to a path under the web root. */
function referencesOf(file: { path: string; text: string }): string[] {
  if (!/\.(?:js|css)$/.test(file.path)) return [];
  return [...file.text.matchAll(RELATIVE_REFERENCE)].map((m) => posix.normalize(posix.join(posix.dirname(file.path), m[1]!)));
}

/** The engine folder a pack path sits in (`math/katex`), or null for a file at `math/` itself. */
function engineFolder(path: string): string | null {
  const parts = path.split("/");
  return parts.length >= 3 ? `${parts[0]}/${parts[1]}` : null;
}

/** What is wrong with the pack on its own, or null: its entries, its imports, its markers. */
export function checkPack(files: readonly { path: string; text: string }[]): string | null {
  const paths = new Set(files.map((f) => f.path));
  for (const engine of MATH_ENGINE_NAMES) {
    const { module, stylesheet } = mathEngineFiles(engine);
    for (const want of [module, stylesheet]) if (!paths.has(want)) return `it lacks ${want}, which the app's loader names`;
  }
  for (const file of files) {
    const folder = engineFolder(file.path);
    for (const ref of referencesOf(file)) {
      if (folder === null || engineFolder(ref) !== folder) return `${file.path} imports ${ref}, outside its own engine folder`;
      if (!paths.has(ref)) return `${file.path} imports ${ref}, which the pack lacks`;
    }
  }
  for (const engine of MATH_ENGINE_NAMES) {
    const marker = ENGINE_MARKERS[engine];
    if (!files.some((f) => f.path.startsWith(`math/${engine}/`) && f.text.includes(marker))) {
      return `no file under math/${engine}/ holds "${marker}", so the check for engine code in the app proves nothing`;
    }
  }
  return null;
}

/** Every file of a build, as (path under the web root with `/`, bytes). */
function buildFiles(dist: string): PackFile[] {
  const out: PackFile[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push({ path: relative(dist, full).split(sep).join("/"), data: readFileSync(full) });
    }
  };
  walk(dist);
  return out;
}

/** What is wrong with one build against the pack, or null when nothing is. */
export function checkBuild(pack: readonly PackFile[], build: readonly PackFile[]): string | null {
  const decoder = new TextDecoder();
  for (const file of build) {
    if (file.path.startsWith("math/") || !/\.(?:js|mjs|css|html)$/.test(file.path)) continue;
    const text = decoder.decode(file.data);
    for (const engine of MATH_ENGINE_NAMES) {
      if (text.includes(ENGINE_MARKERS[engine])) return `${file.path} holds ${engine} code; the app bundle may hold none`;
    }
  }
  const math = build.filter((f) => f.path.startsWith("math/"));
  if (math.length === 0) return null;
  const want = new Map(pack.map((f) => [f.path, f.data]));
  if (math.length !== want.size) return `its math/ holds ${math.length} file(s) and the pack ${want.size}; a math/ it carries must be the pack`;
  for (const file of math) {
    const other = want.get(file.path);
    if (other === undefined) return `its math/ holds ${file.path}, which the pack lacks`;
    if (Buffer.compare(Buffer.from(file.data), Buffer.from(other)) !== 0) return `its ${file.path} is not the pack's`;
  }
  return null;
}

function main(argv: readonly string[]): number {
  const usage = "usage: bun scripts/math-pack.ts check --pack <collie-math-<version>.tar.gz> <web/dist>...";
  if (argv[0] !== "check") {
    console.error(usage);
    return 2;
  }
  const at = argv.indexOf("--pack");
  const packFile = at === -1 ? undefined : argv[at + 1];
  const dists = argv.slice(1).filter((_, i) => i + 1 !== at && i + 1 !== at + 1);
  if (packFile === undefined || dists.length === 0) {
    console.error(usage);
    return 2;
  }
  let pack: PackFile[];
  try {
    pack = readPackTar(Bun.gunzipSync(readFileSync(packFile))).files;
  } catch (err) {
    console.error(`✗ ${packFile} is not a pack the host would accept: ${String(err)}`);
    return 1;
  }
  const decoder = new TextDecoder();
  const packProblem = checkPack(pack.map((f) => ({ path: f.path, text: decoder.decode(f.data) })));
  if (packProblem !== null) {
    console.error(`✗ ${packFile}: ${packProblem}`);
    return 1;
  }
  console.log(`✓ ${packFile}: ${pack.length} files, every engine self-contained under its own math/ folder`);
  let failed = false;
  for (const dist of dists) {
    if (!existsSync(join(dist, "index.html")) || !statSync(dist).isDirectory()) {
      console.error(`✗ ${dist} is not a web build (no index.html)`);
      failed = true;
      continue;
    }
    const problem = checkBuild(pack, buildFiles(dist));
    if (problem === null) console.log(`✓ ${dist}: no engine code in the app, and no math/ but the pack's`);
    else {
      console.error(`✗ ${dist}: ${problem}`);
      failed = true;
    }
  }
  return failed ? 1 : 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
