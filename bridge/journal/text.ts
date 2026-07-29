// Text handling every adapter shares: the caps that keep one pathological log from ballooning the
// bridge, and the escape-stripping that keeps a terminal's colour codes out of a view that renders
// text nodes rather than interpreting them.

/** Per-tool-result cap. Tool output is unbounded (a 2 MB file read); the phone only needs a gist. */
export const MAX_RESULT_CHARS = 2000;

/** Per-text-part cap. Generous — assistant prose is the thing you actually came to read. */
export const MAX_TEXT_CHARS = 20_000;

/** Longest one-line tool summary. Past this the line stops being a summary. */
const MAX_SUMMARY_CHARS = 200;

// CSI/SGR and two-character escapes. Journal text is NOT a terminal mirror — nothing downstream
// interprets escapes, so a `\x1b[2m` left in place renders as garbage glyphs on the phone.
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;

/** Strip terminal escapes from log text. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/** Cap a string, flagging the cut so the view can say so rather than silently lying. */
export function clamp(text: string, max: number): { text: string; truncated?: boolean } {
  if (text.length <= max) return { text };
  return { text: text.slice(0, max), truncated: true };
}

/** Collapse to a single capped line — what a tool-call summary is by definition. */
export function oneLine(value: string): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > MAX_SUMMARY_CHARS ? `${line.slice(0, MAX_SUMMARY_CHARS)}…` : line;
}

/**
 * Collapse a tool call's input object into one readable line.
 *
 * The well-known arguments get picked by name (the path, the command, the pattern); anything else
 * falls back to the first string-ish value, so a tool this code has never heard of still reads as
 * something rather than "{...}". Shared across harnesses because tool vocabularies overlap heavily —
 * every one of them has a `read`, a `shell`, and a `grep` under some spelling.
 */
export function summarizeToolInput(input: unknown): string {
  if (input === null || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = o[k];
      if (typeof v === "string" && v.trim() !== "") return v;
      // Codex spells a shell call's `command` as an ARGV ARRAY (["bash","-lc","ls -la"]), and pi
      // passes arrays for multi-file tools — join rather than skip, or the defining argument of the
      // most common call in any log goes missing.
      if (Array.isArray(v)) {
        const joined = v.filter((x): x is string => typeof x === "string").join(" ").trim();
        if (joined !== "") return joined;
      }
    }
    return undefined;
  };
  // Order matters, and it is load-bearing: Grep carries both `pattern` and `path`, and the pattern is
  // what you actually searched for, so `pattern` MUST outrank the bare `path` (a test pins this). A
  // subagent call carries both `description`/`task` and `prompt`, and the short one is already the
  // one-line form.
  const chosen =
    pick(
      "file_path",
      "command",
      "pattern",
      "query",
      "url",
      "path",
      "description",
      "task",
      "prompt",
    ) ??
    // Unknown tool: first string value wins, so the line is never empty for no reason.
    Object.values(o).find((v): v is string => typeof v === "string" && v.trim() !== "");
  return chosen === undefined ? "" : oneLine(chosen);
}
