import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { PROBE_FIELDS, probeDefaults, probeOutput } from "./fakes.ts";

// THE RATCHET BETWEEN THE GOLDEN SCRIPT AND THE FAKE.
//
// `cli/testdata/leg1-probe.sh` is what a real member runs, and three suites build their fake payload
// from `cli/fakes.ts`. On 2026-10-01 they had drifted to 21, 20 and 15 of the script's 21 fields, so
// two of them tested their consumers against a payload no member sends. Nothing failed, because
// nothing compared the two.
//
// This does. Add a `say` line to the script and it fails here until `PROBE_FIELDS` learns the field.

const SCRIPT = join(import.meta.dir, "testdata", "leg1-probe.sh");

/** Every `say <field>` the golden script emits, in order, `probe` excluded — it is the terminator. */
function scriptFields(): string[] {
  const src = readFileSync(SCRIPT, "utf8");
  return [...src.matchAll(/^say ([a-z0-9]+)\b/gmu)].map((m) => m[1]!).filter((f) => f !== "probe");
}

describe("the leg-1 probe contract", () => {
  test("the fake reports exactly the fields the real script does, and in its order", () => {
    // SAFETY: widening a `readonly` tuple of literals to `string[]` so it can be compared with the
    // strings parsed out of the shell script. The assertion drops knowledge, never adds any, and the
    // comparison it enables is the whole subject of this file.
    const declared: string[] = [...PROBE_FIELDS];
    expect(declared).toEqual(scriptFields());
  });

  test("the default payload has a value for every one of them", () => {
    const defaults = probeDefaults();
    for (const field of PROBE_FIELDS) {
      expect(defaults).toHaveProperty(field);
    }
    expect(Object.keys(defaults).toSorted()).toEqual([...PROBE_FIELDS].toSorted());
  });

  test("the payload ends with the terminator the reader waits for", () => {
    const out = probeOutput();
    expect(out.trimEnd().split("\n").at(-1)).toBe("collie-probe:probe=ok");
    // One line per field plus the terminator, and a trailing newline.
    expect(out.trimEnd().split("\n")).toHaveLength(PROBE_FIELDS.length + 1);
  });

  test("an override replaces a value and adds no field", () => {
    const out = probeOutput({ version: "9.9.9" });
    expect(out).toContain("collie-probe:version=9.9.9");
    expect(out.trimEnd().split("\n")).toHaveLength(PROBE_FIELDS.length + 1);
  });
});
