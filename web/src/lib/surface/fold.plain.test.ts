import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { agentOf, idleFor, PANES_DIR, rowsOf } from "../../test/surface-corpus";
import { CORPUS_WALK, FIXTURES, labelOf } from "../../test/surface-fold";
import { surfaceOfScreen } from "./fold";
import { liftDialog, askOfLift, readerBlocks } from "./lift";
import { stripSgr } from "./plain";
import { modalWord } from "./surface";

// M78 spec 01: herdr-core's `terminal.read` hands Collie a screen with no SGR byte at all, and every
// pane fixture was captured with its styling. This reads each fixture twice, as captured and with its
// SGR stripped (the same rows, the same width, the same profile), and compares what the phone shows:
// the state, the ask, the draft and the frame anchors. A fixture that reads differently stripped is on
// fold.plain.allow.json with a reason and a class, and an entry that no longer differs fails (a stale
// allowlist). The allowlist is the gap list of the Surface on a multiplexer with no colour; the report
// is experiments/herdr-core-coverage/01-plain-corpus.md in the workspace.

type Class = "colour-needed" | "text-rule-possible";
interface AllowEntry {
  readonly why: string;
  readonly class: Class;
  readonly rule: string;
}

/** What one reading shows the phone. */
interface Reading {
  readonly state: string;
  readonly ask: { readonly kind: string; readonly options: readonly string[]; readonly pointer: string } | null;
  readonly draft: string;
  readonly anchors: string;
}

function readOne(raw: string, harness: string): Reading {
  const rows = rowsOf(raw);
  const blocks = readerBlocks(rows, agentOf(harness));
  const dialog = liftDialog(blocks);
  const ask = dialog === null ? null : askOfLift(dialog, `ask-${dialog.hash.slice(0, 8)}`);
  const read = surfaceOfScreen({ seq: 1, source: "screen", at: 0, revision: 1, rows, ask }, idleFor(harness));
  const { surface, frame } = read;
  const reason = surface.reason === undefined ? "" : ` (${JSON.stringify(surface.reason)})`;
  // The pointer is what the option keys encode: a walk from the selected row to each option.
  const block = dialog?.block;
  const pointer = block?.kind === "prompt-select" ? JSON.stringify(block.prompt.options.map((option) => option.keys)) : "";
  return {
    state: `turn ${surface.turn} / modal ${modalWord(surface.modal)} / composer ${surface.composer}${reason}`,
    ask: ask === null ? null : { kind: ask.kind, options: ask.options.map((option) => option.label), pointer },
    draft: frame === null ? "(no frame)" : frame.placeholder ? "(placeholder)" : frame.interior.text,
    // The three placeholder anchors (text, sgr, fg) are three tests of the one fact `draft` already carries
    // (the hole is a placeholder or it is not). A styled read hits sgr or fg, a plain read hits text since
    // the text patterns count on an unstyled read only, so which one hits is no divergence.
    anchors: frame === null ? "(no frame)" : frame.anchorsHit.filter((hit) => !hit.startsWith("placeholder-")).join(","),
  };
}

/** The fields of two readings that differ, as `field: styled -> plain`. */
function differences(styled: Reading, plain: Reading): string[] {
  const out: string[] = [];
  if (styled.state !== plain.state) out.push(`state: ${styled.state} -> ${plain.state}`);
  const a = JSON.stringify(styled.ask);
  const b = JSON.stringify(plain.ask);
  if (a !== b) out.push(`ask: ${a} -> ${b}`);
  if (styled.draft !== plain.draft) out.push(`draft: ${JSON.stringify(styled.draft)} -> ${JSON.stringify(plain.draft)}`);
  if (styled.anchors !== plain.anchors) out.push(`anchors: ${styled.anchors} -> ${plain.anchors}`);
  return out;
}

function loadAllow(): Record<string, AllowEntry> {
  // SAFETY: a committed file of this repo; the test below checks every entry's shape.
  return JSON.parse(readFileSync(join(import.meta.dirname, "fold.plain.allow.json"), "utf8")) as Record<string, AllowEntry>;
}

const ALLOW = loadAllow();

const DIVERGENT = new Map<string, string[]>();
const WALK = new Map<string, true>();

function walk(): void {
  if (WALK.size > 0) return;
  for (const name of FIXTURES) {
    const raw = readFileSync(join(PANES_DIR, name), "utf8");
    const harness = labelOf(name).harness;
    const found = differences(readOne(raw, harness), readOne(stripSgr(raw), harness));
    if (found.length > 0) DIVERGENT.set(name, found);
    WALK.set(name, true);
  }
  const dump = process.env.PLAIN_DUMP;
  if (dump !== undefined) writeFileSync(dump, JSON.stringify(Object.fromEntries(DIVERGENT), null, 2));
}

describe("the corpus read as plain text", () => {
  it("the allowlist names a why, a class and a rule on every entry, and only fixtures that exist", () => {
    expect(Object.keys(ALLOW).length).toBeGreaterThan(0);
    for (const [name, entry] of Object.entries(ALLOW)) {
      expect(FIXTURES, name).toContain(name);
      expect(entry.why.length, name).toBeGreaterThan(10);
      expect(["colour-needed", "text-rule-possible"], name).toContain(entry.class);
      expect(entry.rule.length, name).toBeGreaterThan(3);
    }
  });

  it("some fixtures carry SGR, so the strip changes what is read", () => {
    const styled = FIXTURES.filter((name) => readFileSync(join(PANES_DIR, name), "utf8").includes("\u001b[")).length;
    expect(styled).toBeGreaterThan(1000);
  });

  it("every fixture reads the same stripped of SGR, or is on the allowlist", CORPUS_WALK, () => {
    walk();
    const unlisted = [...DIVERGENT].filter(([name]) => ALLOW[name] === undefined).map(([name, found]) => `${name}\n    ${found.join("\n    ")}`);
    expect(unlisted).toEqual([]);
  });

  it("every allowlist entry still diverges (no stale entry)", CORPUS_WALK, () => {
    walk();
    const stale = Object.keys(ALLOW).filter((name) => !DIVERGENT.has(name));
    expect(stale).toEqual([]);
  });
});
