import { describe, expect, test } from "bun:test";

import { createCacheRulesReader, validateOperatorCacheRules } from "./operator-cache-rules.ts";
import type { OperatorFileIo } from "./operator-file.ts";

// `cache-rules.toml`'s grammar, and the reader it rides. The grammar is pure and total, which is the
// point: `collie doctor` runs this very function, so the verb and the bridge can never disagree about
// which row is valid.

/** The clock every case is judged against, so "in the future" means one thing forever. */
const NOW = Date.parse("2026-09-13T12:00:00Z");

const parse = (toml: string) => {
  const warnings: string[] = [];
  // SAFETY: the test's own literal TOML. `validateOperatorCacheRules` checks every field it names.
  const rows = validateOperatorCacheRules(
    Bun.TOML.parse(toml) as { rule?: unknown },
    (m) => warnings.push(m),
    () => NOW,
  );
  return { rows, warnings };
};

const GOOD = `
[[rule]]
id = "claude.api"
ttl_seconds = 3600
source_url = "https://platform.claude.com/docs/en/build-with-claude/prompt-caching"
retrieved = "2026-09-12"
note = "our gateway sends ttl 1h on every request"
`;

describe("a good row", () => {
  test("is kept whole", () => {
    const { rows, warnings } = parse(GOOD);
    expect(warnings).toEqual([]);
    expect(rows).toEqual([
      {
        ruleId: "claude.api",
        ttlSeconds: 3600,
        sourceUrl: "https://platform.claude.com/docs/en/build-with-claude/prompt-caching",
        retrieved: "2026-09-12",
        note: "our gateway sends ttl 1h on every request",
      },
    ]);
  });

  test("needs no note", () => {
    const { rows } = parse(GOOD.replace(/^note = .*$/m, ""));
    expect(rows[0]?.note).toBeUndefined();
  });

  test("may move any id this build ships", () => {
    const { rows, warnings } = parse(`
[[rule]]
id = "opencode.google"
ttl_seconds = 600
source_url = "https://openrouter.ai/docs/features/prompt-caching"
retrieved = "2026-09-13"

[[rule]]
id = "pi.unknown"
ttl_seconds = 120
source_url = "https://example.invalid/read-this"
retrieved = "2026-09-13"
`);
    expect(warnings).toEqual([]);
    expect(rows.map((r) => r.ruleId)).toEqual(["opencode.google", "pi.unknown"]);
  });

  test("is still good when it was retrieved today — the bound is after today, not today", () => {
    const { rows, warnings } = parse(GOOD.replace('retrieved = "2026-09-12"', 'retrieved = "2026-09-13"'));
    expect(warnings).toEqual([]);
    expect(rows[0]?.retrieved).toBe("2026-09-13");
  });
});

describe("a row is DROPPED, never defaulted, when", () => {
  const cases: Array<[string, string, string]> = [
    ["the id names no shipped rule", 'id = "claude.enterprise"', "not a rule this build ships"],
    ["the id is a number", "id = 7", '"id" is missing or not a string'],
    ["the ttl is not a whole number", "ttl_seconds = 3600.5", "whole number of seconds"],
    ["the ttl is zero", "ttl_seconds = 0", "between 1 and 86400"],
    ["the ttl is longer than a day", "ttl_seconds = 90000", "between 1 and 86400"],
    ["the source url is empty", 'source_url = ""', '"source_url" is required'],
    ["the retrieved date is prose", 'retrieved = "last tuesday"', "not a YYYY-MM-DD date"],
    ["the retrieved date is not a real day", 'retrieved = "2026-02-31"', "not a YYYY-MM-DD date"],
    ["the retrieved date has not happened yet", 'retrieved = "2099-01-01"', '"retrieved" is in the future'],
    ["the retrieved date is tomorrow", 'retrieved = "2026-09-14"', '"retrieved" is in the future'],
    ["the note is present but empty", 'note = ""', '"note" must be a non-empty string'],
  ];
  for (const [what, line, expected] of cases) {
    test(what, () => {
      const key = line.slice(0, line.indexOf(" ="));
      const body = GOOD.split("\n")
        .filter((l) => !l.startsWith(`${key} =`))
        .join("\n");
      const { rows, warnings } = parse(`${body}\n${line}\n`);
      expect(rows).toEqual([]);
      expect(warnings.join(" ")).toContain(expected);
    });
  }

  test("a required field is simply absent", () => {
    const { rows, warnings } = parse('[[rule]]\nid = "claude.api"\nttl_seconds = 600\n');
    expect(rows).toEqual([]);
    expect(warnings.join(" ")).toContain('"source_url" is required');
  });
});

