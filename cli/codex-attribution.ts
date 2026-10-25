import { createHash } from "node:crypto";
import { basename, join } from "node:path";

import type { ProcessProbe } from "../bridge/proc-probe.ts";
import type { HoldMarker } from "../web/src/lib/surface/hold.ts";
import { asJsonNumber, asJsonObject, asJsonString, parseJsonObject } from "../web/src/lib/json.ts";
import { readEnvMarkers } from "./beacon.ts";
import type { Environment } from "./context.ts";
import type { Files } from "./sys.ts";

// WHICH CODEX PROCESS, ON WHICH PANE, A NATIVE HOOK SPEAKS FOR (`collie codex-hook`).
//
// A hook edge and a held permission are placed on a pane by two things the bridge can check: the
// multiplexer markers in the environment, and a process id with its start time (placeEdge,
// bridge/surface/edges.ts). Both must name the SAME Codex process. A wrong answer here is the worst
// one there is: a permission card for pane A answered by a tap that lands on pane B. So this module
// answers only from facts it can check, and "unattributed" is always an acceptable answer.
//
// ── WHAT IS CHECKED ───────────────────────────────────────────────────────────────────────────
// Codex runs a hook as `$SHELL -lc <command>` in a new session (rust-v0.164.0
// codex-rs/hooks/src/engine/command_runner.rs), with the environment of the process that hosts the
// session. That is the Codex process itself when the TUI hosts the core in-process, and the shared
// `codex app-server` daemon when one does (0.163.0 and later may). So:
//
//  1. PARENTAGE. The kernel's own parent chain of this process is walked (the probe, never
//     `process.ppid` alone): every hop must be older than the one below it (a reused pid is younger),
//     and the first process named `codex` is the host. The shell between the two is skipped.
//  2. THE HOST IS A TUI. Its argv is read: `codex app-server` (the daemon, which serves every TUI of
//     one CODEX_HOME and carries the markers of whichever pane started it) and `codex exec` (no pane
//     at all) are NOT attributed. Collie never guesses which TUI a daemon's session belongs to, and
//     never takes "the first Codex in the same folder": two sessions in one folder are two panes.
//  3. THE MARKERS. The hook's environment is the TUI's own, so the multiplexer markers in it are that
//     TUI's pane. No markers, no attribution.
//  4. SESSION IDENTITY. The first verified hook of a session records `session_id` -> (pid, start
//     time, markers). A later hook of the same session whose parent chain has no Codex in it at all
//     (a hook command that detached itself) is attributed through the record, and only while that
//     pid still has that start time. A chain that PROVES another host (a daemon, an exec session, a
//     younger parent) never falls back to the record.
//
// What is not claimed: the environment's markers are taken as the TUI's because Codex builds a
// hook's environment from its own (`std::env::vars_os()` in `registry.rs`); a Codex that filters the
// multiplexer variables out leaves no markers, which is "unattributed", the safe side.

/** A session id as Codex writes it (a UUID today); printable, short, no path characters. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

/** How many hops up the parent chain are read: a login shell, a wrapper or two, then Codex. */
const CHAIN_HOPS = 6;

/** The bindings kept at most; a host with more live Codex sessions than this is not one person's. */
const BINDINGS_MAX = 256;

export type Unattributed =
  /** The environment names no multiplexer pane. */
  | "no-markers"
  /** The probe cannot read this process, or an ancestor the chain needs. */
  | "probe-failed"
  /** This process's parent is not the one the kernel names, so it was re-parented. */
  | "reparented"
  /** An ancestor is younger than its child: a reused pid. */
  | "pid-reuse"
  /** The host is the shared app-server daemon. */
  | "daemon-hosted"
  /** The host is `codex exec`, which has no pane. */
  | "exec-session"
  /** No `codex` process anywhere in the chain. */
  | "no-codex-ancestor"
  /** The session's recorded host is gone or is a different process now. */
  | "stale-binding"
  /** No record for this session. */
  | "no-binding";

export type Attribution =
  | {
      readonly kind: "attributed";
      readonly pid: number;
      readonly pidStartTime: number;
      readonly markers: readonly HoldMarker[];
      /** `parent`: the chain proved it. `session`: the session's own record did. */
      readonly via: "parent" | "session";
    }
  | { readonly kind: "unattributed"; readonly reason: Unattributed };

