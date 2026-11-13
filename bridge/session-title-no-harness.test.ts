import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The session-name code names no harness (2026-11-13). Which rows name a session is each journal
// adapter's `nameProbe`, and which harness has a screen or argv fallback is data in
// harness-name-sources.ts. Everything that decides HOW a session is named, cleaned, ordered or listed
// is shared code, and an `if (agent === "claude")` there is the special case this guard refuses.
//
// The ids are the file stems of the harness profiles, read by directory, so a new harness joins the
// check with no edit here. Comments are stripped by Bun's own transpiler before the scan.

const ROOT = join(import.meta.dirname, "..");
const PROFILES = join(ROOT, "web", "src", "lib", "surface", "profiles");

/** Files that hold the name rule itself: no harness id may appear in them as a string at all. */
const RULE_FILES = [
  "bridge/pane-name.ts",
  "web/src/lib/pane-name.ts",
  "bridge/session-title.ts",
  "bridge/session-titles.ts",
  "bridge/session-titles-store.ts",
  "bridge/walky/names.ts",
  "web/src/lib/walky-names.ts",
  "bridge/cache/watch-key.ts",
  "bridge/push-name.ts",
];

/**
 * Files that carry a name through a wider job: no comparison against a harness id. The state engine
 * keeps the bridge's one screen grammar (CLAUDE.md, "the phone parses what the phone draws"), which
 * loads its profile by id; what it may not do is branch on a pane's harness.
 */
const BRANCH_FILES = ["bridge/state-engine.ts", "bridge/notifications.ts"];

function harnessIds(): string[] {
  return readdirSync(PROFILES)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.replace(/\.json$/u, ""));
}

const transpiler = new Bun.Transpiler({ loader: "ts" });

/** The file's code with comments and types gone. */
function codeOf(file: string): string {
  return transpiler.transformSync(readFileSync(join(ROOT, file), "utf8"));
}

/** Every string literal's text in a piece of code. */
function literalsOf(code: string): string[] {
  return [...code.matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*)\1/gu)].map((match) => match[2]!);
}

/** A comparison or a `case` against one harness id, in any quote. */
function branchesOn(code: string, id: string): boolean {
  const quoted = `["'\`]${id}["'\`]`;
  return new RegExp(`[!=]==?\\s*${quoted}|${quoted}\\s*[!=]==?|case\\s+${quoted}`, "u").test(code);
}

describe("no harness names in the session-name code", () => {
  const ids = harnessIds();

  test("finds the harness ids by directory", () => {
    expect(ids).toContain("claude");
    expect(ids).toContain("pi");
    expect(ids.length).toBeGreaterThan(5);
  });

  test("the scan sees a literal and a branch, and skips a comment", () => {
    const code = transpiler.transformSync(`// "claude" in a comment\nconst a = "x"; if (b === "claude") {}`);
    expect(literalsOf(code)).toContain("claude");
    expect(branchesOn(code, "claude")).toBe(true);
    expect(literalsOf(transpiler.transformSync(`// "claude"\nexport const a = 1;`))).not.toContain("claude");
  });

  for (const file of RULE_FILES) {
    test(`${file} holds no harness id`, () => {
      const literals = literalsOf(codeOf(file));
      expect(ids.filter((id) => literals.includes(id))).toEqual([]);
    });
  }

  for (const file of BRANCH_FILES) {
    test(`${file} branches on no harness id`, () => {
      const code = codeOf(file);
      expect(ids.filter((id) => branchesOn(code, id))).toEqual([]);
    });
  }
});
