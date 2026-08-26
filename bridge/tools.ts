import { accessSync, constants } from "node:fs";
import { isAbsolute, join } from "node:path";

// Finding an external tool (`herdr`, `git`, `systemctl`, `tailscale`, `journalctl`) when there may
// be no PATH at all.
//
// It lives on the bridge side and is re-exported by `cli/tools.ts`, because both processes now spawn
// `tailscale`: the CLI to publish and tear down the one managed front door, and the bridge to take
// that same mapping down when it comes up as a peer (`bridge/front-door.ts`). PURE — it reads the
// filesystem only to ask "is this an executable file", and it is handed the env and the home dir.
//
// Herdr spawns plugin actions with no login shell: nothing sourced a profile, so PATH is minimal or
// absent and `command -v` finds nothing (the pre-shim collie-ctl.sh — the bug that burned four
// `update` invocations). So PATH is a hint, not the mechanism: we search it when it is there and
// then fall back to an explicit list of absolute directories.
//
// ABSOLUTE entries only. An empty or relative PATH entry means "the current directory" — resolving
// a tool through it would let whatever directory we happen to be in supply `git`.

/** Absolute directories searched after PATH. `home` is the resolved home dir, never `$HOME` raw. */
export function fallbackDirs(home: string): string[] {
  return [
    join(home, ".local", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".cargo", "bin"),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/local/sbin",
    "/usr/sbin",
    "/sbin",
    "/opt/homebrew/bin",
  ];
}

/** The full search list: absolute PATH entries first (if any), then {@link fallbackDirs}. */
export function searchDirs(path: string | undefined, home: string): string[] {
  const fromPath = (path ?? "")
    .split(":")
    .map((d) => d.trim())
    .filter((d) => d.length > 0 && isAbsolute(d));
  const seen = new Set<string>();
  return [...fromPath, ...fallbackDirs(home)].filter((d) => {
    if (seen.has(d)) return false;
    seen.add(d);
    return true;
  });
}

/** Pure lookup: the first directory in `dirs` holding an executable `name`, or null. */
export function findIn(
  name: string,
  dirs: string[],
  isExecutable: (p: string) => boolean,
): string | null {
  for (const dir of dirs) {
    const candidate = join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

export function isExecutableFile(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve `name` to an absolute path, or null. Callers report a legible "X not found".
 *
 * An ALREADY-ABSOLUTE `name` is not searched for — it is checked where it is. Without that,
 * `join(dir, "/usr/bin/tmux")` asks after `/usr/bin/usr/bin/tmux` in every directory and the caller
 * is told the binary does not exist. It matters because the mux adapters resolve their binary
 * themselves, from an operator setting (`COLLIE_TMUX_BIN`) or a fixed candidate list
 * (`bridge/mux/<name>/exec.ts`), and `collie doctor` runs that same resolved path through the
 * `Exec` seam, which resolves every tool through here.
 */
export function findTool(
  name: string,
  env: Record<string, string | undefined>,
  home: string,
): string | null {
  if (isAbsolute(name)) return isExecutableFile(name) ? name : null;
  return findIn(name, searchDirs(env.PATH, home), isExecutableFile);
}
