import { spawn } from "node:child_process";
import { constants } from "node:os";

import { asJsonNumber, asJsonObject, asJsonString, parseJsonObject } from "../web/src/lib/json.ts";
import type { JsonObject } from "../bridge/json.ts";
import {
  asPercent,
  USAGE_SCHEMA_VERSION,
  type UsageLimit,
  type UsageRecord,
  type UsageWindow,
} from "../bridge/usage.ts";
import { BEACON_HARNESS, edgeStateDirs, readEnvMarkers, type EdgeTargetDeps } from "./beacon.ts";
import { EXIT } from "./io.ts";
import { mergeStatusLine, readUsage, writeUsage } from "./usage-store.ts";

// `collie beacon statusline` — the operator's own Claude Code statusLine, with Collie listening in.
//
// Claude Code runs the statusLine command on every assistant message with a JSON document on stdin:
// the context window's use, and for a Pro or Max account the 5-hour and 7-day rate limit windows. It
// is the one place the agent tells a local program the two subscription windows, so it is where the
// phone's 5-hour and 7-day dots come from (.adr/0115). Collie never asks the vendor and never reads a
// credential. The context dot does not need this verb: the beacon hooks read it from the session
// transcript (`cli/context-reading.ts`). Since 2026-10-24 the wrap is OPT-IN, `hooks install claude
// --statusline`, because rewriting an operator's statusLine is the part of the design that bites.
//
// ── THE OPERATOR'S STATUSLINE IS NEVER REPLACED ───────────────────────────────────────────────────
//
// `collie hooks install claude --statusline` rewrites `statusLine.command` to this verb with the operator's command
// carried along, base64url-encoded, in the same string: `<collie> beacon statusline <b64> # collie-
// statusline v1`. Nothing else in `statusLine` moves (`padding`, `refreshInterval`), and `uninstall`
// decodes the string and puts the operator's command back exactly. Carrying it in the string, rather
// than in a file of ours, means there is no second place for it to go stale or go missing.
//
// A settings file with NO statusLine gets none. A statusLine is not free: with one configured, Claude
// Code stops drawing most of its footer hints (`esc to interrupt` among them), which the phone's
// screen readers use. So the windows come only to an operator who already chose a statusLine AND asked
// for the wrap; a pane without one draws the model tag and the context dot.
//
// An install WITHOUT the flag leaves a plain statusLine alone, and re-points one that is already
// wrapped (an operator who had the wrap keeps it, and a moved binary heals). Only a wrapped statusLine
// whose command names another binary counts as behind: that one prints nothing until it is re-pointed.
//
// ── THE ORDER, AND WHAT CAN FAIL ──────────────────────────────────────────────────────────────────
//
//  1. Read stdin whole. Claude Code writes the document and closes it.
//  2. Write the numbers (at most one small file per running bridge), inside a guard: a full disk, a
//     state dir that is not ours, a document that does not parse, all mean "no file", never an error.
//     Outside a multiplexer nothing is written, as the beacon emitter does.
//  3. Run the operator's command through `/bin/sh -c` with the SAME bytes on stdin and stdout and
//     stderr inherited, so what Claude Code draws is the command's own output, byte for byte, and the
//     exit code is the command's own. A command that fails, fails exactly as it did before. `/bin/sh`
//     is what Claude Code itself uses on POSIX: 2.1.309 runs a statusLine through its hook runner
//     with `shell: true` (read in its bundle on 2026-10-23).
//
// ── STOPPING ──────────────────────────────────────────────────────────────────────────────────────
//
// Claude Code starts the command `detached`, so the wrapper leads a process group of its own, and it
// cancels a run that a newer one replaces by signalling that whole GROUP, SIGTERM and then SIGKILL
// (2.1.309, read in its bundle). So when the wrapper leads its group the shell stays IN it: a group
// signal reaches the shell and everything it started, even a SIGKILL that leaves the wrapper no
// chance to forward anything. A shell moved into a group of its own would escape exactly that. A
// signal sent to the wrapper alone is passed on to the whole group.
//
// When the wrapper does NOT lead its group (started by hand, or by some other runner), the shell gets
// a group of its own, and a signal the wrapper receives goes to that group. Either way a compound
// command's grandchild (`sleep 13; echo late`) stops with the run, never orphaned.
//
// A statusLine with its own `shell` or `args` key is not wrapped (`statusLineState`): Claude Code then
// runs it some other way than `/bin/sh -c`, and the wrapper would change what the operator sees.
//
// The file holds numbers only. No text from the document reaches it.

/** The marker namespace. A different prefix from the beacon hooks, so neither reader confuses the two. */
export const STATUSLINE_MARKER_PREFIX = "# collie-statusline v";

/** Bump when the COMMAND shape changes; an installed wrapper then heals on the next `hooks install`. */
export const STATUSLINE_MARKER_VERSION = 1;

export const STATUSLINE_MARKER = `${STATUSLINE_MARKER_PREFIX}${STATUSLINE_MARKER_VERSION}`;

