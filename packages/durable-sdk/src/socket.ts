// The socket path and the folder it sits in (WIRE.md section 1A). The adapter walks the path from `/` down and
// refuses anything but a private folder and a private socket, so the program makes both so before it listens.

import { chmodSync, lstatSync, mkdirSync, rmSync, type Stats } from "node:fs";
import { connect } from "node:net";
import { dirname, isAbsolute } from "node:path";
import { bytes, CAPS, isText } from "./core/rules.ts";
import type { Json } from "./core/types.ts";

/** The socket path must be absolute and at most 103 bytes. */
export function checkSocketPath(path: Json | undefined): string {
  if (!isText(path) || !isAbsolute(path)) throw new Error("the socket path must be absolute (set COLLIE_DURABLE_SOCKET)");
  if (bytes(path) > CAPS.socketPath) throw new Error(`the socket path is over ${CAPS.socketPath} bytes (the sun_path limit): ${path}`);
  return path;
}

function myUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("this platform shows no file owner, so the socket cannot be made private (the adapter would never dial it)");
  return uid;
}

/**
 * Make the socket's own folder, mode exactly 0700, or check the one that is there. An existing folder must be a
 * real folder (no symlink), owned by this user, with mode 0700. Anything else stops the start: the program does
 * not chmod or take over a folder it did not make.
 */
export function preparePrivateDir(dir: string): void {
  const uid = myUid();
  let have: Stats | undefined;
  try {
    have = lstatSync(dir);
  } catch (e) {
    if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e;
  }
  if (!have) {
    mkdirSync(dirname(dir), { recursive: true, mode: 0o755 }); // folders above need no more than "not writable by others"
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o700); // an odd umask may have narrowed it; the mode is exact
    have = lstatSync(dir);
  }
  if (have.isSymbolicLink()) throw new Error(`the socket directory is a symlink: ${dir}`);
  if (!have.isDirectory()) throw new Error(`the socket directory is not a directory: ${dir}`);
  if (have.uid !== uid) throw new Error(`the socket directory belongs to user ${have.uid}, not to ${uid}: ${dir}`);
  const mode = have.mode & 0o7777;
  if (mode !== 0o700) throw new Error(`the socket directory must be mode 0700, not ${mode.toString(8).padStart(4, "0")}: ${dir}`);
}

type Probe = "live" | "dead";

/** Connect to the socket and hang up. A listener answers: live. Nothing listens: dead. Anything else: stop and say so. */
function probe(path: string, timeoutMs: number): Promise<Probe> {
  return new Promise((ok, fail) => {
    const s = connect({ path });
    const done = (r: Probe) => {
      clearTimeout(timer);
      s.destroy();
      ok(r);
    };
    const timer = setTimeout(() => done("live"), timeoutMs); // a listener with a full queue does not refuse; it is alive
    s.once("connect", () => done("live"));
    s.once("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "ECONNREFUSED" || e.code === "ENOENT") return done("dead");
      clearTimeout(timer);
      fail(new Error(`cannot tell whether ${path} is in use (${e.code ?? e.message}); it was left alone`));
    });
  });
}

/**
 * Clear the way to bind. Nothing at the path: fine. A file that is not a socket, or a socket that is not ours:
 * stop. A socket that answers a connect: another instance is live, stop. Only a dead socket is unlinked.
 */
export async function clearStaleSocket(path: string, probeMs = 1000): Promise<void> {
  const uid = myUid();
  let old: Stats;
  try {
    old = lstatSync(path);
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") return;
    throw e;
  }
  if (!old.isSocket()) throw new Error(`${path} exists and is not a socket`);
  if (old.uid !== uid) throw new Error(`${path} is a socket of user ${old.uid}, not of ${uid}`);
  if ((await probe(path, probeMs)) === "live") throw new Error(`another instance is already listening on ${path}`);
  rmSync(path);
}

/** After bind: the socket must be ours and mode 0600, never wider. */
export function assertPrivateSocket(path: string): void {
  chmodSync(path, 0o600);
  const st = lstatSync(path);
  if (!st.isSocket() || st.uid !== myUid() || (st.mode & 0o777) !== 0o600) throw new Error(`the socket at ${path} is not private (mode ${(st.mode & 0o777).toString(8)})`);
}

/** Run `bind` with umask 0177, so the socket is created 0600 and never wider, not even for a moment. */
export function withNarrowUmask<T>(bind: () => T): T {
  const before = process.umask(0o177);
  try {
    return bind();
  } finally {
    process.umask(before);
  }
}
