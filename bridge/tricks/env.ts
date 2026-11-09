import { redactText } from "../redact.ts";

// THE PROGRAM'S ENVIRONMENT (M94 slice 01): an allow-list.
//
// A program gets the variables a shell tool needs to find itself and the user's own files, and nothing
// else of the bridge's environment: {@link BASE_ENV_NAMES} and every `LC_*`. A trick that needs more
// names each variable in its manifest, `env = ["GH_TOKEN"]`; `collie trick check` and `GET /api/tricks`
// show every name it asked for, so the person sees what it reads. Some names are never passed, even
// when listed ({@link neverReason}): the bridge's own settings (`COLLIE_*`), the multiplexer's
// (`HERDR_*`), and any socket (`*_SOCK`, `*_SOCKET`), which would hand the program an agent or a daemon
// that acts for the user.
//
// A base variable whose VALUE the secret mask would change is dropped too (`TERM=sk-or-v1-...`); a
// listed one is passed as it is, because the person asked for it by name.
//
// This is a limit on what leaks by accident, not a sandbox. The program runs as the user, with the full
// rights of the user: it can read any file the user can, the config folder too (its own folder is
// inside it, and the facts carry that path as `trick.dir`).

/** The variables every program gets, when the bridge has them. */
export const BASE_ENV_NAMES = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "TZ",
  "TERM",
  "TMPDIR",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "NVM_DIR",
  "BUN_INSTALL",
] as const;

const BASE = new Set<string>(BASE_ENV_NAMES);

/** An environment: names to values. `undefined` reads as unset and is dropped. */
export type ProviderEnv = Readonly<Record<string, string | undefined>>;

/** Why a name is never passed, even when a trick lists it, or null. */
export function neverReason(name: string): string | null {
  const upper = name.toUpperCase();
  if (upper.startsWith("COLLIE_")) return "a COLLIE_ variable";
  if (upper.startsWith("HERDR_")) return "a HERDR_ variable";
  if (upper.endsWith("_SOCK") || upper.endsWith("_SOCKET")) return "a socket";
  return null;
}

/** Whether a name is in the base set every program gets. */
export function isBaseEnvName(name: string): boolean {
  return BASE.has(name) || name.startsWith("LC_");
}

/** Why a variable is kept out of the program's environment, or `null` when it is passed. */
export function scrubReason(name: string, value: string, listed: ReadonlySet<string> = new Set()): string | null {
  const never = neverReason(name);
  if (never !== null) return never;
  if (listed.has(name)) return null;
  if (!isBaseEnvName(name)) return "not on the allow-list; a trick lists it in env";
  if (redactText(value) !== value) return "a value the secret mask hides";
  return null;
}

/**
 * The environment a program gets: the base names and the names the trick `listed`, minus every
 * variable {@link scrubReason} names. Pure; the input is not changed.
 */
export function scrubEnv(env: ProviderEnv, listed: readonly string[] = []): Record<string, string> {
  const names = new Set(listed);
  const kept = Object.entries(env).flatMap(([name, value]): [string, string][] =>
    value === undefined || scrubReason(name, value, names) !== null ? [] : [[name, value]],
  );
  return Object.fromEntries(kept);
}