export interface AttributionDeps {
  readonly probe: ProcessProbe;
  readonly files: Files;
  readonly env: Environment;
  /** The bridge-independent state dir the session records live under. */
  readonly stateDir: string;
  /** This process's pid (`process.pid`). */
  readonly selfPid: number;
  /** This process's parent as the runtime reports it (`process.ppid`), compared with the kernel's answer. */
  readonly parentPid: number;
  /** The payload's `session_id`, or undefined. */
  readonly session?: string | undefined;
}

/** `codex app-server` or its helper loop. */
export function isAppServerArgs(args: readonly string[]): boolean {
  return basename(args[0] ?? "") === "codex" && args.includes("app-server");
}

/** The `codex` subcommands that run without a terminal UI, so with no pane to hold a permission on: `exec` and its alias `e`, and `review`. */
const NON_INTERACTIVE: ReadonlySet<string> = new Set(["exec", "e", "review"]);

/** `codex exec` (or its alias `e`) and `codex review`: non-interactive runs, with no pane of their own to hold a permission on. */
export function isExecArgs(args: readonly string[]): boolean {
  return basename(args[0] ?? "") === "codex" && !args.includes("app-server") && args.slice(1).some((arg) => NON_INTERACTIVE.has(arg));
}

/** The directory the session records live in. */
export const bindingsDir = (stateDir: string): string => join(stateDir, "codex-sessions");

/** One record per session: the file name is a hash, so no session id ever becomes a path. */
const bindingPath = (stateDir: string, session: string): string =>
  join(bindingsDir(stateDir), `${createHash("sha256").update(session).digest("hex").slice(0, 32)}.json`);

interface Binding {
  readonly session: string;
  readonly pid: number;
  readonly pidStartTime: number;
  readonly markers: readonly HoldMarker[];
}

function readBinding(files: Files, path: string): Binding | null {
  const text = files.read(path);
  const node = text === null ? undefined : parseJsonObject(text);
  if (node === undefined || asJsonNumber(node.v) !== 1) return null;
  const session = asJsonString(node.session);
  const pid = asJsonNumber(node.pid);
  const pidStartTime = asJsonNumber(node.pidStartTime);
  const markers: HoldMarker[] = [];
  for (const item of Array.isArray(node.markers) ? node.markers : []) {
    const marker = asJsonObject(item);
    const namespace = asJsonString(marker?.namespace);
    const scope = asJsonString(marker?.scope);
    const pane = asJsonString(marker?.pane);
    if (namespace === undefined || scope === undefined || pane === undefined) return null;
    markers.push({ namespace, scope, pane });
  }
  if (session === undefined || !SESSION_ID.test(session) || pid === undefined || pidStartTime === undefined || markers.length === 0) return null;
  return { session, pid, pidStartTime, markers };
}

/** Whether the record's host is still the process it was recorded for. */
function bindingLive(probe: ProcessProbe, binding: Binding): boolean {
  const now = probe.identityOf(binding.pid);
  return now !== null && now.startTime === binding.pidStartTime && now.comm.toLowerCase().startsWith("codex");
}

/** Walks the kernel's parent chain to the Codex that hosts this hook: its pid and start time, or why not. */
function hostOf(deps: AttributionDeps): { readonly pid: number; readonly pidStartTime: number } | { readonly reason: Unattributed } {
  const { probe } = deps;
  let child = probe.identityOf(deps.selfPid);
  if (child === null) return { reason: "probe-failed" };
  if (child.ppid !== deps.parentPid) return { reason: "reparented" };
  for (let hop = 0; hop < CHAIN_HOPS; hop += 1) {
    if (child.ppid <= 1) return { reason: "no-codex-ancestor" };
    const parent = probe.identityOf(child.ppid);
    if (parent === null) return { reason: "probe-failed" };
    // A parent is older than its child. A younger one is a pid the system handed out again.
    if (parent.startTime > child.startTime) return { reason: "pid-reuse" };
    const args = probe.argsOf(parent.pid);
    const named = args === null ? parent.comm : basename(args[0] ?? parent.comm);
    if (named === "codex") {
      if (args === null) return { reason: "probe-failed" };
      if (isAppServerArgs(args)) return { reason: "daemon-hosted" };
      if (isExecArgs(args)) return { reason: "exec-session" };
      return { pid: parent.pid, pidStartTime: parent.startTime };
    }
    child = parent;
  }
  return { reason: "no-codex-ancestor" };
}

