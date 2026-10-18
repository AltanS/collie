// Where the rig's scratch Herdr keeps its sockets, and the check that the paths fit.
//
// A Unix socket path must fit `sun_path`: 108 bytes with the NUL on Linux, 104 on macOS. Herdr binds
// its sockets under its config home, and the rig's state root can be long (the nightly runner's is
// `~/.cache/collie-lab/browser-leg-nightly/state`), so a path that fits by hand can fail in the
// nightly run. The failure is Herdr's own: "local socket name length exceeds capacity of sun_path".
//
// HOW HERDR DERIVES THE PATH (herdr 0.9.4, probed 2026-10-18 with a scratch server). With
// `--session NAME` the sockets sit under `$XDG_CONFIG_HOME/herdr/sessions/NAME/`: the API socket
// `herdr.sock`, and `herdr-client.sock` beside it, which is the longer one. Nothing else moves them.
// `HERDR_SOCKET_PATH`, `HERDR_CLIENT_SOCKET_PATH`, `HERDR_HOME`, `HERDR_CONFIG_PATH` and
// `XDG_RUNTIME_DIR` all left the sockets where they were. So the rig gives Herdr a short
// XDG_CONFIG_HOME, and everything else of the rig stays under the state root.
//
// Node builtins only, no side effects: `scripts/browser-leg-sock.test.ts` imports this file.
import { createHash } from "node:crypto";
import { join } from "node:path";

/** The most bytes a socket path may have: `sun_path` holds 108 on Linux and 104 on macOS, with the NUL. */
export function sunPathLimit(platform: NodeJS.Platform = process.platform): number {
  return (platform === "darwin" ? 104 : 108) - 1;
}

/** The two sockets `herdr --session <session> server` binds under an XDG config home, API socket first. */
export function herdrSocketPaths(xdgConfigHome: string, session: string): readonly string[] {
  const dir = join(xdgConfigHome, "herdr", "sessions", session);
  return [join(dir, "herdr.sock"), join(dir, "herdr-client.sock")];
}

/** Null when both sockets fit; else one plain sentence naming the longest path and its length. */
export function socketPathProblem(xdgConfigHome: string, session: string, platform: NodeJS.Platform = process.platform): string | null {
  const limit = sunPathLimit(platform);
  let worst = "";
  for (const path of herdrSocketPaths(xdgConfigHome, session)) {
    if (Buffer.byteLength(path) > Buffer.byteLength(worst)) worst = path;
  }
  const bytes = Buffer.byteLength(worst);
  if (bytes <= limit) return null;
  return `the Herdr socket path is ${bytes} bytes, over the ${limit} a Unix socket allows (sun_path): ${worst}`;
}

/** The folder name of the rig's short Herdr home: a short hash of the state root keeps two rigs apart. */
export const XDG_HOME_NAME = /^collie-rig-[0-9a-f]{8}$/;

/**
 * The XDG_CONFIG_HOME for one rig's Herdr: `<runtime dir>/collie-rig-<8 hex of sha256(stateRoot)>`.
 * The runtime dir is `$XDG_RUNTIME_DIR` (per user, mode 0700, in memory) when it is given and the
 * sockets fit under it, else `/tmp`. The same state root gives the same folder, two state roots give
 * two. If even `/tmp` is too long (a very long session name), the `/tmp` path comes back and
 * `assertSocketsFit` says so.
 */
export function shortXdgHome(stateRoot: string, session: string, runtimeDir: string | undefined, platform: NodeJS.Platform = process.platform): string {
  const name = `collie-rig-${createHash("sha256").update(stateRoot).digest("hex").slice(0, 8)}`;
  const candidates = [...(runtimeDir !== undefined && runtimeDir.startsWith("/") ? [runtimeDir] : []), "/tmp"];
  const homes = candidates.map((base) => join(base, name));
  return homes.find((home) => socketPathProblem(home, session, platform) === null) ?? join("/tmp", name);
}
