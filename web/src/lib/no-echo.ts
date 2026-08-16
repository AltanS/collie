// The one screen where the reply guard's evidence can never arrive.
//
// Everything the free-text reply path does is built on reading back what it typed: type unsubmitted →
// poll fresh reads until the adapter sees the text on the input line → only then send the submit key
// (lib/reply-action.ts). A password prompt breaks that by construction rather than by failing — `sudo`,
// an SSH passphrase and `gpg` all turn echo OFF, so the characters are in the pane and the screen
// deliberately shows nothing. The guard is right to withhold the submit key (it has no evidence), and
// it will be right forever, so no amount of retrying or waiting gets the operator through.
//
// The remedy already exists and is one control away: "Type" sends keystrokes straight to the pane with
// no verification at all, because typing into an unrecognised screen is its entire purpose
// (hooks/use-direct-typing.ts). Issue #103 is that nothing on screen connected the two — the refusal
// said "a menu or dialog is probably up", which is a true statement about a different situation, and
// the reporter spent three days walking to a laptop to answer a `sudo`.
//
// So this module exists to RECOGNISE the case, not to handle it. It never decides anything: the
// refusal is already made by `composerReady`, and all a match does is let the UI name what it is
// looking at and offer the control that works. That makes the cost of a false negative exactly zero —
// the operator gets today's generic refusal and today's `force` override — and the cost of a false
// positive one dismissable notice. Both are cheap enough that the patterns below stay conservative and
// literal rather than clever.
//
// It is deliberately HARNESS-NEUTRAL and lives outside harness/: a password prompt is not a property of
// the agent occupying the pane, it is the operating system's own `readpass` painted over whatever was
// there. The same three lines appear under Claude, under codex, and under a bare shell.

import { isBlank, lineText, type StyledLine } from "./blocks";

/**
 * Prompts that read a secret with echo disabled. Anchored at the END of the line, because that is the
 * one position a prompt can be in: the cursor sits right after it, waiting. Anchoring loosely would
 * match a `sudo` command the operator is composing, or a log line about a password, neither of which is
 * a prompt.
 *
 * Each pattern is the literal text a real tool prints:
 *   sudo(8)          `[sudo] password for altan:`  and the plain `Password:` of the non-Linux prompt
 *   ssh(1)           `altan@host's password:`
 *   ssh-add / gpg    `Enter passphrase for /home/altan/.ssh/id_ed25519:`, `Enter passphrase:`
 *   sudo -k / retry  `Password (again):`, `Verify password:`
 * A trailing space is optional and a trailing `:` is not — some tools print `Password?` or nothing at
 * all — but requiring the colon is what keeps this from claiming ordinary prose, and a tool that omits
 * it simply falls through to the generic refusal, which is the pre-#103 behaviour.
 *
 * English only, and that door is deliberately left OPEN rather than argued shut: a `sudo` under
 * `LANG=de_DE` prints `[sudo] Passwort für altan:` and gets today's generic refusal, which is the
 * pre-#103 behaviour and costs nothing. Unlike everything else in this header, adding locales is
 * simply unwritten work, not a decision.
 */
const NO_ECHO_PROMPTS: readonly RegExp[] = [
  /(^|\s)\[sudo\]\s+password\s+for\s+\S+\s*:\s*$/i,
  /(^|\s)password(\s*\([^)]*\))?\s*:\s*$/i,
  /(^|\s)passphrase[^:]*:\s*$/i,
  /(^|\s)enter\s+(the\s+)?(password|passphrase)[^:]*:\s*$/i,
];

/** How far back from the tail to look. A password prompt is the LAST thing on screen — it is what the
 *  terminal is blocked on — but a tool may print a hint under it (`Sorry, try again.` sits above, not
 *  below; ssh prints nothing). Two lines of slack absorbs a trailing blank or a lone cursor row without
 *  letting a prompt scrolled well up the screen, which is no longer the live one, count. */
const TAIL_LINES = 2;

/**
 * The no-echo prompt the pane is sitting at, verbatim, or `null`.
 *
 * The returned string is shown to the operator ("This looks like `[sudo] password for altan:`"), which
 * is the point of returning the text rather than a boolean: the claim is checkable against the mirror
 * they are already looking at, so a false positive is self-evidently one.
 */
export function detectNoEchoPrompt(lines: StyledLine[]): string | null {
  const texts = lines.map(lineText);
  let end = texts.length;
  while (end > 0 && isBlank(texts[end - 1]!)) end--;
  for (let i = end - 1; i >= 0 && i >= end - TAIL_LINES; i--) {
    const text = texts[i]!.trimEnd();
    if (NO_ECHO_PROMPTS.some((re) => re.test(text))) return text.trim();
  }
  return null;
}
