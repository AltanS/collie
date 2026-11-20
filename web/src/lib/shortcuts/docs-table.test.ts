import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { en } from "../i18n/messages/en";
import { ACTIONS, GROUPS } from "./actions";
import { HERDR_NAMES } from "./herdr-names";

// `docs/keyboard-shortcuts.md` is the page an operator reads. Its action table is written by hand, so it
// is held to the action table of the app (`actions.ts`): a missing or extra id, a changed default or a
// moved group fails here, and so does a Herdr name the page lists but the keymap does not know.

const DOCS = resolve(import.meta.dirname, "../../../../docs");
const PAGE = readFileSync(resolve(DOCS, "keyboard-shortcuts.md"), "utf8");
const GLOSSARY = readFileSync(resolve(DOCS, "terminology.md"), "utf8");

/** The text between a `## ` heading and the next one. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n## ${heading}\n`);
  if (start < 0) throw new Error(`keyboard-shortcuts.md has no section "${heading}"`);
  const body = text.slice(start + 1);
  const next = body.indexOf("\n## ", 1);
  return next < 0 ? body : body.slice(0, next);
}

/** The cells of every table row in a section, header and rule rows left out. */
function rows(text: string): string[][] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("| `"))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
}

/** What sits between backticks in a cell. */
function codes(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/gu)].map((match) => match[1] ?? "");
}

function cellAt(row: readonly string[], at: number): string {
  const cell = row[at];
  if (cell === undefined) throw new Error(`a table row has no cell ${at}: ${row.join(" | ")}`);
  return cell;
}

/** The anchor a heading gets on the site: lower case, punctuation out, spaces to hyphens. */
function anchorOf(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N} -]/gu, "")
    .replaceAll(" ", "-");
}

function anchorsOf(text: string): Set<string> {
  return new Set(
    text
      .split("\n")
      .filter((line) => /^#{1,6} /u.test(line))
      .map((line) => anchorOf(line.replace(/^#+ /u, ""))),
  );
}

describe("docs/keyboard-shortcuts.md, the action table", () => {
  const table = rows(section(PAGE, "The actions"));
  const byId = new Map(table.map((row) => [codes(cellAt(row, 0))[0] ?? "", row]));

  it("has one row per action of the app, and no other", () => {
    expect(table.map((row) => codes(cellAt(row, 0))[0]).toSorted()).toEqual(ACTIONS.map((action) => action.id).toSorted());
  });

  it("names each id once", () => {
    expect(byId.size).toBe(table.length);
  });

  it("gives every action its exact default keys", () => {
    for (const action of ACTIONS) {
      const row = byId.get(action.id);
      if (row === undefined) throw new Error(`no row for ${action.id}`);
      expect(codes(cellAt(row, 1)), action.id).toEqual([...action.defaults]);
    }
  });

  it("puts every action in the group the app draws it in", () => {
    for (const action of ACTIONS) {
      const row = byId.get(action.id);
      if (row === undefined) throw new Error(`no row for ${action.id}`);
      const group = GROUPS.find((candidate) => candidate.id === action.group);
      if (group === undefined) throw new Error(`no group ${action.group}`);
      expect(cellAt(row, 2), action.id).toBe(en[group.labelKey]);
    }
  });

  it("says what each action does, and names its glossary words", () => {
    for (const row of table) {
      expect(cellAt(row, 3).length, cellAt(row, 0)).toBeGreaterThan(10);
      expect(cellAt(row, 4).length, cellAt(row, 0)).toBeGreaterThan(0);
    }
  });
});

describe("docs/keyboard-shortcuts.md, the Herdr names", () => {
  const table = rows(section(PAGE, "Herdr names"));

  it("lists the renames the keymap knows, and none it does not", () => {
    const listed = new Map(table.map((row) => [codes(cellAt(row, 0))[0] ?? "", codes(cellAt(row, 1))[0] ?? ""]));
    const known = new Map([...HERDR_NAMES].flatMap(([name, collie]): [string, string][] => (collie === null ? [] : [[name, collie]])));
    expect(listed).toEqual(known);
  });
});

describe("the links between the page and the glossary", () => {
  it("point at headings that exist", () => {
    const glossary = anchorsOf(GLOSSARY);
    const page = anchorsOf(PAGE);
    for (const match of PAGE.matchAll(/\(terminology\.md#([a-z0-9-]+)\)/gu)) expect(glossary.has(match[1] ?? ""), `terminology.md#${match[1]}`).toBe(true);
    for (const match of GLOSSARY.matchAll(/\(keyboard-shortcuts\.md#([a-z0-9-]+)\)/gu)) expect(page.has(match[1] ?? ""), `keyboard-shortcuts.md#${match[1]}`).toBe(true);
  });

  it("have a glossary entry for each word the page links", () => {
    const glossary = anchorsOf(GLOSSARY);
    for (const word of ["prefix-key", "shortcut-list", "navigate-mode", "resize-mode", "row-of-panes", "remove-from-view"]) {
      expect(glossary.has(word), word).toBe(true);
    }
  });
});
