import { spawn } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { connect } from "node:net";

import type { Environment } from "./context.ts";
import { findTool } from "./tools.ts";

// The two seams every lifecycle verb reaches the outside world through: running a system tool, and
// touching the filesystem. Both are interfaces so `bun test` can drive `start`/`stop`/`status`
// end to end without a service manager, a tailnet, or a real `~/.config` — the coverage the shell
// could only get by `source`-ing itself and redefining functions.
//
// Every tool is resolved ABSOLUTE-first (cli/tools.ts): Herdr spawns plugin actions with no login
// shell, so a bare name handed to the OS would simply not be found.

export interface ExecResult {
  /** Exit code. Meaningless when `found` is false. */
  code: number;
  stdout: string;
  stderr: string;
  /** False when the tool is not installed anywhere we look — distinct from "ran and failed". */
  found: boolean;
}

const NOT_FOUND: ExecResult = { code: 127, stdout: "", stderr: "", found: false };

export interface Exec {
  /** Absolute path of `tool`, or null when it isn't installed. */
  which(tool: string): string | null;
  /**
   * Run `tool`, capturing both streams. `timeoutMs` bounds the wall clock: on expiry the child is
   * killed and the result reads as an ordinary failure (code 124, the coreutils `timeout`
   * convention) — a caller probing a binary it does not yet trust must never hang with it.
   */
  capture(tool: string, args: readonly string[], timeoutMs?: number): ExecResult;
  /** Run `tool` with our own stdio — for `journalctl`, whose output IS the result. */
  inherit(tool: string, args: readonly string[]): ExecResult;
  /**
   * Run `tool` in `cwd` with our own stdio — the build steps, whose output IS the operator's
   * progress report and whose working directory is load-bearing (the shell's `( cd … && bun … )`:
   * the root and `web/` trees are installed, typechecked and built separately).
   *
   * `pathPrefix`, when given, is prepended to the CHILD's `PATH`. A tool resolved to an absolute
   * path off this PATH ({@link resolveTool}) still has children that look it up by NAME — `bun
   * cli/main.ts build` spawns `bun install` and Vite — so running the absolute path alone would
   * hand the grandchild the very lookup failure the resolution just repaired. `scripts/collie-ctl.sh`
   * carries the same prepend for the same reason. Already-present directories are not re-added.
   */
  runIn(tool: string, args: readonly string[], cwd: string, pathPrefix?: string): ExecResult;
  /**
   * Start the unsupervised bridge: detached, both streams appended to `logPath`, and unref'd so
   * this process can exit while it keeps running. Returns its pid, or null if it never started.
   */
  spawnDetached(
    command: readonly string[],
    opts: { cwd: string; env: Record<string, string>; logPath: string },
  ): number | null;
  /** `ps -p <pid> -o command=` — the process's command line, or null if there is no such process. */
  processCommand(pid: number): string | null;
  kill(pid: number): void;
}

