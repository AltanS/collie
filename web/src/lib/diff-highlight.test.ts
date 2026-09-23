import { describe, expect, it } from "vitest";

import { languageForPath, type SyntaxToken, type Tokenizer } from "@/lib/diff-highlight";
import { highlightRows, loadTokenizer } from "@/lib/diff-highlight-engine";
import { parseUnifiedDiff } from "@/lib/unified-diff";

describe("languageForPath", () => {
  it.each([
    ["src/app.ts", "typescript"],
    ["web/src/components/changes-view.tsx", "typescript"],
    ["vite.config.mts", "typescript"],
    ["x.cts", "typescript"],
    ["a.js", "javascript"],
    ["a.jsx", "javascript"],
    ["eslint.config.mjs", "javascript"],
    ["a.cjs", "javascript"],
    ["package.json", "json"],
    [".vscode/settings.jsonc", "json"],
    ["index.css", "css"],
    ["index.html", "html"],
    ["README.md", "markdown"],
    ["tool.py", "python"],
    ["main.go", "go"],
    ["lib.rs", "rust"],
    ["install.sh", "shell"],
    ["x.bash", "shell"],
    ["x.zsh", "shell"],
    [".github/workflows/ci.yml", "yaml"],
    ["compose.yaml", "yaml"],
    ["Cargo.toml", "toml"],
    ["a.c", "c"],
    ["a.cpp", "cpp"],
    ["A.cs", "csharp"],
    ["A.java", "java"],
    ["a.kt", "kotlin"],
    ["init.lua", "lua"],
    ["index.php", "php"],
    ["a.rb", "ruby"],
    ["schema.sql", "sql"],
    ["App.swift", "swift"],
    ["build.zig", "zig"],
    ["Dockerfile", "dockerfile"],
    ["docker/Dockerfile.dev", "dockerfile"],
    ["infra/main.tf", "hcl"],
    ["schema.graphql", "graphql"],
    ["UPPER.TS", "typescript"],
  ])("%s is %s", (path, lang) => {
    expect(languageForPath(path)).toBe(lang);
  });

  it.each(["Makefile", "LICENSE", "logo.png", "notes.txt", ".gitignore", "a.unknownext", "dir.d/"])(
    "%s has no language, so its diff stays plain",
    (path) => {
      expect(languageForPath(path)).toBeNull();
    },
  );
});

/** A stand-in highlighter: every line one plain token, and a record of each text it was handed. */
function recording() {
  const calls: string[] = [];
  const tokenize: Tokenizer = (code) => {
    calls.push(code);
    return code.split("\n").map((line) => [{ type: "identifier", value: line }]);
  };
  return { tokenize, calls };
}

function diff(...body: string[]) {
  return parseUnifiedDiff(["diff --git a/x.ts b/x.ts", "--- a/x.ts", "+++ b/x.ts", ...body, ""].join("\n")).rows;
}

describe("highlightRows", () => {
  it("highlights each hunk's old side and new side as one text each", () => {
    const rows = diff("@@ -1,3 +1,3 @@", " a", "-b", "+B", " c", "@@ -10,2 +10,2 @@", " x", "+y");
    const { tokenize, calls } = recording();
    const out = highlightRows(rows, tokenize);
    expect(calls).toEqual(["a\nb\nc", "a\nB\nc", "x", "x\ny"]);
    expect(out.map((t) => (t ? t.map((x) => x.value).join("") : null))).toEqual([
      null,
      "a",
      "b",
      "B",
      "c",
      null,
      "x",
      "y",
    ]);
  });

  it("leaves a row plain when the tokens do not spell its text", () => {
    const rows = diff("@@ -1,1 +1,1 @@", "-a", "+b");
    const out = highlightRows(rows, (code) => code.split("\n").map(() => [{ type: "string", value: "?" }]));
    expect(out).toEqual([null, null, null]);
  });

  it("a block comment spanning a deleted and a context line is a comment on both", async () => {
    const tokenize = await loadTokenizer("typescript");
    const rows = diff("@@ -1,3 +1,1 @@", "-/* the old note", " still the note */", " const x = 1;");
    const out = highlightRows(rows, tokenize);
    const types = (i: number) => (out[i] ?? []).filter((t) => t.type !== "space").map((t) => t.type);
    expect(types(1)).toEqual(["comment"]);
    expect(types(2)).toEqual(["comment"]);
    // The comment closed: the next context line is code again.
    expect(types(3)).toContain("keyword");
  });

  it("a context row under an added comment opener takes the new side", async () => {
    const tokenize = await loadTokenizer("typescript");
    const rows = diff("@@ -1,1 +1,2 @@", "+/*", " x */");
    const out = highlightRows(rows, tokenize);
    expect(out[2]?.map((t) => t.type)).toEqual(["comment"]);
  });

  it("a template string opened on an added line carries into the next added line", async () => {
    const tokenize = await loadTokenizer("typescript");
    const rows = diff("@@ -0,0 +1,2 @@", "+const s = `one", "+two`;");
    const out = highlightRows(rows, tokenize);
    const second: readonly SyntaxToken[] = out[2] ?? [];
    expect(second.find((t) => t.value.includes("two"))?.type).toBe("string");
  });

  it("every row's tokens spell its text exactly, blank lines and CRLF included", async () => {
    const tokenize = await loadTokenizer("python");
    const rows = diff("@@ -1,3 +1,4 @@", " def f():\r", "-    return 'a'", "+    return \"b\"  # why", "+", " ");
    const out = highlightRows(rows, tokenize);
    rows.forEach((row, i) => {
      if (row.kind === "hunk" || row.kind === "note") return;
      expect(out[i]?.map((t) => t.value).join("")).toBe(row.text);
    });
    expect(out[3]?.find((t) => t.value === "# why")?.type).toBe("comment");
  });
});
