import { homedir } from "node:os";
import { join } from "node:path";

import type { JsonObject } from "./json.ts";
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
 * Whether the line carries an ASCII control character.
 *
 * A scan rather than a regular expression: a control-character CLASS in a pattern is itself the
 * thing the lint rule warns about, and the question here is a plain one about code points.
 */
function hasControlChar(line: string): boolean {
  for (const ch of line) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
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
 * cwd = "~/dev/collie"          # optional; defaults to the operator's home dir, leading ~ expanded
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

    // `cwd` is the directory the new Space opens in. Absent → the operator's home dir. A leading
    // `~`/`~/...` is expanded to the operator's home dir, because that is how the operator already
    // spells paths in their shell. Present but not a non-empty string → fail closed rather than
    // silently falling back to the home dir: a typo that was meant to point the launch at a project
    // should not send it to the wrong directory without saying so.
    let cwd: string;
    if (row.cwd !== undefined) {
      if (typeof row.cwd !== "string" || row.cwd.trim() === "") {
        warn(`ignoring "${command}" — cwd must be a non-empty string`);
        continue;
      }
      const rawCwd = row.cwd.trim();
      if (rawCwd === "~") cwd = homedir();
      else if (rawCwd.startsWith("~/")) cwd = join(homedir(), rawCwd.slice(2));
      else cwd = rawCwd;
    } else {
      cwd = homedir();
    }

    const parsed: Launcher = { command, label, cwd };
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

/** The io shape this reader is driven with in tests. */
export type LaunchersFileIo = OperatorFileIo;