describe("the file as a whole", () => {
  test("loses only the bad row, never the good ones", () => {
    const { rows, warnings } = parse(`${GOOD}
[[rule]]
id = "nope.nope"
ttl_seconds = 60
source_url = "https://example.invalid/x"
retrieved = "2026-09-13"

[[rule]]
id = "codex.api"
ttl_seconds = 1800
source_url = "https://developers.openai.com/api/docs/guides/prompt-caching"
retrieved = "2026-09-13"
`);
    expect(rows.map((r) => r.ruleId)).toEqual(["claude.api", "codex.api"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("row 2");
  });

  test("lets a later row for the same id win, in place", () => {
    const { rows, warnings } = parse(`${GOOD}
[[rule]]
id = "claude.api"
ttl_seconds = 300
source_url = "https://code.claude.com/docs/en/prompt-caching"
retrieved = "2026-09-13"
`);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ttlSeconds).toBe(300);
    expect(warnings.join(" ")).toContain("redefined");
  });

  test("declaring nothing is not an error", () => {
    expect(parse("# nothing here\n").rows).toEqual([]);
    expect(validateOperatorCacheRules(null)).toEqual([]);
    expect(validateOperatorCacheRules(undefined)).toEqual([]);
  });

  test("`rule` that is not an array loses the file, with one line about it", () => {
    const { rows, warnings } = parse('rule = "claude.api"\n');
    expect(rows).toEqual([]);
    expect(warnings.join(" ")).toContain("must be an array");
  });
});

describe("the reader", () => {
  const io = (files: Record<string, { text: string; mtime: number }>): OperatorFileIo => ({
    mtime: async (p) => files[p]?.mtime ?? null,
    read: async (p) => {
      const hit = files[p];
      if (hit === undefined) throw new Error("ENOENT");
      return hit.text;
    },
  });

  test("an absent file is no rows and no complaint", async () => {
    const warnings: string[] = [];
    const read = createCacheRulesReader("/cfg/cache-rules.toml", io({}), (m) => warnings.push(m));
    expect(await read()).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("rows are re-read when the mtime moves, and cached when it does not", async () => {
    const files = { "/cfg/cache-rules.toml": { text: GOOD, mtime: 1 } };
    const read = createCacheRulesReader("/cfg/cache-rules.toml", io(files), () => {});
    expect((await read())[0]?.ttlSeconds).toBe(3600);
    files["/cfg/cache-rules.toml"] = { text: GOOD.replace("3600", "900"), mtime: 1 };
    expect((await read())[0]?.ttlSeconds).toBe(3600);
    files["/cfg/cache-rules.toml"] = { text: GOOD.replace("3600", "900"), mtime: 2 };
    expect((await read())[0]?.ttlSeconds).toBe(900);
  });

  test("a file that stops parsing HOLDS the last good rows rather than emptying", async () => {
    const files = { "/cfg/cache-rules.toml": { text: GOOD, mtime: 1 } };
    const warnings: string[] = [];
    const read = createCacheRulesReader("/cfg/cache-rules.toml", io(files), (m) => warnings.push(m));
    expect(await read()).toHaveLength(1);
    files["/cfg/cache-rules.toml"] = { text: "[[rule]\nid =", mtime: 2 };
    expect(await read()).toHaveLength(1);
    expect(warnings.join(" ")).toContain("keeping the last good rows");
  });
});
