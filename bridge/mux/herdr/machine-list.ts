// `herdr machine list --json` — the ONE thing Herdr's machine linking contributes to Collie
// (ADR 0036 (c), M22/07).
//
// It lives under `bridge/mux/herdr/` because that is where the word "herdr" is allowed to be a
// BEHAVIOUR (ADR 0022): everything that knows how Herdr answers sits behind this directory, and the
// registry above it is the only thing that knows the name at all. Nothing here is a pane question,
// so it does not touch `client.ts` or the socket — a machine list is client-side configuration in
// Herdr 0.9.0, with no socket API behind it, which is exactly why it is a shell-out.
//
// ── A MACHINE LIST IS NOT A CREW ─────────────────────────────────────────────
// Every target here is a suggestion for `collie crew add` and nothing else. This module never
// enrols, never dials, never writes and never reads Herdr's file directly. Adding a machine to
// Herdr does not add it to the crew, and this list existing does not change that (`docs/crew.md`).
//
// ── THREE OUTCOMES, NEVER A THROW AND NEVER A GUESS ──────────────────────────
//   • ABSENT   — no `herdr` on PATH, or this Herdr has no `machine` subcommand. No candidates, and
//                nothing said: an operator on Herdr 0.8 asked for a picker, not for a version
//                lecture.
//   • HEALTHY  — exit 0 and the JSON passes {@link parseHerdrMachines}. Its entries are the answer.
//   • UNHEALTHY— a non-zero exit, a timeout, or JSON this build cannot read. No candidates, and
//                exactly ONE stderr line naming the cause, so a broken herdr is visible without
//                being fatal.
// The two "no candidates" outcomes are deliberately distinguishable by their noise and by nothing
// else: neither one may ever fail `crew add`.

import type { JsonObject, JsonValue } from "../../json.ts";
import type { HostCandidate, HostProbe, HostProbeResult } from "../host-candidates.ts";
import { CANDIDATE_TIMEOUT_MS } from "../host-candidates.ts";

// The binary's own name, spelled here rather than imported from `./adapter.ts`. Two reasons, and the
// second is the load-bearing one: this IS the herdr directory, where the name is a behaviour and not
// a branch (ADR 0022); and `./adapter.ts` imports this module, so reading its `HERDR_MUX` at module
// scope would be a circular value read in the temporal dead zone the first time the registry loads.
const HERDR = "herdr";

/** The exact argv, named once so the docs, the tests and the call site cannot drift apart. */
export const HERDR_MACHINE_LIST_ARGS: readonly string[] = ["machine", "list", "--json"];

/** How the command reads in a message. `herdr machine list --json`. */
const SPOKEN = `\`${HERDR} ${HERDR_MACHINE_LIST_ARGS.join(" ")}\``;

/** The coreutils `timeout` convention {@link HostProbe.run} reports an expiry with (`cli/sys.ts`). */
const TIMED_OUT = 124;

/**
 * Does this stderr say "I do not have that subcommand" rather than "that went wrong"?
 *
 * The distinction decides whether the operator hears a line, so it is read off the words rather
 * than off the exit code: an unknown subcommand exits non-zero exactly as a real failure does, and
 * every CLI framework in use picks a different number for it. A phrase this list does not recognise
 * falls through to UNHEALTHY, which is the safe direction — a spurious line is cheaper than silence
 * about a herdr that is genuinely broken.
 */
function subcommandMissing(r: HostProbeResult): boolean {
  const said = `${r.stderr}\n${r.stdout}`;
  return /unknown (?:sub)?command|unrecognized subcommand|no such (?:sub)?command|is not a .{0,20}command|invalid (?:sub)?command/iu.test(
    said,
  );
}

/**
 * Herdr's saved machines as candidates, or none.
 *
 * `probe.warn` is called at most once, and only on the UNHEALTHY outcome.
 */
export function herdrMachineCandidates(probe: HostProbe): readonly HostCandidate[] {
  const asked = probe.run(HERDR, HERDR_MACHINE_LIST_ARGS, CANDIDATE_TIMEOUT_MS);
  // ABSENT: nothing to say. Collie is a Herdr plugin, so `herdr` is normally there — but `crew add`
  // runs from a checkout that a tmux or zellij operator also has, and this must cost them nothing.
  if (!asked.found) return [];
  if (asked.code !== 0) {
    if (subcommandMissing(asked)) return [];
    // UNHEALTHY, one line. The cause, not a remedy: the operator knows their own Herdr.
    probe.warn(
      asked.code === TIMED_OUT
        ? `warn: ${SPOKEN} did not answer within ${CANDIDATE_TIMEOUT_MS} ms — offering no ${HERDR} candidates.`
        : `warn: ${SPOKEN} exited ${asked.code} — offering no ${HERDR} candidates.`,
    );
    return [];
  }
  const machines = parseHerdrMachines(asked.stdout);
  if (machines === null) {
    probe.warn(`warn: ${SPOKEN} answered with something this build cannot read — offering no ${HERDR} candidates.`);
    return [];
  }
  return machines;
}

/**
 * Validate and read the machine list. `null` for anything that fails the shape.
 *
 * **The shape is the minimum that could be useful, and extra fields are IGNORED.** An array, and
 * each entry carrying a non-empty string `target`, with `label` and `id` optional. That is the
 * additive rule this codebase applies to every wire it does not own: a newer Herdr adding a field
 * must not turn a working picker into a warning, and a field this build does not read is a field it
 * has no opinion about.
 *
 * An entry that fails the shape fails the WHOLE list rather than being skipped. A machine list with
 * one unreadable row is a list this build does not understand, and half of an operator's machines
 * offered silently is worse than the one line the caller prints instead.
 */
export function parseHerdrMachines(raw: string): readonly HostCandidate[] | null {
  let value: JsonValue;
  try {
    // SAFETY: `JSON.parse` output IS a JsonValue by construction — string/number/boolean/null or an
    // array/object of those. Naming it keeps every field read below a checked property access.
    value = JSON.parse(raw) as JsonValue;
  } catch {
    return null;
  }
  if (!Array.isArray(value)) return null;
  const out: HostCandidate[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
    const row: JsonObject = entry;
    const target = textOf(row.target);
    if (target === null) return null;
    if (!optionalString(row.label) || !optionalString(row.id)) return null;
    out.push({ target, label: textOf(row.label), id: textOf(row.id) });
  }
  return out;
}

/** Absent, `null`, or a string — the three readings a tolerant optional field is allowed to have. */
function optionalString(value: JsonValue | undefined): boolean {
  return value === undefined || value === null || typeof value === "string";
}

/** A non-empty trimmed string, or `null` for anything else. The one reading of "a name is there". */
function textOf(value: JsonValue | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
