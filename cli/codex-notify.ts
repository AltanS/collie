import { basename, join } from "node:path";

import { EDGE_SCHEMA_VERSION, type BeaconMarker } from "../bridge/beacon/types.ts";
import { parseProcStartTime } from "../bridge/beacon/liveness.ts";
import { asJsonString } from "../web/src/lib/json.ts";
import type { JsonObject, JsonValue } from "../bridge/json.ts";
import { edgeStateDirs, readEnvMarkers, writeEdge, type BeaconEmitDeps } from "./beacon.ts";
import type { Environment } from "./context.ts";
import { EXIT } from "./io.ts";
import type { Files } from "./sys.ts";

// `collie beacon emit codex <payload>`: the Codex `notify` command (M56 spec 13).
//
// Codex has no hook for a permission prompt. Its one outside hook is `notify` in
// `$CODEX_HOME/config.toml`: a command Codex runs after an event, with the event as JSON in its LAST
// ARGUMENT (stdin is empty). Lab, Codex 0.163.0, 2026-10-16: it fires only `agent-turn-complete`,
// with `type`, `thread-id`, `turn-id`, `cwd`, `client`, `input-messages` and `last-assistant-message`.
// It fires on no approval dialog. It also fires for a hidden thread Codex runs to name the task; that
// edge is one extra stop edge, so the pane gets one extra read and nothing more.
//
// ── WHICH PROCESS THE EDGE IS KEYED TO ────────────────────────────────────────────────────────────
// Since 0.163.0 the TUI starts an app-server daemon (`codex app-server ... --manage`) per CODEX_HOME,
// and the DAEMON runs the notify command. So the parent of this process is the daemon, not the TUI,
// and the environment this process inherited is the daemon's: the multiplexer markers of the pane
// that STARTED the daemon. A second TUI on the same CODEX_HOME shares that daemon, so those markers
// may name the wrong pane. The edge is therefore keyed to a TUI found in /proc:
//
//  - the parent is a TUI itself (an older Codex with no daemon): that TUI;
//  - the parent is an app-server: every `codex` process that is no app-server, with the same
//    CODEX_HOME as the daemon and a working folder equal to the payload's `cwd`. Each side's
//    CODEX_HOME comes from that process's own environment, `$HOME/.codex` when it is unset, and both
//    are compared as real paths: the default setup sets no CODEX_HOME at all. Exactly one such TUI
//    gets the edge, with the markers from ITS OWN environment. None, or two in the same folder: no
//    edge, and the pane reads the screen on its own poll as before.
//
// The limits, said once: Linux only (/proc); two Codex TUIs on one CODEX_HOME in one folder get no
// edge; the edge carries no prompt hash (Codex sends no prompt event). Same promise as the Claude
// emitter: it prints nothing and always exits 0.

/** The harness this emitter speaks for, in the journal registry's vocabulary. */
export const CODEX_NOTIFY_HARNESS = "codex";

/** The notify events this emitter writes an edge for. */
export const CODEX_NOTIFY_EVENTS: readonly string[] = ["agent-turn-complete"];

/** How many /proc entries one notify reads at most, so a host with very many processes stays cheap. */
const PROC_SCAN_MAX = 8192;

/** The arguments of a process, or null when they cannot be read. */
function argsOf(files: Files, pid: number): string[] | null {
  const text = files.read(`/proc/${String(pid)}/cmdline`);
  if (text === null || text.length === 0) return null;
  return text.split("\u0000").filter((part) => part.length > 0);
}

/** The environment of a process, or null when it cannot be read (another user's process). */
export function environOf(files: Files, pid: number): Environment | null {
  const text = files.read(`/proc/${String(pid)}/environ`);
  if (text === null) return null;
  const env: Record<string, string> = {};
  for (const entry of text.split("\u0000")) {
    const at = entry.indexOf("=");
    if (at > 0) env[entry.slice(0, at)] = entry.slice(at + 1);
  }
  return env;
}

/** The last path part of a process's first argument. */
function programOf(args: readonly string[]): string {
  return basename(args[0] ?? "");
}

/** Whether the arguments are a Codex app-server (the daemon, or its helper loop). */
export function isAppServer(args: readonly string[]): boolean {
  return programOf(args) === "codex" && args.includes("app-server");
}

