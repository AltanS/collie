// The code of a trick for the About sheet's "Read the code" folds in the playground (2026-11-17, package F):
// what the bridge sends (bridge/tricks/code-view.ts), written out by hand so the states show every case. A small
// trick, so no real host, home or key appears: names are `lodge` and `/home/dev`, and the one key is already
// masked the way the bridge sends it.

import type { WireCodeFile, WireCodeIndex } from "@/lib/tricks/code-wire";

const HASH = "c3a91f0d7e42b8561a09d4e7f23c85b1a6d0e94f7c21b83a5d60e19f4a7c2b85";

const LEGS_LINES = [
  'import { trick } from "./trick.ts";',
  "",
  'const API = "https://api.example.test/v1/checks?branch=release&include=pending,failed,passed&format=compact&limit=50";',
  'const TOKEN = "sk-o••••••••••••••••••••••••••••••";',
  "",
  "const t = trick();",
  "const reply = await fetch(API, { headers: { authorization: `Bearer ${TOKEN}` } });",
  "const checks = await reply.json();",
  "",
  'const sha = await t.sh("git", ["rev-parse", "--short", "HEAD"]);',
  'await Bun.write("/home/dev/checks/latest.json", JSON.stringify(checks));',
  "",
  "t.belt({ label: `${checks.length} checks`, intent: \"open\" });",
];

export const LEGS_CODE_FILE: WireCodeFile = {
  file: "legs.ts",
  size: 612,
  lines: LEGS_LINES,
  leftOut: 0,
  masked: 1,
  marks: [
    { line: 7, kinds: ["network"] },
    { line: 10, kinds: ["spawn"] },
    { line: 11, kinds: ["write"] },
  ],
  marksLeft: 0,
};

export const MANIFEST_CODE_FILE: WireCodeFile = {
  file: "trick.toml",
  size: 168,
  lines: ['id = "legs"', 'name = "Browser leg"', 'run = "bun legs.ts"', 'every = "5m"', 'places = ["belt"]', 'env = ["CHECKS_TOKEN"]'],
  leftOut: 0,
  masked: 0,
  marks: [],
  marksLeft: 0,
};

/** A file too long for the phone: its first part, and how much is left out, with a flag in the part not shown. */
export const LONG_CODE_FILE: WireCodeFile = {
  file: "legs.ts",
  size: 91_648,
  lines: LEGS_LINES,
  leftOut: 59_392,
  masked: 1,
  marks: [{ line: 7, kinds: ["network"] }],
  marksLeft: 2,
};

export const CODE_INDEX: WireCodeIndex = {
  hash: HASH,
  copy: "approved",
  files: [
    { file: "trick.toml", size: 168, flagged: 0 },
    { file: "legs.ts", size: 612, flagged: 3 },
    { file: "trick.ts", size: 4096, flagged: 0 },
    { file: "tools/checks-helper", size: 53_248, binary: true, flagged: 0 },
  ],
};

export const CODE_INDEX_NEXT: WireCodeIndex = { ...CODE_INDEX, copy: "next" };

export const CODE_INDEX_LONG: WireCodeIndex = { ...CODE_INDEX, files: [CODE_INDEX.files[0] ?? { file: "trick.toml", size: 168, flagged: 0 }, { file: "legs.ts", size: 91_648, flagged: 3 }] };

/** One file of the playground's trick, by name. */
export function codeFileOf(file: string, long = false): WireCodeFile {
  if (file === "legs.ts") return long ? LONG_CODE_FILE : LEGS_CODE_FILE;
  if (file === "trick.toml") return MANIFEST_CODE_FILE;
  return { file, size: 4096, lines: ["// collie trick helper v5", "export function trick() {", "  // the helper Collie ships, unchanged", "}"], leftOut: 0, masked: 0, marks: [], marksLeft: 0 };
}