export interface Files {
  exists(p: string): boolean;
  /**
   * May this process EXECUTE `p` — an `access(p, X_OK)` probe that a directory never passes.
   *
   * Separate from {@link Files.exists} because the two shell copies of the tool lookup ask `[ -x ]`,
   * and `[ -e ]` would answer yes for things that cannot be run: a half-written download, a
   * `~/.bun/bin/bun` left behind as an empty file, a directory that happens to carry the name.
   * {@link resolveTool} must reject those exactly where the shim rejects them, or the preflight and
   * the update would name a Bun that dies with EACCES.
   *
   * The directory case is explicit because search permission on a directory IS `X_OK`: without the
   * `stat(2)`, a directory named `bun` would resolve as the tool.
   */
  executable(p: string): boolean;
  /** File contents, or null when missing/unreadable. */
  read(p: string): string | null;
  /**
   * Entry names directly under `p`, or `[]` when it is not a readable directory. The only directory
   * listing any verb does: `join` clears the herd notification slots of the sessions this machine
   * runs, and those are discovered from the herdr config root exactly as the bridge discovers them.
   */
  list(p: string): string[];
  /** Write `text`, creating the parent directory. `mode` is applied to the file. */
  write(p: string, text: string, mode?: number): void;
  mkdirp(p: string, mode?: number): void;
  /** Remove a file. Missing is success — this is `rm -f`. */
  remove(p: string): void;
  /** Remove a tree. Missing is success — this is `rm -rf`. */
  removeTree(p: string): void;
  /**
   * Move `from` onto `to`, replacing it. Both sides are inside the checkout, so this is a
   * same-filesystem `rename(2)`: near-atomic, and it gives the destination a NEW inode — which is
   * how `build` can replace `bin/collie` while a supervised process is executing the old one.
   */
  rename(from: string, to: string): void;
  /**
   * Who OWNS `p` — the uid off `stat(2)`, or null when it cannot be read at all.
   *
   * One of the three facts a packaged install is recognised by, and the one that catches a tree
   * unpacked as root inside `$HOME`. It is ownership, never writability: `access(p, W_OK)` is always
   * true for uid 0, so a bridge running as root would otherwise see a package-manager-owned tree as its own.
   */
  ownerUid(p: string): number | null;
  /**
   * May this process write into `p` — an `access(p, W_OK)` probe, or null when it cannot be answered.
   *
   * Null is not "no". A path that cannot be stat'ed at all says nothing about who may write it, and
   * {@link Files.ownerUid} is the fact that answers such a tree. The caller turns null into the open
   * direction (not read-only), because claiming a read-only root from a failed probe would refuse
   * updates on an install nobody could describe.
   */
  writable(p: string): boolean | null;
  /**
   * `stat(2)`'s two facts about `p` — the inode and the last modification, in epoch ms — or null
   * when it cannot be read at all. Symlinks are FOLLOWED, which is what makes it answer about
   * `/proc/<pid>/exe`: the inode it reports there is the executable the process is running, even
   * after the file behind it has been unlinked.
   *
   * Added for the restart-pending check (`cli/doctor.ts`). A package manager replaces `bin/collie`
   * and restarts nothing, so the running process and the installed file are two different inodes at
   * one path — and on a rebuild of the same version, the inode is the only thing that says so.
   */
  stat(p: string): { inode: number; mtimeMs: number } | null;
  /** Where a symlink points, unresolved, or null when `p` is not one. `/proc/<pid>/exe` answers with
   *  a path carrying ` (deleted)` when the executable behind it is gone — the whole signal. */
  readlink(p: string): string | null;
}

/**
 * Why a download fails, in the two words a message needs: the HTTP status when there was one (`403`
 * is the rate limit the updater must name), and the text of the failure otherwise.
 */
export interface NetFailure {
  /** The HTTP status, or null when the request never got one (DNS, TLS, timeout). */
  status: number | null;
  message: string;
}

export type NetJson = { ok: true; value: unknown } | { ok: false; failure: NetFailure };
/** One answer read as the health gate needs it: the status, one named header, and the body. */
export type NetProbe =
  | { ok: true; status: number; header: string | null; body: unknown }
  | { ok: false; failure: NetFailure };
/** A finished download, with the digest computed AS IT WAS WRITTEN — the bytes are never re-read. */
export type NetDownload =
  | { ok: true; sha256: string; size: number }
  | { ok: false; failure: NetFailure };

/**
 * The third seam, and the only one that leaves the machine: two anonymous HTTPS GETs, one for JSON
 * and one that streams a release asset to a path. It is an interface for the same reason `Exec` and
 * `Files` are — `bun test` drives the whole binary-update path (fetch, verify, lay down, flip,
 * roll back) without a network, and no test may reach github.com.
 *
 * `download` hashes while it writes rather than handing bytes back, so a ~100 MB artifact never
 * exists in memory and the verification in `cli/update.ts` stays a string comparison.
 */
export interface Net {
  getJson(url: string): Promise<NetJson>;
  download(url: string, dest: string): Promise<NetDownload>;
  /**
   * `GET url`, answered **whatever the status is**, with one response header read off it.
   *
   * A third method rather than a flag on {@link Net.getJson}, because it asks a different question:
   * `getJson` wants a document and treats a non-2xx as a failure, while the update health gate wants
   * to know what a machine SAYS while it is refusing to serve. A standby door answers `503` when it
   * is cold, and cold is a healthy peer, not a failure (M15/04, M15/06).
   */
  probe(url: string, header: string): Promise<NetProbe>;
}

