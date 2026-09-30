// The row reducer: the shape every adapter's parser takes so that a live session which gains one row
// costs one row of work.
//
// ── WHY ──────────────────────────────────────────────────────────────────────
// `parse(text)` reads a whole file. On the real sessions measured on 2026-09-29 that is 186.8 MB,
// 89.8 MB and 64.9 MB, and `files.ts`'s `MAX_TRANSCRIPT_BYTES` already clamps a read to the last
// 32 MB — which `TranscriptStore` then re-reads and re-parses on every mtime move. One new row
// therefore costs 32 MB of reading and a full re-parse of it. That is the cost this module removes.
//
// ── THE ONE FACT THE WHOLE DESIGN RESTS ON ───────────────────────────────────
// A raw `\n` byte is always a row boundary, in all six formats. The three file harnesses write JSONL,
// and the two SQLite harnesses serialise their rows through `JSON.stringify`, which escapes a newline
// inside a string value as `\n` (two characters) and never emits a raw one. So a reader may cut the
// byte stream anywhere: a fragment either completes with the next chunk or is a fragment of exactly
// one row. Nothing has to understand JSON to find the boundaries.
//
// ── WHAT A REDUCER REPORTS, AND WHY IT IS TWO LISTS ──────────────────────────
// A tool result lands in a LATER row than its call, and folding it in mutates a part inside a turn
// that was emitted already. Under `parse(text)` that is invisible: the caller only ever sees the
// finished array. Under a tail the caller is holding that turn on a screen, so the reducer has to
// say which of its earlier answers changed. Hence `changed` beside `added`.
//
// It is one `uuid` list rather than a pair of "replace" verbs because a `uuid` is the identity and
// the caller already holds the object. A reducer mutates the part in place, exactly as the whole-file
// loop always did, and names the turn it happened in.
import type { JsonValue } from "../json.ts";
import type { TranscriptEntry, TranscriptPart } from "./types.ts";

/** What one row did to the thread. */
export interface Reduction {
  /** Turns that did not exist before this row, oldest first. */
  readonly added: readonly TranscriptEntry[];
  /** `uuid`s of turns emitted EARLIER that this row changed in place. Never a position. */
  readonly changed: readonly string[];
}

// ── WHAT A REDUCER REPORTS ABOUT WHAT IT COULD NOT READ, AND WHY IT IS A METHOD ──
// A vendor's format drifts by GAINING a type, not by changing a known one: a row kind nobody has
// looked at, or a content block nobody has looked at. Every reducer here drops both silently, and it
// has to — a tail read must tolerate a blank line, a JSON fragment and a row of an unknown shape
// without throwing. So the code that keeps a screen honest is also the code that hides a format
// change. Nothing in the tree notices until somebody reads a card that looks wrong.
//
// A reducer therefore COUNTS what it had no branch for, by name, and the count is asked for with a
// METHOD rather than answered on {@link Reduction}:
//
//   * The question is about the SESSION, not about one row. "Which types did this log show that we
//     cannot read" has one answer per session, and a field on `Reduction` would make every caller
//     accumulate state the reducer already keeps.
//   * `Reduction` is the hot path. `NO_CHANGE` is one frozen object handed back from some forty
//     early returns; giving it a tally means an allocation per row for an answer almost nobody reads.
//   * It is REQUIRED, exactly as `JournalAdapter.reducer()` is required (ADR 0073 §8). Optional would
//     mean every caller writing `reducer.unknowns?.()` behind a fallback that reads "nothing
//     unknown" — the one wrong default for a gate that fails above zero.
//
// KNOWN MEANS "MET AND DECIDED ABOUT", NEVER "RENDERED". A type an adapter drops on purpose is known
// — the drop is the decision — and that is what keeps the tally to one meaning: a name nobody has
// looked at yet. Where a known list holds a type this reducer drops and arguably should not, the
// comment beside it says so. A gap with a name is not drift.
//
// The caller is `scripts/harness-canary/journal.ts`: it reads the canary's OWN session per harness,
// fails the run when the count is above zero, and names the type. Nothing on the live path asks —
// `journal/live.ts` neither calls this nor pays for it.