/** Whether the arguments are a Codex TUI: the `codex` program, and no app-server. */
export function isCodexTui(args: readonly string[]): boolean {
  return programOf(args) === "codex" && !args.includes("app-server") && !args.includes("exec");
}

/**
 * The Codex home of a process, from its own environment: `CODEX_HOME`, else `$HOME/.codex`, as a real
 * path when it resolves. Null when the environment cannot be read or names neither.
 */
export function codexHomeOf(files: Files, pid: number): string | null {
  const env = environOf(files, pid);
  if (env === null) return null;
  const set = (env.CODEX_HOME ?? "").trim();
  const home = (env.HOME ?? "").trim();
  const dir = set !== "" ? set : home !== "" ? join(home, ".codex") : null;
  return dir === null ? null : (files.realpath(dir) ?? dir);
}

/** The TUI a notify belongs to, or null. See the header for the rule. */
export function codexTuiFor(files: Files, parentPid: number, cwd: string | null): number | null {
  const parentArgs = argsOf(files, parentPid);
  if (parentArgs === null) return null;
  if (isCodexTui(parentArgs)) return parentPid;
  if (!isAppServer(parentArgs) || cwd === null) return null;
  const home = codexHomeOf(files, parentPid);
  if (home === null) return null;
  const folder = files.realpath(cwd) ?? cwd;
  const found: number[] = [];
  for (const name of files.list("/proc").slice(0, PROC_SCAN_MAX)) {
    if (!/^\d+$/u.test(name)) continue;
    const pid = Number(name);
    const args = argsOf(files, pid);
    if (args === null || !isCodexTui(args)) continue;
    if (codexHomeOf(files, pid) !== home) continue;
    if (files.realpath(`/proc/${name}/cwd`) !== folder) continue;
    found.push(pid);
  }
  // Two TUIs in one folder on one CODEX_HOME: the payload cannot tell them apart, so no edge.
  return found.length === 1 ? found[0]! : null;
}

/** The payload, from the last argument. Null when it is not a JSON object. */
function payloadOf(args: readonly string[]): JsonObject | null {
  const last = args.at(-1);
  if (last === undefined) return null;
  let value: JsonValue;
  try {
    value = JSON.parse(last);
  } catch {
    return null;
  }
  return value instanceof Object && !Array.isArray(value) ? value : null;
}

/**
 * `collie beacon emit codex <payload>`. `args` are the words after `emit codex`; the payload is the
 * last one. Writes one edge per live bridge (cli/beacon.ts {@link edgeStateDirs}), no beacon: the
 * beacon names an agent on a pane, and Codex panes are named by the screen and the journal.
 */
export function cmdCodexNotify(deps: BeaconEmitDeps, args: readonly string[]): number {
  try {
    const payload = payloadOf(args);
    if (payload === null) return EXIT.OK;
    const event = asJsonString(payload.type);
    if (event === undefined || !CODEX_NOTIFY_EVENTS.includes(event)) return EXIT.OK;
    const tui = codexTuiFor(deps.files, deps.agentPid, asJsonString(payload.cwd) ?? null);
    if (tui === null) return EXIT.OK;
    const env = environOf(deps.files, tui);
    const markers: BeaconMarker[] = env === null ? [] : readEnvMarkers(env);
    if (markers.length === 0) return EXIT.OK;
    const stat = deps.files.read(`/proc/${String(tui)}/stat`);
    const pidStartTime = stat === null ? null : parseProcStartTime(stat);
    if (pidStartTime === null) return EXIT.OK;
    const at = (deps.now ?? Date.now)();
    for (const stateDir of edgeStateDirs(deps)) {
      try {
        writeEdge(deps, stateDir, {
          schemaVersion: EDGE_SCHEMA_VERSION,
          harness: CODEX_NOTIFY_HARNESS,
          event,
          detail: null,
          pid: tui,
          pidStartTime,
          markers,
          at,
          promptHash: null,
        });
      } catch {
        // No edge for this target. The screen still reads the pane on its own poll.
      }
    }
    return EXIT.OK;
  } catch {
    return EXIT.OK;
  }
}

/** The verb with its dependency construction inside the same promise: silent, and exit 0. */
export function runCodexNotify(build: () => BeaconEmitDeps, args: readonly string[]): number {
  try {
    return cmdCodexNotify(build(), args);
  } catch {
    return EXIT.OK;
  }
}
