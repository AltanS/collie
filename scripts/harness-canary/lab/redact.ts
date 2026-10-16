// Redaction for anything the lab writes down and a person may paste into a public issue (M56 spec 10).
// A screen shows the account, the folder and the machine. None of it leaves the lab as it was.
//
// What goes: the home directory and the lab directories (replaced by a short name), the user name,
// the host name, e-mail addresses, and anything shaped like a token or a key. The rows keep their
// length where they can, so a column of the screen still lines up.

import { readFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { join } from "node:path";
import { asJsonObject, asJsonString, parseJson } from "../../../web/src/lib/json";

export interface RedactContext {
  readonly home: string;
  readonly user: string;
  readonly host: string;
  /** Directories under the lab root that name a run (replaced by `<lab>`). */
  readonly labDirs: readonly string[];
  /** Words a screen may show: the account's display name and organization name. Each has the mask it becomes. */
  readonly names?: readonly { readonly word: string; readonly mask: string }[] | undefined;
}

/** The display name and the organization name of the person's Claude account, read from `~/.claude.json`. */
export function accountNames(stateFile: string = join(homedir(), ".claude.json")): { word: string; mask: string }[] {
  try {
    const account = asJsonObject(asJsonObject(parseJson(readFileSync(stateFile, "utf8")))?.oauthAccount);
    const found: { word: string; mask: string }[] = [];
    const display = asJsonString(account?.displayName);
    const org = asJsonString(account?.organizationName);
    if (display !== undefined) found.push({ word: display, mask: "<name>" });
    if (org !== undefined) found.push({ word: org, mask: "<org>" });
    return found;
  } catch {
    return [];
  }
}

export function redactContext(labDirs: readonly string[] = [], names: readonly { word: string; mask: string }[] = accountNames()): RedactContext {
  return { home: homedir(), user: userInfo().username, host: hostname(), labDirs, names };
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu;
// A key has a prefix AND a body of its own: `sk-` and sixteen more characters, not any word that starts
// with `sk` (a screen says "skills" and "skill"). Each shape below is the shape the vendor issues.
const KEY_PREFIXED = /\b(?:(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}|gh[pos]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{12,}|AIza[A-Za-z0-9_-]{20,})/gu;
const BEARER = /\b(?:Bearer|Token)\s+[A-Za-z0-9._~+/=-]{16,}/giu;
const LONG_SECRET = /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/gu;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu;

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** SGR and other escape sequences removed: a plain screen for a person to read. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;:?]*[ -/]*[@-~]/gu, "").replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/gu, "");
}

/** One text with every private part replaced. Longest path first, so a lab path never half matches. */
export function redact(text: string, context: RedactContext): string {
  let out = text;
  for (const dir of [...context.labDirs].toSorted((a, b) => b.length - a.length)) if (dir.length > 0) out = out.replaceAll(dir, "<lab>");
  // Fedora Atomic keeps homes in /var/home and links /home to it: a screen may show either spelling.
  const spellings = new Set([context.home, context.home.replace(/^\/var\/home\//u, "/home/"), context.home.replace(/^\/home\//u, "/var/home/")]);
  for (const home of [...spellings].toSorted((a, b) => b.length - a.length)) if (home.length > 1) out = out.replaceAll(home, "~");
  out = out.replace(EMAIL, "<email>");
  out = out.replace(BEARER, "<token>").replace(KEY_PREFIXED, "<key>").replace(UUID, "<id>").replace(LONG_SECRET, "<secret>");
  // The user and the host last, as whole words, and only when they are long enough to mean something.
  for (const [word, mask] of [
    [context.user, "user"],
    [context.host, "host"],
  ] as const) {
    if (word.length >= 3) out = out.replace(new RegExp(`\\b${escapeRegex(word)}\\b`, "giu"), mask);
  }
  // A display name or an organization name is shown as words. Longest first, any case.
  for (const { word, mask } of [...(context.names ?? [])].toSorted((a, b) => b.word.length - a.word.length)) {
    if (word.trim().length >= 3) out = out.replace(new RegExp(escapeRegex(word.trim()), "giu"), mask);
  }
  return out;
}

/** Plain rows, redacted. Trailing blank rows dropped. */
export function redactRows(rows: readonly string[], context: RedactContext): string[] {
  const out = rows.map((row) => redact(stripAnsi(row), context).trimEnd());
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}