/**
 * A role name in a tally wears this prefix, so a name always says which field produced it.
 *
 * Two of the six formats decide a row's kind with a `type` AND a role (codex and pi); claude and grok
 * never read one, and opencode and hermes have nothing else. Without the prefix a tally saying
 * `developer` would not say where to look. Not exported: it is a spelling inside the names this
 * module produces, and a caller reads those names rather than composing one.
 */
const ROLE_PREFIX = "role:";

/** What a reducer met and had no branch for: name → how many times it met it. */
export interface UnknownTally {
  /** What decided the KIND OF ROW: a row-type name, or `role:<name>`. */
  readonly rows: ReadonlyMap<string, number>;
  /** What decided the kind of CONTENT inside a row: a part or content-block type name. */
  readonly parts: ReadonlyMap<string, number>;
}

/**
 * One adapter's inventory of the names it has met, whether it renders them or drops them.
 *
 * A list is empty where the FORMAT has no such field, and that is a statement rather than a gap:
 * hermes carries no part-type discriminator at all, opencode's composed line carries no row type,
 * and claude and grok decide a row's kind without ever reading a role.
 */
export interface KnownTypes {
  readonly rows: readonly string[];
  readonly roles: readonly string[];
  readonly parts: readonly string[];
}

/**
 * The most distinct names one tally keeps.
 *
 * A bound, for the reason `PENDING_MAX` is a bound: every name here ORIGINATES in a file written by
 * a process we do not control, so an unbounded map keyed by it is a map that grows for as long as
 * the log does. The number is far past anything real — a format that gained thirty-two unread types
 * at once is not drift, it is a different format — and what falls off is named rather than dropped:
 * a name past the bound is counted under {@link UNKNOWN_OVERFLOW}, so the COUNT is never wrong even
 * when the last names are lost. The first names are kept rather than the last, because a format
 * change shows up in the first rows that carry it.
 */
export const UNKNOWN_NAMES_MAX = 32;

/** Where a name past {@link UNKNOWN_NAMES_MAX} is counted. Parenthesised, so no real type collides. */
export const UNKNOWN_OVERFLOW = "(names past the tally's bound)";

/** Where an adapter says "I had no branch for this". One call site per discriminator it reads. */
export interface UnknownCounter {
  /** What decided the kind of row. A name in {@link KnownTypes.rows} is not counted. */
  row(type: JsonValue | undefined): void;
  /** A message role. A name in {@link KnownTypes.roles} is not counted. */
  role(role: JsonValue | undefined): void;
  /** What decided the kind of content. A name in {@link KnownTypes.parts} is not counted. */
  part(type: JsonValue | undefined): void;
  /** A SNAPSHOT, so a later `push` cannot change what a caller is holding. */
  tally(): UnknownTally;
}

/**
 * A counter that knows this adapter's inventory.
 *
 * Every method is called UNCONDITIONALLY, at the line where the adapter reads the field — never
 * inside the branch that failed to match. That is deliberate: a call per fall-through means hunting
 * every early return and every `else`, and the one that gets missed is silent. One call at the read
 * site plus a known list is auditable by reading the list.
 *
 * A value that is not a non-empty string is ignored. A row that names no type at all is not a NEW
 * type — it is a row of no shape, which the tail-tolerance rule above already covers.
 */
