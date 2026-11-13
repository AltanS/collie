import { isAbsolute, relative, sep } from "node:path";

import { asJsonNumber, asJsonObject, asJsonString } from "../web/src/lib/json.ts";
import type { JsonObject } from "../bridge/json.ts";
import { contextPercent, customClaudeConfigDir, WINDOW_BY_STATUSLINE, type UsageRecord } from "../bridge/usage.ts";
import type { CliContext } from "./context.ts";
import { agentConfigRoot } from "./hold-entry.ts";
import { mergeBeacon, readUsage, writeUsage, type BeaconChange, type UsageStoreDeps } from "./usage-store.ts";

// The context use of a Claude Code session, taken by the beacon hooks with no statusLine (.adr/0115,
// amended 2026-10-24). Two hooks feed it, and neither alone is enough.
//
//  - `SessionStart` says how BIG the context window is, and when the context is unknown or known at
//    once. Its input carries `source`, `model` (the session's model setting, with a `[1m]` suffix for
//    the 1M window) and, on resume and fork, `context_tokens`. The transcript never names the window:
//    its `message.model` is the API id and has no `[1m]`.
//  - `Stop` and `PostToolUse` carry `transcript_path`. The last assistant line in that file holds the
//    token counts of the agent's latest request, which is how the agent's own /context counts.
//
// NO WINDOW, NO CONTEXT. A percentage needs a window, and a window guessed as 200k would read a 1M or a
// 400k session far too full (a Fable session read 100% at 235k of 400k). So a window comes from one of
// three places, and from nowhere else: the size Claude Code's statusLine document states
// (`context_window.context_window_size`, exact, written by the wrapper), the `[1m]` suffix of the
// session's model, or the {@link MODEL_FAMILIES} table of the models Collie knows. A model the table
// does not know has no window, and no context dot. The transcript reading writes a context only to a
// record that already carries a `window` (written by `SessionStart` or the wrapper), and a session whose
// start named no model (`claude -p` sends none) has no context dot. Honest beats guessed.
//
// THE TRANSCRIPT'S MODEL CORRECTS THE WINDOW ON FILE. The newest assistant line names the API id of the
// model that answered (`claude-fable-5-2`, no `[1m]`), so a `/model` switch mid-session, which fires no
// `SessionStart`, shows in it. {@link windowForReading} decides, in this order: a window the statusLine
// stated stands (it moves with the session on its own); a model of the family the record's window came
// from keeps that window (the `[1m]` knowledge only the start has); another family takes its own table
// window, and that is also how a record an older build wrote with a guessed 200k is corrected; a model
// the table does not know has no window, so no context. KNOWN LIMIT, narrower than before: a switch to
// `opus[1m]` from `opus` stays unseen, since the transcript's id is the same.
//
// ── WHAT IT COSTS ─────────────────────────────────────────────────────────────────────────────────
//
// This runs on every `PostToolUse`, so it is bounded: two `realpath`s, one `lstat`, ONE read of at most
// {@link TAIL_BYTES} from the end of the file, and a JSON parse of the lines from the end back to the
// first one that decides, never the whole file. An unchanged whole percent writes nothing. When the
// tail was cut and holds no deciding line, the context on file is removed rather than kept stale.
//
// ── WHAT IT TRUSTS ────────────────────────────────────────────────────────────────────────────────
//
// The path is the hook payload's, so it is a hint to be checked, never followed: absolute, `.jsonl`,
// a regular file under the Claude config root once every link is resolved, so a link out of the root
// is refused. Anything else is no reading. The file holds numbers only, as the statusLine wrapper's
// does, and a reading that fails for any reason is a reading that is absent (the beacon's fail-open
// rule: a hint is never an error).

/** How much of the end of a transcript is read. A line longer than this and last in the file is no reading. */
export const TAIL_BYTES = 256 * 1024;

/** One family of models Collie knows the window of. */
export interface ModelFamily {
  /** What a record's `windowBy` says: the family, compared when the transcript names a model. */
  readonly key: string;
  /** The context window in tokens, without a `[1m]` suffix. */
  readonly window: number;
  /** Matches a lowercased model id or alias, after a provider prefix is stripped. */
  readonly match: RegExp;
}

