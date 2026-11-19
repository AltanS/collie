// The header of a quarantined test (`// quarantined: YYYY-MM-DD <reason>`) and the 14-day limit that reads
// it. The real-tree test below checks the HEADER only. The date is checked by `scripts/check-quarantine.ts`
// in the `quarantine` CI job, and here only against fixed dates, so this file never fails because time passed.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { daysQuarantined, firstLinesOf, parseQuarantineHeader, quarantineFiles, quarantineFindings } from "./check-quarantine.ts";

const ROOT = join(import.meta.dir, "..");

describe("every quarantined file in the tree", () => {
  test("starts with `// quarantined: YYYY-MM-DD <reason>`", () => {
    const lines = firstLinesOf(ROOT, quarantineFiles(ROOT));
    const missing = [...lines].filter(([, line]) => parseQuarantineHeader(line) === null).map(([file]) => file);
    expect(missing).toEqual([]);
  });
});

describe("parseQuarantineHeader", () => {
  test("reads the day and the reason", () => {
    const header = parseQuarantineHeader("// quarantined: 2026-11-19 flaky on the runner, issue 812");
    expect(header?.since.toISOString()).toBe("2026-11-19T00:00:00.000Z");
    expect(header?.reason).toBe("flaky on the runner, issue 812");
  });

  test("refuses a missing reason, a bad shape and a day that does not exist", () => {
    expect(parseQuarantineHeader("// quarantined: 2026-11-19")).toBeNull();
    expect(parseQuarantineHeader("// quarantined: 2026-11-19 ")).toBeNull();
    expect(parseQuarantineHeader("// quarantine: 2026-11-19 flaky")).toBeNull();
    expect(parseQuarantineHeader("//quarantined: 2026-11-19 flaky")).toBeNull();
    expect(parseQuarantineHeader("// quarantined: 19-11-2026 flaky")).toBeNull();
    expect(parseQuarantineHeader("// quarantined: 2026-02-30 flaky")).toBeNull();
    expect(parseQuarantineHeader("// quarantined: 2026-13-01 flaky")).toBeNull();
    expect(parseQuarantineHeader('import { test } from "bun:test";')).toBeNull();
  });
});

describe("quarantineFindings", () => {
  const since = (day: string): ReadonlyMap<string, string> => new Map([["bridge/x.quarantine.test.ts", `// quarantined: ${day} flaky`]]);

  test("counts whole days from the quarantine day", () => {
    const header = parseQuarantineHeader("// quarantined: 2026-11-01 flaky");
    expect(header && daysQuarantined(header, new Date("2026-11-01T23:59:00Z"))).toBe(0);
    expect(header && daysQuarantined(header, new Date("2026-11-15T00:00:00Z"))).toBe(14);
  });

  test("the fourteenth day is allowed and the fifteenth is not", () => {
    expect(quarantineFindings(since("2026-11-01"), new Date("2026-11-15T12:00:00Z"))).toEqual([]);
    const late = quarantineFindings(since("2026-11-01"), new Date("2026-11-16T00:00:00Z"));
    expect(late).toHaveLength(1);
    expect(late[0]?.problem).toContain("15 days ago");
  });

  test("a file with no header is a finding, whatever the date", () => {
    const findings = quarantineFindings(new Map([["web/src/y.quarantine.test.tsx", "import { test } from \"vitest\";"]]), new Date("2026-11-01T00:00:00Z"));
    expect(findings.map((finding) => finding.file)).toEqual(["web/src/y.quarantine.test.tsx"]);
  });
});
