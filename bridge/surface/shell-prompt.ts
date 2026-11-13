// A SHELL'S PROMPT, AS ONE RULE FOR EVERY READER (M100 spec 04 and spec 06).
//
// Two places ask whether a screen ends in a shell prompt with nothing typed after it: the Send Protocol's
// blind road (bridge/surface/protocol.ts), which reads a prompt under an agent's leftover frame as proof the
// agent is gone, and the launch (bridge/server.ts), which types a command line into a pane it found in the
// snapshot only when that pane's last row is a prompt. One regex, so they cannot drift.

/**
 * A shell's prompt with nothing typed after it, as the last thing on its row: `$`, `#` or `%` alone or
 * after a user, host or path (`user@host:~/work$`; never after a digit, so a footer's `37%` is none),
 * `❯`, `➜` or `λ` alone or after a space, or `>` after a path (`C:\work>`). A shell draws its prompt
 * from the row's first column, so a row that starts blank is none (an agent's own `❯` stands indented in
 * its box or list). The blind road reads it as proof that a sign above it is an agent's leftover (M100
 * spec 06, item 1, lead review of 9d61e5b41): an agent that exited leaves its last frame on screen, and
 * the shell draws its prompt under it.
 */
export const SHELL_PROMPT = /^(?=\S)(?:[$#%]|.*[\s\p{L}_~/\])][$#%]|(?:.*\s)?[❯➜λ]|.*\S>)$/u;

/** Whether the last non-blank row of a screen's text is a shell prompt (SHELL_PROMPT). A blank screen is none. */
export function endsInShellPrompt(screen: string): boolean {
  const last = screen.split("\n").findLast((row) => row.trim().length > 0);
  return last !== undefined && SHELL_PROMPT.test(last.trimEnd());
}