/** What follows the binary in the command we write. */
const STATUSLINE_VERB = " beacon statusline ";

/** The encoded original: base64url only, so the token needs no shell quoting. */
const ENCODED = /^[A-Za-z0-9_-]+$/u;

/** The longest original command carried. A statusLine is one line; this bounds a strange one. */
const ORIGINAL_MAX = 16 * 1024;

/** The session id: the beacon emitter's rule. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

/** The command that runs `original` through this verb. */
export function wrapCommand(binary: string, original: string): string {
  return `${binary}${STATUSLINE_VERB}${Buffer.from(original, "utf8").toString("base64url")} ${STATUSLINE_MARKER}`;
}

/** Whether a statusLine command is ours, at any version. */
export function isWrapped(command: string): boolean {
  return command.includes(STATUSLINE_MARKER_PREFIX) && command.includes(STATUSLINE_VERB);
}

/** The encoded token of a command we wrote, or null. */
function tokenOf(command: string): string | null {
  const at = command.indexOf(STATUSLINE_VERB);
  if (at <= 0) return null;
  const token = command.slice(at + STATUSLINE_VERB.length).split(" ")[0] ?? "";
  return ENCODED.test(token) ? token : null;
}

/** The operator's command inside a command we wrote, or null when it is not ours or will not decode. */
export function originalOf(command: string): string | null {
  if (!isWrapped(command)) return null;
  const token = tokenOf(command);
  if (token === null) return null;
  const original = decodeOriginal(token);
  return original === null || original === "" ? null : original;
}

/** A token decoded, or null when it is not one {@link wrapCommand} could have written. */
export function decodeOriginal(token: string): string | null {
  if (!ENCODED.test(token)) return null;
  const original = Buffer.from(token, "base64url").toString("utf8");
  // A round trip that does not give the token back was not base64url of valid UTF-8.
  if (Buffer.from(original, "utf8").toString("base64url") !== token) return null;
  return original.length > ORIGINAL_MAX ? null : original;
}

// ── The settings document ────────────────────────────────────────────────────

/** What a settings document's statusLine is, as `install`, `uninstall` and `status` need it. */
export type StatusLineState =
  | { readonly kind: "absent" }
  /** A statusLine that is not a command (a future type), or one with no command string. Left alone. */
  | { readonly kind: "other" }
  | { readonly kind: "plain"; readonly command: string }
  | { readonly kind: "wrapped"; readonly command: string; readonly original: string };

export function statusLineState(document: JsonObject): StatusLineState {
  if (document.statusLine === undefined) return { kind: "absent" };
  const line = asJsonObject(document.statusLine);
  const command = asJsonString(line?.command);
  if (line === undefined || asJsonString(line.type) !== "command" || command === undefined || command.trim() === "") {
    return { kind: "other" };
  }
  // The exec form (`args`) and a named shell run another way than `/bin/sh -c`: leave them alone.
  if (line.args !== undefined || line.shell !== undefined) return { kind: "other" };
  const original = originalOf(command);
  return original === null ? { kind: "plain", command } : { kind: "wrapped", command, original };
}

/** `document` with its statusLine command set, every other key of the statusLine kept in place. */
function withCommand(document: JsonObject, command: string): JsonObject {
  const line = asJsonObject(document.statusLine) ?? {};
  return { ...document, statusLine: { ...line, command } };
}

/**
 * The document with the operator's statusLine wrapped, or unchanged. A wrapper written by another
 * binary path or marker version is rewritten around the same original, which is how it heals. A plain
 * statusLine is wrapped only with `wrapPlain` (`hooks install claude --statusline`); without it the
 * plain command stays exactly as the operator wrote it.
 */
export function wrapStatusLine(document: JsonObject, binary: string, wrapPlain: boolean): JsonObject {
  const state = statusLineState(document);
  if (state.kind === "plain") {
    if (!wrapPlain) return document;
    if (state.command.length > ORIGINAL_MAX) return document;
    return withCommand(document, wrapCommand(binary, state.command));
  }
  if (state.kind === "wrapped") return withCommand(document, wrapCommand(binary, state.original));
  return document;
}

/** The document with the operator's own command back, or unchanged when the statusLine is not ours. */
export function unwrapStatusLine(document: JsonObject): JsonObject {
  const state = statusLineState(document);
  return state.kind === "wrapped" ? withCommand(document, state.original) : document;
}

/**
 * Whether this statusLine is wrapped around another binary or marker version, so it prints nothing or
 * is read by an older wrapper until `install` points it here. A plain statusLine is NOT behind: the
 * wrap is the operator's to ask for.
 */
export function statusLineBehind(document: JsonObject, binary: string): boolean {
  const state = statusLineState(document);
  return state.kind === "wrapped" && state.command !== wrapCommand(binary, state.original);
}

// ── The payload ──────────────────────────────────────────────────────────────

/** The two windows Claude Code reports, by its key, and the label the phone draws for each. */
const WINDOW_KEYS: readonly (readonly [string, UsageWindow])[] = [
  ["five_hour", "5h"],
  ["seven_day", "7d"],
];

