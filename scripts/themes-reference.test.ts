import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { GLYPH_SET_IDS } from "../web/src/lib/glyph-sets.ts";
import { MARK_IDS } from "../web/src/lib/mark-ids.ts";
import { SHIPPED_FONTS } from "../web/src/lib/shipped-fonts.ts";
import {
  ANSI_KEY_WORDS,
  CHARACTERS,
  FILE_EXAMPLE,
  FILE_KEYS,
  FONTS,
  GLYPH_SET_ENTRIES,
  GROUND_KEY_ENTRIES,
  GROUND_PATTERN_ENTRIES,
  GROUND_SIZE_ENTRIES,
  GROUND_STRENGTH_ENTRIES,
  LIMITS,
  REPORT_FLOORS,
  SURFACE_ENTRIES,
  TOKENS,
  VERSIONS,
} from "../web/src/lib/theme/catalogue.ts";
import { ALL_THEME_TOKENS, THEME_MAX_BYTES, THEME_VERSIONS_READ, TOP_KEYS, isColour, parseTheme } from "../web/src/lib/theme/schema.ts";
import { ANSI_KEYS, GROUND_KEYS, GROUND_PATTERN_WORDS, GROUND_SIZE_WORDS, GROUND_STRENGTH_WORDS, SURFACE, SURFACE_DEFAULTS, SURFACE_TOKENS } from "../web/src/lib/theme/surface.ts";
import { REFERENCE_COMMAND, REFERENCE_PAGE, renderReference } from "./themes-reference.ts";

// THE THEMES REFERENCE (docs/themes-reference.md) is generated from the catalogue. This file holds it to
// the code in four ways:
//   1. the page on disk is exactly what the generator writes (a stale page fails, with the command);
//   2. every example passes the real theme parser, at the version it claims;
//   3. the catalogue and the page name every file key, token, block word, ground word, palette key,
//      typeface, character and glyph set that the parser has;
//   4. every token, block word, character and glyph set that `docs/themes.md` and `cli/theme-skill.md`
//      name is in the catalogue, so a page cannot teach a word the parser lacks.
// It lives in scripts/, which `bun test ./scripts` runs in CI (the `check` job and the Windows job).

const ROOT = join(import.meta.dir, "..");
const CAP = { maxBytes: THEME_MAX_BYTES };

/** A text file of the checkout with LF line ends: a Windows checkout may hand back CRLF. */
function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8").replaceAll("\r\n", "\n");
}

const PAGE = read(REFERENCE_PAGE);
const THEMES = read("docs/themes.md");
const SKILL = read("cli/theme-skill.md");

/** The lines of one heading's section: after the heading, up to the next heading of the same or a higher level. */
function section(text: string, heading: string): string[] {
  const level = heading.indexOf(" ");
  const lines = text.split("\n");
  const start = lines.indexOf(heading);
  if (start === -1) throw new Error(`no heading "${heading}"`);
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const hashes = /^(#+) /.exec(line)?.[1];
    if (hashes !== undefined && hashes.length <= level) break;
    out.push(line);
  }
  return out;
}

/** The cells of a table row, trimmed; empty for a line that is not a row. */
function cells(line: string): string[] {
  if (!line.startsWith("|")) return [];
  return line
    .slice(1, line.lastIndexOf("|"))
    .split("|")
    .map((cell) => cell.trim());
}

/** The words in backticks in a text. */
function ticked(text: string): string[] {
  return [...text.matchAll(/`([^`]+)`/gu)].map((match) => match[1] ?? "");
}

describe("the page is the generator's output", () => {
  test(`docs/themes-reference.md is current (run: ${REFERENCE_COMMAND})`, () => {
    expect(PAGE).toBe(renderReference());
  });

  test("it says it is generated, and by which command, on the line after the title", () => {
    const lines = PAGE.split("\n");
    expect(lines[0]).toBe("# Themes reference");
    expect(lines[2]).toContain("generated");
    expect(lines[2]).toContain(REFERENCE_COMMAND);
  });

  test("it is plain Markdown: no HTML tag but its one comment, no SVG, no image", () => {
    // Code blocks and code spans may hold `<id>` placeholders, which are not tags.
    const prose = PAGE.replace(/<!--[\s\S]*?-->/u, "").replace(/```[\s\S]*?```/gu, "").replace(/`[^`\n]*`/gu, "");
    expect(prose).not.toMatch(/<\/?[a-z][^>]*>/iu);
    expect(PAGE).not.toMatch(/\.svg|!\[/u);
  });

  test("it carries no em dash and no private path", () => {
    expect(PAGE).not.toContain("\u2014");
    expect(PAGE).not.toMatch(/concepts\/|experiments\/|decisions\/|\/var\/home\/|\/home\//u);
  });

  test("it names ColliePWA once, at first mention", () => {
    expect(PAGE.split("ColliePWA").length - 1).toBe(1);
  });
});

