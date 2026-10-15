#!/usr/bin/env bun
// Write `web/src/themes.css` from the shipped theme files in `web/src/themes/*.json` (M57).
//
//   bun scripts/build-themes.ts           write the file
//   bun scripts/build-themes.ts --check   exit 1 when the file on disk is not what it would write
//
// Each file is validated with the same `parseTheme` an import goes through, so a shipped theme
// cannot hold anything an imported one could not. The text itself comes from
// `web/src/lib/theme/themes-css.ts`, which the web suite also runs against the file on disk.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildThemesCss } from "../web/src/lib/theme/themes-css.ts";

const root = resolve(import.meta.dirname, "..");
const themesDir = resolve(root, "web/src/themes");
const target = resolve(root, "web/src/themes.css");

const files = readdirSync(themesDir)
  .filter((name) => name.endsWith(".json"))
  .toSorted()
  .map((name) => ({ name, raw: readFileSync(resolve(themesDir, name), "utf8") }));

const result = buildThemesCss(files);
if (!result.ok) {
  for (const line of result.errors) console.error(`build-themes: ${line}`);
  process.exit(1);
}

if (process.argv.includes("--check")) {
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
  console.log(`build-themes: web/src/themes.css is current (${files.length} theme files)`);
} else {
  writeFileSync(target, result.css);
  console.log(`build-themes: wrote web/src/themes.css from ${files.length} theme files`);
}
