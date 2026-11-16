// Tests for scripts/check-adr.ts, the check over `.adr/`.
//
// The first block reads THIS REPOSITORY'S `.adr/`, the way release-notes.test.ts reads the real
// CHANGELOG: a header that rots, a record missing from the topic map or a pointer without its
// back pointer turns CI red on the commit that wrote it. The rest plants one fault at a time in a
// small fixture, and pairs each with a clean control, because a check that matches nothing passes
// everything.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  type AdrFile,
  checkAdrs,
  FIRST_STRICT_NUMBER,
  MAX_LINES,
  NOT_YET_STUBBED,
  readAdrDir,
} from "./check-adr.ts";

const ADR_DIR = join(import.meta.dir, "..", ".adr");

const A = "0001-first-rule.md";
const B = "0002-second-rule.md";

function record(name: string, header: string, body = "## Context\n\nWhy.\n"): AdrFile {
  const number = name.slice(0, 4);
  return { name, text: `# ${number} — Title\n\n${header}\n\n${body}` };
}

function live(name: string, extra = ""): AdrFile {
  return record(name, `- **Status:** Accepted\n- **Date:** 2026-11-01\n${extra}`);
}

function mapOf(...names: string[]): string {
  const rows = names.map((name) => `| [${name.slice(0, 4)}](./${name}) | A decision | Accepted |`);
  return ["# Architecture decision records", "", "| # | Decision | Status |", "| --- | --- | --- |", ...rows, ""].join("\n");
}

function failuresOf(files: AdrFile[], map = mapOf(...files.map((file) => file.name))): string[] {
  return checkAdrs(files, map);
}

describe("check-adr: the real .adr/", () => {
  const { files, readme } = readAdrDir(ADR_DIR);

  test("reads every record file", () => {
    expect(files.length).toBeGreaterThanOrEqual(140);
    expect(files[0]?.name).toBe("0001-one-managed-front-door.md");
  });

  test("has no failure", () => {
    expect(checkAdrs(files, readme)).toEqual([]);
  });

  test("keeps the not-yet-stubbed list honest", () => {
    // A number leaves the list when its record becomes a stub, never later.
    for (const number of NOT_YET_STUBBED) {
      const file = files.find((candidate) => candidate.name.startsWith(`${number}-`));
      expect(file).toBeDefined();
      expect(file?.text).toMatch(/Status:\*{0,2} \*{0,2}Superseded by/);
      expect(file?.text).toContain("\n## ");
    }
  });

  test("holds no superseded record that still has a body", () => {
    // Every `Superseded by` record is a stub unless it is on the list above.
    for (const file of files) {
      if (!/Status:\*{0,2} \*{0,2}Superseded by/.test(file.text)) continue;
      if (NOT_YET_STUBBED.has(file.name.slice(0, 4))) continue;
      expect(file.text).not.toContain("\n## ");
    }
  });
});

