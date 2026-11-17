import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseMcodeTranscript } from "./mcode.ts";

// The browser tier draws Chat and History from a committed parse of a session saved by MiniMax Code
// 0.7.7 (fixtures/mcode/README.md says how that capture was made), because Playwright cannot load
// the bridge's parser. This test is what keeps that copy honest: a parser change shows up here as a
// diff of the golden, and the web fixtures follow it.
//
// Regenerate on purpose only, and say so in the PR:
//   COLLIE_REGEN_MCODE_JOURNAL=1 bun test bridge/journal/mcode-journal-golden.test.ts

const SOURCE = join(import.meta.dir, "fixtures", "mcode", "messages.jsonl");
const GOLDEN = join(import.meta.dir, "..", "..", "web", "src", "fixtures", "mcode-journal-entries.json");

describe("the committed mcode journal golden", () => {
  test("is what the shipped parser reads from the saved-session fixture", () => {
    // Given: the saved session.
    const log = readFileSync(SOURCE, "utf8");
    // When: the shipped mcode journal parses it.
    const text = `${JSON.stringify(parseMcodeTranscript(log), null, 2)}\n`;
    if (process.env.COLLIE_REGEN_MCODE_JOURNAL === "1") writeFileSync(GOLDEN, text);
    // Then: it equals the golden the web tests draw from.
    // SAFETY: both sides are JSON text this test or its regeneration wrote.
    expect(JSON.parse(text) as unknown).toEqual(JSON.parse(readFileSync(GOLDEN, "utf8")) as unknown);
  });
});
