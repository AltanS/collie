import { homedir } from "node:os";
import { join } from "node:path";

import { harnessLaunch } from "./harness-launch.ts";
import type { JsonObject } from "./json.ts";
import { isForbiddenCodePoint } from "./launcher-recipes.ts";
import { createOperatorFileReader, diskIo, type OperatorFileIo } from "./operator-file.ts";
import type { Launcher } from "./types.ts";

// The operator's own launcher rows, read from `launchers.toml` next to their `.env` — the exact
// sibling of `commands.toml` and `keys.toml`, down to the discovery rule and the mtime-checked live
// reload (operator-file.ts owns both).
//
// A file rather than an env var for the same reason `commands.toml` gives: `.env` is dual-parsed
// (bash sources it, systemd reads it as an EnvironmentFile) and the quoting the two readers want
// differs, and a list packed into one variable has to spend separators a value then cannot contain.
// A shell line — `command = "make -C ~/dev/collie test"` — is exactly the kind of prose that would
// be wounded by that. TOML gives every field its own key, so a command may contain any character
// except the control characters the shell would interpret as a second line.
//
// Why the configured list doubles as the allowlist `POST /api/launch` matches against: the client
// names a row, it never supplies a command line. The `command` string is an identity looked up by
// exact equality, not a free-text argument the bridge interpolates. That is the whole security story
// of the route — a phone outside the tailnet cannot invent a command the operator never wrote. The
// bridge never builds a shell line from client input; it only re-types a line the operator already
// reviewed in their own file.
//
// Why a control character in `command` drops the row: the string is typed into a herdr pane
// verbatim via `pane.send_text` and a newline (or any ASCII control) would submit a second line the
// operator never reviewed. The row is not sanitised; it is rejected. A pane is a real terminal, so
// silently stripping the character would change what runs without saying so — the narrow failure
// (drop the row, warn once) is the only one that cannot be mistaken for a successful launch of the
// operator's intended command.

/**
 * Whether the line carries a character no typed line may hold: an ASCII or C1 control character, a
 * line or paragraph separator, or a bidi control (`isForbiddenCodePoint`, bridge/launcher-recipes.ts,
 * the one rule phone-added rows meet too, ADR 0094).
 *
 * A scan rather than a regular expression: a control-character CLASS in a pattern is itself the
 * thing the lint rule warns about, and the question here is a plain one about code points.
 */
function hasControlChar(line: string): boolean {
  for (const ch of line) {
    if (isForbiddenCodePoint(ch.codePointAt(0) ?? 0)) return true;
  }
  return false;
}

/** A parsed `launchers.toml` document, before a byte of it is believed. */
interface LaunchersDocument {
  launchers?: unknown;
}

/**
 * Turn a parsed TOML document into launcher rows, dropping anything malformed with one warning line.
 *
 * Pure and total: it never throws and never reads a file, so the grammar is unit-testable without
 * fs. Every rejection is a DROP of the offending row, never of the file — one typo'd row must not
 * cost the operator the rest of their launch strip.
 *
 * ```toml
 * [[launchers]]
 * command = "rumen-peek"        # required; the shell line, typed verbatim
 * label = "Runs & quota"        # optional; defaults to the command's first whitespace-separated token
 * cwd = "~/dev/collie"          # optional; absent means "here" (home from the dashboard, the pane's own dir from a pane); leading ~ expanded
 * harness = "claude"            # optional; the agent that reads this row, so the sheet lists it under Agents (ADR 0094)
 * no_prompts = true             # optional; the line skips permission prompts (an alias hides its flags)
 * ```
 *
 * A later row for the same `command` replaces the earlier one IN PLACE, so correcting a row does
 * not reshuffle the dashboard.
 */
