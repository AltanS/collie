// `hc machine ls --json` — what the Herdr core's machine list contributes to Collie (ADR 0036 (c),
// M84/01). The sibling of `../herdr/machine-list.ts`, for the core instead of the TUI.
//
// It lives under `bridge/mux/herdr-core/` because that is where the word "hc" is allowed to be a
// BEHAVIOUR (ADR 0022): everything that knows how the core answers sits behind this directory, and
// the registry above it is the only thing that knows the name at all. Nothing here is a pane
// question, so it does not touch `client.ts` or the socket: the machine list is the core's
// client-side configuration, and it is read the way the TUI's is, by a shell-out.
//
// ── A MACHINE LIST IS NOT A CREW ─────────────────────────────────────────────
// Every target here is a suggestion for `collie crew add` and nothing else. This module never
// enrols, never dials, never writes. It runs `machine ls` and no other `machine` verb: the core's
// list stays the core's (`docs/crew.md`).
//
// ── THREE OUTCOMES, NEVER A THROW AND NEVER A GUESS ──────────────────────────
//   • ABSENT   — no `hc` on PATH, an `hc` with no `machine` subcommand, or a core that is not
//                running (`error.kind` is `unavailable`). No candidates, and nothing said. A stopped
//                core is the ordinary state on a laptop, and a warning on every `crew add` would
//                teach the operator to ignore warnings.
//   • HEALTHY  — exit 0 and the JSON passes {@link parseHcMachines}. Its entries are the answer.
//   • UNHEALTHY— any other non-zero exit, a timeout, or JSON this build cannot read. No candidates,
//                and exactly ONE stderr line naming the cause.
// Neither "no candidates" outcome may ever fail `crew add`.

import type { JsonObject, JsonValue } from "../../json.ts";
import type { HostCandidate, HostProbe, HostProbeResult } from "../host-candidates.ts";
import { CANDIDATE_TIMEOUT_MS } from "../host-candidates.ts";

// The binary's own name, spelled here rather than imported from `./adapter.ts`: `./adapter.ts`
// imports this module, so reading its constants at module scope would be a circular value read the
// first time the registry loads. The same reason `../herdr/machine-list.ts` spells its own.
const HC = "hc";

/** The exact argv, named once so the docs, the tests and the call site cannot drift apart. */
export const HC_MACHINE_LIST_ARGS: readonly string[] = ["machine", "ls", "--json"];

/** How the command reads in a message. `hc machine ls --json`. */
const SPOKEN = `\`${HC} ${HC_MACHINE_LIST_ARGS.join(" ")}\``;

/**
 * Why a machine the core reaches with a command of its own (`hc machine add --via <command>`) cannot
 * be picked. Shown on the greyed row, so it says what to do.
 *
 * For such a machine the core's `target` IS the command (`ssh -p 2222 user@ip`, `fly ssh console -a
 * app -C`), not a host. When the command is an `ssh` one, its destination is the hop the machine is
 * reached through, and adding that hop first (or typing its address) is something the operator can
 * do. Any other command names no hop Collie could dial, and the text says so.
 */
export function viaBlockedReason(command: string): string {
  const hop = sshHopOf(command);
  if (hop === null) {
    return "reached through a command of its own, not plain ssh; type an address ssh can reach, or add it to ~/.ssh/config";
  }
  return `reached through ${hop}; add ${hop} first, or type its address`;
}

/** The `ssh` options that take the next word as their value, so that word is not mistaken for the host. */
const SSH_OPTIONS_WITH_VALUE = new Set(["-B", "-b", "-c", "-D", "-E", "-e", "-F", "-I", "-i", "-J", "-L", "-l", "-m", "-O", "-o", "-p", "-Q", "-R", "-S", "-W", "-w"]);

/** The destination of an `ssh ...` command, or `null` when the command is not ssh or names none. */
function sshHopOf(command: string): string | null {
  const words = command.trim().split(/\s+/u);
  if (words[0] !== "ssh" && !words[0]?.endsWith("/ssh")) return null;
  for (let i = 1; i < words.length; i++) {
    const word = words[i]!;
    if (!word.startsWith("-")) return word;
    if (SSH_OPTIONS_WITH_VALUE.has(word)) i += 1;
  }
  return null;
}

/** The coreutils `timeout` convention {@link HostProbe.run} reports an expiry with (`cli/sys.ts`). */
const TIMED_OUT = 124;

/** The `error` object a failing `hc` prints on stdout, or `null` when stdout is not that. */
interface HcFailure {
  readonly kind: string | null;
  readonly message: string | null;
}

