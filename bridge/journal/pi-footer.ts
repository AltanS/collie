/**
 * Which pi log a pane runs, read off the pane's own footer (#508).
 *
 * Two pi panes in one folder cannot be told apart by the folder, and pi leaves nothing else that
 * names the log: it keeps no file open, and a stock pi sets no terminal label. What each pane DOES
 * show is pi's footer, whose first row is the session's token totals:
 *
 *     ↑26k ↓827 R171k 10.3%/272k (auto)
 *     ↑34k ↓661k R114M W6.7M CH99.7% $12.345 4.2%/1.0M (auto)
 *
 * pi 1.5.2 draws that row from the sum of every usage entry of the session (`footer.js`, the
 * `usageTotals` loop over `getEntries()`), and the same numbers are in the log file. So a pane's log
 * is the one whose totals, written the way pi writes them, are the footer's row. Checked on 2026-11-17
 * against 6 live pi panes in 3 shared folders: every footer equalled exactly one log, character for
 * character.
 *
 * The rule is deliberately strict, because a wrong log shows another conversation to the person:
 *  - the row must parse in full, ending in the context part (`10.3%/272k` or `?/272k`), so a cut-off
 *    row on a narrow pane names nothing;
 *  - at least two of the four token fields must be shown, so a pane that has barely begun names
 *    nothing (pi omits a field that is zero);
 *  - EVERY field shown, and the cache-hit rate, must equal the log's, and exactly ONE log of the
 *    folder may match. Two matches, or none, is "no session", which is what the folder gave before.
 *
 * The row is pi's own format (`formatTokens`), which can change between pi versions. A change makes
 * the row stop matching, which falls back to "no session"; it never makes a wrong match more likely.
 * Oh My Pi draws another footer, which does not parse here.
 */
import type { JsonValue } from "../json.ts";
import { asRecord, tokenCount } from "./cache-probe.ts";

// TEST:bridge/journal/pi-footer.test.ts[formatPiTokens, parsePiFooter, PiFooterTotals, pickByFooter]

/** The token fields of pi's footer row, in the order pi draws them, with the sign that opens each. */
const FIELD_SIGNS = ["↑", "↓", "R", "W"] as const;

/** One token count as pi draws it: `827`, `1.5k`, `171k`, `6.7M`, `114M`. */
const COUNT = "\\d+(?:\\.\\d)?[kM]?";

/** The cache-hit rate pi draws after the counts: `CH99.7%`. */
const HIT_RE = /^CH\d+\.\d%$/u;

/** A cost pi may draw, then optionally `(sub)`: `$12.345`. It is skipped, never compared. */
const COST_RE = /^\$\d+\.\d{3}$/u;

/** The context part that always ends the stats: `10.3%/272k` or, when unknown, `?/272k`. */
const CONTEXT_RE = new RegExp(`^(?:\\d+(?:\\.\\d)?%|\\?)/${COUNT}$`, "u");

/** The footer fewer fields than this cannot tell two sessions apart (see the header). */
const MIN_FIELDS = 2;

/** What a pane's footer shows: the token fields and the cache-hit rate, as drawn, in drawing order. */
export interface PiFooter {
  readonly fields: readonly string[];
}

/**
 * A token count the way pi's `formatTokens` draws it (`footer.js`): the number below 1000, one decimal
 * of thousands below 10k, whole thousands below 1M, one decimal of millions below 10M, else whole millions.
 *
 * @param count A token count.
 * @returns The compact text pi shows for it.
 */
export function formatPiTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

/**
 * The footer a pane shows, or null when no line of `screen` is one. The BOTTOMMOST row that parses
 * wins, because the footer sits under the conversation and anything above it is the agent's output.
 * A row parses only when it begins the line and ends its stats in the context part.
 *
 * @param screen The pane's visible text, without colour codes.
 * @returns The shown token fields, or null when the screen has no complete footer row with enough fields.
 */
export function parsePiFooter(screen: string): PiFooter | null {
  const lines = screen.split(/\r?\n/u);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const footer = footerOf(lines[i] ?? "");
    if (footer !== null) return footer;
  }
  return null;
}