export function validateOperatorLaunchers(
  doc: LaunchersDocument | null | undefined,
  warn = defaultWarn,
): Launcher[] {
  const rows = doc?.launchers;
  if (rows === undefined || rows === null) return [];
  if (!Array.isArray(rows)) {
    warn("`launchers` must be an array of [[launchers]] tables — ignoring the file's rows");
    return [];
  }
  const out: Launcher[] = [];
  const at = new Map<string, number>();
  for (const raw of rows) {
    if (typeof raw !== "object" || raw === null || raw === undefined || Array.isArray(raw)) {
      warn("ignoring a row that is not a [[launchers]] table");
      continue;
    }
    const row: JsonObject = raw;

    // `command` is the allowlist key and the shell line. It must be a non-empty string and must
    // not contain an ASCII control character — a newline would submit a second line nobody reviewed
    // via `pane.send_text`, and the bridge types the line verbatim.
    if (typeof row.command !== "string" || row.command.trim() === "") {
      warn(`ignoring a row whose command is missing or empty: ${JSON.stringify(row.command)}`);
      continue;
    }
    const command = row.command.trim();
    if (hasControlChar(command)) {
      warn(`ignoring "${command}" — command contains a control character and cannot be typed verbatim`);
      continue;
    }

    // `label` is the button text. Absent → defaults to the command's first whitespace-separated
    // token, so `command = "make test"` labels itself "make" without extra typing. Present but not
    // a non-empty string → fail closed rather than silently falling back, in the same spirit as
    // `scope`/`confirm` in the sibling validators: a typo that was meant to name the button should
    // not produce a launch strip the operator did not intend.
    let label: string;
    if (row.label !== undefined) {
      if (typeof row.label !== "string" || row.label.trim() === "") {
        warn(`ignoring "${command}" — label must be a non-empty string`);
        continue;
      }
      label = row.label.trim();
    } else {
      // First token of the command, after the same trim the allowlist key used.
      const first = command.split(/\s+/)[0];
      label = first ?? command;
    }

    // `cwd` is the directory the new Space (or tab) opens in. Absent → "here": resolved on the
    // bridge at launch time, to the operator's home dir from the dashboard or to the pane's own cwd
    // from a pane (server.ts § launch/createTab), never defaulted here. A leading `~`/`~/...` is
    // expanded to the operator's home dir, because that is how the operator already spells paths in
    // their shell. Present but not a non-empty string → fail closed rather than silently falling
    // back to "here": a typo that was meant to point the launch at a project should not silently
    // change what "no cwd" means for that row.
    let cwd: string | undefined;
    if (row.cwd !== undefined) {
      if (typeof row.cwd !== "string" || row.cwd.trim() === "") {
        warn(`ignoring "${command}" — cwd must be a non-empty string`);
        continue;
      }
      const rawCwd = row.cwd.trim();
      if (rawCwd === "~") cwd = homedir();
      else if (rawCwd.startsWith("~/")) cwd = join(homedir(), rawCwd.slice(2));
      else cwd = rawCwd;
    }

    // `harness` names the agent that reads the row (ADR 0094): the sheet lists it under Agents with
    // that agent's mark. Only an id Collie starts is accepted; a typo drops the row, as above.
    let harness: string | undefined;
    if (row.harness !== undefined) {
      if (typeof row.harness !== "string" || harnessLaunch(row.harness.trim()) === undefined) {
        warn(`ignoring "${command}" — harness must be one of the agents Collie starts`);
        continue;
      }
      harness = row.harness.trim();
    }
    // `no_prompts = true` marks a line whose flags the scan cannot see (an alias), so the phone shows
    // the "No prompts" badge and asks once per device (ADR 0094).
    let noPrompts: true | undefined;
    if (row.no_prompts !== undefined) {
      if (typeof row.no_prompts !== "boolean") {
        warn(`ignoring "${command}" — no_prompts must be true or false`);
        continue;
      }
      if (row.no_prompts) noPrompts = true;
    }

    const parsed: Launcher = cwd === undefined ? { command, label } : { command, label, cwd };
    if (harness !== undefined) {
      parsed.kind = "agent";
      parsed.harness = harness;
    }
    if (noPrompts !== undefined) parsed.noPrompts = true;
    const prev = at.get(command);
    if (prev !== undefined) {
      warn(`"${command}" redefined — the later row wins`);
      out[prev] = parsed;
      continue;
    }
    at.set(command, out.length);
    out.push(parsed);
  }
  return out;
}

