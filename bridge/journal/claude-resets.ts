// Claude Code actions that drop the prompt cache between turns, read off the session log.
//
// Ported from AltanS/herdr-cache-alert `src/harness/claude-resets.ts` (commit 17fb2af). The RULES, with
// their quotes and dates, live in `bridge/cache/rules/claude.ts`; this module only finds them on disk
// and reports them as `ResetEvent`s. Whether an event is pending or history is the engine's call
// (`bridge/cache/engine.ts`), never this module's.
//
// WHAT IS READ. Records Claude Code writes the moment the action happens, which is what lets the chip
// turn cold BEFORE the operator pays for the next turn:
//
//   `/model`, `/effort`   a `<local-command-stdout>` record, either a `user` message string or a
//                         `system` `local_command` content; one build bolds the model name with ANSI
//                         instead of backticks
//   compaction            a `system` record with `subtype: "compact_boundary"`
//   `/reload-plugins`     the `<command-name>` record, with `<command-args>`
//
// ONLY A RECORD THAT IS THE ENVELOPE COUNTS. A string that merely CONTAINS "Set model to" (a quoted
// transcript, a background task's notification) is not the command, so the text must open with the
// tag. Sidechain records are a subagent's own conversation on its own cache, and are skipped.
//
// WHERE. Two stretches of the same 128 KB tail the probe already reads, and nothing past it: the
// stretch after the newest turn (it acts on the NEXT turn) and the stretch between the turn before it
// and the newest turn (it explains why the newest turn missed). A stretch the window does not reach is
// simply not seen; the observed cold mark still catches the miss one turn later.

import type { ResetEvent } from "../cache/claims.ts";
import type { JsonObject, JsonValue } from "../json.ts";
import { asRecord, asText } from "./cache-probe.ts";
import { stripAnsi } from "./text.ts";

/** The rule ids this module reports. Each is a shipped rule; `claude-resets.test.ts` holds them to it. */
export const CLAUDE_RESET_IDS = {
  model: "claude.reset.model",
  effort: "claude.reset.effort",
  compaction: "claude.reset.compaction",
  reloadForced: "claude.reset.reload-plugins-force",
  reload: "claude.reset.reload-plugins",
} as const;

/** The Claude Code build that stopped an effort change resetting Fable 5.1. */
const FABLE_EFFORT_KEEPS_CACHE_FROM: readonly number[] = [2, 1, 260];

/** The model Claude Code writes on a record it made up itself: a limit notice, an API error. */
const SYNTHETIC_MODEL = "<synthetic>";

const STDOUT = "<local-command-stdout>";

/**
 * A model name reduced to family and version, so a display name and an API id meet.
 *
 * `Opus 5 (1M context)` and `claude-opus-5` both become `opus5`; `Fable 5.1` and `claude-fable-5-1`
 * both become `fable51`. Anything that does not reduce to a known family is null, and a null NEVER
 * produces a reset: "Default (recommended)" or a renamed family is a sentence Collie cannot read, not a
 * switch.
 */
export function normaliseModel(name: string | undefined): string | null {
  if (name === undefined || name === "") return null;
  const reduced = name
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "")
    .replace(/[^a-z0-9]/g, "");
  return /^(opus|sonnet|haiku|fable|mythos)\d+$/.test(reduced) ? reduced : null;
}

/**
 * The model a `/model` stdout names, or null when it set none.
 *
 * Backticks on most builds. One build bolded the name with ANSI instead, which the caller has already
 * stripped, so the name then runs to " for this session only" or " and saved as".
 */
