#!/usr/bin/env bun
// Write `web/src/components/icons/KEYS.md`, the list of every icon key with its meaning and its glyph
// in each family, from the key table (`keys.ts`) and the family maps (`sets/`).
//
//   bun scripts/glyph-keys.ts           write the file
//   bun scripts/glyph-keys.ts --check   exit 1 when the file on disk is not what it would write

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { keysMarkdown } from "../web/src/components/icons/keys-md.ts";

const target = resolve(import.meta.dirname, "../web/src/components/icons/KEYS.md");
const text = keysMarkdown();

if (process.argv.includes("--check")) {
  const onDisk = readFileSync(target, "utf8");
  if (onDisk !== text) {
    console.error("glyph-keys: KEYS.md is out of date. Run: bun scripts/glyph-keys.ts");
    process.exit(1);
  }
  process.exit(0);
}
writeFileSync(target, text);
console.log(`glyph-keys: wrote ${target}`);
