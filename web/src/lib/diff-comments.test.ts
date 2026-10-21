import { describe, expect, it } from "vitest";

import {
  captureDiffLines,
  diffCommentRowKey,
  displayDiffPath,
  formatDiffComment,
  formatDiffCommentBatch,
  formatDiffLineLabel,
  stageDiffCommentsToDraft,
} from "./diff-comments";
import { loadDraftEntry, saveDraft, __resetDraftPrune } from "./drafts";
import { parseUnifiedDiff, type DiffRow } from "./unified-diff";

type CodeRow = Extract<DiffRow, { kind: "context" | "add" | "del" }>;

describe("diff-comments helpers", () => {
  const parsed = parseUnifiedDiff(
    [
      "diff --git a/src/calc.ts b/src/calc.ts",
      "--- a/src/calc.ts",
      "+++ b/src/calc.ts",
      "@@ -3,2 +3,3 @@",
      "-const oldVal = 1;",
      "+const newVal = 2;",
      "+const extra = 3;",
      " export { newVal };",
    ].join("\n"),
  );
  const codeRows = parsed.rows.filter(
    (r): r is CodeRow => r.kind === "context" || r.kind === "add" || r.kind === "del",
  );

  it("formats single, contiguous, mixed old/new, and non-contiguous line labels", () => {
    expect(formatDiffLineLabel([codeRows[0]!])).toBe("-3");
    expect(formatDiffLineLabel([codeRows[1]!])).toBe("+3");
    expect(formatDiffLineLabel([codeRows[1]!, codeRows[2]!])).toBe("+3–4");
    expect(formatDiffLineLabel([codeRows[0]!, codeRows[1]!, codeRows[2]!])).toBe("-3, +3–4");
    expect(formatDiffLineLabel([codeRows[1]!, codeRows[3]!])).toBe("+3, +5");
  });

  it("anchors diffCommentRowKey to kind, oldNo, newNo, and text", () => {
    expect(diffCommentRowKey(codeRows[0]!)).toBe("del:3::const oldVal = 1;");
    expect(diffCommentRowKey(codeRows[1]!)).toBe("add::3:const newVal = 2;");
    expect(displayDiffPath(".", "src/calc.ts")).toBe("src/calc.ts");
    expect(displayDiffPath("api/", "server/orders.ts")).toBe("api/server/orders.ts");
  });

  it("captures selected diff lines with their signs intact", () => {
    expect(captureDiffLines([codeRows[0]!, codeRows[1]!])).toEqual([
      "-const oldVal = 1;",
      "+const newVal = 2;",
    ]);
  });

  it("formats single and batch diff comments as Markdown quotes with path and line range", () => {
    const first = {
      id: 1,
      repo: ".",
      path: "src/calc.ts",
      rowKeys: ["k1", "k2"],
      lineLabel: "+3–4",
      linesText: ["+const newVal = 2;", "+const extra = 3;"],
      note: "Please inline extra into newVal.",
    };
    const second = {
      id: 2,
      repo: "api",
      path: "server/orders.ts",
      rowKeys: ["k3"],
      lineLabel: "+12",
      linesText: ["+  return total;"],
      note: "Guard against negative total.",
    };
    expect(formatDiffComment(first)).toBe(
      [
        "> `src/calc.ts` (+3–4)",
        "> +const newVal = 2;",
        "> +const extra = 3;",
        "",
        "Please inline extra into newVal.",
      ].join("\n"),
    );
    expect(formatDiffCommentBatch([first, second])).toContain("> `api/server/orders.ts` (+12)");
  });

  it("stages a batch of diff comments into a pane's draft while preserving existing text and chips", () => {
    localStorage.clear();
    __resetDraftPrune();
    const chip = { n: 1, path: "/tmp/a.png", name: "a.png", kind: "image" as const };
    saveDraft(undefined, "w1:p1", "See [Image #1]", [chip], 2);

    stageDiffCommentsToDraft(undefined, "w1:p1", [
      {
        id: 1,
        repo: ".",
        path: "src/calc.ts",
        rowKeys: ["k1"],
        lineLabel: "+3",
        linesText: ["+const newVal = 2;"],
        note: "Use const here.",
      },
    ]);

    const updated = loadDraftEntry(undefined, "w1:p1");
    expect(updated?.attachments).toEqual([chip]);
    expect(updated?.next).toBe(2);
    expect(updated?.text).toBe(
      "See [Image #1]\n\n> `src/calc.ts` (+3)\n> +const newVal = 2;\n\nUse const here.\n\n",
    );
  });
});
