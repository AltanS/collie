// `collie skill` and `collie docs` — the two verbs that print the embedded manual.
//
// Both are read-only and neither draws a terminal view, so `--plain` changes nothing for them: the
// output is raw markdown on stdout, with no pager and no colour, because the reader is an AI agent
// working in the operator's terminal or a shell redirect into a skills directory.

import { DOC_PAGES, type DocPage, findDocPage, SKILL_TEMPLATE } from "./docs-embed.ts";
import { EXIT, type Io } from "./io.ts";

/** The line `cli/skill.md` carries where the docs table goes. */
const DOCS_TABLE_TOKEN = "{{COLLIE_DOCS_TABLE}}";

/** The token `cli/skill.md` carries where this binary's version goes. */
const VERSION_TOKEN = "{{COLLIE_VERSION}}";

/**
 * The page's own first `# ` heading — the title `collie docs` lists and `collie skill` tabulates.
 * Read out of the embedded text, so it is never a second list somebody has to keep in step.
 *
 * A page with no heading falls back to its name. `cli/docs-embed.test.ts` asserts every page has
 * one, so the fallback is a shape the repository does not contain.
 */
export function pageTitle(page: DocPage): string {
  for (const line of page.text.split("\n")) if (line.startsWith("# ")) return line.slice(2).trim();
  return page.name;
}

/** The `name  title` list, one line per page, in registry order. */
export function docsList(): string[] {
  const width = Math.max(...DOC_PAGES.map((p) => p.name.length));
  return DOC_PAGES.map((p) => `${p.name.padEnd(width)}  ${pageTitle(p)}`);
}

/** The table the skill text carries: the name to type, the page's own title, one line of purpose. */
export function docsTable(): string[] {
  return [
    "| Page | Title | What it covers |",
    "| --- | --- | --- |",
    ...DOC_PAGES.map((p) => `| \`${p.name}\` | ${pageTitle(p)} | ${p.purpose} |`),
  ];
}

/** An embedded document as lines, with the file's single trailing newline dropped. */
function bodyLines(text: string): string[] {
  const lines = text.split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** The skill text with both placeholders resolved: the generated table, and this binary's version. */
export function skillText(version: string): string[] {
  const out: string[] = [];
  for (const line of bodyLines(SKILL_TEMPLATE)) {
    if (line === DOCS_TABLE_TOKEN) out.push(...docsTable());
    else out.push(line.replaceAll(VERSION_TOKEN, version));
  }
  return out;
}

export function cmdSkill(io: Io, version: string): number {
  for (const line of skillText(version)) io.out(line);
  return EXIT.OK;
}

/**
 * `collie docs` lists the pages, `collie docs <name>` prints one, `collie docs --all` prints every
 * one behind a marker an agent can split the stream on. An unknown name is a usage error with the
 * list on stderr, so a pipe of stdout stays empty and the exit code says why.
 */
export function cmdDocs(io: Io, args: readonly string[]): number {
  if (args.includes("--all")) {
    for (const page of DOC_PAGES) {
      io.out(`<!-- collie docs: ${page.name} -->`);
      for (const line of bodyLines(page.text)) io.out(line);
    }
    return EXIT.OK;
  }
  const name = args.find((a) => !a.startsWith("-"));
  if (name === undefined) {
    for (const line of docsList()) io.out(line);
    return EXIT.OK;
  }
  const page = findDocPage(name);
  if (page === undefined) {
    io.err(`error: no page named \`${name}\` is embedded in this binary`);
    for (const line of docsList()) io.err(line);
    io.err("usage: collie docs [<name>|--all]");
    return EXIT.USAGE;
  }
  for (const line of bodyLines(page.text)) io.out(line);
  return EXIT.OK;
}