/** One line read as a footer row, or null. The tokens are cut on blanks, so the model name on the right does not matter. */
function footerOf(line: string): PiFooter | null {
  const tokens = line.trim().split(/\s+/u);
  const fields: string[] = [];
  let at = 0;
  for (const sign of FIELD_SIGNS) {
    const token = tokens[at] ?? "";
    if (token.startsWith(sign) && new RegExp(`^${sign}${COUNT}$`, "u").test(token)) {
      fields.push(token);
      at += 1;
    }
  }
  if (fields.length < MIN_FIELDS) return null;
  const hit = tokens[at] ?? "";
  if (HIT_RE.test(hit)) {
    fields.push(hit);
    at += 1;
  }
  if (COST_RE.test(tokens[at] ?? "")) {
    at += 1;
    if (tokens[at] === "(sub)") at += 1;
  }
  return CONTEXT_RE.test(tokens[at] ?? "") ? { fields } : null;
}

/** A session's token totals, the way pi's footer adds them up. */
export interface PiTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** The newest assistant turn's cache-read share of its prompt, in percent, or undefined when it had no prompt. */
  latestHit: number | undefined;
}

/** Totals of nothing. */
export function emptyPiTotals(): PiTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, latestHit: undefined };
}

/** Add one usage object to the totals; a field that is not a number counts as zero. */
function addUsage(totals: PiTotals, usage: JsonValue | undefined): void {
  const u = asRecord(usage);
  if (u === null) return;
  totals.input += tokenCount(u.input) ?? 0;
  totals.output += tokenCount(u.output) ?? 0;
  totals.cacheRead += tokenCount(u.cacheRead) ?? 0;
  totals.cacheWrite += tokenCount(u.cacheWrite) ?? 0;
}

/**
 * Fold one log row into the totals, the way pi's footer reads its entries: a `usage` row, an
 * assistant message, a tool result that carries usage, and a branch summary or compaction that carries
 * usage. The assistant message also sets the newest cache-hit rate (zero prompt: none).
 *
 * @param totals The totals so far, changed in place.
 * @param raw One parsed log row.
 */
export function addPiRow(totals: PiTotals, raw: JsonValue): void {
  const entry = asRecord(raw);
  if (entry === null) return;
  if (entry.type === "usage") {
    addUsage(totals, entry.usage);
    return;
  }
  if (entry.type === "message") {
    const message = asRecord(entry.message);
    if (message === null) return;
    if (message.role === "assistant") {
      addUsage(totals, message.usage);
      const usage = asRecord(message.usage);
      const read = tokenCount(usage?.cacheRead) ?? 0;
      const prompt = (tokenCount(usage?.input) ?? 0) + read + (tokenCount(usage?.cacheWrite) ?? 0);
      totals.latestHit = prompt > 0 ? (read / prompt) * 100 : undefined;
    } else if (message.role === "toolResult") {
      addUsage(totals, message.usage);
    }
    return;
  }
  if (entry.type === "branch_summary" || entry.type === "compaction") addUsage(totals, entry.usage);
}

/**
 * The fields pi would draw for these totals: a zero count is left out, and the cache-hit rate is
 * drawn only when something was read or written to the cache and the newest turn had a prompt.
 *
 * @param totals A session's totals.
 * @returns The footer fields in drawing order.
 */
export function piFooterFields(totals: PiTotals): string[] {
  const fields: string[] = [];
  if (totals.input !== 0) fields.push(`↑${formatPiTokens(totals.input)}`);
  if (totals.output !== 0) fields.push(`↓${formatPiTokens(totals.output)}`);
  if (totals.cacheRead !== 0) fields.push(`R${formatPiTokens(totals.cacheRead)}`);
  if (totals.cacheWrite !== 0) fields.push(`W${formatPiTokens(totals.cacheWrite)}`);
  if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && totals.latestHit !== undefined) {
    fields.push(`CH${totals.latestHit.toFixed(1)}%`);
  }
  return fields;
}

// ── Totals over a whole log ──────────────────────────────────────────────────
//
// A session log runs to hundreds of megabytes, and the footer wants the sum of all of it. So the sum is
// taken once over the whole file, then only over the bytes appended since, the way `FileSum` does for
// the cost: the memo keeps the byte offset (always just past a newline, so a half-written last row is
// read again once it is whole) and the running totals. A poll whose file did not grow reads 64 bytes.