/** Writes or refreshes the session's record. A write that fails is no record, never an error. */
function remember(deps: AttributionDeps, session: string, host: { readonly pid: number; readonly pidStartTime: number }, markers: readonly HoldMarker[]): void {
  try {
    const path = bindingPath(deps.stateDir, session);
    const known = readBinding(deps.files, path);
    if (known !== null && known.pid === host.pid && known.pidStartTime === host.pidStartTime && JSON.stringify(known.markers) === JSON.stringify(markers)) return;
    deps.files.mkdirp(bindingsDir(deps.stateDir), 0o700);
    prune(deps);
    const temp = `${path}.${String(deps.selfPid)}.tmp`;
    const record: Binding & { readonly v: 1 } = { v: 1, session, pid: host.pid, pidStartTime: host.pidStartTime, markers };
    try {
      deps.files.write(temp, `${JSON.stringify(record)}\n`, 0o600);
      deps.files.rename(temp, path);
    } catch (err) {
      deps.files.remove(temp);
      throw err;
    }
  } catch {
    // No record: the next hook of this session is attributed by its own parent chain again.
  }
}

/** Drops the records whose host is gone (or is another process now), so the directory does not grow. */
function prune(deps: AttributionDeps): void {
  const dir = bindingsDir(deps.stateDir);
  const names = deps.files.list(dir).filter((name) => name.endsWith(".json"));
  for (const name of names.slice(0, BINDINGS_MAX * 2)) {
    const binding = readBinding(deps.files, join(dir, name));
    if (binding === null || !bindingLive(deps.probe, binding)) deps.files.remove(join(dir, name));
  }
  const left = deps.files.list(dir).filter((name) => name.endsWith(".json"));
  if (left.length >= BINDINGS_MAX) for (const name of left.slice(0, left.length - BINDINGS_MAX + 1)) deps.files.remove(join(dir, name));
}

/** Removes the session's record, for `SessionEnd`. */
export function forgetSession(deps: Pick<AttributionDeps, "files" | "stateDir">, session: string | undefined): void {
  if (session === undefined || !SESSION_ID.test(session)) return;
  try {
    deps.files.remove(bindingPath(deps.stateDir, session));
  } catch {
    // A record left behind dies with its host (prune).
  }
}

/** The pane's Codex process behind this hook, or why it is unknown. Never throws. */
export function attributeCodexHook(deps: AttributionDeps): Attribution {
  try {
    const markers = readEnvMarkers(deps.env);
    const session = deps.session !== undefined && SESSION_ID.test(deps.session) ? deps.session : undefined;
    const host = hostOf(deps);
    if ("reason" in host) {
      // Only a chain with NO Codex in it may lean on the session's record: the hook detached itself,
      // and the record names the TUI that hosted this very session earlier.
      if ((host.reason === "no-codex-ancestor" || host.reason === "reparented") && session !== undefined) {
        const binding = readBinding(deps.files, bindingPath(deps.stateDir, session));
        if (binding === null || binding.session !== session) return { kind: "unattributed", reason: "no-binding" };
        // This hook's own environment must name the very panes the record does: a hook that carries
        // another pane's markers (or none) is not that session's, whatever the record says.
        if (markers.length === 0 || JSON.stringify(markers) !== JSON.stringify(binding.markers)) return { kind: "unattributed", reason: "no-binding" };
        if (!bindingLive(deps.probe, binding)) return { kind: "unattributed", reason: "stale-binding" };
        return { kind: "attributed", pid: binding.pid, pidStartTime: binding.pidStartTime, markers: binding.markers, via: "session" };
      }
      return { kind: "unattributed", reason: host.reason };
    }
    if (markers.length === 0) return { kind: "unattributed", reason: "no-markers" };
    if (session !== undefined) remember(deps, session, host, markers);
    return { kind: "attributed", pid: host.pid, pidStartTime: host.pidStartTime, markers, via: "parent" };
  } catch {
    return { kind: "unattributed", reason: "probe-failed" };
  }
}
