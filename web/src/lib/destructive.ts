// A socket call types straight into a real terminal, so an accidental send of a destructive command
// (a fat-fingered `rm -rf`, a stray force-push) is remote-shell dangerous. `isDestructiveInput`
// flags the small, reviewed set of patterns worth a second tap before send. It's deliberately
// conservative — a false positive costs one extra tap, but it must NOT fire on innocent look-alikes
// ("assume", "sudoku", "forced"), so every pattern is word-boundary anchored.

export interface DestructivePattern {
  /** Short human reason, surfaced on the "Really send?" confirm. */
  reason: string;
  pattern: RegExp;
}

// Ordered most-specific first; the first match wins, so its reason is the one shown. None use the
// `g` flag — `.test()` with `g` is stateful (lastIndex) and would flake across calls.
export const DESTRUCTIVE_PATTERNS: readonly DestructivePattern[] = [
  // `rm` with a recursive flag (-r, -R, -rf, -fr, -rfv, --recursive). Covers the plain `rm -rf` too.
  // The gap can't cross a command separator (; & |), so a later unrelated `-r` flag won't trip it.
  { reason: "rm -r (recursive delete)", pattern: /\brm\b[^\n;&|]*\s(?:-[a-z]*r[a-z]*|--recursive)\b/i },
  // A force-push can rewrite shared history.
  { reason: "git push --force", pattern: /\bgit\s+push\b[^\n;&|]*\s(?:--force|-f)\b/i },
  { reason: "sudo (runs as root)", pattern: /\bsudo\b/i },
  { reason: "--force flag", pattern: /--force\b/i },
  { reason: "dd if= (raw disk write)", pattern: /\bdd\b[^\n]*\bif=/i },
  { reason: "mkfs (format a filesystem)", pattern: /\bmkfs\b/i },
  // Truncate/redirect onto an absolute system path (`:> /…`, `> /dev/sda`, `> /`).
  {
    reason: "redirect to a system path",
    pattern: /:>\s*\/|>\s*\/(?:\s|$|(?:dev|etc|boot|proc|sys|usr|bin|sbin|lib|var|root)\b)/i,
  },
];

/** Returns the reason for the first destructive pattern the text matches, or null if none do. */
export function isDestructiveInput(text: string): string | null {
  for (const { reason, pattern } of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(text)) return reason;
  }
  return null;
}