function failureOf(stdout: string): HcFailure | null {
  let value: JsonValue;
  try {
    // SAFETY: `JSON.parse` output IS a JsonValue by construction.
    value = JSON.parse(stdout) as JsonValue;
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const error = value.error;
  if (error === null || typeof error !== "object" || Array.isArray(error)) return null;
  return { kind: textOf(error.kind), message: textOf(error.message) };
}

/**
 * Does this answer say "I do not have that subcommand" rather than "that went wrong"?
 *
 * Read off the words, as the TUI module does: an unknown subcommand exits non-zero like any failure.
 * The core words it `unrecognized subcommand 'machine'` with kind `usage`. A phrase this does not
 * recognise falls through to UNHEALTHY, the safe direction.
 */
function subcommandMissing(r: HostProbeResult): boolean {
  const said = `${r.stderr}\n${r.stdout}`;
  return /unknown (?:sub)?command|unrecognized subcommand|no such (?:sub)?command|is not a .{0,20}command|invalid (?:sub)?command/iu.test(
    said,
  );
}

/**
 * The core's machines as candidates, or none.
 *
 * `probe.warn` is called at most once, and only on the UNHEALTHY outcome.
 */
export function herdrCoreMachineCandidates(probe: HostProbe): readonly HostCandidate[] {
  const asked = probe.run(HC, HC_MACHINE_LIST_ARGS, CANDIDATE_TIMEOUT_MS);
  // ABSENT: nothing to say. A tmux or zellij operator runs this checkout too, and it costs them nothing.
  if (!asked.found) return [];
  if (asked.code !== 0) {
    const failure = failureOf(asked.stdout);
    // ABSENT: the core is not running. Exit 5, kind `unavailable`, and the common state on a laptop.
    if (failure?.kind === "unavailable") return [];
    if (subcommandMissing(asked)) return [];
    // UNHEALTHY, one line. The core's own message when it gave one, else the exit code.
    const cause = failure?.message ?? null;
    probe.warn(
      asked.code === TIMED_OUT
        ? `warn: ${SPOKEN} did not answer within ${CANDIDATE_TIMEOUT_MS} ms — offering no ${HC} candidates.`
        : cause === null
          ? `warn: ${SPOKEN} exited ${asked.code} — offering no ${HC} candidates.`
          : `warn: ${SPOKEN} exited ${asked.code} (${cause}) — offering no ${HC} candidates.`,
    );
    return [];
  }
  const machines = parseHcMachines(asked.stdout);
  if (machines === null) {
    probe.warn(`warn: ${SPOKEN} answered with something this build cannot read — offering no ${HC} candidates.`);
    return [];
  }
  return machines;
}

/**
 * Validate and read the machine list. `null` for anything that fails the shape.
 *
 * **An object with a `machines` array, and extra fields are IGNORED.** Each entry carries a
 * non-empty string `target`; `name` (the label) and `id` are optional strings, `via` and `temporary`
 * optional booleans that read `false` when absent. A newer core adding a field must not turn a
 * working picker into a warning.
 *
 * A sandbox (`temporary: true`) is DROPPED: it is a throwaway the operator did not choose to keep.
 * A machine the core reaches without ssh (`via: true`) is KEPT but blocked, so the operator sees it
 * is known and why `crew add` cannot take it.
 *
 * An entry that fails the shape fails the WHOLE list, as in the TUI module: a list with one
 * unreadable row is a list this build does not understand.
 */
export function parseHcMachines(raw: string): readonly HostCandidate[] | null {
  let value: JsonValue;
  try {
    // SAFETY: `JSON.parse` output IS a JsonValue by construction.
    value = JSON.parse(raw) as JsonValue;
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const machines = value.machines;
  if (!Array.isArray(machines)) return null;
  const out: HostCandidate[] = [];
  for (const entry of machines) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
    const row: JsonObject = entry;
    const target = textOf(row.target);
    if (target === null) return null;
    if (!optionalString(row.name) || !optionalString(row.id)) return null;
    if (!optionalFlag(row.via) || !optionalFlag(row.temporary)) return null;
    if (row.temporary === true) continue;
    out.push({
      target,
      label: textOf(row.name),
      id: textOf(row.id),
      blocked: row.via === true ? viaBlockedReason(target) : null,
    });
  }
  return out;
}

/** Absent, `null`, or a string. */
function optionalString(value: JsonValue | undefined): boolean {
  return value === undefined || value === null || typeof value === "string";
}

/** Absent, `null`, or a boolean. Absent reads `false` at the call site. */
function optionalFlag(value: JsonValue | undefined): boolean {
  return value === undefined || value === null || typeof value === "boolean";
}

/** A non-empty trimmed string, or `null` for anything else. */
function textOf(value: JsonValue | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