/** The window the `[1m]` suffix of a model setting names, whatever the model. */
export const WINDOW_1M = 1_000_000;

/**
 * THE ONE PLACE TO GROW IT: a model with another window gets a row here, and a model that is in no row has
 * no window, never a guess. Rows are tried in order. Ids and aliases as Claude Code writes them: the
 * `SessionStart` input carries the model setting (`fable`, `opus[1m]`, `claude-opus-5-5`), and the
 * transcript the API id (`claude-fable-5-2`, `claude-haiku-4-5-20251001`).
 */
export const MODEL_FAMILIES: readonly ModelFamily[] = [
  { key: "fable", window: 400_000, match: /^(?:claude-)?fable(?:-.+)?$/u },
  { key: "mythos", window: 400_000, match: /^(?:claude-)?mythos(?:-.+)?$/u },
  { key: "opus", window: 200_000, match: /^(?:claude-)?opus(?:-.+)?$/u },
  { key: "sonnet", window: 200_000, match: /^(?:claude-)?sonnet(?:-.+)?$/u },
  { key: "haiku", window: 200_000, match: /^(?:claude-)?haiku(?:-.+)?$/u },
  { key: "claude-3", window: 200_000, match: /^claude-3-.+$/u },
];

/** `windowBy` of a `[1m]` start on a model no row names: the start stated the window, the table cannot say the family. */
const OTHER_1M = "other";

const WINDOW_1M_SUFFIX = "[1m]";

/** A provider's prefix on an id (`us.anthropic.`, `anthropic.`, `global.anthropic.`), which names no other model. */
const PROVIDER_PREFIX = /^(?:[a-z0-9-]+\.)*anthropic\./u;

/** The table row of a model id or alias, ignoring case, a provider prefix and the `[1m]` suffix, or undefined. */
export function modelFamily(model: string | undefined): ModelFamily | undefined {
  if (model === undefined) return undefined;
  const id = model.trim().toLowerCase().replace(WINDOW_1M_SUFFIX, "").replace(PROVIDER_PREFIX, "");
  return MODEL_FAMILIES.find((family) => family.match.test(id));
}

/** A window and who gave it, as a record keeps them. */
export interface ModelWindow {
  readonly window: number;
  readonly by: string;
}

/**
 * The context window a model setting names, or undefined when it names no model or one the table does
 * not know. The `[1m]` suffix is Claude Code's own mark of the 1M variants (`claude-opus-5-5[1m]`, seen
 * on 2.1.310) and holds for any model; every other model is the window of its row in
 * {@link MODEL_FAMILIES}.
 */
export function modelWindow(model: string | undefined): ModelWindow | undefined {
  if (model === undefined || model.trim() === "") return undefined;
  const family = modelFamily(model);
  if (model.includes(WINDOW_1M_SUFFIX)) return { window: WINDOW_1M, by: family?.key ?? OTHER_1M };
  return family === undefined ? undefined : { window: family.window, by: family.key };
}

/** {@link modelWindow}'s size alone. */
export function windowFromModel(model: string | undefined): number | undefined {
  return modelWindow(model)?.window;
}

/** What a transcript reading does with the window on file. */
export type WindowDecision =
  /** The window on file stands. */
  | { readonly kind: "keep"; readonly window: number }
  /** Another window, from the table: write it with its family. */
  | { readonly kind: "set"; readonly window: number; readonly by: string }
  /** No window for this model: no context. */
  | { readonly kind: "none" };

/**
 * The window a transcript reading counts against, from the record on file and the model the newest
 * assistant line names. Precedence: a statusLine size stands; a transcript that names no model keeps the
 * window; a model of the family the window came from keeps it (a `[1m]` start is known only to the
 * start); a record an older build wrote with a window of exactly 1M can only have had a `[1m]` start,
 * so it stands too; any other family takes its table window; a model the table does not know has none.
 * Call it only when the record carries a window.
 */
export function windowForReading(existing: UsageRecord, model: string | undefined): WindowDecision {
  const stored = existing.window;
  if (stored === undefined) return { kind: "none" };
  if (existing.windowBy === WINDOW_BY_STATUSLINE || model === undefined) return { kind: "keep", window: stored };
  const family = modelFamily(model);
  const declared1m = existing.windowBy === undefined ? stored === WINDOW_1M : existing.windowBy === OTHER_1M;
  if (family === undefined) return declared1m ? { kind: "keep", window: stored } : { kind: "none" };
  if (existing.windowBy === family.key || (existing.windowBy === undefined && stored === WINDOW_1M)) return { kind: "keep", window: stored };
  return { kind: "set", window: family.window, by: family.key };
}

