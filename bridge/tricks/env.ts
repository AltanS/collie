import { HOST, type Host } from "../host.ts";
import { redactText } from "../redact.ts";
import { envGet } from "../tools.ts";
import { BASE_ENV_NAMES } from "../../web/src/lib/tricks/limits.ts";

// THE PROGRAM'S ENVIRONMENT (M94 slice 01): an allow-list.
//
// A program gets the variables a shell tool needs to find itself and the user's own files, and nothing
// else of the bridge's environment: {@link BASE_ENV_NAMES} and every `LC_*`. A trick that needs more
// names each variable in its manifest, `env = ["GH_TOKEN"]`; `collie trick check` and `GET /api/tricks`
// show every name it asked for, so the person sees what it reads. Some names are never passed, even
// when listed ({@link neverReason}): the bridge's own settings (`COLLIE_*`), the multiplexer's
// (`HERDR_*`), any socket (`*_SOCK`, `*_SOCKET`), which would hand the program an agent or a daemon
// that acts for the user, and `BUN_BE_BUN`, which only the runner sets, for a script run (run.ts).
//
// A base variable whose VALUE the secret mask would change is dropped too (`TERM=sk-or-v1-...`); a
// listed one is passed as it is, because the person asked for it by name.
//
// The test hooks (`TRICK_NOW`, `TRICK_TOOLS_ONLY_PATH`, any `TRICK_*` name) reach a program only from
// `collie trick dev` and `collie trick check --run`, which pass `{ testHooks: true }`. The bridge never
// does, and never passes one even when a manifest lists it: a hook that fixes the clock or hides a tool
// has no business in a run the phone sees.
//
// This is a limit on what leaks by accident, not a sandbox. The program runs as the user, with the full
// rights of the user: it can read any file the user can, the config folder too (its own folder is
// inside it, and the facts carry that path as `trick.dir`).

// WINDOWS (fault a of the Windows milestone). A name there is one in any case, and a copy of the
// environment spells it the way Windows does: `Path`, `PathExt`, `SystemRoot`. So on win32 every rule
// below compares names without case, and the scrub keeps the spelling the copy carries (no second
// `PATH` beside `Path`). The Windows base set adds the names a program and Bun itself need there; it
// widens the list on win32 only, and every `never` rule still wins over it. Every rule takes the host
// as a parameter, so a test reaches the Windows branch on Linux with `hostFor("win32")`.

// The base list lives in web/src/lib/tricks/limits.ts, which the tricks catalogue reads too. The
// Windows set lives here while tricks are gated on Windows; the catalogue gains it with the gate's lift.
export { BASE_ENV_NAMES };

/** The names a program gets on Windows besides {@link BASE_ENV_NAMES}. Compared without case. */
export const WINDOWS_BASE_ENV_NAMES = ["SystemRoot", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "COMSPEC", "WINDIR"] as const;

const BASE = new Set<string>(BASE_ENV_NAMES);
const BASE_FOLDED = new Set<string>([...BASE_ENV_NAMES, ...WINDOWS_BASE_ENV_NAMES].map((n) => n.toUpperCase()));

/** An environment: names to values. `undefined` reads as unset and is dropped. */
export type ProgramEnv = Readonly<Record<string, string | undefined>>;

/** Why a name is never passed, even when a trick lists it, or null. */
export function neverReason(name: string, host: Host = HOST): string | null {
  const upper = name.toUpperCase();
  if (upper.startsWith("COLLIE_")) return "a COLLIE_ variable";
  if (upper.startsWith("HERDR_")) return "a HERDR_ variable";
  if (upper.endsWith("_SOCK") || upper.endsWith("_SOCKET")) return "a socket";
  // The runner adds it to a script run alone (run.ts): passed on, it turns any `collie` the program calls into `bun`.
  if (upper === "BUN_BE_BUN") return "Collie's own runtime switch";
  // On Windows `trick_now` is the same variable as `TRICK_NOW`, so the hook rule reads it folded there.
  if (isTestHookName(host.caseInsensitive ? upper : name)) return "a test hook, passed only by collie trick dev and check --run";
  return null;
}

/** Whether a name is a test hook a program reads: `TRICK_` and upper-case letters, digits and `_`. */
export function isTestHookName(name: string): boolean {
  return /^TRICK_[A-Z0-9_]+$/.test(name);
}

/** Whether a name is in the base set every program gets: exact case on POSIX, any case on Windows (with its own set). */
export function isBaseEnvName(name: string, host: Host = HOST): boolean {
  if (!host.caseInsensitive) return BASE.has(name) || name.startsWith("LC_");
  const upper = name.toUpperCase();
  return BASE_FOLDED.has(upper) || upper.startsWith("LC_");
}

/** Whether the trick listed `name`: exact case on POSIX, any case on Windows. */
function isListed(name: string, listed: ReadonlySet<string>, host: Host): boolean {
  if (listed.has(name)) return true;
  if (!host.caseInsensitive) return false;
  const upper = name.toUpperCase();
  for (const l of listed) if (l.toUpperCase() === upper) return true;
  return false;
}

/** Why a variable is kept out of the program's environment, or `null` when it is passed. */
export function scrubReason(name: string, value: string, listed: ReadonlySet<string> = new Set(), host: Host = HOST): string | null {
  const never = neverReason(name, host);
  if (never !== null) return never;
  if (isListed(name, listed, host)) return null;
  if (!isBaseEnvName(name, host)) return "not on the allow-list; a trick lists it in env";
  if (redactText(value) !== value) return "a value the secret mask hides";
  return null;
}

/**
 * The environment a program gets: the base names and the names the trick `listed`, minus every
 * variable {@link scrubReason} names. With `testHooks` (the CLI's `trick dev` and `check --run` only,
 * never the bridge) every `TRICK_*` variable of `env` is passed too. Pure; the input is not changed.
 */
export function scrubEnv(env: ProgramEnv, listed: readonly string[] = [], opts: { testHooks?: boolean; host?: Host } = {}): Record<string, string> {
  const host = opts.host ?? HOST;
  const names = new Set(listed);
  const kept = Object.entries(env).flatMap(([name, value]): [string, string][] => {
    if (value === undefined) return [];
    if (opts.testHooks === true && isTestHookName(name)) return [[name, value]];
    return scrubReason(name, value, names, host) !== null ? [] : [[name, value]];
  });
  return Object.fromEntries(kept);
}

/** The PATH of an environment copy, read by any spelling on Windows (`Path`), by `PATH` elsewhere. */
export function envPath(env: ProgramEnv, host: Host = HOST): string | undefined {
  return envGet(env, "PATH", host);
}