/** Same budget as the bridge's tag check — a hung request must never wedge a verb. */
const NET_TIMEOUT_MS = 20_000;

/**
 * A failure with no HTTP status behind it — DNS, TLS, or the timeout. `fetch` rejects with a value,
 * not a type (a `TypeError` here, a `DOMException` for the abort), so the catch clause narrows the
 * throw to its text and this takes that text. The parse stays at the boundary that caught it.
 */
const netFailure = (message: string): NetFailure => ({ status: null, message });

export const realNet: Net = {
  async getJson(url) {
    try {
      const res = await fetch(url, {
        headers: { accept: "application/json", "user-agent": "collie-update" },
        signal: AbortSignal.timeout(NET_TIMEOUT_MS),
      });
      if (!res.ok) return { ok: false, failure: { status: res.status, message: `HTTP ${res.status}` } };
      return { ok: true, value: await res.json() };
    } catch (err) {
      return { ok: false, failure: netFailure(err instanceof Error ? err.message : String(err)) };
    }
  },
  async probe(url, header) {
    try {
      const res = await fetch(url, {
        headers: { accept: "application/json", "user-agent": "collie-update" },
        signal: AbortSignal.timeout(NET_TIMEOUT_MS),
      });
      // The body is best effort and the status is not: a door that answered at all is a door that is
      // up, and an unreadable body is one field missing from an answer that already arrived.
      const body = await res.json().catch(() => null);
      return { ok: true, status: res.status, header: res.headers.get(header), body };
    } catch (err) {
      return { ok: false, failure: netFailure(err instanceof Error ? err.message : String(err)) };
    }
  },
  async download(url, dest) {
    try {
      const res = await fetch(url, {
        headers: { "user-agent": "collie-update" },
        signal: AbortSignal.timeout(NET_TIMEOUT_MS),
      });
      if (!res.ok) return { ok: false, failure: { status: res.status, message: `HTTP ${res.status}` } };
      if (res.body === null) return { ok: false, failure: { status: res.status, message: "empty response" } };
      mkdirSync(dirname(dest), { recursive: true });
      const hasher = new Bun.CryptoHasher("sha256");
      const sink = Bun.file(dest).writer();
      let size = 0;
      for await (const chunk of res.body) {
        hasher.update(chunk);
        size += chunk.byteLength;
        sink.write(chunk);
      }
      await sink.end();
      return { ok: true, sha256: hasher.digest("hex"), size };
    } catch (err) {
      return { ok: false, failure: netFailure(err instanceof Error ? err.message : String(err)) };
    }
  },
};

/**
 * `env` with `dir` at the FRONT of `PATH`, or `env` unchanged when there is nothing to add.
 *
 * The front, not the back: the directory is being added because it holds the tool this process
 * already resolved, so it has to outrank anything else on the PATH that answers the same name.
 *
 * Mirrors the shim's `case ":${PATH}:" in *":${BUN_DIR}:"*) ;;` — a directory already on the PATH is
 * left where it is rather than duplicated onto the front.
 *
 * Exported for `cli/sys.test.ts` only. A `runIn` runs its child with inherited stdio, so the env it
 * built is not observable from the outside, and this is the half worth pinning.
 */
export function withPathPrefix(env: Environment, dir: string | undefined): Environment {
  if (dir === undefined || dir === "") return env;
  const path = env.PATH ?? "";
  if (path.split(":").includes(dir)) return env;
  return { ...env, PATH: path === "" ? dir : `${dir}:${path}` };
}

