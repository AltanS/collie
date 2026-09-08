// HERDR'S SESSION LAYOUT, where a second herd on this machine actually lives (M22/02).
//
// Herdr can run several named sessions, each its own server with its own unix socket:
//
//   • default session:  <configRoot>/herdr.sock
//   • named session:    <configRoot>/sessions/<name>/herdr.sock
//
// THAT SHAPE IS HERDR'S AND NOTHING ABOVE THIS DIRECTORY MAY KNOW IT. It used to sit in
// `bridge/sessions.ts`, above the seam, which is what made "can this bridge front more than one
// session" a question about the multiplexer's NAME instead of about its declaration (ADR 0022, ADR
// 0036). It moved here with the `listSessions` capability: `bridge/sessions.ts` keeps the registry
// and the naming rules, the adapter answers where the sockets are.
//
// A CLEANLY STOPPED SESSION REMOVES ITS SOCKET, so a socket's presence is the liveness signal this
// module scans for. That is a Herdr fact, not a general one, tmux keeps its socket file after
// `kill-server` (see MUX_CONTRACT.md § listSessions), which is exactly why the answer is per adapter.
//
// SECURITY: the only filesystem input here is the trusted config root plus a directory listing. A
// client-supplied session name never reaches this module, and never becomes a path, it can only
// select among what discovery already found (`bridge/sessions.ts`).

import { basename, dirname, join } from "node:path";
import { existsSync, readdirSync } from "node:fs";

import { DEFAULT_SESSION_NAME } from "../../sessions.ts";
import type { MuxSession } from "../types.ts";

/** The socket file every Herdr session listens on, whichever directory holds it. */
export const HERDR_SOCKET_FILE = "herdr.sock";

/** The directory that holds the named sessions, under a config root. */
const SESSIONS_DIR = "sessions";

/**
 * The config root that holds a session layout, derived from a socket path. If the socket sits at
 * `…/sessions/<name>/herdr.sock` the root is the prefix before `/sessions/`; otherwise it's just the
 * socket's directory (the default session's `<root>/herdr.sock`). Pure + exported for tests.
 */
export function deriveConfigRoot(socketPath: string): string {
  const dir = dirname(socketPath); // <root>  OR  <root>/sessions/<name>
  const parent = dirname(dir); // <parentOfRoot>  OR  <root>/sessions
  if (basename(parent) === SESSIONS_DIR) return dirname(parent);
  return dir;
}

/**
 * Discover every running herdr session under a config root: the default (`<root>/herdr.sock`) plus
 * each `<root>/sessions/<name>/herdr.sock` that currently exists. `listSessionDirs` and `exists` are
 * injected (real fs in the bridge, fakes in tests) so this stays pure and unit-testable — and so the
 * only filesystem input is the trusted config root, never a client-supplied name.
 */
export function discoverSessionSockets(
  configRoot: string,
  listSessionDirs: (dir: string) => string[],
  exists: (p: string) => boolean,
): Array<{ name: string; socketPath: string }> {
  const found: Array<{ name: string; socketPath: string }> = [];
  const defaultSock = join(configRoot, HERDR_SOCKET_FILE);
  if (exists(defaultSock)) found.push({ name: DEFAULT_SESSION_NAME, socketPath: defaultSock });
  const sessionsDir = join(configRoot, SESSIONS_DIR);
  for (const name of listSessionDirs(sessionsDir)) {
    const sock = join(sessionsDir, name, HERDR_SOCKET_FILE);
    if (exists(sock)) found.push({ name, socketPath: sock });
  }
  return found;
}

/** The same discovery in the port's words: a socket path IS a Herdr endpoint. Pure. */
export function herdrSessionsIn(
  configRoot: string,
  listSessionDirs: (dir: string) => string[],
  exists: (p: string) => boolean,
): readonly MuxSession[] {
  return discoverSessionSockets(configRoot, listSessionDirs, exists).map(
    ({ name, socketPath }): MuxSession => ({ name, endpoint: socketPath }),
  );
}

/** The session directory names under `<configRoot>/sessions`, or none when the dir is not there. */
function realSessionDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    // A missing (or unreadable) sessions directory is the common case, one session and nothing named.
    return [];
  }
}

/**
 * What {@link HerdrMux.listSessions} answers with, against the real filesystem.
 *
 * A function of the ADAPTER'S OWN ENDPOINT, because that is all the adapter has: the socket it was
 * built for names the config root every other session of that Herdr install sits under. Handed to
 * the adapter as a dependency rather than called from inside it, so the whole translation stays
 * unit-testable with no filesystem at all (`sessions.test.ts`).
 */
export function herdrSessionSource(endpoint: string): () => readonly MuxSession[] {
  const configRoot = deriveConfigRoot(endpoint);
  return () => herdrSessionsIn(configRoot, realSessionDirs, existsSync);
}
