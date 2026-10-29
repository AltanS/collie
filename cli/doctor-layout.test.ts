import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { layoutFindings } from "./doctor-layout.ts";
import type { Finding } from "./finding.ts";

// The 21 `surface-*` and `harness-*` rows of a real `collie doctor --json`, home paths and machine
// names scrubbed. They are the rows that made the plain output unreadable: ids up to 23 characters
// and details up to 393.
// SAFETY: the fixture is a checked-in copy of `doctor --json` rows, and the first test pins its length.
const ROWS = JSON.parse(readFileSync(join(import.meta.dir, "testdata", "doctor-wide-rows.json"), "utf8")) as Finding[];

const LABEL = Math.max(...ROWS.map((r) => r.check.length)) + 2;
const VALUE_COL = 2 + 9 + LABEL;

/** The value of a row as the layout is asked to print it. */
const valueOf = (f: Finding): string => (f.remedy === null ? f.detail : `${f.detail} → ${f.remedy}`);

/** Split a layout into one block of lines per finding: a new row starts with two spaces and a non-space. */
function rows(lines: readonly string[]): string[][] {
  const out: string[][] = [];
  for (const l of lines) {
    if (/^ {2}\S/.test(l)) out.push([l]);
    else out[out.length - 1]?.push(l);
  }
  return out;
}

/** What a row says after its status and id, with the continuation indent taken off. */
function valueLines(block: readonly string[], f: Finding): string[] {
  const [first = "", ...rest] = block;
  const afterId = first.replace(/^ {2}\S+\s+/, "").slice(f.check.length);
  return [afterId, ...rest].map((l) => l.trim()).filter((l) => l !== "");
}

const squash = (s: string): string => s.replace(/\s+/g, "");

describe("layoutFindings on the 21 wide rows", () => {
  test("the fixture is the 21 rows, with an id that outgrew the old 22-wide column", () => {
    expect(ROWS).toHaveLength(21);
    expect(Math.max(...ROWS.map((r) => r.check.length))).toBeGreaterThan(22);
    expect(Math.max(...ROWS.map((r) => r.detail.length))).toBeGreaterThan(300);
  });

  test("at width 60 no line is longer than 60, and every row comes back whole", () => {
    const lines = layoutFindings(ROWS, 60);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(60);
    const blocks = rows(lines);
    expect(blocks).toHaveLength(ROWS.length);
    const room = 60 - VALUE_COL;
    ROWS.forEach((f, i) => {
      const got = valueLines(blocks[i] ?? [], f);
      // Hard breaks may split a long path, so the whole value is compared without whitespace...
      expect(squash(got.join(""))).toBe(squash(valueOf(f)));
      // ...and every word that fits a line stays whole, in order.
      const tokens = got.join(" ").split(/\s+/);
      for (const word of valueOf(f).split(" ")) if (word.length <= room) expect(tokens).toContain(word);
    });
  });

  test("at width 200 a short row is one line, and the value starts at the longest id plus 2", () => {
    const lines = layoutFindings(ROWS, 200);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(200);
    const blocks = rows(lines);
    ROWS.forEach((f, i) => {
      const block = blocks[i] ?? [];
      const first = block[0] ?? "";
      expect(first.slice(0, VALUE_COL)).toBe(`  ${"✓".padEnd(9)}${f.check.padEnd(LABEL)}`);
      expect(first.charAt(VALUE_COL)).not.toBe(" ");
      if (valueOf(f).length <= 200 - VALUE_COL) expect(block).toHaveLength(1);
      // A continuation line sits under the value column.
      for (const l of block.slice(1)) expect(l.slice(0, VALUE_COL)).toBe(" ".repeat(VALUE_COL));
    });
    // The longest id leaves exactly two spaces before its value.
    const longest = ROWS.find((r) => r.check.length === LABEL - 2);
    expect(lines.some((l) => l.includes(`${longest?.check}  `) && !l.includes(`${longest?.check}   `))).toBe(true);
  });

  test("at width 30 the value moves to its own lines at indent 4 and still prints in full", () => {
    const lines = layoutFindings(ROWS, 30);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(30);
    const blocks = rows(lines);
    expect(blocks).toHaveLength(ROWS.length);
    ROWS.forEach((f, i) => {
      const block = blocks[i] ?? [];
      // The id keeps its place; the value is not on the id's line.
      expect(block[0]).toMatch(new RegExp(`^ {2}✓ +${f.check.replace(/\./g, "\\.")}$`));
      expect(block.length).toBeGreaterThan(1);
      for (const l of block.slice(1)) {
        expect(l.startsWith("    ")).toBe(true);
        expect(l.charAt(4)).not.toBe(" ");
      }
      expect(squash(block.slice(1).join(""))).toBe(squash(valueOf(f)));
    });
  });
});

