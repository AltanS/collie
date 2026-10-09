// ── Which branch names a worktree create may carry (ADR 0089) ────────────────────────────────────
//
// The phone mints `worktree/<adjective>-<noun>-<hex>` and the operator may edit it, so the bridge is
// the one place that decides whether a name reaches the multiplexer at all. Git would refuse most of
// these itself, but its refusal arrives as a `worktree_create_failed` sentence after a round trip
// that can take a minute, and a few of them are worse than refused: a leading `-` reads as an option
// to whatever runs `git` underneath. So this is checked BEFORE the multiplexer is touched, and the
// answer is a plain 400.
//
// It is a SUBSET of `git check-ref-format`, not a copy: every name refused here is one Git would
// refuse or one that would parse as a flag. A name this lets through may still be refused by Git
// (a branch that already exists, a ref that clashes with a directory), and that refusal keeps
// arriving as the multiplexer's own words, as it always has.

/** Characters Git forbids anywhere in a ref name, plus the backslash. */
const FORBIDDEN_CHARS = ["~", "^", ":", "?", "*", "[", "\\"];

/** Sequences Git forbids anywhere in a ref name. */
const FORBIDDEN_SEQUENCES = ["..", "@{", "//"];

/** Whitespace or an ASCII control character (DEL included). */
function hasSpaceOrControl(name: string): boolean {
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f) return true;
    if (/\s/u.test(ch)) return true;
  }
  return false;
}

/**
 * Whether `name` may be sent as a new worktree's branch.
 *
 * Refuses: empty, a leading `-` or `/`, any whitespace or control character, `..`, `@{`, `\`, `~`,
 * `^`, `:`, `?`, `*`, `[`, a trailing `/`, `.` or `.lock`, `//`, the lone `@`, and a path component
 * that starts with `.` or ends in `.lock` (M48: `git check-ref-format --branch` refuses all of
 * these). The caller trims first, so surrounding whitespace is not a refusal; whitespace INSIDE the
 * name is.
 */
export function isValidWorktreeBranch(name: string): boolean {
  if (name === "" || name === "@") return false;
  if (name.startsWith("-") || name.startsWith("/")) return false;
  if (hasSpaceOrControl(name)) return false;
  if (FORBIDDEN_CHARS.some((ch) => name.includes(ch))) return false;
  if (FORBIDDEN_SEQUENCES.some((seq) => name.includes(seq))) return false;
  if (name.endsWith("/") || name.endsWith(".") || name.endsWith(".lock")) return false;
  return name.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock"));
}