describe("every example passes the real parser", () => {
  test("the complete file is read as version 4, with no refusal", () => {
    const parsed = parseTheme(FILE_EXAMPLE, CAP);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.refusals));
    expect(parsed.theme.version).toBe(4);
    expect(parsed.theme.character).toBe("kawaii");
    expect(parsed.theme.glyphs).toBe("phosphor");
  });

  for (const entry of VERSIONS) {
    test(`the example of version ${String(entry.version)} is read as exactly that version`, () => {
      const parsed = parseTheme(entry.example, CAP);
      if (!parsed.ok) throw new Error(JSON.stringify(parsed.refusals));
      expect(parsed.theme.version).toBe(entry.version);
    });
  }

  test("every colour the catalogue gives as a default is a colour the parser takes", () => {
    for (const token of TOKENS) {
      expect(isColour(token.light), `${token.token} light`).toBe(true);
      expect(isColour(token.dark), `${token.token} dark`).toBe(true);
    }
  });

  test("every block word, and every word of the object ground, is read by the parser", () => {
    for (const block of SURFACE_ENTRIES) {
      for (const entry of block.words) {
        const file = JSON.stringify({ version: 2, id: "words", name: "Words", light: { background: "oklch(0.985 0 0)" }, surface: { [block.key]: entry.word } });
        const parsed = parseTheme(file, CAP);
        expect(parsed.ok, `${block.key}: ${entry.word}`).toBe(true);
      }
    }
    for (const pattern of GROUND_PATTERN_ENTRIES) {
      for (const size of GROUND_SIZE_ENTRIES) {
        const file = JSON.stringify({ version: 4, id: "words", name: "Words", light: { background: "oklch(0.985 0 0)" }, surface: { ground: { pattern: pattern.word, size: size.word, strength: "faint" } } });
        expect(parseTheme(file, CAP).ok, `${pattern.word} ${size.word}`).toBe(true);
      }
    }
  });

  test("every character, glyph set and typeface is read by the parser", () => {
    for (const entry of CHARACTERS) {
      expect(parseTheme(JSON.stringify({ version: 4, id: "words", name: "Words", character: entry.word, light: { background: "oklch(0.985 0 0)" } }), CAP).ok, entry.word).toBe(true);
    }
    for (const entry of GLYPH_SET_ENTRIES) {
      expect(parseTheme(JSON.stringify({ version: 4, id: "words", name: "Words", glyphs: entry.word, light: { background: "oklch(0.985 0 0)" } }), CAP).ok, entry.word).toBe(true);
    }
    for (const entry of FONTS) {
      expect(parseTheme(JSON.stringify({ version: 2, id: "words", name: "Words", fonts: { ui: entry.word, display: entry.word }, light: { background: "oklch(0.985 0 0)" } }), CAP).ok, entry.word).toBe(true);
    }
  });
});

describe("the catalogue and the page name everything the parser has", () => {
  test("every file key, and every version", () => {
    expect(FILE_KEYS.map((entry) => entry.key)).toEqual([...TOP_KEYS]);
    for (const key of TOP_KEYS) expect(PAGE, key).toContain(`| \`${key}\` |`);
    expect(VERSIONS.map((entry) => entry.version)).toEqual([...THEME_VERSIONS_READ]);
    for (const entry of VERSIONS) expect(PAGE, `version ${String(entry.version)}`).toContain(`| ${String(entry.version)} | ${entry.holds} |`);
  });

  test("every colour token, with its words", () => {
    expect(TOKENS.map((entry) => entry.token)).toEqual([...ALL_THEME_TOKENS]);
    for (const entry of TOKENS) {
      expect(entry.what, entry.token).not.toBe("");
      expect(PAGE, entry.token).toContain(`| \`${entry.token}\` |`);
    }
  });

  test("every block key and word, the default first, and the default named by the parser", () => {
    expect(SURFACE_ENTRIES.map((block) => block.key)).toEqual([...SURFACE_TOKENS]);
    for (const block of SURFACE_ENTRIES) {
      expect(PAGE, block.key).toContain(`### \`${block.key}\`\n`);
      expect(block.words.map((entry) => entry.word)).toEqual(Object.keys(SURFACE[block.key]));
      expect(block.words.filter((entry) => entry.isDefault).map((entry) => entry.word)).toEqual([SURFACE_DEFAULTS[block.key]]);
      for (const entry of block.words) {
        expect(entry.what, `${block.key} ${entry.word}`).not.toBe("");
        expect(PAGE, `${block.key} ${entry.word}`).toContain(`| \`${entry.word}\` |`);
      }
    }
  });

  test("every key and word of the object ground, and the palette keys", () => {
    expect(GROUND_KEY_ENTRIES.map((entry) => entry.key)).toEqual([...GROUND_KEYS]);
    expect(GROUND_PATTERN_ENTRIES.map((entry) => entry.word)).toEqual([...GROUND_PATTERN_WORDS]);
    expect(GROUND_SIZE_ENTRIES.map((entry) => entry.word)).toEqual([...GROUND_SIZE_WORDS]);
    expect(GROUND_STRENGTH_ENTRIES.map((entry) => entry.word)).toEqual([...GROUND_STRENGTH_WORDS]);
    expect(ANSI_KEY_WORDS).toEqual([...ANSI_KEYS]);
    for (const key of ANSI_KEYS) expect(PAGE, key).toContain(`\`${key}\``);
    for (const entry of GROUND_PATTERN_ENTRIES) expect(PAGE, entry.word).toContain(`| \`${entry.word}\` |`);
  });

  test("every typeface, character and glyph set", () => {
    expect(FONTS.map((entry) => entry.word)).toEqual([...SHIPPED_FONTS]);
    expect(CHARACTERS.map((entry) => entry.word)).toEqual([...MARK_IDS]);
    expect(GLYPH_SET_ENTRIES.map((entry) => entry.word)).toEqual([...GLYPH_SET_IDS]);
    for (const entry of [...FONTS, ...CHARACTERS, ...GLYPH_SET_ENTRIES]) expect(PAGE, entry.word).toContain(`| \`${entry.word}\` |`);
  });

  test("every limit and every report floor", () => {
    for (const limit of [...LIMITS, ...REPORT_FLOORS]) expect(PAGE, limit.what).toContain(`| ${limit.what} | ${limit.value} |`);
  });
});