export function modelSetBy(text: string): string | null {
  const match =
    /^<local-command-stdout>Set model to (?:`([^`]+)`|(.+?)(?: for this session only| and saved as|<\/local-command-stdout>))/.exec(
      text,
    );
  return match?.[1] ?? match?.[2] ?? null;
}

/** `2.1.260` or later. Anything unparseable is "no", which keeps the effort reset: pessimistic. */
function fableEffortKeepsCache(version: string | undefined): boolean {
  const parts = (version ?? "").split(".").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n))) return false;
  for (let i = 0; i < 3; i++) {
    const have = parts[i] ?? 0;
    const need = FABLE_EFFORT_KEEPS_CACHE_FROM[i] ?? 0;
    if (have !== need) return have > need;
  }
  return true;
}

/**
 * A local command's text, if this record IS one: ANSI stripped, and opening with the envelope tag.
 *
 * Two carriers exist on disk: a `user` record whose `message.content` is the string, and a `system`
 * `local_command` record whose own `content` is. Anything else answers undefined.
 */
function commandText(record: JsonObject): string | undefined {
  let raw: JsonValue | undefined;
  if (record.type === "user") raw = asRecord(record.message)?.content;
  else if (record.type === "system" && record.subtype === "local_command") raw = record.content;
  if (typeof raw !== "string") return undefined;
  const text = stripAnsi(raw).trimStart();
  return text.startsWith(STDOUT) || text.startsWith("<command-name>") ? text : undefined;
}

/**
 * Reset events in one stretch of transcript, oldest first.
 *
 * `modelBefore` is the model of the turn that OPENS the stretch, which is what a `/model` must differ
 * from to count. Only the newest `/model` in the stretch counts: switching away and back again is no
 * switch.
 */
export function resetsBetween(
  records: readonly JsonObject[],
  modelBefore: string | undefined,
  path: string,
): ResetEvent[] {
  const events: ResetEvent[] = [];
  const before = normaliseModel(modelBefore);
  let newestModel: { name: string; at: number; stamp: string } | undefined;

  for (const record of records) {
    if (record.isSidechain === true) continue;
    const stamp = asText(record.timestamp);
    const at = Date.parse(stamp ?? "");
    if (stamp === undefined || Number.isNaN(at)) continue;
    const where = `${path} (${stamp})`;

    if (record.type === "system" && record.subtype === "compact_boundary") {
      events.push({ ruleId: CLAUDE_RESET_IDS.compaction, at, evidence: `compaction in ${where}` });
      continue;
    }

    const text = commandText(record);
    if (text === undefined) continue;

    if (text.startsWith("<command-name>/reload-plugins</command-name>")) {
      const args = /<command-args>([^<]*)<\/command-args>/.exec(text)?.[1] ?? "";
      const forced = /(^|\s)--force(\s|$)/.test(args);
      events.push({
        ruleId: forced ? CLAUDE_RESET_IDS.reloadForced : CLAUDE_RESET_IDS.reload,
        at,
        evidence: `/reload-plugins${forced ? " --force" : ""} in ${where}`,
      });
      continue;
    }

    const model = modelSetBy(text);
    if (model !== null) {
      newestModel = { name: model, at, stamp };
      continue;
    }

    if (text.startsWith(`${STDOUT}Set effort level to`)) {
      const keeps = before === "fable51" && fableEffortKeepsCache(asText(record.version));
      if (!keeps) events.push({ ruleId: CLAUDE_RESET_IDS.effort, at, evidence: `effort change in ${where}` });
    }
  }

  if (newestModel !== undefined) {
    const after = normaliseModel(newestModel.name);
    // Both sides must be readable. An unreadable name claims nothing: the observed cold mark still
    // catches a real miss one turn later.
    if (before !== null && after !== null && before !== after) {
      events.push({
        ruleId: CLAUDE_RESET_IDS.model,
        at: newestModel.at,
        evidence: `model ${modelBefore ?? "?"} → ${newestModel.name} in ${path} (${newestModel.stamp})`,
      });
    }
  }
  return events.toSorted((a, b) => a.at - b.at);
}

/** One assistant record that stands for a request Claude Code really sent. */
export interface ClaudeTurn {
  /** Its line index in the window. */
  index: number;
  entry: JsonObject;
  message: JsonObject;
  /** Epoch ms of its timestamp. */
  at: number;
  stamp: string;
}

/** The newest turn in a window, the turn before it where the window reaches it, and the parsed lines. */
export interface ClaudeTurns {
  newest: ClaudeTurn;
  previous?: ClaudeTurn;
  /**
   * Each line of the window, parsed, by index. Filled from the end down to the previous turn (or the
   * window's start); everything above that, and every line that is not a JSON object, is null.
   */
  records: ReadonlyArray<JsonObject | null>;
}

/** A line of the log as an object, or null. The file is the harness's, so a bad line is skipped. */
function parseLine(raw: string | undefined): JsonObject | null {
  const line = raw?.trim();
  if (line === undefined || line === "") return null;
  try {
    // SAFETY: `JSON.parse` output IS a JsonValue by construction — a string, number, boolean, null,
    // or an array/object of those. `asRecord` narrows it to an object or null before any field read.
    return asRecord(JSON.parse(line) as JsonValue);
  } catch {
    return null;
  }
}

/**
 * The record as a turn, or undefined.
 *
 * A sidechain record is a subagent's request on its own cache. A `<synthetic>` one is a notice Claude
 * Code wrote without sending anything (a usage limit, an API error, "No response requested"): its
 * model names nothing, and a `/model` right after a limit notice must still be compared with the model
 * the conversation was really on.
 */
function turnOf(entry: JsonObject, index: number): ClaudeTurn | undefined {
  if (entry.type !== "assistant" || entry.isSidechain === true) return undefined;
  const message = asRecord(entry.message);
  if (message === null || message.model === SYNTHETIC_MODEL) return undefined;
  const stamp = asText(entry.timestamp);
  const at = Date.parse(stamp ?? "");
  if (stamp === undefined || Number.isNaN(at)) return undefined;
  return { index, entry, message, at, stamp };
}

/**
 * Walk a window newest-first to its newest turn and the turn before it.
 *
 * One API response is written as several records sharing a message id, one per content block, so the
 * turn before is the first record further back whose id differs. Null when the window holds no turn at
 * all: a session that has only just started, or a stretch larger than the window.
 */
export function lastTwoTurns(lines: readonly string[]): ClaudeTurns | null {
  const records: (JsonObject | null)[] = Array.from({ length: lines.length }, () => null);
  let newest: ClaudeTurn | undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    const entry = parseLine(lines[i]);
    records[i] = entry;
    const turn = entry === null ? undefined : turnOf(entry, i);
    if (turn === undefined) continue;
    if (newest === undefined) {
      newest = turn;
      continue;
    }
    const id = asText(turn.message.id);
    if (id !== undefined && id === asText(newest.message.id)) continue;
    return { newest, previous: turn, records };
  }
  return newest === undefined ? null : { newest, records };
}

/** The parsed records in `[from, to)`, nulls dropped. */
function stretch(records: ReadonlyArray<JsonObject | null>, from: number, to: number): JsonObject[] {
  return records.slice(Math.max(0, from), to).filter((r): r is JsonObject => r !== null);
}

/**
 * Every reset event around the newest turn, oldest first: the stretch between the previous turn and
 * the newest (history, which explains a cold newest turn) and the stretch after it (pending).
 *
 * A model change between the two turns with no `/model` behind it (an automatic fallback, a skill that
 * names its own model) still shows on the turns themselves, and is reported at the newest turn's own
 * time, which the engine reads as history rather than as a warning.
 */
export function claudeResets(turns: ClaudeTurns, path: string): ResetEvent[] {
  const { newest, previous, records } = turns;
  const modelBefore = previous === undefined ? undefined : asText(previous.message.model);
  const modelNow = asText(newest.message.model);
  const before = resetsBetween(stretch(records, (previous?.index ?? -1) + 1, newest.index), modelBefore, path);
  const after = resetsBetween(stretch(records, newest.index + 1, records.length), modelNow, path);

  const was = normaliseModel(modelBefore);
  const now = normaliseModel(modelNow);
  const explained = before.some((event) => event.ruleId === CLAUDE_RESET_IDS.model);
  if (was !== null && now !== null && was !== now && !explained) {
    before.push({
      ruleId: CLAUDE_RESET_IDS.model,
      at: newest.at,
      evidence: `model ${modelBefore ?? "?"} → ${modelNow ?? "?"} in ${path} (${newest.stamp})`,
    });
  }
  return [...before, ...after].toSorted((a, b) => a.at - b.at);
}
