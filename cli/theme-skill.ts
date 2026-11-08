// `collie theme skill` and `collie theme --skill`: the brief an AI agent reads before it writes a
// theme file for the operator.
//
// NO SECOND LIST. The brief is a short hand-written loop (`cli/theme-skill.md`) and, under it, whole
// sections of the operator page `docs/themes.md` as this binary embeds it. The tokens, the closed
// words, the fonts and the floors are printed from that page, and the page is checked against the
// parser by its own tests, so the brief cannot teach a key the parser refuses. The loop sends the
// agent to `collie theme check`, which runs the parser itself.
//
// The section titles below are headings of the page. A renamed heading fails `cli/theme-skill.test.ts`
// and throws here, so the brief never prints with a section silently gone.

import { DOC_PAGES, THEME_SKILL_TEMPLATE } from "./docs-embed.ts";
import { EXIT, type Io } from "./io.ts";

/** The line `cli/theme-skill.md` carries where the page's sections go. */
const DOCS_TOKEN = "{{COLLIE_THEME_DOCS}}";

/** The `## ` sections of `docs/themes.md` the brief carries, in the order it prints them. */
export const THEME_SKILL_SECTIONS = [
  "Write a theme",
  "Characters",
  "Shape",
  "Look",
  "Terminal palette",
  "What a theme cannot change",
  "The contrast report",
  "Share a theme on colliepwa.dev",
] as const;

function lines(text: string): string[] {
  const out = text.replaceAll("\r\n", "\n").split("\n");
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

/**
 * One `## ` section of a page: its heading and every line up to the next `## ` heading, with its
 * `### ` subsections. A `## ` inside a code fence is text, not a heading.
 */
export function pageSection(text: string, title: string): string[] {
  const all = lines(text);
  const start = all.indexOf(`## ${title}`);
  if (start === -1) throw new Error(`docs/themes.md has no section "## ${title}"`);
  let fenced = false;
  let end = all.length;
  for (let i = start + 1; i < all.length; i += 1) {
    const line = all[i] ?? "";
    if (line.startsWith("```")) fenced = !fenced;
    if (!fenced && line.startsWith("## ")) {
      end = i;
      break;
    }
  }
  const section = all.slice(start, end);
  while (section.length > 0 && section[section.length - 1] === "") section.pop();
  return section;
}

/** The brief, with the page's sections in place of the token. */
export function themeSkillText(): string[] {
  const page = DOC_PAGES.find((p) => p.name === "themes");
  if (page === undefined) throw new Error("the themes page is not embedded in this binary");
  const out: string[] = [];
  for (const line of lines(THEME_SKILL_TEMPLATE)) {
    if (line !== DOCS_TOKEN) {
      out.push(line);
      continue;
    }
    for (const [i, title] of THEME_SKILL_SECTIONS.entries()) {
      if (i > 0) out.push("");
      out.push(...pageSection(page.text, title));
    }
  }
  return out;
}

export function cmdThemeSkill(io: Io): number {
  for (const line of themeSkillText()) io.out(line);
  return EXIT.OK;
}