export function createUnknownCounter(known: KnownTypes): UnknownCounter {
  const knownRows = new Set(known.rows);
  const knownRoles = new Set(known.roles);
  const knownParts = new Set(known.parts);
  const rows = new Map<string, number>();
  const parts = new Map<string, number>();

  const bump = (into: Map<string, number>, name: string): void => {
    const at = into.get(name);
    if (at !== undefined) {
      into.set(name, at + 1);
      return;
    }
    // At the bound the count keeps going and the name stops. `into` can reach MAX + 1 entries: the
    // overflow bucket is one more name, and it is the one name worth having.
    const key = into.size >= UNKNOWN_NAMES_MAX ? UNKNOWN_OVERFLOW : name;
    into.set(key, (into.get(key) ?? 0) + 1);
  };
  const note = (into: Map<string, number>, allowed: ReadonlySet<string>, value: JsonValue | undefined, prefix = ""): void => {
    if (typeof value !== "string" || value === "") return;
    if (allowed.has(value)) return;
    bump(into, `${prefix}${value}`);
  };

  return {
    row: (type) => note(rows, knownRows, type),
    role: (role) => note(rows, knownRoles, role, ROLE_PREFIX),
    part: (type) => note(parts, knownParts, type),
    tally: () => ({ rows: new Map(rows), parts: new Map(parts) }),
  };
}

/**
 * An empty tally, for a `RowReducer` that is not one of the six grammars.
 *
 * A function rather than a shared constant: `Object.freeze` does not stop `Map.set`, so a shared
 * empty tally would be a shared mutable handed to every caller.
 */
export function noUnknowns(): UnknownTally {
  return { rows: new Map(), parts: new Map() };
}

/** How many rows and parts a reducer could not read. The gate: above zero is a finding. */
export function unknownCount(tally: UnknownTally): number {
  let total = 0;
  for (const n of tally.rows.values()) total += n;
  for (const n of tally.parts.values()) total += n;
  return total;
}

/** `name (n)` pairs, commonest first, so a failure message is stable enough to diff. */
function nameCounts(counts: ReadonlyMap<string, number>): string {
  return [...counts]
    .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, n]) => `${name} (${n})`)
    .join(", ");
}

/**
 * The tally in words, or `""` when there is nothing to report.
 *
 * A count alone is useless for diagnosis: the whole point of the gate is that the next person reads
 * the NAME of the type the vendor added.
 */
export function describeUnknowns(tally: UnknownTally): string {
  const said: string[] = [];
  if (tally.rows.size > 0) said.push(`row types ${nameCounts(tally.rows)}`);
  if (tally.parts.size > 0) said.push(`part types ${nameCounts(tally.parts)}`);
  return said.join("; ");
}

/** Count one part's own `type`, when the part is an object that names one. */
export function notePartType(note: UnknownCounter, part: JsonValue | undefined): void {
  if (part === null || part === undefined || typeof part !== "object" || Array.isArray(part)) return;
  note.part(part.type);
}

/**
 * Count every part type in a content LIST. A `content` that is a string, absent or of another shape
 * carries no part type and is nothing to count.
 */
export function noteBlockTypes(note: UnknownCounter, content: JsonValue | undefined): void {
  if (!Array.isArray(content)) return;
  for (const block of content) notePartType(note, block);
}

export interface RowReducer {
  /**
   * Fold one row in. Takes a complete line WITHOUT its newline, and tolerates every kind of rubbish
   * a tail read produces: a blank line, a fragment of JSON, a scalar, a row of an unknown shape. A
   * row it cannot use adds nothing and changes nothing; it never throws.
   */
  push(line: string): Reduction;
  /**
   * Every type name this reducer has met and had no branch for, with how often — see "what a reducer
   * reports about what it could not read" above for why this is a method and why it is required.
   *
   * Cumulative over every row pushed so far, and a SNAPSHOT: the answer does not change under a
   * later `push`. A reducer with no grammar of its own answers {@link noUnknowns}.
   */
  unknowns(): UnknownTally;
}

/** The answer for a row that did nothing. Frozen, because it is handed to every caller. */
export const NO_CHANGE: Reduction = Object.freeze({
  added: Object.freeze<TranscriptEntry[]>([]),
  changed: Object.freeze<string[]>([]),
});