/**
 * The numbers in a statusLine document, as the record the bridge reads, plus the session they belong
 * to. Null when there is no session id or no number at all.
 */
export function usageFromStatusLine(payload: JsonObject, now: number): { session: string; record: UsageRecord } | null {
  const session = asJsonString(payload.session_id);
  if (session === undefined || !SESSION_ID.test(session)) return null;
  const record: UsageRecord = { schemaVersion: USAGE_SCHEMA_VERSION, harness: BEACON_HARNESS, at: now };
  const context = asPercent(asJsonObject(payload.context_window)?.used_percentage);
  if (context !== undefined) record.context = context;
  const limitsRoot = asJsonObject(payload.rate_limits);
  const limits: UsageLimit[] = [];
  for (const [key, window] of WINDOW_KEYS) {
    const row = asJsonObject(limitsRoot?.[key]);
    const used = asPercent(row?.used_percentage);
    if (used === undefined) continue;
    // Claude Code says epoch SECONDS; the record is epoch milliseconds, as every time in the bridge is.
    const seconds = asJsonNumber(row?.resets_at);
    limits.push(seconds !== undefined && Number.isFinite(seconds) && seconds > 0 ? { window, used, resetsAt: seconds * 1000 } : { window, used });
  }
  if (limits.length > 0) record.limits = limits;
  if (record.context === undefined && record.limits === undefined) return null;
  return { session, record };
}

// ── The verb ─────────────────────────────────────────────────────────────────

export interface StatusLineDeps extends EdgeTargetDeps {
  /** The document Claude Code wrote. A seam so the tests need no real stdin. */
  readStdin(): Promise<string>;
  /**
   * Run the operator's command through the shell with `input` on its stdin and this process's stdout
   * and stderr, and give back its exit code.
   */
  run(command: string, input: string): Promise<number>;
  readonly now?: () => number;
}

/** Take the numbers. Never throws: a reading that cannot be written is a reading that is absent. */
function takeReading(deps: StatusLineDeps, input: string): void {
  try {
    if (readEnvMarkers(deps.ctx.env).length === 0) return;
    const payload = parseJsonObject(input);
    if (payload === undefined) return;
    const usage = usageFromStatusLine(payload, (deps.now ?? Date.now)());
    if (usage === null) return;
    for (const stateDir of edgeStateDirs(deps)) {
      try {
        writeUsage(deps, stateDir, usage.session, mergeStatusLine(readUsage(deps, stateDir, usage.session), usage.record, usage.record.at));
      } catch {
        // No reading for this bridge. The tag draws the model alone.
      }
    }
  } catch {
    // Same: no reading.
  }
}

/**
 * `collie beacon statusline <encoded>` — record the numbers, then run the operator's command and
 * return its exit code. With no command to run it prints nothing and exits 0, which is what an empty
 * statusLine looks like.
 */
export async function cmdBeaconStatusline(deps: StatusLineDeps, args: readonly string[]): Promise<number> {
  let input = "";
  try {
    input = await deps.readStdin();
  } catch {
    input = "";
  }
  takeReading(deps, input);
  const original = decodeOriginal(args[0] ?? "");
  if (original === null || original.trim() === "") return EXIT.OK;
  try {
    return await deps.run(original, input);
  } catch {
    return EXIT.FAIL;
  }
}

/** Whether this process leads its own process group, as Claude Code starts every hook command. */
function leadsGroup(): boolean {
  try {
    process.kill(-process.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The handle {@link startShell} gives back: the exit code to come, and how to stop the run. */
export interface ShellRun {
  readonly pid: number | undefined;
  readonly exited: Promise<number>;
  stop(signal: NodeJS.Signals): void;
}

/**
 * Start `/bin/sh -c command`, `input` on its stdin, stdout and stderr this process's own: in this
 * process's group when it leads one, else in a group of its own (see STOPPING above). The exit code
 * is the shell's, or 128 plus the signal that ended it.
 */
export function startShell(command: string, input: string): ShellRun {
  const leader = leadsGroup();
  const child = spawn("/bin/sh", ["-c", command], { stdio: ["pipe", "inherit", "inherit"], detached: !leader });
  // A command that never reads stdin closes it early; the write then fails, and that is fine.
  child.stdin.on("error", () => {});
  child.stdin.end(input);
  const exited = new Promise<number>((resolve) => {
    child.on("error", () => resolve(EXIT.FAIL));
    child.on("close", (code, signal) => resolve(code ?? 128 + (signal === null ? 0 : (constants.signals[signal] ?? 0))));
  });
  const group = leader ? process.pid : child.pid;
  return {
    pid: child.pid,
    exited,
    stop: (signal) => {
      try {
        if (group !== undefined) process.kill(-group, signal);
      } catch {
        // Already gone.
      }
    },
  };
}

/** {@link startShell}, with this process's own stopping signals passed on to the run. */
export function runShell(command: string, input: string): Promise<number> {
  const run = startShell(command, input);
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.once(signal, () => run.stop(signal));
  return run.exited;
}
