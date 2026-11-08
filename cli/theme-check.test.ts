import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { en } from "../web/src/lib/i18n/messages/en.ts";
import { THEME_MAX_BYTES } from "../web/src/lib/theme/schema.ts";
import { capture } from "./fakes.ts";
import { EXIT } from "./io.ts";
import { cmdTheme, cmdThemeCheck, realThemeFiles, type FileReport, type ThemeFiles } from "./theme-check.ts";

// `collie theme check` (M59 spec 05), driven through its one seam: a map of paths to texts. The
// shipped files are read from the tree, so a shipped theme the parser starts to refuse fails here.

const HARBOUR = readFileSync(resolve(import.meta.dirname, "../web/src/themes/harbour.json"), "utf8");

function fakeFiles(entries: Record<string, string>, sizes: Record<string, number> = {}) {
  const reads: string[] = [];
  const files: ThemeFiles = {
    size: (path) => sizes[path] ?? (path in entries ? new TextEncoder().encode(entries[path]).length : null),
    read: (path) => {
      reads.push(path);
      return entries[path] ?? null;
    },
  };
  return { files, reads };
}

function world(entries: Record<string, string>, sizes: Record<string, number> = {}) {
  const io = capture();
  const { files, reads } = fakeFiles(entries, sizes);
  return { deps: { io, files }, io, reads };
}

const GOOD = JSON.stringify({ version: 1, id: "my-day", name: "My day", author: "Sam", light: { background: "#ffffff" } });

