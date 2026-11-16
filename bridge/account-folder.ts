import { isAbsolute, join, relative, sep } from "node:path";

import type { AccountAdapter } from "./account-adapters.ts";
import { isForbiddenCodePoint } from "./launcher-recipes.ts";

// ── The label, the folder and the start line of an account (M101, ADR 0141) ─────────────────────
//
// THE FOLDER IS TYPED INTO A SHELL. `NAME='<folder>' <binary>` is the line, so the folder is a
// command-injection surface and is checked before it is stored and again when it is read back. The
// rule is narrow on purpose: an absolute path after `~` expansion, at most {@link MAX_FOLDER_CHARS}
// characters, no control or bidi character, and none of `'`, `"`, `\`, `` ` `` or `$`. The value is
// then always single-quoted. With no `'` in it, a single-quoted word is literal in sh, bash, zsh and
// fish; with no `\` either, fish's two escapes inside single quotes cannot occur. `` ` `` and `$` would
// already be inert there, and they are refused anyway, so a shell that does not take single quotes
// literally still sees no substitution.
//
// THE SAME TEXT EVERY TIME. Claude Code keys its macOS Keychain item on the raw text of the variable,
// so an account always types its cleaned absolute path (`join(dir, ".")`), never `~`, never a trailing
// slash, never a second spelling.

/** The longest label, in code points after trim and NFC. */
export const MAX_ACCOUNT_LABEL = 24;
/** The longest folder, in code points, as typed. */
export const MAX_FOLDER_CHARS = 200;
/** A longer raw value is refused before any other look. */
const MAX_RAW_CHARS = 1024;

/** Characters a folder may never hold, beyond control and bidi characters. */
const FORBIDDEN_IN_FOLDER = new Set(["'", '"', "\\", "`", "$"]);

export type LabelCheck = { ok: true; label: string; slug: string } | { ok: false };

/** A label's slug: lower case, `[a-z0-9-]`, spaces to `-`, no leading, trailing or doubled `-`. */
export function labelSlug(label: string): string {
  return label
    .toLowerCase()
    .replace(/\s+/gu, "-")
    .replace(/[^a-z0-9-]/gu, "")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "");
}

/** The label rule: 1 to 24 characters after trim, no control character, and a slug that is not empty. */
export function checkLabel(raw: string): LabelCheck {
  if (raw.length > MAX_RAW_CHARS) return { ok: false };
  for (const ch of raw) if (isForbiddenCodePoint(ch.codePointAt(0) ?? 0)) return { ok: false };
  const label = raw.normalize("NFC").trim();
  const length = [...label].length;
  if (length < 1 || length > MAX_ACCOUNT_LABEL) return { ok: false };
  const slug = labelSlug(label);
  if (slug === "") return { ok: false };
  return { ok: true, label, slug };
}

/** Whether two labels collide: the same words without case. */
export function sameLabel(a: string, b: string): boolean {
  return a.normalize("NFC").toLocaleLowerCase("en") === b.normalize("NFC").toLocaleLowerCase("en");
}

/** Why a folder is refused, as the `reason` of `accounts.bad_folder`. English, the bridge's words. */
export type FolderProblem =
  | "not a folder path"
  | "not an absolute path"
  | "a character that is not allowed"
  | "too long"
  | "outside your home folder and missing"
  | "the home folder itself"
  | "the agent's default folder"
  | "not empty";

/** The pure half of the rule: the cleaned absolute folder, or the problem. No disk call. */
export function parseFolderPath(raw: string, home: string): { ok: true; dir: string } | { ok: false; problem: FolderProblem } {
  if (raw === "") return { ok: false, problem: "not a folder path" };
  if (raw.length > MAX_RAW_CHARS) return { ok: false, problem: "too long" };
  for (const ch of raw) {
    if (isForbiddenCodePoint(ch.codePointAt(0) ?? 0) || FORBIDDEN_IN_FOLDER.has(ch)) return { ok: false, problem: "a character that is not allowed" };
  }
  // A space at either end is refused, never trimmed: the folder typed must be the folder named.
  if (raw.trim() !== raw) return { ok: false, problem: "a character that is not allowed" };
  let expanded: string;
  if (raw === "~") expanded = home;
  else if (raw.startsWith("~/")) expanded = join(home, raw.slice(2));
  else if (raw.startsWith("~")) return { ok: false, problem: "not an absolute path" };
  else expanded = raw;
  if (!isAbsolute(expanded)) return { ok: false, problem: "not an absolute path" };
  // On the string as sent: `join` would quietly resolve a `..` away.
  if (raw.split(/[\\/]+/u).includes("..")) return { ok: false, problem: "not an absolute path" };
  const dir = join(expanded, ".");
  if ([...dir].length > MAX_FOLDER_CHARS) return { ok: false, problem: "too long" };
  if (dir === join(home, ".")) return { ok: false, problem: "the home folder itself" };
  return { ok: true, dir };
}

