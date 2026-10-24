// ── COLLIE_ACCOUNT_WINDOWS, READ ONCE ────────────────────────────────────────────────────────────
//
// `COLLIE_ACCOUNT_WINDOWS` / `[bridge] account_windows` (ADR 0118) names which harnesses Collie may
// ask for their 5-hour and 7-day windows. A leaf module on purpose: the bridge config, the config
// file reader and the doctor all read the setting, and none of them should pull the service in.

/** Every harness with an account-windows source, in the order the doctor lists them. */
export const ACCOUNT_WINDOW_HARNESSES = ["claude", "codex", "opencode", "grok"] as const;

/**
 * The harnesses on when the setting is unset, or says `on`. Claude is proven live. Codex reads its
 * own session files and sends no token. OpenCode Go and Grok are off until one real login has proven
 * their shape; `all` or their name turns them on.
 */
export const ACCOUNT_WINDOWS_DEFAULT: readonly string[] = ["claude", "codex"];

/** The harnesses whose source no live login has proven yet (ADR 0118, "Other harnesses"). */
export const ACCOUNT_WINDOWS_UNVERIFIED: readonly string[] = ["opencode", "grok"];

const OFF_WORDS: ReadonlySet<string> = new Set(["0", "off", "false", "no"]);
const ON_WORDS: ReadonlySet<string> = new Set(["1", "on", "true", "yes"]);

/** How the operator wrote the setting. */
export type AccountWindowsForm = "unset" | "off" | "on" | "all" | "list";

export interface AccountWindowsSetting {
  readonly form: AccountWindowsForm;
  /** The harness ids that are on, in {@link ACCOUNT_WINDOW_HARNESSES} order. Empty means all off. */
  readonly harnesses: readonly string[];
  /** Set when the value held ids this build does not know: they are dropped, and only the known ids are on. */
  readonly unknown: readonly string[];
}

/** The words `all`, `on`, `off` and the ids, for one sentence of help. */
export const ACCOUNT_WINDOWS_FORMS = `0/off/false/no, 1/on/true/yes, all, or a list of ${ACCOUNT_WINDOW_HARNESSES.join(", ")}`;

function ordered(ids: ReadonlySet<string>): string[] {
  return ACCOUNT_WINDOW_HARNESSES.filter((id) => ids.has(id));
}

/**
 * Read the setting's text. Case and spaces do not matter. Unset or blank is the default set. A list
 * keeps the ids this build knows and drops the rest, named in `unknown` for a warning: a typo never
 * turns on a source the operator did not name, so `opencode,gork` reads only OpenCode, and a list with
 * no known id reads nothing at all. A list may not hold `off`, `on` or `all`; those stand alone, and
 * inside a list they are unknown ids.
 */
export function parseAccountWindowsSetting(raw: string | undefined): AccountWindowsSetting {
  const text = (raw ?? "").trim().toLowerCase();
  if (text === "") return { form: "unset", harnesses: ACCOUNT_WINDOWS_DEFAULT, unknown: [] };
  if (OFF_WORDS.has(text)) return { form: "off", harnesses: [], unknown: [] };
  if (ON_WORDS.has(text)) return { form: "on", harnesses: ACCOUNT_WINDOWS_DEFAULT, unknown: [] };
  if (text === "all") return { form: "all", harnesses: ACCOUNT_WINDOW_HARNESSES, unknown: [] };
  const ids = text
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");
  const unknown = ids.filter((id) => !ACCOUNT_WINDOW_HARNESSES.some((known) => known === id));
  return { form: "list", harnesses: ordered(new Set(ids)), unknown: ids.length === 0 ? [text] : unknown };
}

/** The warning for a value with unknown ids, or null. Names the ids, never anything else. */
export function accountWindowsProblem(setting: AccountWindowsSetting): string | null {
  if (setting.unknown.length === 0) return null;
  const shown = setting.unknown.map((id) => JSON.stringify(id.slice(0, 32))).join(", ");
  return `unknown ${setting.unknown.length === 1 ? "id" : "ids"} ${shown} ignored; use ${ACCOUNT_WINDOWS_FORMS}`;
}
