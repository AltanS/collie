import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// THE CAPABILITY FENCE, enforced by a test because this repo wires no ESLint runner yet.
//
// web/eslint.config.mjs declares a `no-restricted-imports` rule banning the network API
// (@/lib/api / a relative "…/api" path) under src/lib/harness/**, with ONE exception: guard.ts, the
// race-guard engine that legitimately re-fetches the pane before a guarded keystroke. But nothing
// runs ESLint in CI. So this Vitest test re-implements the fence's INTENT — a socket call types into
// a real terminal, so the harness detection layer must stay pure of I/O — and `bun run test` (which
// the pre-push hook runs) enforces it. If an ESLint runner is added later, the rule and this test
// simply agree.

const HARNESS_DIR = import.meta.dirname; // src/lib/harness
const GUARD_FILE = "guard.ts"; // the sole allowed importer of the network API

// The quoted network-API specifier: the "@/lib/api" alias or any relative "…/api" path (./api,
// ../api, ../../api, …), with an optional .js/.ts extension. Matched against the WHOLE file text (not
// line-by-line) so a Prettier-wrapped `import {\n  fetchPane,\n} from "../api";` — whose closing
// `} from "../api";` line carries no import keyword — is still caught. A harness file has no
// legitimate reason to even MENTION a quoted api specifier, so no import-keyword co-anchor is needed;
// the quoted-specifier shape (a sibling like "../ansi" ends in "ansi", not "api") is the whole guard.
const NETWORK_API_SPECIFIER = /["'`](?:@\/lib\/api|(?:\.{1,2}\/)+api)(?:\.[jt]s)?["'`]/;

// The fence guards the PRODUCTION detection layer, so test files are out of scope: a `*.test.ts` may
// legitimately reference the network API (to mock it, or — as this very file does — to assert the
// fence catches an api specifier), and it never runs on the render/keystroke path. Excluding them is
// also what lets this suite's own self-test embed a literal `from "../api"` without self-flagging.
function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectSourceFiles(full));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

// Pure content predicate (takes the file TEXT, not a path) so it can be unit-tested directly against
// a multi-line import literal — and so the whole-file match survives a Prettier line wrap.
function importsNetworkApi(source: string): boolean {
  return NETWORK_API_SPECIFIER.test(source);
}

describe("harness network-API fence", () => {
  const files = collectSourceFiles(HARNESS_DIR);

  it("finds harness source files to check (guard against a broken glob)", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("no harness module except guard.ts imports the network API", () => {
    const offenders = files
      .filter((file) => relative(HARNESS_DIR, file) !== GUARD_FILE)
      .filter((file) => importsNetworkApi(readFileSync(file, "utf8")))
      .map((file) => relative(HARNESS_DIR, file));
    expect(offenders).toEqual([]);
  });

  it("guard.ts is the ONE module that legitimately imports it (so the fence is real, not vacuous)", () => {
    expect(importsNetworkApi(readFileSync(join(HARNESS_DIR, GUARD_FILE), "utf8"))).toBe(true);
  });

  // The whole-file (not line-by-line) match is the fix: a Prettier-wrapped multi-line import must be
  // caught even though its `} from "../api";` line has no import keyword. A sibling "../ansi" must not.
  it("importsNetworkApi catches a single-line AND a multi-line api import", () => {
    expect(importsNetworkApi(`import { fetchPane } from "../api";`)).toBe(true);
    expect(importsNetworkApi(`import {\n  fetchPane,\n} from "../api";`)).toBe(true);
    expect(importsNetworkApi(`import { fetchPane } from "@/lib/api";`)).toBe(true);
    expect(importsNetworkApi(`import { splitLines } from "../ansi";`)).toBe(false);
  });
});
