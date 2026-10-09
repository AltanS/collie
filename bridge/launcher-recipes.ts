import { harnessLaunch } from "./harness-launch.ts";
import type { LaunchCheckResponse } from "./types.ts";

// ── Recipes: a harness plus option chips, and the bridge builds the line (M48 spec 02, ADR 0094) ──
//
// "Add your own" on the phone first offers a RECIPE: pick an agent, tick option chips, and the bridge,
// never the phone, turns that into a shell line. The phone sends ids (`claude`, `skip`), so a stolen
// token can only ever plant a line made of the words in this table. A free line is a separate path,
// off unless the operator switched it on (`[phone] free_text`, bridge/operator-launchers.ts).
//
// ── EVERY FLAG HERE WAS READ OFF THE CLI'S OWN `--help` ─────────────────────────────────────────
// On 2026-10-09, on the development host, through a login shell: Claude Code 2.1.295, Codex 0.162.0,
// opencode 1.18.35, pi 0.87.1, omp. A harness that was not installed there (grok, hermes, muse, agy)
// lists no option: a flag nobody saw is a flag that may not exist. When a CLI renames a flag, a row
// built from the old one stops matching its rebuild and drops out at read time
// (bridge/launchers-added.ts), so a stale chip can never type a stale line.
//
// ── GROUPS ARE ONE-OF ───────────────────────────────────────────────────────────────────────────
// Options in one `group` exclude each other (two models, or plan mode beside skip-permissions). The
// bridge refuses a recipe that names two of a group, so the phone's radio behaviour is not the rule.
//
// ── "NO PROMPTS" ────────────────────────────────────────────────────────────────────────────────
// A chip that makes the agent act without asking first says so (`noPrompts`). The phone then shows a
// "No prompts" badge and asks once per device before the first start (ADR 0094). For a line the
// operator or a person wrote, {@link scanNoPrompts} looks for the known flags; an alias hides its
// flags, so the free-text form also has a tick.

/** One option chip. */
export interface RecipeOption {
  /** The id the phone sends. */
  id: string;
  /** The chip's words. English, the CLI's own vocabulary; never translated (it names a flag). */
  label: string;
  /** The words appended to the line, verbatim. */
  args: string;
  /** Options sharing a group exclude each other. */
  group?: string;
  /** True when this option makes the agent act without asking first. */
  noPrompts?: true;
}

const RECIPE_TABLE = {
  claude: [
    {
      id: "skip",
      label: "Skip permission prompts",
      args: "--dangerously-skip-permissions",
      group: "permissions",
      noPrompts: true,
    },
    { id: "plan", label: "Plan mode", args: "--permission-mode plan", group: "permissions" },
    { id: "opus", label: "Model: opus", args: "--model opus", group: "model" },
    { id: "sonnet", label: "Model: sonnet", args: "--model sonnet", group: "model" },
    { id: "continue", label: "Continue last", args: "--continue" },
  ],
  codex: [
    {
      id: "bypass",
      label: "Skip approvals and sandbox",
      args: "--dangerously-bypass-approvals-and-sandbox",
      group: "mode",
      noPrompts: true,
    },
    { id: "never", label: "Never ask", args: "--ask-for-approval never", group: "mode", noPrompts: true },
    { id: "readonly", label: "Read-only sandbox", args: "--sandbox read-only", group: "mode" },
    { id: "search", label: "Web search", args: "--search" },
  ],
  opencode: [
    { id: "auto", label: "Auto-approve", args: "--auto", noPrompts: true },
    { id: "plan", label: "Plan agent", args: "--agent plan" },
    { id: "continue", label: "Continue last", args: "--continue" },
  ],
  pi: [
    { id: "continue", label: "Continue last", args: "--continue" },
    { id: "thinking-high", label: "Thinking: high", args: "--thinking high" },
  ],
  omp: [
    { id: "continue", label: "Continue last", args: "--continue" },
    { id: "thinking-high", label: "Thinking: high", args: "--thinking=high" },
  ],
} satisfies Record<string, readonly RecipeOption[]>;

/** The options each harness offers. A harness with no entry offers none: its recipe is its binary. */
export const RECIPE_OPTIONS: ReadonlyMap<string, readonly RecipeOption[]> = new Map(Object.entries(RECIPE_TABLE));

/** The options for `harness`, in table order. Empty for a harness with none. */
export function recipeOptions(harness: string): readonly RecipeOption[] {
  return RECIPE_OPTIONS.get(harness) ?? [];
}

/** A recipe the bridge built, or why it would not. */
export type BuiltRecipe =
  | { ok: true; command: string; label: string; noPrompts: boolean; options: string[] }
  | { ok: false; reason: "unknown_harness" | "unknown_option" | "conflict" };

/**
 * The line a recipe types: the harness binary, then each picked option's words in TABLE order, so one
 * set of picks is always one line (and so one allowlist entry), whatever order the phone sent them in.
 */
export function buildRecipe(harness: string, picked: readonly string[]): BuiltRecipe {
  const launch = harnessLaunch(harness);
  if (launch === undefined) return { ok: false, reason: "unknown_harness" };
  const table = recipeOptions(harness);
  const wanted = new Set(picked);
  if (wanted.size !== picked.length) return { ok: false, reason: "conflict" };
  for (const id of wanted) {
    if (!table.some((o) => o.id === id)) return { ok: false, reason: "unknown_option" };
  }
  const chosen = table.filter((o) => wanted.has(o.id));
  const groups = new Set<string>();
  for (const o of chosen) {
    if (o.group === undefined) continue;
    if (groups.has(o.group)) return { ok: false, reason: "conflict" };
    groups.add(o.group);
  }
  return {
    ok: true,
    command: [launch.binary, ...chosen.map((o) => o.args)].join(" "),
    label: chosen.length === 0 ? launch.label : `${launch.label}, ${chosen.map((o) => o.label).join(", ")}`,
    noPrompts: chosen.some((o) => o.noPrompts === true),
    options: chosen.map((o) => o.id),
  };
}

