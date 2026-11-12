import { describe, expect, test } from "bun:test";

import { HIDDEN_CHAR_CASES } from "../../web/src/test/hidden-char-cases.ts";
import type { TrickManifest } from "../../web/src/lib/tricks/schema.ts";
import { addedDiff, GROUP_MASKED, groupLineEnds } from "./card-group.ts";
import { unsafeText } from "./code-hash.ts";
import { proposalCard, proposalCardCount, proposalVersionCard, type ProposerFacts } from "./proposal-card.ts";
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

describe("line ends", () => {
  const crlf = (text: string) => text.replaceAll("\n", "\r\n");
  const long = "console.log(1);\n".repeat(600);

  test("a file with Windows line ends (CRLF) is proposed, on one card and on a group, and no card holds its CR", () => {
    for (const program of [crlf("console.log(1);\nconsole.log(2);\n"), crlf(long)]) {
      const made = proposalCard({ id: "legs", manifest: MANIFEST, proposer: WHO, diff: addedDiff([{ rel: "trick.toml", bytes: enc(crlf('id = "legs"\n')) }, { rel: "program.ts", bytes: enc(program) }]), warnings: [], crew: false });
      if (!made.ok) throw new Error(made.error);
      expect(JSON.stringify(made.card)).not.toContain("\\r");
    }
    // `collie trick propose` counts the same cards as for the file with Unix line ends.
    const windows = [{ rel: "trick.toml", bytes: enc(crlf('id = "legs"\n')) }, { rel: "program.ts", bytes: enc(crlf(long)) }];
    expect(proposalCardCount({ manifest: MANIFEST, files: windows, warnings: [], crew: false })).toEqual({ ok: true, cards: 3 });
    expect(proposalCardCount({ manifest: MANIFEST, files: files(long), warnings: [], crew: false })).toEqual({ ok: true, cards: 3 });
  });

  test("a carriage return inside a line (old or mixed line ends) refuses the proposal in its own words, naming the file", () => {
    const words = groupLineEnds("program.ts");
    expect(words).toBe("This trick holds a file with old or mixed line ends (program.ts), so it was not proposed. Save it with Unix line ends, or ask your person to add it on the machine.");
    // Old Mac line ends, a doubled CR before a CRLF line end, and a lone CR in an LF file; one card and a group.
    for (const program of ["console.log(1);\rconsole.log(2);\r", "console.log(1);\r\r\n", "a();\rb();\n", `${long}a();\rb();\n`]) {
      const one = proposalCard({ id: "legs", manifest: MANIFEST, proposer: WHO, diff: addedDiff(files(program)), warnings: [], crew: false });
      expect(one).toEqual({ ok: false, code: "cannot_show", error: words });
    }
    const version = proposalVersionCard({ id: "legs", manifest: MANIFEST, baseManifest: MANIFEST, proposer: WHO, diff: addedDiff(files("a();\rb();\n")), warnings: [], crew: false });
    expect(version).toEqual({ ok: false, code: "cannot_show", error: words });
  });

  test("a stray CR beside a key or another hidden character keeps the general refusal", () => {
    for (const program of ['a();\rb();\nconst KEY = "sk-or-v1-your-key-here-placeholder00";\n', "a();\r\u202eb();\n", "a();\rb();\nconst x = '\u200b';\n"]) {
      const card = proposalCard({ id: "legs", manifest: MANIFEST, proposer: WHO, diff: addedDiff(files(program)), warnings: [], crew: false });
      expect(card).toEqual({ ok: false, code: "cannot_show", error: GROUP_MASKED });
    }
  });
});
