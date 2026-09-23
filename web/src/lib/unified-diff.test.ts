import { describe, expect, it } from "vitest";

import { parseUnifiedDiff } from "./unified-diff";

const SAMPLE = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,4 +1,5 @@ export function main() {",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  " ",
  " return a + b;",
  "@@ -20,2 +21,2 @@",
  " x",
  "-y",
  "\\ No newline at end of file",
  "+y",
  "\\ No newline at end of file",
  "",
].join("\n");

describe("parseUnifiedDiff", () => {
  it("numbers both gutters and skips the file header", () => {
    const d = parseUnifiedDiff(SAMPLE);
    expect(d.added).toBe(3);
    expect(d.removed).toBe(2);
    expect(d.rows[0]).toEqual({ kind: "hunk", header: "@@ -1,4 +1,5 @@ export function main() {", oldStart: 1, newStart: 1 });
    expect(d.rows.slice(1, 7)).toEqual([
      { kind: "context", oldNo: 1, newNo: 1, text: "const a = 1;" },
      { kind: "del", oldNo: 2, newNo: null, text: "const b = 2;" },
      { kind: "add", oldNo: null, newNo: 2, text: "const b = 3;" },
      { kind: "add", oldNo: null, newNo: 3, text: "const c = 4;" },
      { kind: "context", oldNo: 3, newNo: 4, text: "" },
      { kind: "context", oldNo: 4, newNo: 5, text: "return a + b;" },
    ]);
  });

  it("restarts the counters at each hunk and keeps the no-newline note", () => {
    const d = parseUnifiedDiff(SAMPLE);
    const second = d.rows.slice(7);
    expect(second[0]).toMatchObject({ kind: "hunk", oldStart: 20, newStart: 21 });
    expect(second[1]).toEqual({ kind: "context", oldNo: 20, newNo: 21, text: "x" });
    expect(second[2]).toEqual({ kind: "del", oldNo: 21, newNo: null, text: "y" });
    expect(second[3]).toEqual({ kind: "note", text: "No newline at end of file" });
    expect(second[4]).toEqual({ kind: "add", oldNo: null, newNo: 22, text: "y" });
    expect(d.maxLineNo).toBe(22);
  });

  it("reads a new file's single-number hunk header", () => {
    const d = parseUnifiedDiff("--- /dev/null\n+++ b/x\n@@ -0,0 +1 @@\n+only\n");
    expect(d.rows).toEqual([
      { kind: "hunk", header: "@@ -0,0 +1 @@", oldStart: 0, newStart: 1 },
      { kind: "add", oldNo: null, newNo: 1, text: "only" },
    ]);
  });

  it("gives nothing for an empty diff and ignores text before the first hunk", () => {
    expect(parseUnifiedDiff("").rows).toEqual([]);
    expect(parseUnifiedDiff("diff --git a/x b/x\nrename from x\nrename to y\n").rows).toEqual([]);
  });

  it("keeps markup as plain text", () => {
    const d = parseUnifiedDiff("@@ -1 +1 @@\n-<b>x</b>\n+<script>y</script>\n");
    expect(d.rows[2]).toEqual({ kind: "add", oldNo: null, newNo: 1, text: "<script>y</script>" });
  });
});
