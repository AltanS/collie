// Redaction for anything the lab writes down and a person may paste into a public issue (M56 spec 10).
// A screen shows the account, the folder and the machine. None of it leaves the lab as it was.
//
// What goes: the home directory and the lab directories (replaced by a short name), the user name,
// the host name, e-mail addresses, and anything shaped like a token or a key. The rows keep their
// length where they can, so a column of the screen still lines up.

import { homedir, hostname, userInfo } from "node:os";

export interface RedactContext {
  readonly home: string;
  readonly user: string;
  readonly host: string;
  /** Directories under the lab root that name a run (replaced by `<lab>`). */
  readonly labDirs: readonly string[];
}

export function redactContext(labDirs: readonly string[] = []): RedactContext {
  return { home: homedir(), user: userInfo().username, host: hostname(), labDirs };
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu;
const KEY_PREFIXED = /\b(?:sk|pk|rk|ghp|gho|ghs|github_pat|xox[abprs]|AKIA|AIza)[-_A-Za-z0-9]{10,}/gu;
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
    if (word.length >= 3) out = out.replace(new RegExp(`\\b${escapeRegex(word)}\\b`, "gu"), mask);
  }
  return out;
}

/** Plain rows, redacted. Trailing blank rows dropped. */
export function redactRows(rows: readonly string[], context: RedactContext): string[] {
  const out = rows.map((row) => redact(stripAnsi(row), context).trimEnd());
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}
