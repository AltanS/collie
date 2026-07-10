import { appendFile } from "node:fs/promises";

// Append-only audit trail of write-level actions (a socket call can type into a real terminal, so
// who-did-what-when is worth recording). One JSONL line per action at `<stateDir>/audit.log`
// (created 0600 — it may echo reply text). The line format is a pure, tested function; the writer
// takes an injectable append so the disk side is decoupled from `bun test`. Crucially, an audit
// failure must NEVER fail the user's action — record() swallows and logs, never throws.

/** Cap on any single string value written into a line — a 2 000-char reply becomes a 120-char preview. */
const MAX_STR = 120;

/** One write-level action worth recording. `ts` is stamped by {@link formatAuditLine}, not here. */
export interface AuditEntry {
  /** The action performed, e.g. "reply" / "keys" / "upload" / "tab.create" / "pane.close". */
  action: string;
  /** Target pane, when the action is pane-scoped. */
  paneId?: string;
  /** The herdr session the action targeted (registry name); absent on pre-multi-session lines. */
  session?: string;
  /** Attributed device (from the per-device auth header), or null/absent when the feature is off. */
  device?: string | null;
  /** Truncated, newline-safe parameters — reply text, key names, filename+size, labels, etc. */
  detail?: Record<string, unknown>;
}

/** Delivers one formatted line (newline included) to its destination. Injectable for tests. */
export type AppendFn = (line: string) => void | Promise<void>;

/**
 * Collapse newlines and truncate long strings so every value is a single-line, bounded preview.
 * JSON.stringify already escapes a literal newline to `\n` (keeping the output single-line), but we
 * still fold embedded newlines to a space so a multi-line reply reads as one legible preview rather
 * than a wall of `\n`. Recurses into arrays/objects so `detail` can nest (e.g. a key-name array).
 */
function sanitize(value: unknown): unknown {
  if (typeof value === "string") {
    const oneLine = value.replace(/[\r\n]+/g, " ");
    return oneLine.length > MAX_STR ? `${oneLine.slice(0, MAX_STR)}…` : oneLine;
  }
  if (Array.isArray(value)) return value.map(sanitize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitize(v);
    return out;
  }
  return value;
}

/**
 * Render one entry to a single JSONL line (no trailing newline). Stable field order
 * (ts, action, paneId?, session?, device?, detail) so lines are grep/diff-friendly; optional
 * attribution is omitted (not null) when absent. Pure — `now` (epoch ms) is injected so tests are
 * deterministic.
 */
export function formatAuditLine(entry: AuditEntry, now: number): string {
  const line: Record<string, unknown> = { ts: new Date(now).toISOString(), action: entry.action };
  if (entry.paneId !== undefined) line.paneId = entry.paneId;
  if (entry.session !== undefined) line.session = entry.session;
  if (entry.device != null) line.device = entry.device;
  line.detail = sanitize(entry.detail ?? {});
  return JSON.stringify(line);
}

/** A real fs appender for `<stateDir>/audit.log`, owner-only (0600) on create. */
export function fileAuditAppender(path: string): AppendFn {
  return (line) => appendFile(path, line, { mode: 0o600 });
}

/**
 * The write side of the audit trail. `record()` is fire-and-forget: it formats the line and hands it
 * to the injected append, swallowing any failure (format or write) so a full disk or a bad entry can
 * never break the user action it was auditing.
 */
export class AuditLog {
  constructor(
    private readonly append: AppendFn,
    private readonly now: () => number = Date.now,
  ) {}

  record(entry: AuditEntry): void {
    let line: string;
    try {
      line = formatAuditLine(entry, this.now());
    } catch (err) {
      console.warn(`[audit] could not format ${entry.action}: ${(err as Error).message}`);
      return;
    }
    try {
      void Promise.resolve(this.append(`${line}\n`)).catch((err) => {
        console.warn(`[audit] write failed: ${(err as Error).message}`);
      });
    } catch (err) {
      // A synchronous throw from the append (shouldn't happen for the fs sink, but stay defensive).
      console.warn(`[audit] write failed: ${(err as Error).message}`);
    }
  }
}