/** How much of a log one read takes at once, so a first read of a huge log is chunked and never held whole. */
const CHUNK_BYTES = 4 * 1024 * 1024;

/** The head the memo was taken from: a file replaced under the same name no longer matches it. */
const HEAD_BYTES = 64;

/** How many logs are remembered before the oldest is dropped. */
const FILES_MAX = 64;

/** What is remembered of one log. */
interface Memo {
  /** Bytes consumed, always just past a newline (or 0). */
  offset: number;
  head: string;
  totals: PiTotals;
}

/** The token totals of pi logs, kept up to date by reading only what was appended. */
export class PiFooterTotals {
  private readonly held = new Map<string, Memo>();

  /**
   * The totals of one log, or undefined when it cannot be read. Never throws.
   *
   * @param path The log's real path, already checked to lie inside a sessions root.
   * @returns The session's totals as of the last whole row.
   */
  async read(path: string): Promise<PiTotals | undefined> {
    try {
      const file = Bun.file(path);
      // A missing file has size 0 and would read as an empty log; it is no log at all.
      if (!(await file.exists())) {
        this.held.delete(path);
        return undefined;
      }
      const size = file.size;
      const head = new TextDecoder().decode(new Uint8Array(await file.slice(0, Math.min(HEAD_BYTES, size)).arrayBuffer()));
      let memo = this.held.get(path);
      // A file that shrank, or whose first bytes changed, is not the one the memo came from.
      if (memo !== undefined && (size < memo.offset || !head.startsWith(memo.head))) memo = undefined;
      const next: Memo =
        memo === undefined
          ? { offset: 0, head, totals: emptyPiTotals() }
          : { offset: memo.offset, head: head.length > memo.head.length ? head : memo.head, totals: { ...memo.totals } };
      let chunk = CHUNK_BYTES;
      while (next.offset < size) {
        const to = Math.min(size, next.offset + chunk);
        const bytes = new Uint8Array(await file.slice(next.offset, to).arrayBuffer());
        const end = bytes.lastIndexOf(0x0a);
        if (end === -1) {
          // No row boundary: either the row is still being written (read it again next time) or it is
          // longer than the chunk (widen the chunk).
          if (to >= size) break;
          chunk *= 2;
          continue;
        }
        for (const line of new TextDecoder().decode(bytes.subarray(0, end)).split("\n")) {
          // Every row that counts names `usage`, so a log of mostly text rows costs a scan and no parse.
          if (!line.includes('"usage"')) continue;
          let row: JsonValue;
          try {
            // SAFETY: JSON.parse output is a JsonValue; `addPiRow` guards every read.
            row = JSON.parse(line) as JsonValue;
          } catch {
            continue;
          }
          addPiRow(next.totals, row);
        }
        next.offset += end + 1;
        chunk = CHUNK_BYTES;
      }
      this.held.delete(path);
      this.held.set(path, next);
      if (this.held.size > FILES_MAX) {
        const oldest = this.held.keys().next();
        if (!oldest.done) this.held.delete(oldest.value);
      }
      return next.totals;
    } catch {
      return undefined;
    }
  }
}

/** A log that may be the pane's: its session id and its real path. */
export interface PiFooterLog {
  readonly id: string;
  readonly path: string;
}

/**
 * The one log whose totals are the footer's row, or null. Every log is read (the totals are kept, so
 * a repeat costs the appended bytes); two logs that both match is as good as none.
 *
 * @param footer What the pane's footer shows.
 * @param logs The logs filed for the pane's folder.
 * @param totals The reader that keeps each log's totals.
 * @returns The single matching log, or null when none or more than one matches.
 */
export async function pickByFooter(footer: PiFooter, logs: readonly PiFooterLog[], totals: PiFooterTotals): Promise<PiFooterLog | null> {
  const shown = footer.fields.join(" ");
  const matching: PiFooterLog[] = [];
  for (const log of logs) {
    const read = await totals.read(log.path);
    if (read !== undefined && piFooterFields(read).join(" ") === shown) matching.push(log);
  }
  return matching.length === 1 ? (matching[0] ?? null) : null;
}
