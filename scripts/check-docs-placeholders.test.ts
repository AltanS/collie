// Tests for scripts/check-docs-placeholders.ts, the check over `README.md` and `docs/*.md`.
//
// The first block reads THIS REPOSITORY'S docs, so a placeholder written outside a code span turns
// CI red on the commit that wrote it. The rest plants one case at a time and pairs each fault with a
// clean control, because a check that matches nothing passes everything.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { ALLOWED_TAGS, checkDocs, EXCEPTIONS, findPlaceholders, readDocs } from "./check-docs-placeholders.ts";

const ROOT = join(import.meta.dir, "..");

function tagsOf(text: string): string[] {
  return findPlaceholders(text).map((hit) => hit.text);
}

describe("check-docs-placeholders: the real docs", () => {
  const files = readDocs(ROOT);

  test("reads the README and every docs page", () => {
    expect(files[0]?.name).toBe("README.md");
    expect(files.length).toBeGreaterThanOrEqual(25);
    expect(files.some((file) => file.name === "docs/hill.md")).toBe(true);
  });

  test("has no finding", () => {
    expect(checkDocs(files)).toEqual([]);
  });

  test("keeps the exception list honest", () => {
    for (const entry of EXCEPTIONS) {
      const file = files.find((candidate) => candidate.name === entry.file);
      expect(file).toBeDefined();
      expect(tagsOf(file?.text ?? "")).toContain(entry.text);
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });

  test("gives each allowed tag a reason", () => {
    for (const reason of Object.values(ALLOWED_TAGS)) expect(reason.length).toBeGreaterThan(0);
  });
});

describe("check-docs-placeholders: prose", () => {
  test("reports a placeholder in prose, with its line", () => {
    expect(findPlaceholders("One line.\n\nRun it in the <repo> folder.\n")).toEqual([{ line: 3, text: "<repo>" }]);
  });

  test("reports a placeholder of two words, one with a dash, and a closing tag", () => {
    expect(tagsOf("A <old lead> and a <state-dir> and a </name> here.")).toEqual(["<old lead>", "<state-dir>", "</name>"]);
  });

  test("reports a line that starts with a placeholder", () => {
    expect(findPlaceholders("<repo> is the folder.")).toEqual([{ line: 1, text: "<repo>" }]);
  });

  test("reports a placeholder in a table cell", () => {
    const table = "| Name | Meaning |\n| --- | --- |\n| `a` | The <id> of the card |\n";
    expect(findPlaceholders(table)).toEqual([{ line: 3, text: "<id>" }]);
  });

  test("reports a placeholder in a link text", () => {
    expect(findPlaceholders("See [the <repo> page](docs/x.md) now.")).toEqual([{ line: 1, text: "<repo>" }]);
  });

  test("reports a placeholder in a heading and a list item", () => {
    expect(tagsOf("# Use <name>\n\n- the <id> value\n")).toEqual(["<name>", "<id>"]);
  });

  test("reports the placeholder after a code span on the same line", () => {
    expect(tagsOf("Run `collie <verb>` then open <folder>.")).toEqual(["<folder>"]);
  });

  test("a plain less-than sign is not a tag", () => {
    expect(tagsOf("When a < b and 3 <4 hold, or x<=y.")).toEqual([]);
  });
});

describe("check-docs-placeholders: what is code", () => {
  test("skips a single-backtick code span", () => {
    expect(tagsOf("Run it in the `<repo>` folder.")).toEqual([]);
  });

  test("skips a multi-backtick code span, also one that holds a backtick", () => {
    expect(tagsOf("Use ``a ` <repo>`` or ```<old lead>``` here.")).toEqual([]);
  });

  test("skips a code span that crosses a line break", () => {
    expect(tagsOf("Run `collie hill\nstatus <id>` now.")).toEqual([]);
  });

  test("skips a backtick fence, with an info string", () => {
    expect(tagsOf("Text.\n\n```bash\ncd <repo>\n```\n\nAfter.\n")).toEqual([]);
  });

  test("skips a tilde fence, and a longer fence that holds a shorter one", () => {
    expect(tagsOf("~~~\ncd <repo>\n~~~\n\n````md\n```\n<name>\n```\n<id>\n````\n")).toEqual([]);
  });

  test("reads on after a fence closes", () => {
    expect(findPlaceholders("```\n<a1>\n```\nThe <repo> again.\n")).toEqual([{ line: 4, text: "<repo>" }]);
  });

  test("skips an indented code block, and reads a deep list continuation", () => {
    expect(tagsOf("Text.\n\n    cd <repo>\n    ls <path>\n\nAfter.\n")).toEqual([]);
    expect(tagsOf("- item\n\n    the <repo> continues the item\n")).toEqual(["<repo>"]);
  });

  test("skips an HTML comment, also one over several lines", () => {
    expect(tagsOf("A <!-- <repo> --> b.\n\n<!--\n<name>\n-->\n")).toEqual([]);
  });

  test("skips a backslash-escaped less-than sign", () => {
    expect(tagsOf("A \\<repo> is shown as text.")).toEqual([]);
  });
});

describe("check-docs-placeholders: allowed tags", () => {
  test("allows real HTML the docs use", () => {
    const html = '<a href="x"><b>Try</b></a> <img src="a.png" width="250"><br><sub>cap</sub>\n\n<table><tr><td align="center">x</td></tr></table>';
    expect(tagsOf(html)).toEqual([]);
  });

  test("allows an allowed tag in any case, and reports an unknown tag beside it", () => {
    expect(tagsOf("<BR> and <foo>")).toEqual(["<foo>"]);
  });

  test("allows an autolink, and an email autolink", () => {
    expect(tagsOf("See <https://example.com/a?b=1> or <mailto:a@b.dev> or <a@b.dev>.")).toEqual([]);
  });
});

describe("check-docs-placeholders: findings", () => {
  test("names the file and the line", () => {
    const findings = checkDocs([
      { name: "docs/a.md", text: "ok\n" },
      { name: "docs/b.md", text: "ok\n\nbad <repo>\n" },
    ]);
    expect(findings).toEqual([{ file: "docs/b.md", line: 3, text: "<repo>" }]);
  });
});