describe("layoutFindings details", () => {
  const f = (check: string, detail: string, remedy: string | null = null, status: Finding["status"] = "ok"): Finding => ({
    check,
    status,
    detail,
    remedy,
  });

  test("the label column belongs to its section: a short section gets a short column", () => {
    expect(layoutFindings([f("clock", "fine"), f("acl", "fine")], 80)).toEqual([
      `  ${"✓".padEnd(9)}clock  fine`,
      `  ${"✓".padEnd(9)}acl    fine`,
    ]);
  });

  test("the status word fills the status column, and the remedy follows the detail after an arrow", () => {
    expect(layoutFindings([f("bind", "open", "`collie restart`", "warn")], 80)).toEqual([
      `  warn:    bind  open → \`collie restart\``,
    ]);
  });

  test("a detail with a line break keeps the break and wraps each part under the value column", () => {
    const lines = layoutFindings([f("secrets-private", "the folder is open.\nC:\\state\\collie", "fix it")], 80);
    const pad = " ".repeat(2 + 9 + "secrets-private".length + 2);
    expect(lines).toEqual([`  ${"✓".padEnd(9)}secrets-private  the folder is open.`, `${pad}C:\\state\\collie → fix it`]);
  });

  test("each part of a broken detail wraps on its own", () => {
    const part = Array.from({ length: 12 }, (_, i) => `word${String(i)}`).join(" ");
    const lines = layoutFindings([f("a", `${part}\n${part}`)], 40);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(40);
    // 2 + 9 + 3 = 14 columns of lead, 26 for the value: each part needs several lines.
    expect(lines.length).toBeGreaterThan(4);
    const joined = lines.map((l) => l.trim()).join(" ");
    expect(joined).toBe(`✓        a  ${part} ${part}`);
  });

  test("a word wider than the room breaks hard at the edge, and no line exceeds the width", () => {
    const path = `/home/user/${"deep/".repeat(30)}file`;
    const lines = layoutFindings([f("a", `see ${path} now`)], 50);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(50);
    expect(squash(lines.join(""))).toBe(`✓a${squash(`see${path}now`)}`);
  });

  test("exactly 20 characters of room keeps the value on the row; 19 moves it", () => {
    const check = "abc"; // value column 2 + 9 + 5 = 16
    expect(layoutFindings([f(check, "x")], 36)[0]).toBe(`  ${"✓".padEnd(9)}abc  x`);
    expect(layoutFindings([f(check, "x")], 35)).toEqual([`  ${"✓".padEnd(9)}abc`, "    x"]);
  });

  test("when even the status column and the id pass the width, the id keeps whole and the column goes", () => {
    const lines = layoutFindings([f("surface-opencode-1.19.2", "verified", null, "skipped")], 30);
    expect(lines).toEqual(["  skipped: surface-opencode-1.19.2", "    verified"]);
  });

  test("an empty detail prints the id alone, with no trailing space", () => {
    expect(layoutFindings([f("a", "")], 80)).toEqual([`  ✓        a`]);
  });
});
