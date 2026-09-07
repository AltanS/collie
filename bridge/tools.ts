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

/**
 * The full search list: absolute PATH entries first (if any), then {@link fallbackDirs}.
 *
 * The separator comes from `platform`, not from a literal `":"` — Windows separates PATH with `;`,
 * and a `:` split there does not merely miss entries, it shreds every one of them at its drive
 * letter (`C:\Program Files\Git\cmd` becomes `C` and `\Program Files\Git\cmd`), so the
 * absolute-only filter below drops the lot and PATH contributes nothing at all.
 *
 * `platform` is a parameter defaulting to `process.platform` rather than a read of it, the way
 * `bridge/config.ts`'s `defaultSocketPath` takes its own: it makes the Windows branch reachable
 * from a test on any host. We do not test on Windows hardware, so an injected platform is the only
 * way this branch is ever exercised.
 */
export function searchDirs(
  path: string | undefined,
  home: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const fromPath = (path ?? "")
    .split(platform === "win32" ? ";" : ":")
    .map((d) => d.trim())
    .filter((d) => d.length > 0 && isAbsolute(d));
  const seen = new Set<string>();
  return [...fromPath, ...fallbackDirs(home)].filter((d) => {
    if (seen.has(d)) return false;
    seen.add(d);
    return true;
  });
}

/**
 * An environment variable read case-insensitively on Windows, exactly as the OS itself reads it.
 *
 * Windows spells them `Path` and `PathExt`, and case only stops mattering while the environment is
 * still the live `process.env` — Node's win32 proxy is case-insensitive. Every copy made of it is
 * a plain object that is not, and this module is handed such copies (the CLI merges `.env` over the
 * ambient environment before it builds `Exec`). So `env.PATH` reads `undefined` under PowerShell
 * while working under a shell that happens to export the name uppercase, such as Git Bash — the
 * tool search then silently falls back to the POSIX directory list and reports every Windows tool
 * as "not installed on this host".
 */
function envGet(
  env: Record<string, string | undefined>,
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  const direct = env[name];
  if (direct !== undefined) return direct;
  if (platform !== "win32") return undefined;
  const wanted = name.toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === wanted) return env[key];
  }
  return undefined;
}

/**
 * The suffixes a bare tool name may carry, most-bare first. `[""]` everywhere but Windows, where
 * executability is spelled in the extension: `git`, `herdr` and `python3` exist only as `git.exe`,
 * `herdr.exe`, `python3.exe`, and a lookup for the bare name finds nothing — which reads downstream
 * as "not installed" rather than "we looked in the wrong place".
 */
export function toolExts(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform !== "win32") return [""];
  const raw = envGet(env, "PATHEXT", platform) ?? ".COM;.EXE;.BAT;.CMD";
  const ext = raw.split(";").map((e) => e.trim()).filter((e) => e !== "");
  return ["", ...ext];
}

/**
 * Pure lookup: the first directory in `dirs` holding an executable `name`, or null. Each directory
 * is tried against every suffix in `exts` before moving on, so PATH order still decides.
 */
export function findIn(
  name: string,
  dirs: string[],
  isExecutable: (p: string) => boolean,
  exts: readonly string[] = [""],
): string | null {
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (isExecutable(candidate)) return candidate;
    }
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
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (isAbsolute(name)) return isExecutableFile(name) ? name : null;
  return findIn(
    name,
    searchDirs(envGet(env, "PATH", platform), home, platform),
    isExecutableFile,
    toolExts(env, platform),
  );
}
