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
//   (c) it exists and is empty, or holds only entries Collie writes ({@link isCollieEntry}): files
//       with Collie's names, and Collie's own folders holding only their own kind of file.
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
      // The CLI's read credential (bridge/local-secret.ts), rotated per bridge start.
      "local-secret",
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

/** Every FILE name Collie writes into the state or the config folder (one place, for rule (c)). */
const KNOWN_NAMES: ReadonlySet<string> = new Set([
  // State folder.
  "activity.json",
  "audit.log",
  "cache-watch.json",
  "crew-ops.json",
  "crew-runtime.json",
  "crew-trust.json",
  "folders.json",
  "local-secret",
  "machine-alerts.json",
  "machine-history.json",
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
  "worktree-bases.json",
  "worktree-receipts.json",
  // Config folder.
  ".env",
  "cache-rules.toml",
  "commands.toml",
  "config.toml",
  "keys.toml",
  "launchers.toml",
  "quick-replies.toml",
  "theme.toml",
]);

/** File name shapes with a variable part: per-instance files, staging logs, backups. */
const KNOWN_NAME_PATTERNS: readonly RegExp[] = [
  /^collie(-[\w.-]+)?\.(log|pid)$/i,
  /^collie(-[\w.-]+)?-(processes|restart)$/i,
  /^herdr\.collie(-[\w.-]+)?\.task\.xml$/i,
  /^tailscale-managed-handler.*$/i,
  /^update-staging-.+$/i,
  /^acl-backup-.+\.sddl$/i,
];

/**
 * The suffixes Collie itself puts after one of its names: a rotation (`audit.log.1`), a temporary
 * file of an atomic write (`crew-trust.json.tmp`, `collie-processes.4242.tmp`, `.env.collie-tmp`,
 * `.env.push-keys.tmp`, and `paired-devices.json.4242.7.tmp`, pid and sequence, from `pairing.ts`).
 * Nothing else: `.env.production` and `audit.log.x` are somebody else's.
 */
const OWN_SUFFIX = /^(?:\.\d+|\.tmp|\.\d+\.tmp|\.\d+\.\d+\.tmp|\.collie-tmp|\.push-keys\.tmp)$/;

/**
 * Collie's own FOLDERS in the state and the config folder, and the one kind of file each holds:
 * beacons as `.json`, phone uploads as `<pane>-<time>-<8 hex>.<ext>` (`bridge/server.ts`), fonts as
 * bare `.woff2` names (`operator-fonts.ts`), and saved access lists.
 */
const KNOWN_FOLDERS: ReadonlyMap<string, RegExp> = new Map([
  ["beacons", /^[^\\/]+\.json(?:\.tmp)?$/i],
  ["uploads", /^[A-Za-z0-9_-]+-[0-9a-z]+-[0-9a-f]{8}\.[A-Za-z0-9]+$/],
  ["fonts", /^[^\\/]+\.woff2$/i],
  ["acl-backups", /^acl-backup-.+\.sddl$/i],
]);

/**
 * Whether `name`, a FILE, is one Collie writes: a known name or shape, alone or followed by one of
 * Collie's own suffixes ({@link OWN_SUFFIX}).
 */
export function isCollieName(name: string): boolean {
  const known = (stem: string): boolean => KNOWN_NAMES.has(stem) || KNOWN_NAME_PATTERNS.some((s) => s.test(stem));
  if (known(name)) return true;
  for (let dot = name.indexOf(".", 1); dot > 0; dot = name.indexOf(".", dot + 1)) {
    if (known(name.slice(0, dot)) && OWN_SUFFIX.test(name.slice(dot))) return true;
  }
  return false;
}

/**
 * The state folder's secret names, case-folded: {@link PRIVATE_ROOTS}' `state` secrets, plus
 * `pack-trust.json`, the name 1.7.0 wrote the trust store under, which a folder that never saw 1.8.x
 * still holds (ADR 0045).
 */
const STATE_SECRET_NAMES: ReadonlySet<string> = new Set(
  [...privateRoot("state").secrets, "pack-trust.json"].map((n) => n.toLowerCase()),
);

/**
 * Whether a file NAME is one of a Collie state folder's secrets, wherever it sits: a state secret,
 * alone or followed by one of Collie's own suffixes (`crew-trust.json.tmp`). Case-folded on every
 * host. The Files view refuses and hides these by basename (ADR 0083), because a root that holds a
 * SIBLING instance's state folder is not one of this bridge's private folders.
 */
export function isStateSecretName(name: string): boolean {
  const folded = name.toLowerCase();
  if (STATE_SECRET_NAMES.has(folded)) return true;
  for (let dot = folded.indexOf(".", 1); dot > 0; dot = folded.indexOf(".", dot + 1)) {
    if (STATE_SECRET_NAMES.has(folded.slice(0, dot)) && OWN_SUFFIX.test(folded.slice(dot))) return true;
  }
  return false;
}

/** What one entry of a folder is, as {@link ScopeFacts.look} reports it. A link is never followed. */
export type EntryKind =
  | { readonly kind: "file" }
  | { readonly kind: "link" }
  /** `names` is `null` when the folder could not be listed. */
  | { readonly kind: "folder"; readonly names: readonly string[] | null };

/**
 * Whether an entry is Collie's, for rule (c). The rule, one level deep:
 *   * a FILE is Collie's when {@link isCollieName} says so;
 *   * a FOLDER is Collie's when it is one of {@link KNOWN_FOLDERS} and is empty or holds only FILES
 *     of that folder's own kind (no subfolder, no link): `fonts` holding a `.woff2` is Collie's,
 *     `fonts` holding the operator's photos is not;
 *   * a LINK (a symbolic link or a junction) is never Collie's: Collie never makes one there;
 *   * an entry that cannot be read is not Collie's.
 * `look` reports a path relative to the folder being judged, as a list of names.
 */
export function isCollieEntry(name: string, look: (rel: readonly string[]) => EntryKind | null): boolean {
  const entry = look([name]);
  if (entry === null || entry.kind === "link") return false;
  if (entry.kind === "file") return isCollieName(name);
  const ownFiles = KNOWN_FOLDERS.get(name);
  if (ownFiles === undefined || entry.names === null) return false;
  return entry.names.every((child) => ownFiles.test(child) && look([name, child])?.kind === "file");
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
  /** What an entry below the folder is, links not followed; `null` when it cannot be read. */
  look(rel: readonly string[]): EntryKind | null;
}

/**
 * May Collie change this folder's list? `allowed: false` carries the reason, worded to follow
 * "because" in a sentence.
 */
export type Scope = { readonly allowed: true } | { readonly allowed: false; readonly why: string };

export function repairScope(
  facts: ScopeFacts,
  host: Host,
  places: readonly SystemPlace[],
  defaults: readonly { readonly parent: string; readonly prefix: string }[],
): Scope {
  if (facts.realPath === null) return { allowed: false, why: "its real path could not be read" };
  const never = neverTouch(facts.realPath, host, places);
  if (never !== null) return { allowed: false, why: `${never}, and Collie never changes such a folder` };
  if (facts.createdNow || isDefaultLocation(facts.realPath, host, defaults)) return { allowed: true };
  if (facts.names === null) return { allowed: false, why: "its contents could not be listed" };
  const foreign = facts.names.filter((n) => !isCollieEntry(n, (rel) => facts.look(rel)));
  if (foreign.length === 0) return { allowed: true };
  return {
    allowed: false,
    why: `it also holds files that are not Collie's (${foreign.slice(0, 3).join(", ")}${foreign.length > 3 ? " and more" : ""})`,
  };
}
