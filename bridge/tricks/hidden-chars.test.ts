import { describe, expect, test } from "bun:test";

import { HIDDEN_CHAR_CASES } from "../../web/src/test/hidden-char-cases.ts";
import type { TrickManifest } from "../../web/src/lib/tricks/schema.ts";
import { addedDiff, GROUP_MASKED } from "./card-group.ts";
import { unsafeText } from "./code-hash.ts";
import { proposalCard, proposalVersionCard, type ProposerFacts } from "./proposal-card.ts";
import { readViewLine } from "./version-diff.ts";

// REVIEW 7 M1: the bridge runs the phone's table of hidden characters (web/src/test/hidden-char-cases.ts)
// through its own readers, and a proposal or a proposed version with one is refused, one card or a group.

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const MANIFEST: TrickManifest = { id: "legs", name: "Legs", run: "program.ts", mode: "once", contract: 1, icon: "plug", places: ["belt"] };
const WHO: ProposerFacts = { by: "agent", host: "workshop", label: "repo#one" };
const files = (program: string) => [
  { rel: "trick.toml", bytes: enc('id = "legs"\n') },
  { rel: "program.ts", bytes: enc(program) },
];

describe("the bridge runs the one table", () => {
  for (const { ch, name, hidden } of HIDDEN_CHAR_CASES) {
    // A line never holds a line feed, and a tab shows as two spaces: neither hides anything.
    if (ch === "\n") continue;
    test(`${name}: ${hidden ? "a ? on the card, the line marked" : "kept"}`, () => {
      const read = readViewLine(`a${ch}b`);
      expect(read.masked).toBe(hidden);
      if (hidden) expect(read.line).toBe("a?b");
      if (ch !== "\t") expect(unsafeText(ch)).toBe(hidden);
    });
  }
});

describe("the U+2028 proof", () => {
  const code = "// note globalThis.ran = true";

  test("JavaScript reads U+2028 as a line end: what looks like one comment runs code", () => {
    const scope = new Map<string, boolean>();
    new Function("globalThis", code.replace("globalThis.ran = true", "globalThis.set('ran', true)"))(scope);
    expect(scope.get("ran")).toBe(true);
  });

  test("a proposal with it is refused, on one card and on a group", () => {
    const one = proposalCard({ id: "legs", manifest: MANIFEST, proposer: WHO, diff: addedDiff(files(`${code}\n`)), warnings: [], crew: false });
    expect(one).toEqual({ ok: false, code: "cannot_show", error: GROUP_MASKED });
    const long = `${"console.log(1);\n".repeat(600)}${code}\n`;
    const group = proposalCard({ id: "legs", manifest: MANIFEST, proposer: WHO, diff: addedDiff(files(long)), warnings: [], crew: false });
    expect(group).toEqual({ ok: false, code: "cannot_show", error: GROUP_MASKED });
  });

  test("a proposed version with it is refused", () => {
    const card = proposalVersionCard({ id: "legs", manifest: MANIFEST, baseManifest: MANIFEST, proposer: WHO, diff: addedDiff(files(`${code}\n`)), warnings: [], crew: false });
    expect(card).toEqual({ ok: false, code: "cannot_show", error: GROUP_MASKED });
  });

  // A lone surrogate never reaches a file's bytes: UTF-8 cannot hold one.
  for (const { ch, name } of HIDDEN_CHAR_CASES.filter((c) => c.hidden && c.ch !== "\ud800")) {
    test(`a proposal with ${name} in its code is refused`, () => {
      const card = proposalCard({ id: "legs", manifest: MANIFEST, proposer: WHO, diff: addedDiff(files(`const a${ch} = 1;\n`)), warnings: [], crew: false });
      expect(card).toMatchObject({ ok: false, code: "cannot_show" });
    });
  }
});
