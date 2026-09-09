import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { DOC_PAGE_ALIASES, DOC_PAGES, findDocPage, SKILL_TEMPLATE } from "./docs-embed.ts";
import { docsTable, pageTitle } from "./docs.ts";

// The drift guard. `cli/docs-embed.ts` is a hand-written list of ten imports, so a page added to
// `docs/` without a line there would simply not be in the binary and nothing would say so.
//
// `import.meta.dir` is used on purpose. The ban that `bridge/root.test.ts` enforces covers shipped
// modules, because under `bun build --compile` it resolves into the embedded bundle; a test only
// ever runs from the checkout, and its own comment says tests are exempt.
const DOCS_DIR = join(import.meta.dir, "..", "docs");

/** The stems of `docs/*.md`. The glob is `*.md`, because `docs/images/` is a directory in there. */
function pagesOnDisk(): string[] {
  return readdirSync(DOCS_DIR)
    .filter((n) => n.endsWith(".md"))
    .map((n) => n.slice(0, -".md".length))
    .toSorted();
}

describe("the embedded docs registry", () => {
  test("every page on disk is embedded, and every embedded page is on disk", () => {
    expect(DOC_PAGES.map((p) => p.name).toSorted()).toEqual(pagesOnDisk());
  });

  test("the registry names each page once", () => {
    const names = DOC_PAGES.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("every embedded page carries text and a `# ` heading of its own", () => {
    for (const page of DOC_PAGES) {
      expect(page.text.length).toBeGreaterThan(0);
      expect(page.text.split("\n").some((l) => l.startsWith("# "))).toBe(true);
      expect(pageTitle(page)).not.toBe(page.name);
    }
  });

  test("every page carries a one-line purpose, with no table cell separator in it", () => {
    for (const page of DOC_PAGES) {
      expect(page.purpose.trim().length).toBeGreaterThan(0);
      expect(page.purpose).not.toContain("|");
      expect(page.purpose).not.toContain("\n");
    }
  });

  test("the generated table names every registry key and every title", () => {
    const table = docsTable().join("\n");
    for (const page of DOC_PAGES) {
      expect(table).toContain(`\`${page.name}\``);
      expect(table).toContain(pageTitle(page));
      expect(table).toContain(page.purpose);
    }
    // Two header rows plus one row per page, so a page cannot go missing from the middle.
    expect(docsTable()).toHaveLength(DOC_PAGES.length + 2);
  });

  test("an old page name resolves to the page that carries the text now", () => {
    // ADR 0038 renamed the page an operator reads from `crew` to `crew` and kept the old name
    // working until 2.0.0, so `collie docs pack` on a 1.7.0 binary must print the crew page.
    expect(findDocPage("pack")).toBe(findDocPage("crew"));
    expect(findDocPage("crew")?.name).toBe("crew");
  });

  test("no alias shadows a page on disk, and every alias has a target", () => {
    for (const [alias, target] of Object.entries(DOC_PAGE_ALIASES)) {
      expect(DOC_PAGES.map((p) => p.name)).not.toContain(alias);
      expect(DOC_PAGES.map((p) => p.name)).toContain(target);
    }
  });

  test("an unknown name resolves to nothing", () => {
    expect(findDocPage("herd")).toBeUndefined();
  });

  test("the skill text holds both placeholders the printer resolves", () => {
    expect(SKILL_TEMPLATE).toContain("{{COLLIE_DOCS_TABLE}}");
    expect(SKILL_TEMPLATE).toContain("{{COLLIE_VERSION}}");
    expect(SKILL_TEMPLATE.split("\n")[0]).toBe("---");
    expect(SKILL_TEMPLATE).toContain("\nname: collie\n");
  });
});
