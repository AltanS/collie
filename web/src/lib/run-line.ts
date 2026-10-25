// Which code blocks in an agent's reply can be run as they are. A run types one line into a fresh
// shell (ADR 0095), and the bridge refuses a line over its 200-character limit or with a control
// character in it, so only a block that is a single command offers one.

/** The fence languages that name a shell. An untagged fence counts too: agents leave most of them bare. */
const SHELL_LANGS: ReadonlySet<string> = new Set(["", "bash", "sh", "shell", "zsh", "fish", "console", "terminal"]);

/** The bridge's own limit on a run's line (`MAX_COMMAND_CHARS`, bridge/launcher-recipes.ts). */
export const MAX_RUN_CHARS = 200;

/**
 * The line a fenced block would run, or `null` when it is not one command: another language, more
 * than one line, or over the limit. A `$ ` prompt in front is the prompt, not the command.
 */
export function runnableLine(lang: string, text: string): string | null {
  if (!SHELL_LANGS.has(lang.trim().toLowerCase())) return null;
  const trimmed = text.trim();
  if (trimmed === "" || trimmed.includes("\n")) return null;
  const line = trimmed.replace(/^\$(\s+|$)/u, "");
  if (line === "" || [...line].length > MAX_RUN_CHARS) return null;
  return line;
}