describe("the other pages teach no word that the catalogue lacks", () => {
  const TOKEN_WORDS: readonly string[] = ALL_THEME_TOKENS;

  test("docs/themes.md: every token of its two token tables is a token, and every token is in them", () => {
    const rows = [...section(THEMES, "### The 43 tokens"), ...section(THEMES, "### The optional tokens")].map((line) => cells(line)[0] ?? "");
    const named = rows.flatMap((first) => (first.startsWith("`") ? ticked(first) : []));
    for (const word of named) expect(TOKEN_WORDS, word).toContain(word);
    for (const token of ALL_THEME_TOKENS) expect(named, token).toContain(token);
  });

  test("docs/themes.md: every key and word of its Shape and Look tables is a key and a word of the parser", () => {
    for (const heading of ["## Shape", "## Look"]) {
      let key = "";
      // The object ground has its own tables under `### Ground patterns`: stop at the first subsection.
      const own = section(THEMES, heading);
      const lines = own.slice(0, own.findIndex((line) => line.startsWith("### ")) === -1 ? own.length : own.findIndex((line) => line.startsWith("### ")));
      for (const line of lines) {
        const [first = "", second = ""] = cells(line);
        if (first.startsWith("`")) key = ticked(first)[0] ?? "";
        if (!second.startsWith("`")) continue;
        const block = SURFACE_ENTRIES.find((entry) => entry.key === key);
        expect(block, `${heading}: ${key}`).toBeDefined();
        expect(block?.words.map((entry) => entry.word), `${key}: ${second}`).toContain(ticked(second)[0] ?? "");
      }
    }
  });

  test("docs/themes.md and cli/theme-skill.md: every character and glyph word of their tables is one", () => {
    const characters = CHARACTERS.map((entry) => entry.word);
    const glyphs = GLYPH_SET_ENTRIES.map((entry) => entry.word);
    for (const [text, heading] of [
      [THEMES, "### Characters"],
      [SKILL, "## Characters"],
    ] as const) {
      for (const line of section(text, heading)) {
        const word = ticked(cells(line)[0] ?? "")[0];
        if (word !== undefined && word !== "character") expect(characters, `${heading}: ${word}`).toContain(word);
      }
    }
    for (const [text, heading] of [
      [THEMES, "### Glyphs"],
      [SKILL, "## Glyphs"],
    ] as const) {
      for (const line of section(text, heading)) {
        const word = ticked(cells(line)[0] ?? "")[0];
        if (word !== undefined && word !== "glyphs") expect(glyphs, `${heading}: ${word}`).toContain(word);
      }
    }
    for (const id of MARK_IDS) expect(SKILL, id).toContain(`\`${id}\``);
    for (const id of GLYPH_SET_IDS) expect(SKILL, id).toContain(`\`${id}\``);
  });

  test("cli/theme-skill.md: every optional token it names is a token, and it names the version that holds each key", () => {
    for (const word of ticked(SKILL)) {
      if (/^(?:pane|tab)-active$|^find$/u.test(word)) expect(TOKEN_WORDS, word).toContain(word);
    }
    for (const entry of FILE_KEYS) if (entry.version === 4) expect(SKILL, entry.key).toContain(`\`${entry.key}\``);
  });
});
