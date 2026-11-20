import { describe, expect, test } from "bun:test";

import { capture, CONFIG, context, fakeFiles } from "./fakes.ts";
import { cmdConfigCheck } from "./config.ts";
import { EXIT } from "./io.ts";
import { readShortcutsReport, shortcutsLines, shortcutsPath } from "./shortcuts-file.ts";
import { shortcutsFinding } from "./shortcuts-finding.ts";

const FILE = shortcutsPath(CONFIG);
const BROKEN = '[keys]\nZoom = "z"\nnew_tab = ["ctrl+alt+c", "prefix+"]\nnew_workspace = "prefix+n"\nzen_mode = "ctrl+alt+z"\n';
const CLEAN = '[keys]\nzen_mode = "ctrl+alt+z"\n';

describe("shortcutsLines", () => {
  test("names a bad name, a bad binding and a Herdr name, each with its reason", () => {
    const lines = shortcutsLines(BROKEN);
    expect(lines.some((l) => l.includes('"Zoom"'))).toBe(true);
    expect(lines.some((l) => l.startsWith("invalid-binding:") && l.includes("prefix+"))).toBe(true);
    expect(lines.some((l) => l.startsWith("herdr-name:"))).toBe(true);
  });

  test("a clean file and an empty one give no lines", () => {
    expect(shortcutsLines(CLEAN)).toEqual([]);
    expect(shortcutsLines("")).toEqual([]);
  });

  test("a file that is not TOML gives one line, and no control character", () => {
    const lines = shortcutsLines("[keys\n\u0007");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("could not be parsed");
    expect([...(lines[0] ?? "")].some((ch) => ch.charCodeAt(0) < 32)).toBe(false);
  });

  test("a name over the cap is named like the bridge names it", () => {
    expect(shortcutsLines(`[keys]\n${"a".repeat(65)} = "x"\n`)).toHaveLength(1);
  });
});

describe("readShortcutsReport and the doctor row", () => {
  test("no file is null and no row", () => {
    const files = fakeFiles();
    expect(readShortcutsReport({ configDir: CONFIG, files })).toBeNull();
    expect(shortcutsFinding({ configDir: CONFIG, files })).toEqual([]);
  });

  test("a clean file gives an empty report and no row", () => {
    const files = fakeFiles({ [FILE]: CLEAN });
    expect(readShortcutsReport({ configDir: CONFIG, files })?.lines).toEqual([]);
    expect(shortcutsFinding({ configDir: CONFIG, files })).toEqual([]);
  });

  test("a broken file is one warn row that names the file and the lines", () => {
    const [row] = shortcutsFinding({ configDir: CONFIG, files: fakeFiles({ [FILE]: BROKEN }) });
    expect(row).toMatchObject({ check: "shortcuts-file", status: "warn" });
    expect(row?.detail).toContain(FILE);
    expect(row?.detail).toContain("herdr-name:");
  });
});

describe("config check over shortcuts.toml", () => {
  function run(seed: Record<string, string>, args: string[] = []) {
    const io = capture();
    const files = fakeFiles(seed);
    const code = cmdConfigCheck({ ctx: context({}, {}), io, files }, args);
    return { code, io };
  }

  test("a broken file prints its lines as errors and fails", () => {
    const { code, io } = run({ [FILE]: BROKEN });
    expect(code).toBe(EXIT.FAIL);
    expect(io.stderr.some((l) => l.startsWith("error: shortcuts.toml:") && l.includes('"Zoom"'))).toBe(true);
  });

  test("a control character in a binding never reaches the printed output", () => {
    const { io } = run({ [FILE]: '[keys]\nnew_tab = "prefix+\\u001b[31m"\n' });
    expect(io.stderr.some((l) => l.includes('"new_tab"'))).toBe(true);
    for (const line of [...io.stdout, ...io.stderr]) expect([...line].some((ch) => /\p{Cc}/u.test(ch))).toBe(false);
  });

  test("a clean file and a missing file add nothing", () => {
    expect(run({ [FILE]: CLEAN }).code).toBe(EXIT.OK);
    const missing = run({});
    expect(missing.code).toBe(EXIT.OK);
    expect(missing.io.stdout.some((l) => l.includes("shortcuts.toml"))).toBe(false);
  });

  test("a named path is checked alone, so the shortcuts file is left out", () => {
    expect(run({ [FILE]: BROKEN, "/tmp/c.toml": "[network]\nport = 8800\n" }, ["/tmp/c.toml"]).code).toBe(EXIT.OK);
  });
});
