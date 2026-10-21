import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseKiroTranscript } from "./kiro.ts";

// The browser tier draws Kiro's Chat and History from a committed parse of a session saved by the
// kiro-cli 2.32.0 (fixtures/kiro/README.md), because Playwright cannot load the bridge's parser. This test is what keeps that copy
// honest: a parser change shows up here as a diff of the golden, and the web fixtures follow it.
//
// Regenerate on purpose only, and say so in the PR:
//   COLLIE_REGEN_KIRO_JOURNAL=1 bun test bridge/journal/kiro-journal-golden.test.ts

const SOURCE = join(import.meta.dir, "fixtures", "kiro", "messages.jsonl");
const GOLDEN = join(import.meta.dir, "..", "..", "web", "src", "fixtures", "kiro-journal-entries.json");

describe("the committed Kiro journal golden", () => {
  test("is what the shipped parser reads from the saved-session fixture", () => {
    // Given: the saved session.
    const log = readFileSync(SOURCE, "utf8");
    // When: the shipped Kiro journal parses it.
    const text = `${JSON.stringify(parseKiroTranscript(log), null, 2)}\n`;
    if (process.env.COLLIE_REGEN_KIRO_JOURNAL === "1") writeFileSync(GOLDEN, text);
    // Then: it equals the golden the web tests import.
    // SAFETY: both sides are JSON text this test or its regeneration wrote.
    expect(JSON.parse(text) as unknown).toEqual(JSON.parse(readFileSync(GOLDEN, "utf8")) as unknown);
  });
});
