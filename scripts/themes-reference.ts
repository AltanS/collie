#!/usr/bin/env bun
// THE THEMES REFERENCE, GENERATED. `docs/themes-reference.md` is written whole from the themes catalogue
// (`web/src/lib/theme/catalogue.ts`), which reads its names, numbers and defaults from the theme parser's
// own tables and from the shipped theme Collie. Nobody edits the page by hand.
//
//   bun scripts/themes-reference.ts            print a diff and exit 1 when the page is stale
//   bun scripts/themes-reference.ts --write    write the page
//
// `scripts/themes-reference.test.ts` holds the page to the generator, parses every example with the real
// parser, and fails when a key, a token, a word or a limit is missing from the page, or when a token that
// `docs/themes.md` or `cli/theme-skill.md` names is not in the catalogue.
import { runReferenceCli, table, word } from "./reference-kit.ts";
import {
  ANSI_GATES,
  ANSI_KEY_WORDS,
  CHARACTERS,
  FILE_EXAMPLE,
  FILE_KEYS,
  FONTS,
  GLYPH_SET_ENTRIES,
  GROUND_INK_WORDS,
  GROUND_KEY_ENTRIES,
  GROUND_PATTERN_ENTRIES,
  GROUND_SIZE_ENTRIES,
  GROUND_STRENGTH_ENTRIES,
  LIMITS,
  REPORT_FLOORS,
  SURFACE_ENTRIES,
  TOKENS,
  VERSIONS,
  type NamedEntry,
  type TokenGroup,
} from "../web/src/lib/theme/catalogue.ts";

/** The page, relative to the repository root. */
export const REFERENCE_PAGE = "docs/themes-reference.md";

/** The command that writes it, as the page names it. */
export const REFERENCE_COMMAND = "bun scripts/themes-reference.ts --write";

const TOKEN_GROUPS: readonly TokenGroup[] = ["Surfaces and inks", "Status", "Syntax", "Host", "Optional"];

function fileSection(): string[] {
  return [
    "## The file",
    "",
    "A theme is one JSON file with these keys, and no others. An unknown key anywhere is refused with its name.",
    "",
    ...table(
      ["Key", "Type", "Needed", "From version", "What it is"],
      FILE_KEYS.map((entry) => [word(entry.key), entry.type, entry.needed, String(entry.version), entry.what]),
    ),
    "",
    "A complete file that uses every part of the newest version:",
    "",
    "```json",
    FILE_EXAMPLE,
    "```",
    "",
    "### Versions",
    "",
    "A file says which version it is. Write the lowest version that holds what the file has.",
    "",
    ...table(
      ["Version", "What the file may hold"],
      VERSIONS.map((entry) => [String(entry.version), entry.holds]),
    ),
    ...VERSIONS.flatMap((entry) => ["", `A file at version ${String(entry.version)}:`, "", "```json", entry.example, "```"]),
    "",
    "### Limits of a file",
    "",
    ...table(
      ["Limit", "Value"],
      LIMITS.map((limit) => [limit.what, limit.value]),
    ),
  ];
}

function tokensSection(): string[] {
  const lines: string[] = [
    "## Colour tokens",
    "",
    "Each half, `light` and `dark`, takes any of these. A token that a half leaves out takes the value of the theme Collie, which the last two columns show. The tokens of the group Optional need version 3, and a half that sets none of them draws as it always did.",
  ];
  for (const group of TOKEN_GROUPS) {
    const entries = TOKENS.filter((entry) => entry.group === group);
    lines.push("", `### ${group}`, "", ...table(["Token", "What it colours", "Collie, light", "Collie, dark"], entries.map((entry) => [word(entry.token), entry.what, word(entry.light), word(entry.dark)])));
  }
  return lines;
}

function surfaceSection(): string[] {
  const lines: string[] = [
    "## Shape and look",
    "",
    "The `surface` block holds one closed word for each key. A word is a name and never a number, and a key left out takes its default word.",
  ];
  for (const block of SURFACE_ENTRIES) {
    lines.push(
      "",
      `### ${word(block.key)}`,
      "",
      block.what,
      "",
      ...table(
        ["Word", "Default", "What it does", "Sets"],
        block.words.map((entry) => [word(entry.word), entry.isDefault ? "yes" : "", entry.what, entry.sets]),
      ),
    );
  }
  return lines;
}

