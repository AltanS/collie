// WHAT COLLIE MAY CHANGE ON WINDOWS, AND WHAT IT ONLY LOOKS AT (M43 spec 04).
//
// Pure rules over facts the caller collects (real paths, folder listings, the environment). No
// process and no file call lives here.
//
// THE REPAIR SCOPE. Collie changes the access list of a folder only when the folder is plainly its
// own:
//
//   (a) Collie created it in this run, or
//   (b) it is a default location under the user profile (the plugin folders Herdr hands out, and the
//       `~/.local/state/collie*`, `~/.config/collie*` and `~/.collie` fallbacks), or
//   (c) it exists and is empty, or holds only names Collie writes ({@link isCollieName}).
//
// Any other folder (a `COLLIE_STATE_DIR` someone pointed at `D:\Projects`, `Documents`, a synced or
// shared folder) is CHECKED ONLY: one warning with the exact `icacls` line, and no change.
//
// NEVER, whatever the scope says: a network path, a drive root, a folder inside Windows or Program
// Files, and a folder that is or holds Windows, Program Files, ProgramData or the user profile. The
// comparison is made on the REAL path (links, 8.3 names like `PROGRA~1` and `\\?\` resolved by the
// caller) and folds case, so no spelling slips past it.

import { type Host, isInside, splitPath } from "./host.ts";

// ── The private roots ────────────────────────────────────────────────────────

/** A folder that holds secrets and must be private to the account. */
export interface PrivateRoot {
  readonly id: "state" | "config";
  /** The words a message uses: "the Collie state folder". */
  readonly label: string;
  /** The files in it that hold a secret. Start-up checks these by name; doctor reads the whole tree. */
  readonly secrets: readonly string[];
  /**
   * How source code names a path under this root. `bridge/private-roots-guard.test.ts` reads every
   * 0700/0600 write site and requires one of these on or just above it.
   */
  readonly sourceNames: RegExp;
}

/** The two private roots, in the order start-up and doctor go through them. */
export const PRIVATE_ROOTS: readonly PrivateRoot[] = [
  {
    id: "state",
    label: "the Collie state folder",
    secrets: [
      "crew-trust.json",
      "paired-devices.json",
      "pairing-pending.json",
      "push-subscriptions.json",
      "standby-devices.json",
      "stt.json",
    ],
    sourceNames: /\bstateDir\b|\buploadsDir\b|\bbeaconsDir\b/,
  },
  {
    id: "config",
    label: "the Collie config folder",
    secrets: [".env", "config.toml"],
    sourceNames: /\bconfigDir\b|\benvPath\b/,
  },
];

/** One root by its id. */
export function privateRoot(id: PrivateRoot["id"]): PrivateRoot {
  const root = PRIVATE_ROOTS.find((r) => r.id === id);
  if (root === undefined) throw new Error(`no private root ${id}`);
  return root;
}

// ── Names Collie writes ──────────────────────────────────────────────────────

/** Every name Collie writes into the state or the config folder (one place, for rule (c)). */
const KNOWN_NAMES: ReadonlySet<string> = new Set([
  // State folder.
  "activity.json",
  "audit.log",
  "beacons",
  "cache-watch.json",
  "crew-ops.json",
  "crew-runtime.json",
  "crew-trust.json",
  "folders.json",
  "notify-prefs.json",
  "pack-ops.json",
  "pack-runtime.json",
  "pack-trust.json",
  "paired-devices.json",
  "pairing-pending.json",
  "push-subscriptions.json",
  "snooze.json",
  "standby-devices.json",
  "stt.json",
  "update-runner.log",
  "update-state.json",
  "update.json",
  "update.lock",
  "uploads",
  // Config folder.
  ".env",
  "cache-rules.toml",
  "commands.toml",
  "config.toml",
  "fonts",
  "keys.toml",
  "launchers.toml",
  "quick-replies.toml",
  "theme.toml",
]);

/** Name shapes with a variable part: per-instance files, rotations, staging logs, backups. */
const KNOWN_NAME_PATTERNS: readonly RegExp[] = [
  /^collie(-[\w.-]+)?\.(log|pid)$/i,
  /^collie(-[\w.-]+)?-processes$/i,
  /^herdr\.collie(-[\w.-]+)?\.task\.xml$/i,
  /^tailscale-managed-handler.*$/i,
  /^update-staging-.+$/i,
  /^acl-backups$|^acl-backup-.+\.sddl$/i,
];

/**
 * Whether `name` is something Collie writes: a known name, a known shape, or either with a suffix
 * (`crew-trust.json.tmp`, `audit.log.1`, `.env.collie-tmp`).
 */
export function isCollieName(name: string): boolean {
  if (KNOWN_NAMES.has(name) || KNOWN_NAME_PATTERNS.some((s) => s.test(name))) return true;
  for (let dot = name.indexOf(".", 1); dot > 0; dot = name.indexOf(".", dot + 1)) {
    const stem = name.slice(0, dot);
    if (KNOWN_NAMES.has(stem) || KNOWN_NAME_PATTERNS.some((s) => s.test(stem))) return true;
  }
  return false;
}

