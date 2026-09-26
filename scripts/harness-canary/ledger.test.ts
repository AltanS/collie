import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEDGER_FILE, recordVerified, withRecord } from "./ledger";

const LEDGER = JSON.stringify(
  {
    $comment: "kept",
    agents: {
      claude: { version: "2.1.278", verified: "2026-09-22", how: "capture", adapter: true, evidence: "old" },
      pi: { version: "0.87.0", verified: "2026-09-20", how: "live sweep", adapter: false, evidence: "old" },
    },
  },
  null,
  2,
);

const rec = { agent: "claude", version: "2.1.283", verified: "2026-09-26", adapter: false, evidence: "canary run X" };

describe("withRecord", () => {
  test("rewrites the one entry and keeps the rest", () => {
    const next = JSON.parse(withRecord(LEDGER, rec));
    expect(next.$comment).toBe("kept");
    expect(next.agents.claude).toEqual({
      version: "2.1.283",
      verified: "2026-09-26",
      how: "canary",
      // The entry's own `adapter` wins over the caller's guess.
      adapter: true,
      evidence: "canary run X",
    });
    expect(next.agents.pi.version).toBe("0.87.0");
    expect(Object.keys(next.agents)).toEqual(["claude", "pi"]);
  });

  test("adds an agent the ledger does not have yet", () => {
    const next = JSON.parse(withRecord(LEDGER, { ...rec, agent: "opencode", version: "1.18.32" }));
    expect(next.agents.opencode.adapter).toBe(false);
    expect(next.agents.opencode.how).toBe("canary");
  });

  test("refuses a version or date that is not plain", () => {
    expect(() => withRecord(LEDGER, { ...rec, version: "2.1.283 (Claude Code)" })).toThrow(/x\.y\.z/);
    expect(() => withRecord(LEDGER, { ...rec, verified: "26.09.2026" })).toThrow(/ISO/);
  });

  test("refuses a document without an agents map", () => {
    expect(() => withRecord('{"version":1}', rec)).toThrow(/agents/);
  });
});

describe("recordVerified", () => {
  let dir = "";
  afterEach(() => {
    if (dir !== "") rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  test("writes a copy of the real ledger, never the real one", () => {
    dir = mkdtempSync(join(tmpdir(), "canary-ledger-"));
    const copy = join(dir, "verified-versions.json");
    copyFileSync(LEDGER_FILE, copy);
    const before = readFileSync(LEDGER_FILE, "utf8");
    recordVerified(rec, copy);
    expect(JSON.parse(readFileSync(copy, "utf8")).agents.claude.how).toBe("canary");
    expect(readFileSync(LEDGER_FILE, "utf8")).toBe(before);
  });

  test("never creates a missing ledger", () => {
    dir = mkdtempSync(join(tmpdir(), "canary-ledger-"));
    expect(() => recordVerified(rec, join(dir, "missing.json"))).toThrow(/does not exist/);
  });
});