function groundSection(): string[] {
  return [
    "## Ground",
    "",
    'From version 4, `surface.ground` may be an object of four keys in place of a word. A key it leaves out takes its default word. A word that this Collie does not know is kept as written and drawn as the default.',
    "",
    ...table(
      ["Key", "Words", "What it does"],
      GROUND_KEY_ENTRIES.map((entry) => [word(entry.key), entry.words.map(word).join(" "), entry.what]),
    ),
    "",
    "### Patterns",
    "",
    ...table(
      ["Pattern", "What it draws"],
      GROUND_PATTERN_ENTRIES.map((entry) => [word(entry.word), entry.what]),
    ),
    "",
    "### Sizes",
    "",
    ...table(
      ["Size", "Factor on every pitch"],
      GROUND_SIZE_ENTRIES.map((entry) => [word(entry.word), entry.factor]),
    ),
    "",
    "### Strengths",
    "",
    `The percent of ink mixed into the page colour. The ink is ${GROUND_INK_WORDS.map(word).join(" or ")}.`,
    "",
    ...table(
      ["Strength", "A line", "A dot", "A block", "Foot of `gradient`"],
      GROUND_STRENGTH_ENTRIES.map((entry) => [word(entry.word), `${String(entry.line)}%`, `${String(entry.dot)}%`, `${String(entry.area)}%`, `${String(entry.tint)}%`]),
    ),
  ];
}

function ansiSection(): string[] {
  return [
    "## Terminal palette",
    "",
    "The `ansi` block gives the terminal mirror its own colours. It holds all 18 keys or none, and each colour is `#rrggbb` or `oklch()` with no alpha.",
    "",
    `The keys: ${ANSI_KEY_WORDS.map(word).join(", ")}. The numbers are the 16 slots. \`ink\` is the text, and \`ground\` is the background.`,
    "",
    "A colour that fails a gate is refused with its key named.",
    "",
    ...table(
      ["Gate", "Rule"],
      ANSI_GATES.map((gate) => [gate.gate, gate.rule]),
    ),
  ];
}

function reportSection(): string[] {
  return [
    "## The contrast report",
    "",
    "`collie theme check` and the preview of an import measure these pairs and warn below each floor. A warning does not refuse the file.",
    "",
    ...table(
      ["Pair", "Floor"],
      REPORT_FLOORS.map((floor) => [floor.what, floor.value]),
    ),
  ];
}

function namedSection(title: string, intro: string, head: string, entries: readonly NamedEntry[]): string[] {
  return [
    `## ${title}`,
    "",
    intro,
    "",
    ...table(
      [head, "Name", "What it is"],
      entries.map((entry) => [word(entry.word), entry.name, entry.what]),
    ),
  ];
}

function fontsSection(): string[] {
  return [
    "## Typefaces",
    "",
    "`fonts.ui` and `fonts.display` take one of these words. A theme cannot add a face.",
    "",
    ...table(
      ["Word", "Face"],
      FONTS.map((font) => [word(font.word), font.name]),
    ),
  ];
}

/** The whole page, as the generator writes it. */
export function renderReference(): string {
  const lines: string[] = [
    "# Themes reference",
    "",
    `<!-- This page is generated by \`${REFERENCE_COMMAND}\` from web/src/lib/theme/catalogue.ts. Do not edit it by hand. -->`,
    "",
    "This page lists every key, colour token, word and limit of a ColliePWA theme file, and it is complete. It is generated from the code, so it cannot drift. It is the one list: [Themes](themes.md) explains how to pick, write, check and share a theme.",
    "",
    ...fileSection(),
    "",
    ...tokensSection(),
    "",
    ...surfaceSection(),
    "",
    ...groundSection(),
    "",
    ...ansiSection(),
    "",
    ...reportSection(),
    "",
    ...fontsSection(),
    "",
    ...namedSection("Characters", "The header character, set with the key `character` at the top level. A theme without it shows Collie.", "Word", CHARACTERS),
    "",
    ...namedSection("Glyph sets", "The icon set every icon is drawn in, set with the key `glyphs` at the top level. A theme without it shows Lucide.", "Word", GLYPH_SET_ENTRIES),
  ];
  return `${lines.join("\n")}\n`;
}

if (import.meta.main) process.exit(runReferenceCli(process.argv.slice(2), REFERENCE_PAGE, REFERENCE_COMMAND, renderReference()));