describe("check-adr: the header", () => {
  test("a clean record passes", () => {
    expect(failuresOf([live(A)])).toEqual([]);
  });

  test("a missing Status is named", () => {
    const failures = failuresOf([record(A, "- **Date:** 2026-11-01")]);
    expect(failures).toEqual([`.adr/${A}: has no Status header line`]);
  });

  test("a missing Date is named", () => {
    const failures = failuresOf([record(A, "- **Status:** Accepted")]);
    expect(failures).toEqual([`.adr/${A}: has no Date header line (a date as YYYY-MM-DD)`]);
  });

  test("a Date with no date in it is a missing Date", () => {
    const failures = failuresOf([record(A, "- **Status:** Accepted\n- **Date:** soon")]);
    expect(failures).toEqual([`.adr/${A}: has no Date header line (a date as YYYY-MM-DD)`]);
  });

  test("the three header shapes of the older records read the same", () => {
    const plain = record(A, "Status: **Accepted** (2026-08-01)\nDate: 2026-08-01");
    const bold = record(B, "**Status:** accepted, 2026-09-13\n**Date:** 2026-09-13");
    expect(failuresOf([plain, bold])).toEqual([]);
  });

  test("a Shipped in line is refused", () => {
    const failures = failuresOf([live(A, "- **Shipped in:** pending")]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain(`.adr/${A}: has a \`Shipped in:\` line`);
  });

  test("the words 'shipped in' in a sentence are not a Shipped in line", () => {
    const body = "## Context\n\nThe fix shipped in 1.10.2 and the plan shipped in pieces.\n";
    expect(failuresOf([record(A, "- **Status:** Accepted\n- **Date:** 2026-11-01", body)])).toEqual([]);
  });
});

describe("check-adr: the topic map", () => {
  test("a record missing from the map is named", () => {
    const failures = failuresOf([live(A), live(B)], mapOf(A));
    expect(failures).toEqual([`.adr/README.md: the topic map does not list ${B}`]);
  });

  test("a record listed twice is named", () => {
    const failures = failuresOf([live(A)], mapOf(A, A));
    expect(failures).toEqual([`.adr/README.md: the topic map lists ${A} 2 times; once is the rule`]);
  });

  test("a row for a file that does not exist is named", () => {
    const failures = failuresOf([live(A)], mapOf(A, B));
    expect(failures).toEqual([`.adr/README.md: the topic map lists ${B}, and no such file exists`]);
  });

  test("a row whose number and file disagree is named", () => {
    const map = mapOf(A).replace("[0001]", "[0007]");
    const failures = failuresOf([live(A)], map);
    expect(failures).toEqual([`.adr/README.md: the map row [0007] links to ${A}, a file of another number`]);
  });
});

describe("check-adr: pointers", () => {
  const amended = live(A, `- **Amended in scope by:** [ADR 0002](./${B}): the scope grew.`);

  test("a pointer pair that points both ways passes", () => {
    const newer = live(B, `- **Amends in scope:** [ADR 0001](./${A}), the scope.`);
    expect(failuresOf([amended, newer])).toEqual([]);
  });

  test("a pointer to a record that does not exist is named", () => {
    const failures = failuresOf([amended]);
    expect(failures).toEqual([`.adr/${A}: points to ADR 0002 as its amender or successor, and no such record exists`]);
  });

  test("an amended record whose amender does not point back is named", () => {
    const failures = failuresOf([amended, live(B)]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain(`.adr/${A}: says ADR 0002 amends or supersedes it, but ${B} has no`);
  });

  test("an amender whose older record has no pointer is named", () => {
    const newer = live(B, `- **Amends:** [ADR 0001](./${A})`);
    const failures = failuresOf([live(A), newer]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain(`.adr/${B}: says it amends or supersedes ADR 0001, but ${A} has no`);
  });

  test("a pointer inside the Status line counts", () => {
    const old = record(A, `- **Status:** Accepted. Amended by [ADR 0002](./${B}) (point 4)\n- **Date:** 2026-11-01`);
    const newer = live(B, `- **Amends:** [ADR 0001](./${A}), point 4 only.`);
    expect(failuresOf([old, newer])).toEqual([]);
  });

  test("a pointer without a colon counts, and a label wrapped onto a second line reads on", () => {
    const old = record(A, `Status: **Accepted** (2026-08-15) · Amended in scope by\n[0002](./${B})\nDate: 2026-08-15`);
    const newer = record(B, `Status: **Accepted** (2026-09-01)\nDate: 2026-09-01\n\nSupersedes in part [ADR 0001](./${A}) on one word.`);
    expect(failuresOf([old, newer])).toEqual([]);
  });

  test("Generalises and Narrows are amendments of the record they name", () => {
    const old = live(A, `- **Amended in scope by:** [ADR 0002](./${B})`);
    expect(failuresOf([old, live(B, `- **Narrows:** [ADR 0001](./${A})`)])).toEqual([]);
    expect(failuresOf([old, live(B, `- **Generalises:** [ADR 0001](./${A})`)])).toEqual([]);
  });

  test("a self-amendment note is not a pointer", () => {
    expect(failuresOf([live(A, "- **Amended:** 2026-10-01, the body gained a field.")])).toEqual([]);
  });
});

describe("check-adr: stubs", () => {
  const NEWER = live(B, `- **Supersedes:** [ADR 0001](./${A})`);
  const STUB = record(
    A,
    [
      `- **Status:** Superseded by [ADR 0002](./${B}) (2026-11-16)`,
      "- **Decided:** One door.",
      `- **Full text:** \`git show 0123abc:.adr/${A}\``,
    ].join("\n"),
    "",
  );

  test("a well-formed stub passes", () => {
    expect(failuresOf([STUB, NEWER])).toEqual([]);
  });

  test("a stub without a Decided line is named", () => {
    const stub = { ...STUB, text: STUB.text.replace("- **Decided:** One door.\n", "") };
    expect(failuresOf([stub, NEWER])).toEqual([`.adr/${A}: is a stub with no \`Decided:\` line`]);
  });

  test("a stub without the git show command is named", () => {
    const stub = { ...STUB, text: STUB.text.replace(/git show \w+:\.adr\/\S+/, "see git") };
    const failures = failuresOf([stub, NEWER]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("lacks `git show <sha>:.adr/");
  });

  test("a stub that kept its body is named", () => {
    const stub = { ...STUB, text: `${STUB.text}\n## Context\n\nOld text.\n` };
    const failures = failuresOf([stub, NEWER]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("still has a body");
  });

  test("a stub status without a date is named", () => {
    const stub = { ...STUB, text: STUB.text.replace(" (2026-11-16)", "") };
    expect(failuresOf([stub, NEWER])).toEqual([`.adr/${A}: is a stub whose Status line has no date of the supersession`]);
  });

  test("a retired record names where its rule lives", () => {
    const retired = record(
      A,
      [
        "- **Status:** Retired: the rule lives in `bridge/surface/protocol.ts`",
        "- **Decided:** One door.",
        `- **Full text:** \`git show 0123abc:.adr/${A}\``,
      ].join("\n"),
      "",
    );
    expect(failuresOf([retired])).toEqual([]);
    const bare = { ...retired, text: retired.text.replace(": the rule lives in `bridge/surface/protocol.ts`", "") };
    expect(failuresOf([bare])).toEqual([`.adr/${A}: is retired without \`Retired: the rule lives in <path>\` as its status`]);
  });

  test("a superseded record that still holds its full text is refused unless it is on the list", () => {
    const old = record(
      "0099-old-rule.md",
      `- **Status:** Superseded by [ADR 0002](./${B}) (2026-11-16)\n- **Date:** 2026-10-01`,
    );
    const newer = live(B, "- **Supersedes:** [ADR 0099](./0099-old-rule.md)");
    expect(failuresOf([old, newer]).length).toBeGreaterThan(0);
    expect(NOT_YET_STUBBED.has("0099")).toBe(false);
  });
});

describe("check-adr: a new record", () => {
  const NAME = `${String(FIRST_STRICT_NUMBER).padStart(4, "0")}-new-rule.md`;

  function fresh(lineCount: number, header: string): AdrFile {
    const filler = Array.from({ length: lineCount }, (_, index) => `Line ${index}.`).join("\n");
    return record(NAME, header, `## Decision\n\n${filler}\n`);
  }

  const HEADER = "- **Status:** Accepted\n- **Date:** 2026-11-16\n- **Trail:** issue #1";

  test("a short record with a Trail passes", () => {
    expect(failuresOf([fresh(20, HEADER)])).toEqual([]);
  });

  test("a record without a Trail is named", () => {
    const failures = failuresOf([fresh(20, "- **Status:** Accepted\n- **Date:** 2026-11-16")]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain(`.adr/${NAME}: has no Trail header line`);
  });

  test("a record over the line limit is named", () => {
    const failures = failuresOf([fresh(MAX_LINES, HEADER)]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain(`.adr/${NAME}: is `);
    expect(failures[0]).toContain(`a record is at most ${MAX_LINES}`);
  });

  test("an older record is not held to the line limit or the Trail", () => {
    const long = record(A, "- **Status:** Accepted\n- **Date:** 2026-11-01", `## Decision\n\n${"Line.\n".repeat(400)}`);
    expect(failuresOf([long])).toEqual([]);
  });
});
