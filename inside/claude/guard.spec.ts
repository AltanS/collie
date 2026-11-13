// The guard (M99 spec 02, README decision 13): the Collie mod never calls a completion, never runs a
// host command, never writes a file, never loads code at run time, and never holds a tool call in
// `tool.check`. It reads every source file the mod ships, comments removed, for those names.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const HOOKS = join(import.meta.dir, "hooks");

/** The source with line and block comments removed. Strings stay: a name in a string is still a name. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/(^|[^:])\/\/.*$/gmu, "$1");
}

const BANNED: readonly [string, RegExp][] = [
  ["the model noun", /\bmodel\b/u],
  ["the process noun", /\bprocess\b/u],
  ["a file write", /\.\s*write\s*\(/u],
  ["a file write by name", /\bwrite(File|Text)?\b/u],
  ["code loaded at run time", /\bimport\s*\(/u],
  ["a hold in tool.check", /tool\.check/u],
  ["a tool call hook", /tool\.call/u],
  ["eval", /\b(eval|Function)\s*\(/u],
];

describe("the Collie mod's source", () => {
  const files = readdirSync(HOOKS).filter((name) => /\.(ts|js|mjs|cjs|mts|cts|tsx|jsx)$/u.test(name));

  test("the guard reads every module the mod ships", () => {
    expect(files.toSorted()).toEqual(["core.ts", "register.ts"]);
  });

  for (const [what, pattern] of BANNED) {
    test(`never names ${what}`, () => {
      for (const name of files) expect(code(readFileSync(join(HOOKS, name), "utf8")), `${name}: ${what}`).not.toMatch(pattern);
    });
  }

  test("the guard itself catches what it bans", () => {
    expect(code("const x = await $.model.complete({})")).toMatch(BANNED[0]![1]);
    expect(code("// $.model is fine in a comment\nconst y = 1")).not.toMatch(BANNED[0]![1]);
    expect(code("$.process.run(['ls'])")).toMatch(BANNED[1]![1]);
    expect(code("await $.fs.write('/x', 'y')")).toMatch(BANNED[2]![1]);
  });
});
