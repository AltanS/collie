import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { SHIPPED_FONTS } from "../web/src/lib/shipped-fonts.ts";
import { ALL_THEME_TOKENS } from "../web/src/lib/theme/schema.ts";
import { ANSI_KEYS, SURFACE_TOKENS, surfaceWords } from "../web/src/lib/theme/surface.ts";
import { SKILL_TEMPLATE, THEME_SKILL_TEMPLATE } from "./docs-embed.ts";
import { capture } from "./fakes.ts";
import { EXIT } from "./io.ts";
import { run } from "./program.ts";
import { cmdThemeCheck, type ThemeFiles } from "./theme-check.ts";
import { pageSection, THEME_SKILL_SECTIONS, themeSkillText } from "./theme-skill.ts";

// `collie theme skill` (M59): the brief an agent reads before it writes a theme. These tests hold it
// to the parser, so the brief can never teach a key the parser refuses or miss one it accepts.

const BRIEF = themeSkillText().join("\n");
const PAGE = readFileSync(resolve(import.meta.dirname, "../docs/themes.md"), "utf8");

function filesOf(entries: Record<string, string>): ThemeFiles {
  return {
    size: (path) => (path in entries ? new TextEncoder().encode(entries[path]).length : null),
    read: (path) => entries[path] ?? null,
  };
}

describe("collie theme skill", () => {
  test("`theme skill` and `theme --skill` print the same brief and exit 0", async () => {
    const verb = capture();
    const flag = capture();
    expect(await run(["theme", "skill"], verb)).toBe(EXIT.OK);
    expect(await run(["theme", "--skill"], flag)).toBe(EXIT.OK);
    expect(verb.stdout.join("\n")).toBe(BRIEF);
    expect(flag.stdout).toEqual(verb.stdout);
    expect(verb.stderr).toEqual([]);
  });

  test("the brief carries every section it names, in order, and no placeholder", () => {
    let from = 0;
    for (const title of THEME_SKILL_SECTIONS) {
      const at = BRIEF.indexOf(`\n## ${title}\n`, from);
      expect(at).toBeGreaterThan(-1);
      from = at;
    }
    expect(BRIEF).not.toContain("{{");
  });

  test("every token, surface key and word, typeface and palette key the parser reads is in the brief", () => {
    for (const token of ALL_THEME_TOKENS) expect(BRIEF).toContain(`\`${token}\``);
    for (const key of SURFACE_TOKENS) {
      expect(BRIEF).toContain(`\`${key}\``);
      for (const word of surfaceWords(key)) expect(BRIEF).toContain(`\`${word}\``);
    }
    for (const font of SHIPPED_FONTS) expect(BRIEF).toContain(`\`${font}\``);
    for (const key of ANSI_KEYS) expect(BRIEF).toContain(`"${key}"`);
  });

  test("the complete example the brief starts an agent from passes `collie theme check`", () => {
    const example = /```json\n([\s\S]*?)\n```/.exec(BRIEF)?.[1];
    expect(example).toBeDefined();
    const io = capture();
    const code = cmdThemeCheck({ io, files: filesOf({ "my-day.collie-theme.json": example ?? "" }) }, ["my-day.collie-theme.json"]);
    expect(io.stderr).toEqual([]);
    expect(code).toBe(EXIT.OK);
  });

  test("a section ends at the next `## ` heading, and a `## ` inside a code fence is text", () => {
    const text = "# T\n\n## A\none\n```md\n## not a heading\n```\n### Sub\ntwo\n\n## B\nthree\n";
    expect(pageSection(text, "A")).toEqual(["## A", "one", "```md", "## not a heading", "```", "### Sub", "two"]);
    expect(pageSection(text, "B")).toEqual(["## B", "three"]);
    expect(() => pageSection(text, "C")).toThrow('no section "## C"');
  });

  test("every section the brief names is a heading of docs/themes.md", () => {
    for (const title of THEME_SKILL_SECTIONS) expect(PAGE.split("\n")).toContain(`## ${title}`);
  });

  test("the general brief sends an agent that writes a theme to `collie theme skill`", () => {
    expect(SKILL_TEMPLATE).toContain("`collie theme skill`");
  });

  test("the hand-written part has no em dash and names no shipped theme id by hand", () => {
    expect(THEME_SKILL_TEMPLATE).not.toContain(String.fromCodePoint(0x2014));
    expect(THEME_SKILL_TEMPLATE).not.toMatch(/`(?:nightwatch|daylight|harbour)`/);
  });
});