// ── Places Collie never changes ──────────────────────────────────────────────

/** The environment variables that name the places, read by the caller from its own environment. */
export const SYSTEM_PLACE_VARS = ["SystemRoot", "ProgramFiles", "ProgramFiles(x86)", "ProgramData", "USERPROFILE"] as const;

/** Places whose INSIDE is off limits too: the system's own trees. */
const SYSTEM_TREES = new Set(["SystemRoot", "ProgramFiles", "ProgramFiles(x86)"]);

/** One never-touch place: its real path, and whether everything below it is off limits too. */
export interface SystemPlace {
  readonly path: string;
  readonly below: boolean;
}

/** The places from an environment, each run through `realpath` (an unreadable one keeps its spelling). */
export function systemPlaces(
  env: Readonly<Record<string, string | undefined>>,
  realpath: (path: string) => string | null,
): SystemPlace[] {
  return SYSTEM_PLACE_VARS.flatMap((name) => {
    const value = env[name];
    if (value === undefined || value === "") return [];
    return [{ path: realpath(value) ?? value, below: SYSTEM_TREES.has(name) }];
  });
}

/** A UNC path (`\\server\share\...`). The local long-path form `\\?\C:\` is not one. */
export function isNetworkPath(path: string): boolean {
  return /^\\\\(?!\?\\[a-z]:)/i.test(path) || /^\\\\\?\\UNC\\/i.test(path);
}

/**
 * Why Collie must never change `realPath`'s list, or `null` when it may (scope permitting).
 * `realPath` is the real path, already resolved.
 */
export function neverTouch(realPath: string, host: Host, places: readonly SystemPlace[]): string | null {
  if (isNetworkPath(realPath)) return "it is on a network share";
  const { root, parts } = splitPath(host, realPath);
  if (parts.length === 0 && root !== "") return "it is the root of a drive";
  for (const place of places) {
    if (isInside(host, place.path, realPath)) return `it holds ${place.path}`;
    if (place.below && isInside(host, realPath, place.path)) return `it is inside ${place.path}`;
  }
  return null;
}

// ── The repair scope ─────────────────────────────────────────────────────────

/** The default parents a Collie folder sits in, and the name prefixes it has there. */
export function defaultLocations(
  host: Host,
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): readonly { readonly parent: string; readonly prefix: string }[] {
  const out: { parent: string; prefix: string }[] = [
    { parent: host.path.join(home, ".local", "state"), prefix: "collie" },
    { parent: host.path.join(home, ".config"), prefix: "collie" },
    { parent: home, prefix: ".collie" },
  ];
  const appData = env.APPDATA;
  if (appData !== undefined && appData !== "") {
    out.push({ parent: host.path.join(appData, "herdr", "plugins", "config"), prefix: "herdr.collie" });
  }
  const localAppData = env.LOCALAPPDATA;
  if (localAppData !== undefined && localAppData !== "") {
    out.push({ parent: host.path.join(localAppData, "herdr", "plugins"), prefix: "herdr.collie" });
  }
  return out;
}

/** Whether `realPath` is one of the default locations: its parent is a default parent and its name starts right. */
export function isDefaultLocation(
  realPath: string,
  host: Host,
  defaults: readonly { readonly parent: string; readonly prefix: string }[],
): boolean {
  const parent = host.path.dirname(realPath);
  const name = host.path.basename(realPath).toLowerCase();
  return defaults.some(
    (d) => isInside(host, parent, d.parent) && isInside(host, d.parent, parent) && name.startsWith(d.prefix.toLowerCase()),
  );
}

/** The facts the scope rule needs about one folder. */
export interface ScopeFacts {
  /** The real path, or `null` when it could not be resolved. */
  readonly realPath: string | null;
  /** True when Collie created the folder in this run. */
  readonly createdNow: boolean;
  /** The names in the folder, or `null` when it could not be listed. */
  readonly names: readonly string[] | null;
}

/** May Collie change this folder's list? `allowed: false` carries the reason for the warning. */
export type Scope = { readonly allowed: true } | { readonly allowed: false; readonly why: string };

export function repairScope(
  facts: ScopeFacts,
  host: Host,
  places: readonly SystemPlace[],
  defaults: readonly { readonly parent: string; readonly prefix: string }[],
): Scope {
  if (facts.realPath === null) return { allowed: false, why: "its real path could not be read" };
  const never = neverTouch(facts.realPath, host, places);
  if (never !== null) return { allowed: false, why: `Collie never changes it: ${never}` };
  if (facts.createdNow || isDefaultLocation(facts.realPath, host, defaults)) return { allowed: true };
  if (facts.names === null) return { allowed: false, why: "it could not be listed" };
  const foreign = facts.names.filter((n) => !isCollieName(n));
  if (foreign.length === 0) return { allowed: true };
  return {
    allowed: false,
    why: `it is not only Collie's: it also holds ${foreign.slice(0, 3).join(", ")}${foreign.length > 3 ? " and more" : ""}`,
  };
}