function defaultWarn(message: string): void {
  console.warn(`[launchers] ${message}`);
}

/**
 * A reader for the operator's `launchers.toml` — the same mtime cache, the same "no file is not an
 * error" rule and the same hold-the-last-good-rows failure posture `commands.toml` and `keys.toml`
 * get, because it is literally the same reader (operator-file.ts).
 */
export function createOperatorLaunchers(
  path: string,
  io: OperatorFileIo = diskIo,
  warn = defaultWarn,
): () => Promise<Launcher[]> {
  return createOperatorFileReader(path, validateOperatorLaunchers, io, warn);
}

// ── The operator's switches for rows added from a phone (ADR 0094) ───────────────────────────────
//
// A `[phone]` table in the same file, because these are the operator's rules about the same list:
//
// ```toml
// [phone]
// adds = true          # default true: a phone may add rows built from a recipe
// free_text = false    # default false: a phone may also add a line typed by hand
// ```
//
// A table rather than top-level keys, so its place in the file does not matter (a top-level key
// written after the first `[[launchers]]` would belong to that row). Enforced by the bridge: a phone
// that is told "no" by the UI is told "no" again by the route, and a row a switch covers leaves the
// launch allowlist (it stays on disk, so turning the switch back on restores it). A value that is
// not true or false reads as OFF: a switch the operator touched and got wrong must not open a door.

/** The switches, as the bridge enforces them. */
export interface LauncherSwitches {
  /** Phones may add rows at all, and rows they added may start. */
  adds: boolean;
  /** Phones may add a free line, and free lines they added may start. */
  freeText: boolean;
}

/** The defaults: recipes on, free text off. */
export const DEFAULT_SWITCHES: LauncherSwitches = { adds: true, freeText: false };

/** A parsed `launchers.toml`'s `[phone]` table, before a byte of it is believed. */
interface SwitchesDocument {
  phone?: unknown;
}

/** Read the `[phone]` table. Pure and total; a wrong value is OFF with one warning. */
export function launcherSwitches(doc: SwitchesDocument | null | undefined, warn = defaultWarn): LauncherSwitches {
  const table = doc?.phone;
  if (table === undefined || table === null) return { ...DEFAULT_SWITCHES };
  if (typeof table !== "object" || Array.isArray(table)) {
    warn("`phone` must be a [phone] table — phone adds and free text are off");
    return { adds: false, freeText: false };
  }
  // SAFETY: a TOML table parses to a plain object; every field is checked below before it is believed.
  const t = table as JsonObject;
  const read = (key: string, fallback: boolean): boolean => {
    const v = t[key];
    if (v === undefined) return fallback;
    if (typeof v === "boolean") return v;
    warn(`[phone] ${key} must be true or false — reading it as false`);
    return false;
  };
  return { adds: read("adds", DEFAULT_SWITCHES.adds), freeText: read("free_text", DEFAULT_SWITCHES.freeText) };
}

/** A reader for the switches, on the same mtime cache and hold-the-last-good posture as the rows. */
export function createLauncherSwitches(
  path: string,
  io: OperatorFileIo = diskIo,
  warn = defaultWarn,
): () => Promise<LauncherSwitches> {
  const read = createOperatorFileReader<SwitchesDocument, LauncherSwitches>(path, (doc, w) => [launcherSwitches(doc, w)], io, warn);
  return async () => (await read())[0] ?? { ...DEFAULT_SWITCHES };
}

/** The io shape this reader is driven with in tests. */
export type LaunchersFileIo = OperatorFileIo;
