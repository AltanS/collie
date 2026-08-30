import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ACK_MANIFEST } from "./ack-manifest";

// The anti-rot guard for lib/ack-manifest.ts. It reads api.ts AS SOURCE — never by importing it —
// for the same reason components/collie-mark-hash.test.ts does: the property being asserted is a
// fact about the FILE (which exports it declares, how they are written), and a module object cannot
// tell a POST wrapper from a GET one at runtime.
//
// ── WHAT THE EXTRACTION KEYS ON ─────────────────────────────────────────────────────────────────
//
// Two keys, both textual, both narrow on purpose:
//
//   1. The source is cut into chunks at every top-level `export` (a line STARTING with `export`).
//      A chunk's name is read from `export [async] function <name>` or `export const <name>`;
//      `export type` / `export interface` / re-exports have no name to take and are dropped.
//   2. A chunk is MUTATING iff its text contains the literal `method: "POST"` (or PUT/PATCH/DELETE).
//      That is the one spelling every mutating call in api.ts uses today, whether it goes through
//      `req` (the JSON transport) or straight to `apiFetch` (the multipart upload, the raw-audio
//      STT post) — so it catches both without knowing which helper was used.
//
// ── WHAT WOULD SLIP PAST IT, STATED SO NOBODY DISCOVERS IT THE HARD WAY ─────────────────────────
//
//   • A method that is not a literal at the call: `method: verb`, `method`, `...init`, or a new
//     transport helper that hardcodes POST once and is passed a path. Each is invisible here.
//   • A mutation exported from some OTHER module and re-exported through api.ts — the chunk carries
//     no method literal, only a name.
//   • A GET that mutates on the bridge's side. `refreshNow` is the near miss in the other direction:
//     it POSTs and is in the manifest, while the bridge gates it as a read (ADR 0031).
//   • Indentation: a top-level export is assumed to start at column 0. Everything in api.ts does.
//
// The false-positive direction is bounded but real: a non-exported helper containing the literal,
// placed between two exports, is attributed to the chunk above it. Chunking at EVERY top-level
// export (not only functions) is what keeps that window one declaration wide.
//
// None of that is a hole to be plugged with a cleverer regex — a regex cannot know a bridge route's
// semantics any more than scripts/check-pack-wire.sh can know a protocol change's (ADR 0025). It is
// the reason the manifest's `why` lines are written by a person and read in review. What the guard
// buys is that the ORDINARY way of adding a mutation to this file cannot be done without answering
// the question, and that is the way every one of the seventeen present today was added.

// VERIFIED TO FAIL IN BOTH DIRECTIONS (DESIGN.md §9), which is what makes this a guard rather than a
// comment: adding `export function pokeThing() { return req("/api/poke", { method: "POST" }) }` to
// api.ts fails with `+ "pokeThing"`, and deleting the `focusPane` entry from the manifest fails with
// the same name from the other side.

const MUTATING_METHOD = /method:\s*"(?:POST|PUT|PATCH|DELETE)"/;
const EXPORTED_NAME = /^export (?:async function|function|const) ([A-Za-z0-9_$]+)\b/;

function mutatingExportsOf(source: string): string[] {
  const starts: number[] = [];
  const boundary = /^export\b/gm;
  for (let m = boundary.exec(source); m !== null; m = boundary.exec(source)) starts.push(m.index);

  const names: string[] = [];
  for (const [i, start] of starts.entries()) {
    const chunk = source.slice(start, starts[i + 1] ?? source.length);
    const named = EXPORTED_NAME.exec(chunk);
    if (named === null) continue;
    if (!MUTATING_METHOD.test(chunk)) continue;
    names.push(named[1]);
  }
  return names;
}

describe("ack-manifest covers every mutating export of lib/api.ts", () => {
  const source = readFileSync(join(import.meta.dirname, "api.ts"), "utf-8");

  it("names the same set of mutations the source declares", () => {
    const found = mutatingExportsOf(source).toSorted();
    const declared = Object.keys(ACK_MANIFEST).toSorted();
    // One assertion on the two SETS rather than two "contains" checks, so both directions fail
    // loudly: a new mutation with no entry, and an entry left behind by a deleted mutation.
    expect(found).toEqual(declared);
  });

  it("finds the mutations at all", () => {
    // A negative control for the extraction itself. Break the regex and the test above would pass
    // trivially against an empty manifest; this refuses an empty or implausibly small answer, and
    // pins three call shapes that are each written differently in api.ts — through `req`, through
    // `apiFetch` with FormData, and through `apiFetch` with a raw body.
    const found = mutatingExportsOf(source);
    expect(found.length).toBeGreaterThan(10);
    expect(found).toContain("closePane");
    expect(found).toContain("uploadImage");
    expect(found).toContain("transcribeAudio");
  });

  it("never counts a read", () => {
    // The other half of the control: the GET wrappers must stay out, or "set equality" would be
    // satisfied by a manifest that classified the whole file.
    const found = mutatingExportsOf(source);
    for (const read of ["fetchSnapshot", "fetchPane", "fetchHistory", "fetchConfig", "fetchDevices", "fetchPack", "getNotifyPrefs"]) {
      expect(found).not.toContain(read);
    }
  });

  it("carries a real one-line WHY on every entry", () => {
    // `why: string` is already required by the type, so this catches the thing the compiler cannot:
    // an empty string, or a placeholder short enough to be a shrug rather than a reason.
    for (const [name, entry] of Object.entries(ACK_MANIFEST)) {
      expect(entry.why.trim().length, `${name} needs a real why`).toBeGreaterThan(40);
    }
  });
});