describe("collie theme check", () => {
  test("a shipped theme passes with --shipped, and prints one ok line", () => {
    const { deps, io } = world({ "harbour.json": HARBOUR });
    expect(cmdThemeCheck(deps, ["--shipped", "harbour.json"])).toBe(EXIT.OK);
    expect(io.stdout).toEqual(['harbour.json: ok, "Harbour" (harbour), version 2, every contrast check passes']);
    expect(io.stderr).toEqual([]);
  });

  test("a shipped theme without --shipped is refused as an import would refuse it", () => {
    const { deps, io } = world({ "harbour.json": HARBOUR });
    expect(cmdThemeCheck(deps, ["harbour.json"])).toBe(EXIT.FAIL);
    expect(io.stdout).toEqual([`harbour.json: refused: ${en["theme.refusal.reserved-id"]} (id)`]);
  });

  test("a theme of one's own passes", () => {
    const { deps, io } = world({ "collie-theme.json": GOOD });
    expect(cmdThemeCheck(deps, ["collie-theme.json"])).toBe(EXIT.OK);
    expect(io.stdout).toEqual(['collie-theme.json: ok, "My day" (my-day), version 1, every contrast check passes']);
  });

  test("a broken file fails with the app's headline, the place and the parser's words", () => {
    const broken = JSON.stringify({ version: 1, id: "x", name: "X", dark: { background: "red" }, bar: 1 });
    const { deps, io } = world({ "bad.json": broken });
    expect(cmdThemeCheck(deps, ["bad.json"])).toBe(EXIT.FAIL);
    expect(io.stdout).toEqual([
      `bad.json: refused: ${en["theme.refusal.unknown-key"]} (bar: "bar" is not part of a theme file. Remove it.)`,
      `bad.json: refused: ${en["theme.refusal.value"]} (dark.background: "dark.background" is not a colour. Use #rrggbb, #rrggbbaa, oklch(L C H) or oklch(L C H / A).)`,
    ]);
  });

  test("a version 4 file with a character passes, and the report says version 4", () => {
    for (const character of ["collie", "kawaii", "kawaii-tilt", "pixel"]) {
      const file = JSON.stringify({ version: 4, id: "my-day", name: "My day", character, light: { background: "#ffffff" } });
      const { deps, io } = world({ "character.json": file });
      expect(cmdThemeCheck(deps, ["character.json"])).toBe(EXIT.OK);
      expect(io.stdout).toEqual(['character.json: ok, "My day" (my-day), version 4, every contrast check passes']);
    }
  });

  test("a character in a file that says version 3 is refused with the version it needs", () => {
    const file = JSON.stringify({ version: 3, id: "my-day", name: "My day", character: "pixel", light: { background: "#ffffff" } });
    const { deps, io } = world({ "character.json": file });
    expect(cmdThemeCheck(deps, ["character.json"])).toBe(EXIT.FAIL);
    expect(io.stdout).toEqual([
      `character.json: refused: ${en["theme.refusal.version"]} (character: A file with "character" must say version 4. This one says version 3.)`,
    ]);
  });

  test("an unknown character word is refused with the character headline and the list of words", () => {
    const file = JSON.stringify({ version: 4, id: "my-day", name: "My day", character: "dog", light: { background: "#ffffff" } });
    const { deps, io } = world({ "character.json": file });
    expect(cmdThemeCheck(deps, ["character.json"])).toBe(EXIT.FAIL);
    expect(io.stdout).toEqual([
      `character.json: refused: ${en["theme.refusal.mark"]} (character: "character" must be one of: collie, kawaii, kawaii-tilt, pixel.)`,
    ]);
  });

  test("text that is not JSON is refused with the json headline", () => {
    const { deps, io } = world({ "bad.json": "{ not json" });
    expect(cmdThemeCheck(deps, ["bad.json"])).toBe(EXIT.FAIL);
    expect(io.stdout).toEqual([`bad.json: refused: ${en["theme.refusal.json"]} ($: The file is not a JSON object.)`]);
  });

  test("a file over the cap is refused on its size, before a byte is read", () => {
    const { deps, io, reads } = world({ "big.json": GOOD }, { "big.json": THEME_MAX_BYTES + 1 });
    expect(cmdThemeCheck(deps, ["big.json"])).toBe(EXIT.FAIL);
    expect(reads).toEqual([]);
    expect(io.stdout).toEqual([
      `big.json: refused: ${en["theme.refusal.size"]} ($: The file is ${THEME_MAX_BYTES + 1} bytes. A theme may be at most ${THEME_MAX_BYTES} bytes.)`,
    ]);
  });

  test("a missing file is refused, and the other files are still checked", () => {
    const { deps, io } = world({ "good.json": GOOD });
    expect(cmdThemeCheck(deps, ["missing.json", "good.json"])).toBe(EXIT.FAIL);
    expect(io.stdout).toEqual([
      "missing.json: refused: cannot read the file",
      'good.json: ok, "My day" (my-day), version 1, every contrast check passes',
    ]);
  });

  test("a contrast warning prints the preview's line and does not fail the check", () => {
    const dim = JSON.stringify({ version: 1, id: "dim", name: "Dim", dark: { foreground: "#333333" } });
    const { deps, io } = world({ "dim.json": dim });
    expect(cmdThemeCheck(deps, ["dim.json"])).toBe(EXIT.OK);
    const [head, ...warnings] = io.stdout;
    expect(head).toMatch(/^dim\.json: ok, "Dim" \(dim\), version 1, \d+ contrast warnings?$/);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toMatch(/^dim\.json: warning: Dark: foreground on background measures [\d.]+\. The floor is 4\.5\.$/);
  });

  test("--json prints one object: ok, and one report per file", () => {
    const dim = JSON.stringify({ version: 1, id: "dim", name: "Dim", dark: { foreground: "#333333" } });
    const { deps, io } = world({ "dim.json": dim, "bad.json": "[]" });
    expect(cmdThemeCheck(deps, ["--json", "dim.json", "bad.json", "gone.json"])).toBe(EXIT.FAIL);
    expect(io.stdout).toHaveLength(1);
    // SAFETY: `cmdThemeCheck` prints exactly one line under --json, `JSON.stringify({ ok, files })`
    // with `files` built as FileReport[]; the assertions below check the shape they rely on.
    const report = JSON.parse(io.stdout[0] ?? "") as { ok: boolean; files: FileReport[] };
    expect(report.ok).toBe(false);
    expect(report.files.map((file) => [file.file, file.ok])).toEqual([
      ["dim.json", true],
      ["bad.json", false],
      ["gone.json", false],
    ]);
    const [good, bad, gone] = report.files;
    expect(good).toMatchObject({ id: "dim", name: "Dim", version: 1 });
    expect(good?.ok === true && good.warnings[0]).toMatchObject({ half: "dark", check: "foreground on background", floor: 4.5 });
    expect(good?.ok === true && Object.keys(good.warnings[0] ?? {})).toEqual(["half", "check", "ratio", "floor", "text"]);
    expect(bad).toEqual({
      file: "bad.json",
      ok: false,
      refusals: [{ code: "json", headline: en["theme.refusal.json"], path: "$", detail: "The file is not a JSON object." }],
    });
    expect(gone).toEqual({ file: "gone.json", ok: false, error: "cannot read the file", refusals: [] });
  });

  test("--json of a passing set says ok and exits 0", () => {
    const { deps, io } = world({ "good.json": GOOD });
    expect(cmdThemeCheck(deps, ["good.json", "--json"])).toBe(EXIT.OK);
    expect(JSON.parse(io.stdout[0] ?? "")).toEqual({
      ok: true,
      files: [{ file: "good.json", ok: true, id: "my-day", name: "My day", version: 1, warnings: [] }],
    });
  });

  test("no file, an unknown flag and an unknown sub-verb are usage errors, and nothing is read", () => {
    for (const run of [
      (deps: ReturnType<typeof world>["deps"]) => cmdThemeCheck(deps, []),
      (deps: ReturnType<typeof world>["deps"]) => cmdThemeCheck(deps, ["--fix", "good.json"]),
      (deps: ReturnType<typeof world>["deps"]) => cmdTheme(deps, []),
      (deps: ReturnType<typeof world>["deps"]) => cmdTheme(deps, ["lint", "good.json"]),
    ]) {
      const { deps, io, reads } = world({ "good.json": GOOD });
      expect(run(deps)).toBe(EXIT.USAGE);
      expect(reads).toEqual([]);
      expect(io.stdout).toEqual([]);
      expect(io.stderr.join("\n")).toContain("usage: collie theme check");
    }
  });

  test("`theme check` through the tree's fallback is the same verb", () => {
    const { deps, io } = world({ "good.json": GOOD });
    expect(cmdTheme(deps, ["check", "good.json"])).toBe(EXIT.OK);
    expect(io.stdout).toHaveLength(1);
  });

  test("the real seam answers null for a directory and a missing path, and reads a file", () => {
    const here = resolve(import.meta.dirname, "../web/src/themes");
    expect(realThemeFiles.size(here)).toBeNull();
    expect(realThemeFiles.size(`${here}/missing.json`)).toBeNull();
    expect(realThemeFiles.read(`${here}/harbour.json`)).toBe(HARBOUR);
  });
});