export function realExec(env: Environment, home: string): Exec {
  const resolve = (tool: string): string | null => findTool(tool, env, home);
  return {
    which: resolve,
    capture(tool, args, timeoutMs) {
      const bin = resolve(tool);
      if (bin === null) return NOT_FOUND;
      const r = Bun.spawnSync([bin, ...args], { env, timeout: timeoutMs });
      return {
        // A timed-out child has no exit code — it was killed. 124 keeps the seam's "number" contract.
        code: r.exitCode ?? 124,
        stdout: r.stdout.toString(),
        stderr: r.stderr.toString(),
        found: true,
      };
    },
    inherit(tool, args) {
      const bin = resolve(tool);
      if (bin === null) return NOT_FOUND;
      const r = Bun.spawnSync([bin, ...args], {
        env,
        stdout: "inherit",
        stderr: "inherit",
      });
      return { code: r.exitCode, stdout: "", stderr: "", found: true };
    },
    runIn(tool, args, cwd, pathPrefix) {
      const bin = resolve(tool);
      if (bin === null) return NOT_FOUND;
      const r = Bun.spawnSync([bin, ...args], {
        cwd,
        env: withPathPrefix(env, pathPrefix),
        stdout: "inherit",
        stderr: "inherit",
      });
      return { code: r.exitCode, stdout: "", stderr: "", found: true };
    },
    spawnDetached(command, opts) {
      const [program, ...args] = command;
      if (program === undefined) return null;
      // Append, never truncate: this log is the only record an unsupervised host keeps, and `start`
      // runs again on every `restart`.
      mkdirSync(dirname(opts.logPath), { recursive: true });
      const fd = openSync(opts.logPath, "a");
      try {
        const child = spawn(program, args, {
          cwd: opts.cwd,
          env: opts.env,
          detached: true,
          stdio: ["ignore", fd, fd],
        });
        child.unref();
        return child.pid ?? null;
      } catch {
        return null;
      }
    },
    processCommand(pid) {
      const bin = resolve("ps");
      if (bin === null) return null;
      const r = Bun.spawnSync([bin, "-p", String(pid), "-o", "command="], {
        env,
      });
      if (r.exitCode !== 0) return null;
      const out = r.stdout.toString().trim();
      return out === "" ? null : out;
    },
    kill(pid) {
      try {
        process.kill(pid);
      } catch {
        // Already gone — the pidfile outliving its process is the normal case, not an error.
      }
    },
  };
}