/** Whether `child` sits strictly under `parent`, on whole segments. */
export function isUnder(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** The disk calls the folder rule makes. */
export interface FolderLook {
  /** Whether anything sits at `path`, a link included. */
  exists(path: string): Promise<boolean>;
  /** The real path, or null when it does not resolve. */
  realpath(path: string): Promise<string | null>;
}

export interface FolderRuleInput {
  raw: string;
  home: string;
  /** The agent's default folder, cleaned. */
  defaultDir: string;
  /** The cleaned folders other accounts of any agent hold. */
  taken: readonly string[];
  look: FolderLook;
}

export type FolderRule = { ok: true; dir: string; exists: boolean } | { ok: false; code: "accounts.bad_folder"; problem: FolderProblem } | { ok: false; code: "accounts.folder_taken" };

/** The whole folder rule: the shape, inside home or already there, not the default, not taken. */
export async function checkFolder(input: FolderRuleInput): Promise<FolderRule> {
  const parsed = parseFolderPath(input.raw, input.home);
  if (!parsed.ok) return { ok: false, code: "accounts.bad_folder", problem: parsed.problem };
  const { dir } = parsed;
  const exists = await input.look.exists(dir);
  if (!exists && !isUnder(dir, join(input.home, "."))) return { ok: false, code: "accounts.bad_folder", problem: "outside your home folder and missing" };
  const real = exists ? await input.look.realpath(dir) : null;
  const defaultReal = await input.look.realpath(input.defaultDir);
  if (dir === input.defaultDir || (real !== null && real === defaultReal)) return { ok: false, code: "accounts.bad_folder", problem: "the agent's default folder" };
  for (const other of input.taken) {
    if (other === dir) return { ok: false, code: "accounts.folder_taken" };
    if (real !== null && (await input.look.realpath(other)) === real) return { ok: false, code: "accounts.folder_taken" };
  }
  return { ok: true, dir, exists };
}

/**
 * One shell word, single-quoted. Only for a folder {@link parseFolderPath} passed: it holds no `'`.
 * Throws on one all the same, so a folder that reached here another way can never close the quote
 * and type a command of its own.
 */
export function quoteFolder(dir: string): string {
  if (dir.includes("'")) throw new Error("a folder with a ' cannot be quoted as one shell word");
  return `'${dir}'`;
}

/** The line the bridge types for an added account: `NAME='<folder>' <binary>[ <args>]`. */
export function accountStartLine(adapter: AccountAdapter, dir: string, binary: string, args: readonly string[] = []): string {
  return [`${adapter.select.env}=${quoteFolder(dir)}`, binary, ...args].join(" ");
}

/** A folder for reading: `~/rest` under home, else the path itself. */
export function displayFolder(dir: string, home: string): string {
  const base = join(home, ".");
  if (dir === base) return "~";
  return isUnder(dir, base) ? `~/${relative(base, dir).split(sep).join("/")}` : dir;
}

/**
 * The line a desktop terminal needs, for the page: `CLAUDE_CONFIG_DIR=~/.claude-work claude`. The
 * `~` form only when the rest is plain path characters, so the line pastes as it reads (the shell
 * expands `~` in an assignment to the same absolute path the bridge types); else the quoted path.
 */
export function displayStartLine(adapter: AccountAdapter, dir: string, binary: string, home: string): string {
  const shown = displayFolder(dir, home);
  const value = shown.startsWith("~/") && /^~\/[A-Za-z0-9._/-]+$/u.test(shown) ? shown : quoteFolder(dir);
  return `${adapter.select.env}=${value} ${binary}`;
}

/**
 * The folder a sign-in start runs in: `sign-in` in the instance's state folder, so it follows
 * `COLLIE_STATE_DIR`. An agent started only to log in should not ask about, or get trust for, the home
 * folder or the folder of a neighbouring pane. The bridge makes it empty and writes nothing into it.
 */
export function signInFolder(stateDir: string): string {
  return join(stateDir, "sign-in");
}