/** Tokens billed for one request's input, as Claude Code's `/context` counts the live context. */
function tokensOf(value: JsonObject | undefined, key: string): number {
  const n = asJsonNumber(value?.[key]);
  return n !== undefined && Number.isFinite(n) && n > 0 ? n : 0;
}

/** What the end of a transcript says about the context. */
export type TailReading =
  /** The newest assistant line's input tokens, and the API id of the model that answered, when the line names one. */
  | { readonly kind: "used"; readonly tokens: number; readonly model: string | undefined }
  /** A compaction came after the newest assistant line: no response has measured the new context yet. */
  | { readonly kind: "compacted" };

/**
 * Whether a tail is a cut of a longer file: the read stopped at {@link TAIL_BYTES}. A cut that falls
 * inside a character decodes to a replacement character of three bytes, so the length never shrinks.
 */
export function tailIsCut(tail: string): boolean {
  return Buffer.byteLength(tail, "utf8") >= TAIL_BYTES;
}

/**
 * The context reading in the end of a transcript, walking from the last line back to the first one that
 * decides, or null when none does. Only the lines that can decide are parsed. In a `cut` tail the first
 * line is the end of a line torn by the cut and is never read, even when the piece would parse.
 */
export function readTail(tail: string, cut = false): TailReading | null {
  const lines = tail.split("\n");
  const first = cut ? 1 : 0;
  for (let i = lines.length - 1; i >= first; i--) {
    const line = lines[i]!;
    // A cheap test before the parse: a big tool result is a long line that is not worth parsing.
    const boundary = line.includes("compact_boundary");
    if (!boundary && (!line.includes('"usage"') || !line.includes("assistant"))) continue;
    let row: JsonObject | undefined;
    try {
      row = asJsonObject(JSON.parse(line));
    } catch {
      // A torn last line is not a line yet.
      continue;
    }
    if (row === undefined) continue;
    if (row.type === "system" && row.subtype === "compact_boundary") return { kind: "compacted" };
    if (row.type !== "assistant") continue;
    // A subagent's turns are not the session's context.
    if (row.isSidechain === true) continue;
    const message = asJsonObject(row.message);
    const usage = asJsonObject(message?.usage);
    if (usage === undefined) continue;
    // Claude Code writes its own notices (an API error) as assistant lines with a made-up model and no tokens.
    const model = asJsonString(message?.model);
    if (model === "<synthetic>") continue;
    const tokens = tokensOf(usage, "input_tokens") + tokensOf(usage, "cache_creation_input_tokens") + tokensOf(usage, "cache_read_input_tokens");
    return { kind: "used", tokens, model };
  }
  return null;
}

export interface ContextReadingDeps extends UsageStoreDeps {
  readonly ctx: CliContext;
}

/**
 * The transcript's resolved path, or null when it is not one this reading may open: it must be an
 * absolute path ending in `.jsonl`, and once every link is resolved a regular file under the config
 * root (also resolved). A link that leaves the root fails here, and so does a pipe or a folder.
 */
export function transcriptFile(deps: ContextReadingDeps, path: string): string | null {
  if (!isAbsolute(path) || !path.endsWith(".jsonl") || path.length >= 4096) return null;
  const root = deps.files.realpath(agentConfigRoot(deps.ctx.env, deps.ctx.home));
  const real = deps.files.realpath(path);
  if (root === null || real === null || !real.endsWith(".jsonl")) return null;
  const inside = relative(root, real);
  if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return null;
  return deps.files.entryType(real) === "file" ? real : null;
}

/** Merge a change into each state dir's record for the session. One dir failing costs only that dir. */
function writeChange(
  deps: ContextReadingDeps,
  stateDirs: readonly string[],
  session: string,
  harness: string,
  now: number,
  change: (existing: UsageRecord | null) => BeaconChange | null,
): void {
  for (const stateDir of stateDirs) {
    try {
      const existing = readUsage(deps, stateDir, session);
      const wanted = change(existing);
      if (wanted === null) continue;
      const record = mergeBeacon(existing, harness, now, wanted);
      if (record !== null) writeUsage(deps, stateDir, session, record);
    } catch {
      // No reading for this bridge. The tag draws the model alone.
    }
  }
}