/**
 * A tool call waiting for its result, and the turn it has already gone out in.
 *
 * The `uuid` is what makes `changed` possible: without it a reducer can mutate the part and has no
 * way to say where. `""` for a row that carried no id of its own, which is not reportable and is
 * dropped from `changed` rather than sent as an empty name (see {@link reduction}).
 */
export interface PendingTool {
  part: Extract<TranscriptPart, { kind: "tool" }>;
  uuid: string;
}

/**
 * The most tool calls a reducer holds waiting for a result.
 *
 * The bound is the requirement, and the number is deliberately far past anything real: a call and
 * its result are adjacent rows in every format here, so a map this size means thousands of calls in
 * a row went unanswered. Over a whole session with no bound at all the map is one of the things in a
 * reducer that grows for ever, which is the fault this closes. Eviction is oldest-first, since a
 * `Map` keeps insertion order and the oldest waiting call is the one least likely to still be
 * answered.
 *
 * It is no longer the ONLY such map. pi's reducer keeps a second one, the branch chain
 * (`journal/pi.ts` § `BRANCH_MAX`), and it is bounded here's way and for here's reason. Any state a
 * reducer keeps per row needs a bound and a sentence saying what falls off it.
 */
export const PENDING_MAX = 4096;

/** Remember a call, and forget the oldest one if that would push the map past {@link PENDING_MAX}. */
export function rememberPending<V>(map: Map<string, V>, key: string, value: V): void {
  map.set(key, value);
  if (map.size <= PENDING_MAX) return;
  const oldest = map.keys().next().value;
  if (oldest !== undefined) map.delete(oldest);
}

/**
 * Build one row's answer.
 *
 * Two rules live here rather than in six adapters. A `uuid` of `""` is dropped from `changed`,
 * because a turn with no name cannot be addressed by one. And a `uuid` that is in `added` is dropped
 * too: a row that both makes a turn and folds a result into it has not changed anything the caller
 * held, it has simply handed over a finished turn.
 */
export function reduction(added: readonly TranscriptEntry[], changed: ReadonlySet<string>): Reduction {
  if (changed.size === 0) return added.length === 0 ? NO_CHANGE : { added, changed: NO_CHANGE.changed };
  const fresh = new Set(added.map((e) => e.uuid));
  const out = [...changed].filter((uuid) => uuid !== "" && !fresh.has(uuid));
  return { added, changed: out };
}

/**
 * Run a reducer over a whole text and concatenate what it added: the `parse(text)` contract every
 * caller and every existing test already drives, expressed once.
 *
 * `text.split("\n")` is the same cut `parse` always made, including the final fragment a file with
 * no trailing newline ends in. The reducer skips that fragment when it is one, exactly as the loop
 * inside `parse` did, so the two answers are identical by construction rather than by agreement.
 */
export function parseWith(reducer: RowReducer, text: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const line of text.split("\n")) {
    for (const entry of reducer.push(line).added) entries.push(entry);
  }
  return entries;
}

/** Turns arbitrary byte chunks into complete rows. See "the one fact" in this file's header. */
export interface LineFeeder {
  /** The complete rows in these bytes. A trailing fragment is held for the next chunk. */
  push(chunk: string): string[];
  /**
   * The held fragment, as one last row.
   *
   * A reader at the END of its input calls this, and gets the same final row `text.split("\n")`
   * would have produced for a file with no trailing newline. A reader tailing a LIVE file must not:
   * that fragment is a half-written row which the next write completes.
   */
  flush(): string[];
}

export function createLineFeeder(): LineFeeder {
  let carry = "";
  return {
    push(chunk: string): string[] {
      const rows = (carry + chunk).split("\n");
      // The last element is either a fragment or "" when the chunk ended on a newline. Either way it
      // is what the next chunk continues, and "" costs the next `push` nothing.
      carry = rows.pop() ?? "";
      return rows;
    },
    flush(): string[] {
      if (carry === "") return [];
      const last = carry;
      carry = "";
      return [last];
    },
  };
}
