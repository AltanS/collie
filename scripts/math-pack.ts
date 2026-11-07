#!/usr/bin/env bun
// ── THE MATH PACK'S RELEASE CHECK (ADR 0132 Decisions 2 and 3) ───────────────────────────────
//
//   bun scripts/math-pack.ts check --pack <collie-math-<version>.tar.gz> <web/dist> [<web/dist> …]
//
// The release job builds the pack from its own `web/dist`, and every payload builds `web/dist` on its
// own runner. A dynamic import names a hashed file, so a payload whose bundle names an engine file the
// pack lacks would leave every formula as source on that platform. This check fails the release
// before anything is published when:
//
//   • the pack is not one the host would accept (the same reader, bridge/math/tar.ts);
//   • a payload's `web/dist` still holds a `math/` folder: no install carries the engines;
//   • a payload's bundle names no engine file at all, so the check would prove nothing;
//   • a payload's bundle names an engine file the pack does not hold;
//   • an engine file in the pack imports a file outside `math/` (the entry chunk, the runtime chunk)
//     that a payload's `web/dist` does not hold. The engine files carry no hash in their names, but
//     they still import the shell's hashed files, and a pack made beside another build would load
//     nothing there.
//
// Each `<web/dist>` is a folder the workflow extracted from a payload tarball, the Windows zip or the
// `web-dist` asset. Exit 0 and one line per folder, or exit 1 and the reason.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative } from "node:path";

import { readPackTar } from "../bridge/math/tar.ts";

/** Every `math/…` file a bundle file names: `../math/katex/katex-abc.js`, `/math/x.css`, `math/y.js`. */
const ENGINE_REFERENCE = /(?<![A-Za-z0-9_-])(?:\.\.\/|\/)?(math\/[A-Za-z0-9_@+./-]+\.(?:js|css|woff2))/g;

/** The engine files a bundle file's text names, as pack paths. */
export function engineReferences(text: string): string[] {
  return [...new Set([...text.matchAll(ENGINE_REFERENCE)].map((m) => m[1]!))];
}

/**
 * A relative file a pack file imports or points a `url()` at. A bare string that merely looks like a
 * path (MathJax names its font ranges so) is not a reference.
 * For example: `from"../assets/index-abc.js"`, `import("./svg.js")`, `url(./a.woff2)`. */
const RELATIVE_REFERENCE =
  /(?:\b(?:from|import)\s*\(?\s*["'`]|\burl\(\s*["']?)((?:\.\.?\/)[A-Za-z0-9_@+./-]+\.(?:js|css|woff2))(?=["'`)\s])/g;

/**
 * The files the pack's own files name, resolved to paths under the web root (`assets/index-abc.js`,
 * `math/katex/katex.js`), once each. A reference that climbs out of the web root is kept as it is.
 */
export function packImports(files: readonly { path: string; text: string }[]): string[] {
  const out = new Set<string>();
  for (const file of files) {
    if (!/\.(?:js|css)$/.test(file.path)) continue;
    for (const m of file.text.matchAll(RELATIVE_REFERENCE)) out.add(posix.normalize(posix.join(posix.dirname(file.path), m[1]!)));
  }
  return [...out];
}

/** What is wrong with the pack's imports, given what the pack and one payload's web root hold, or null. */
export function checkPackImports(imports: readonly string[], pack: ReadonlySet<string>, distHas: (rel: string) => boolean): string | null {
  const missing = imports.filter((rel) => (rel.startsWith("math/") ? !pack.has(rel) : !distHas(rel)));
  if (missing.length === 0) return null;
  return `the pack's engine files import ${missing.length} file(s) it or this build lacks, first ${missing[0]}`;
}

/** Every file of the build that is not under `math/`, as (relative name, text). */
function bundleFiles(dist: string): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(?:js|css|html)$/.test(entry.name)) out.push({ name: relative(dist, full), text: readFileSync(full, "utf8") });
    }
  };
  walk(dist);
  return out;
}

/** What is wrong with one build against the pack's paths, or null when nothing is. */
export function checkBuild(pack: ReadonlySet<string>, files: readonly { name: string; text: string }[], hasMathFolder: boolean): string | null {
  if (hasMathFolder) return "it still carries web/dist/math; no install may carry the engines";
  const named = new Set(files.flatMap((f) => engineReferences(f.text)));
  if (named.size === 0) return "its bundle names no engine file, so the check proves nothing; has the build's naming changed?";
  const missing = [...named].filter((path) => !pack.has(path));
  if (missing.length > 0) return `its bundle names ${missing.length} engine file(s) the pack lacks, first ${missing[0]}`;
  return null;
}

function main(argv: readonly string[]): number {
  if (argv[0] !== "check") {
    console.error("usage: bun scripts/math-pack.ts check --pack <collie-math-<version>.tar.gz> <web/dist>...");
    return 2;
  }
  const at = argv.indexOf("--pack");
  const packFile = at === -1 ? undefined : argv[at + 1];
  const dists = argv.slice(1).filter((_, i) => i + 1 !== at && i + 1 !== at + 1);
  if (packFile === undefined || dists.length === 0) {
    console.error("usage: bun scripts/math-pack.ts check --pack <collie-math-<version>.tar.gz> <web/dist>...");
    return 2;
  }
  let pack: Set<string>;
  let imports: string[];
  try {
    const files = readPackTar(Bun.gunzipSync(readFileSync(packFile))).files;
    pack = new Set(files.map((f) => f.path));
    imports = packImports(files.map((f) => ({ path: f.path, text: new TextDecoder().decode(f.data) })));
  } catch (err) {
    console.error(`✗ ${packFile} is not a pack the host would accept: ${String(err)}`);
    return 1;
  }
  console.log(`✓ ${packFile}: ${pack.size} files, all under math/`);
  let failed = false;
  for (const dist of dists) {
    if (!existsSync(join(dist, "index.html"))) {
      console.error(`✗ ${dist} is not a web build (no index.html)`);
      failed = true;
      continue;
    }
    const hasMath = existsSync(join(dist, "math")) && statSync(join(dist, "math")).isDirectory();
    const problem =
      checkBuild(pack, bundleFiles(dist), hasMath) ?? checkPackImports(imports, pack, (rel) => existsSync(join(dist, rel)));
    if (problem === null) console.log(`✓ ${dist}: every engine file its bundle names is in the pack, and the pack's own imports resolve`);
    else {
      console.error(`✗ ${dist}: ${problem}`);
      failed = true;
    }
  }
  return failed ? 1 : 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