/**
 * Take the session's context reading from its transcript (`Stop`, `PostToolUse`) and write it to every
 * state dir in `stateDirs`. NEVER THROWS: a path that is refused, a file with no deciding line, a full
 * disk, a state dir that is not ours all mean "no reading". `stateDirs` is a function so the registry
 * walk happens only once a transcript has been read.
 */
export function takeContextReading(
  deps: ContextReadingDeps,
  input: { readonly session: string; readonly transcriptPath: string | undefined; readonly harness: string },
  stateDirs: () => string[],
  now: number,
): void {
  try {
    if (input.transcriptPath === undefined) return;
    const file = transcriptFile(deps, input.transcriptPath);
    if (file === null) return;
    const tail = deps.files.tail(file, TAIL_BYTES);
    if (tail === null) return;
    const cut = tailIsCut(tail);
    const reading = readTail(tail, cut);
    // A whole file with no deciding line is a session before its first answer: what is on file stays
    // (a resume's `context_tokens`). A CUT tail with none means one huge line, a tool result, filled the
    // window after the last answer: the context has grown by that much, so the old value is stale.
    // Remove it; the next answer measures it again.
    const configDir = customClaudeConfigDir(deps.ctx.env, deps.ctx.home);
    writeChange(deps, stateDirs(), input.session, input.harness, now, (existing) => {
      const dirChanged = existing?.configDir !== configDir;
      if (reading === null && !cut) return dirChanged ? { configDir } : null;
      if (reading === null || reading.kind === "compacted") return { context: null, configDir };
      // No window, no context; a configDir change is still recorded so the session is scoped or cleared at once.
      if (existing?.window === undefined) return dirChanged ? { configDir } : null;
      const decision = windowForReading(existing, reading.model);
      // A model the table does not know: the window on file is not its window, so there is no context.
      if (decision.kind === "none") return { context: null, configDir };
      const context = contextPercent(reading.tokens, decision.window);
      return decision.kind === "keep" ? { context, configDir } : { context, window: decision.window, windowBy: decision.by, configDir };
    });
  } catch {
    // Same: no reading.
  }
}

/** How a session began, as `SessionStart`'s `source` says. */
const SESSION_SOURCES = ["startup", "resume", "clear", "compact", "fork"] as const;

/**
 * Take what `SessionStart` says: the window the model setting names, a context that is unknown after a
 * `compact` or a `clear`, and a context known at once on `resume` and `fork` when the input carries
 * `context_tokens`. NEVER THROWS.
 */
export function takeSessionStart(
  deps: ContextReadingDeps,
  input: { readonly session: string; readonly harness: string; readonly source: string | undefined; readonly model: string | undefined; readonly contextTokens: number | undefined },
  stateDirs: () => string[],
  now: number,
): void {
  try {
    const source = SESSION_SOURCES.find((name) => name === input.source);
    if (source === undefined) return;
    const model = input.model !== undefined && input.model.length <= 256 ? input.model : undefined;
    const named = modelWindow(model);
    const tokens = input.contextTokens !== undefined && Number.isFinite(input.contextTokens) && input.contextTokens >= 0 ? input.contextTokens : undefined;
    const configDir = customClaudeConfigDir(deps.ctx.env, deps.ctx.home);
    writeChange(deps, stateDirs(), input.session, input.harness, now, (existing) => {
      const window = named?.window ?? existing?.window;
      // The context is unknown until the next assistant message measures it.
      const forgotten = source === "compact" || source === "clear";
      const resumed = (source === "resume" || source === "fork") && tokens !== undefined && window !== undefined;
      const context = forgotten ? null : resumed ? contextPercent(tokens, window) : undefined;
      const dirChanged = existing?.configDir !== configDir;
      const change: BeaconChange = { context, window: named?.window, windowBy: named?.by, configDir };
      return named === undefined && context === undefined && !dirChanged ? null : change;
    });
  } catch {
    // No reading.
  }
}
