import { isAbsolute, relative, sep } from "node:path";

import { asJsonNumber, asJsonObject, asJsonString } from "../web/src/lib/json.ts";
import type { JsonObject } from "../bridge/json.ts";
import { contextPercent } from "../bridge/usage.ts";
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
// NO WINDOW, NO CONTEXT. A percentage needs a window, and a window guessed as 200k would read a 1M
// session five times too full. So the transcript reading writes a context only to a record that
// already carries a `window` (written by `SessionStart`), and a session whose start named no model
// (`claude -p` sends none) has no context dot. Honest beats guessed.
//
// KNOWN LIMIT: `/model` mid-session fires no `SessionStart`, so the window stays the one from the last
// start, compact or clear.
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

/**
 * The context window, in tokens, a `SessionStart` model setting names, or undefined when it names no
 * model. THE ONE PLACE TO GROW IT: a model with another window gets a row here. Claude Code puts the
 * `[1m]` suffix on the 1M variants (`claude-opus-5-5[1m]`, seen on 2.1.310); every other model is the
 * 200k window.
 */
export function windowFromModel(model: string | undefined): number | undefined {
  if (model === undefined || model.trim() === "") return undefined;
  return model.includes("[1m]") ? 1_000_000 : 200_000;
}

/** Tokens billed for one request's input, as Claude Code's `/context` counts the live context. */
function tokensOf(value: JsonObject | undefined, key: string): number {
  const n = asJsonNumber(value?.[key]);
  return n !== undefined && Number.isFinite(n) && n > 0 ? n : 0;
}

/** What the end of a transcript says about the context. */
export type TailReading =
  /** The newest assistant line's input tokens. */
  | { readonly kind: "used"; readonly tokens: number }
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
    if (asJsonString(message?.model) === "<synthetic>") continue;
    const tokens = tokensOf(usage, "input_tokens") + tokensOf(usage, "cache_creation_input_tokens") + tokensOf(usage, "cache_read_input_tokens");
    return { kind: "used", tokens };
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
function writeChange(deps: ContextReadingDeps, stateDirs: readonly string[], session: string, harness: string, now: number, change: (window: number | undefined) => BeaconChange | null): void {
  for (const stateDir of stateDirs) {
    try {
      const existing = readUsage(deps, stateDir, session);
      const wanted = change(existing?.window);
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
    if (reading === null && !cut) return;
    writeChange(deps, stateDirs(), input.session, input.harness, now, (window) => {
      if (reading === null || reading.kind === "compacted") return { context: null };
      // No window, no context.
      return window === undefined ? null : { context: contextPercent(reading.tokens, window) };
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
    const named = windowFromModel(model);
    const tokens = input.contextTokens !== undefined && Number.isFinite(input.contextTokens) && input.contextTokens >= 0 ? input.contextTokens : undefined;
    writeChange(deps, stateDirs(), input.session, input.harness, now, (known) => {
      const window = named ?? known;
      // The context is unknown until the next assistant message measures it.
      const forgotten = source === "compact" || source === "clear";
      const resumed = (source === "resume" || source === "fork") && tokens !== undefined && window !== undefined;
      const context = forgotten ? null : resumed ? contextPercent(tokens, window) : undefined;
      const change: BeaconChange = { context, window: named };
      return named === undefined && context === undefined ? null : change;
    });
  } catch {
    // No reading.
  }
}