export const realFiles: Files = {
  exists: (p) => existsSync(p),
  executable(p) {
    try {
      if (statSync(p).isDirectory()) return false;
      accessSync(p, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  read(p) {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  },
  list(p) {
    try {
      return readdirSync(p);
    } catch {
      return [];
    }
  },
  write(p, text, mode) {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text, mode === undefined ? undefined : { mode });
  },
  mkdirp(p, mode) {
    mkdirSync(p, { recursive: true, mode });
  },
  remove(p) {
    rmSync(p, { force: true });
  },
  removeTree(p) {
    rmSync(p, { force: true, recursive: true });
  },
  rename(from, to) {
    renameSync(from, to);
  },
  ownerUid(p) {
    // Windows has no POSIX uid, and Node/Bun report a constant 0 there regardless of who owns the
    // file — that is not "owned by root", it is "this platform does not have the concept", and the
    // two must not collide: on win32 every non-checkout, non-versions/ install would answer uid 0
    // and `collie update` would refuse forever. `null` reads as "nothing to claim about the owner"
    // exactly like a failed `stat`, which is what the caller already treats it as.
    if (process.platform === "win32") return null;
    try {
      return statSync(p).uid;
    } catch {
      // ENOENT, EACCES on a parent — nothing readable, so nothing to claim about the owner.
      return null;
    }
  },
  writable(p) {
    try {
      accessSync(p, constants.W_OK);
      return true;
    } catch (e) {
      // EACCES / EPERM / EROFS are an ANSWER: this process may not write here. Anything else —
      // ENOENT above all — is the probe failing to reach the question, which is `null`.
      //
      // SAFETY: the assertion asserts NOTHING. `catch` binds `unknown`, every Node errno error
      // carries a string `code`, and anything that does not read `undefined` here and falls to
      // `null` — the same answer an unrecognised code gets. Nothing is called on the value.
      const code = (e as { code?: string }).code;
      return code === "EACCES" || code === "EPERM" || code === "EROFS" ? false : null;
    }
  },
  stat(p) {
    try {
      const s = statSync(p);
      return { inode: Number(s.ino), mtimeMs: s.mtimeMs };
    } catch {
      // ENOENT on a path nothing sits at, EACCES on another user's `/proc` entry — both are
      // "no fact", which is what the decision treats null as.
      return null;
    }
  },
  readlink(p) {
    try {
      return readlinkSync(p);
    } catch {
      return null;
    }
  },
};

// ── One tool lookup list, spelled once ───────────────────────────────────────
//
// Three places used to look for Bun and no two of them looked in the same order: the shim's six
// candidates (`scripts/collie-ctl.sh`), the remote probe's nine (`cli/remote.ts`), and the
// preflight's bare `which`. An operator whose Bun sits in a directory their login shell exports and
// a plugin action does not therefore got a RED preflight blocking an update the shim would have
// built without complaint (#169).
//
// So the list lives here, once, and the two shell copies spell it in the same order because they
// run where TypeScript cannot: `resolve_bun` bootstraps the binary Bun compiles, and `collie_tool`
// is shipped down an ssh pipe. `cli/sys.test.ts` parses both files and fails on a drift.
//
// The PREDICATE matches too, not just the order: both shells ask `[ -x "$candidate" ]`, so this side
// asks {@link Files.executable} rather than {@link Files.exists}. A candidate that is present but
// not runnable is not the tool, and all three copies have to agree on that or they resolve to
// different paths on the same host.
//
// This is NOT `bridge/tools.ts`'s `findTool`, and it does not replace it. That one searches PATH
// plus a generic fallback set for a system tool; this one is the Bun installer's own locations, it
// honours `$BUN_INSTALL`, and it is a fixed ordered list on purpose — a shell can spell it.

/**
 * The absolute candidate paths for `tool`, in the canonical order. PURE: it reads nothing.
 *
 * `$BUN_INSTALL` is the operator's explicit choice, so it outranks the default `~/.bun`. An EMPTY
 * value counts as unset, exactly as the shell's `${BUN_INSTALL:-…}` reads it.
 */
export function toolCandidates(env: Environment, home: string, tool: string): string[] {
  const declared = env.BUN_INSTALL;
  const bunRoot = declared === undefined || declared === "" ? join(home, ".bun") : declared;
  return [
    join(bunRoot, "bin", tool),
    join(home, ".bun", "bin", tool),
    join(home, ".local", "bin", tool),
    `/usr/local/bin/${tool}`,
    `/opt/homebrew/bin/${tool}`,
    `/usr/bin/${tool}`,
    `/bin/${tool}`,
    `/usr/sbin/${tool}`,
    `/sbin/${tool}`,
  ];
}

/** Where a tool was found, and whether PATH is what named it. */
export interface ResolvedTool {
  readonly path: string;
  /** True when PATH answered. False when it took a candidate this PATH does not name. */
  readonly onPath: boolean;
}

/**
 * Walk {@link toolCandidates} for `tool`: PATH first, then each candidate that is EXECUTABLE — the
 * shells' `[ -x ]`, never a bare "is there a file here".
 *
 * PATH's answer is taken ONLY when it is absolute. `command -v` reports a shell function or an
 * alias as a bare word, and a bare word is not a path — it is whatever the caller's cwd and PATH
 * make of it later. The shim and the remote probe both carry the same guard, for the same reason.
 */
export function resolveTool(
  exec: Pick<Exec, "which">,
  files: Pick<Files, "executable">,
  env: Environment,
  home: string,
  tool: string,
): ResolvedTool | null {
  const onPath = exec.which(tool);
  if (onPath !== null && isAbsolute(onPath)) return { path: onPath, onPath: true };
  for (const candidate of toolCandidates(env, home, tool)) {
    if (files.executable(candidate)) return { path: candidate, onPath: false };
  }
  return null;
}

// ── Readiness ────────────────────────────────────────────────────────────────
// "Is the bridge up?" is a TCP connect to the loopback port, never a `systemctl is-active` reading:
// the unit goes active the moment the process starts, seconds before it binds, and the banner would
// then claim a bridge the phone can't reach (the pre-shim collie-ctl.sh).

/**
 * `host` defaults to loopback, but a caller MUST pass the bridge's actual resolved bind
 * (`resolveBridgeHost` in `bridge/config.ts`) when `COLLIE_HOST` sets one — a peer bound to a
 * tailnet address never answers on 127.0.0.1, and probing loopback there reports "down" against a
 * bridge that is in fact up.
 */
export function tcpProbe(port: number, host = "127.0.0.1", timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/** Poll {@link tcpProbe} for ~5s — the same budget as the shell's 25 × 0.2s. */
export async function waitReady(
  port: number,
  host = "127.0.0.1",
  attempts = 25,
  delayMs = 200,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await tcpProbe(port, host)) return true;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}
