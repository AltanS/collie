#!/usr/bin/env bun
// Write `web/src/themes.css` from the shipped theme files in `web/src/themes/*.json` (M57), and the
// SURFACE line of `web/public/theme-init.js` from `web/src/lib/theme/surface.ts` (spec 14).
//
//   bun scripts/build-themes.ts           write both files
//   bun scripts/build-themes.ts --check   exit 1 when a file on disk is not what it would write
//
// Each file is validated with the same `parseTheme` an import goes through, so a shipped theme
// cannot hold anything an imported one could not. The text itself comes from
// `web/src/lib/theme/themes-css.ts`, which the web suite also runs against the file on disk.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { withSurfaceInitLine } from "../web/src/lib/theme/surface.ts";
import { buildThemesCss } from "../web/src/lib/theme/themes-css.ts";

const root = resolve(import.meta.dirname, "..");
const themesDir = resolve(root, "web/src/themes");
const target = resolve(root, "web/src/themes.css");
const initTarget = resolve(root, "web/public/theme-init.js");

const files = readdirSync(themesDir)
  .filter((name) => name.endsWith(".json"))
  .toSorted()
  .map((name) => ({ name, raw: readFileSync(resolve(themesDir, name), "utf8") }));

const result = buildThemesCss(files);
if (!result.ok) {
  for (const line of result.errors) console.error(`build-themes: ${line}`);
  process.exit(1);
}

const initCurrent = readFileSync(initTarget, "utf8");
const init = withSurfaceInitLine(initCurrent);
if (init === undefined) {
  console.error("build-themes: web/public/theme-init.js has no SURFACE marker line");
  process.exit(1);
}

if (process.argv.includes("--check")) {
  if (initCurrent !== init) {
    console.error("build-themes: web/public/theme-init.js is stale. Run `bun scripts/build-themes.ts`.");
    process.exit(1);
  }
  let current = "";
  try {
    current = readFileSync(target, "utf8");
  } catch {
    // A missing file is stale in the same way a wrong one is.
  }
  if (current !== result.css) {
    console.error("build-themes: web/src/themes.css is stale. Run `bun scripts/build-themes.ts`.");
    process.exit(1);
  }
  console.log(`build-themes: web/src/themes.css (${files.length} theme files) and the SURFACE line of web/public/theme-init.js are current`);
} else {
  writeFileSync(target, result.css);
  writeFileSync(initTarget, init);
  console.log(`build-themes: wrote web/src/themes.css from ${files.length} theme files and the SURFACE line of theme-init.js`);
}