// ── The no-prompts scan ─────────────────────────────────────────────────────────────────────────

/** Flags that skip permission prompts wherever they sit in a line. Each verified first-hand. */
const NO_PROMPT_FLAGS: ReadonlySet<string> = new Set([
  // Claude Code
  "--dangerously-skip-permissions",
  "--permission-mode=bypassPermissions",
  // Codex
  "--dangerously-bypass-approvals-and-sandbox",
  "--yolo",
  "--ask-for-approval=never",
]);

/** Flags whose VALUE decides it, written as two words: `--permission-mode bypassPermissions`. */
const NO_PROMPT_PAIRS: readonly (readonly [string, string])[] = [
  ["--permission-mode", "bypassPermissions"],
  ["--ask-for-approval", "never"],
];

/**
 * Whether a shell line carries a flag known to skip permission prompts. A scan of whitespace words,
 * not a shell parse: an alias or a wrapper script hides its flags, which is why a person adding a
 * free line also ticks the box themselves. Over-reporting costs one confirm; under-reporting is the
 * case the tick exists for.
 */
export function scanNoPrompts(line: string): boolean {
  const words = line.trim().split(/\s+/).map(unquote);
  // The command word's last path part, on either separator, without a Windows launcher suffix.
  const first = (words[0]?.split(/[\\/]/).at(-1) ?? "").replace(/\.(?:exe|cmd|ps1)$/i, "");
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? "";
    if (NO_PROMPT_FLAGS.has(word)) return true;
    const next = words[i + 1];
    if (next !== undefined && NO_PROMPT_PAIRS.some(([flag, value]) => word === flag && next === value)) return true;
    // Short or generic spellings count only for the CLI that owns them.
    if (first === "codex" && word === "-a" && next === "never") return true;
    if (first === "opencode" && word === "--auto") return true;
  }
  return false;
}

/** A word with one layer of matching quotes taken off, so `'--yolo'` still reads as the flag. */
function unquote(word: string): string {
  if (word.length >= 2 && (word[0] === "'" || word[0] === '"') && word.at(-1) === word[0]) return word.slice(1, -1);
  return word;
}

// ── The character rule, shared by a free line, a label, and every row read back off disk ────────

/** The longest free line, in code points after NFC. */
export const MAX_COMMAND_CHARS = 200;
/** The longest label, in code points after NFC. */
export const MAX_LABEL_CHARS = 60;

/**
 * Whether one code point may never sit in a line typed into a terminal or in a label shown beside it:
 * ASCII and C1 control characters (a newline submits a second line nobody reviewed), the line and
 * paragraph separators, and the bidi controls that make a line read differently from what runs
 * (U+202A to U+202E, U+2066 to U+2069, and the LRM, RLM and ALM marks).
 */
export function isForbiddenCodePoint(code: number): boolean {
  if (code < 0x20 || code === 0x7f) return true;
  if (code >= 0x80 && code <= 0x9f) return true;
  if (code === 0x2028 || code === 0x2029) return true;
  if (code >= 0x202a && code <= 0x202e) return true;
  if (code >= 0x2066 && code <= 0x2069) return true;
  return code === 0x200e || code === 0x200f || code === 0x061c;
}

/** Why a piece of launcher text is refused. */
export type TextProblem = "empty" | "too_long" | "forbidden_character";

/**
 * Trim and NFC-normalise `raw`, then check it. Answers the clean text or the problem. The same
 * function runs when a row is added and when it is read back, so a file edited by hand meets the
 * same rule as the phone did.
 */
export function cleanLauncherText(raw: string, max: number): { ok: true; text: string } | { ok: false; problem: TextProblem } {
  // Checked BEFORE the trim as well: a trailing newline is exactly the character the rule is about,
  // and `trim()` would quietly take it away.
  for (const ch of raw) {
    if (isForbiddenCodePoint(ch.codePointAt(0) ?? 0)) return { ok: false, problem: "forbidden_character" };
  }
  const text = raw.normalize("NFC").trim();
  if (text === "") return { ok: false, problem: "empty" };
  if ([...text].length > max) return { ok: false, problem: "too_long" };
  for (const ch of text) {
    if (isForbiddenCodePoint(ch.codePointAt(0) ?? 0)) return { ok: false, problem: "forbidden_character" };
  }
  return { ok: true, text };
}

/**
 * The answer of `POST /api/launch/check` for one typed line (ADR 0095, amendment): the character rule
 * and {@link scanNoPrompts}, both on the cleaned line, exactly as a run would apply them. It decides
 * nothing about the operator's switch or a paired device, and it runs nothing: the page asks it so a
 * line that skips permission prompts can be confirmed BEFORE its first run, which the history's
 * `noPrompts` flag cannot do. No line at all is the same `empty` a blank one is.
 */
export function checkRunLine(raw: string | undefined): LaunchCheckResponse {
  const line = cleanLauncherText(raw ?? "", MAX_COMMAND_CHARS);
  if (!line.ok) return { ok: true, noPrompts: false, problem: line.problem };
  return { ok: true, noPrompts: scanNoPrompts(line.text) };
}
