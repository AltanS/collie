import { appendFile } from "node:fs/promises";

// Append-only audit trail of write-level actions (a socket call can type into a real terminal, so
// who-did-what-when is worth recording). One JSONL line per action at `<stateDir>/audit.log`
// (created 0600 — it may echo reply text). The line format is a pure, tested function; the writer
// takes an injectable append so the disk side is decoupled from `bun test`. Crucially, an audit
// failure must NEVER fail the user's action — record() swallows and logs, never throws.

/** Cap on any single string value written into a line — a 2 000-char reply becomes a 120-char preview. */
const MAX_STR = 120;

/**
 * How much of a value's CONTENT the trail keeps.
 *
 * - `preview` (default, unchanged behaviour): a bounded, single-line preview.
 * - `none`: nothing. Every string inside `detail` becomes `⟨redacted⟩` unless its key names an
 *   action parameter ({@link METADATA_KEYS}).
 *
 * `none` exists for deployments where the audit trail is wanted but the message bodies are not:
 * under `tailscale serve` the operator's replies and, via the prompt binding, a slice of whatever
 * was on the terminal both land in this file. Booleans, numbers and the whole envelope
 * (ts, action, paneId, session, device) are untouched either way — the point is to keep answering
 * "who typed into what, when" without also keeping "what they said".
 */
export type AuditContent = "preview" | "none";

/**
 * The metadata allowlist for `none` mode, matched by key name at ANY depth inside `detail`.
 *
 * A string survives only if its key names an action PARAMETER — a key name, an id, an enum-ish
 * outcome, a server-generated filename. Anything screen- or operator-originated must not be listed:
 * `text` is what the operator typed and `promptBinding.expected` is a slice of the pane screen.
 *
 * ⛔ The direction of the default is the whole feature. A detail field added later under a new name
 * redacts until someone deliberately adds it here, so a content-bearing field can never leak into a
 * redacted trail by being forgotten. Members of an array inherit the array's own key ("keys" carries
 * "ctrl+c", not a body).
 */
const METADATA_KEYS: ReadonlySet<string> = new Set([
  "checked",
  "keys",
  "passed",
  "reason",
  "saved",
  "sent",
  "size",
  "submit",
  "submitted",
  "tabId",
  "textDelivered",
  "workspaceId",
]);

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
 *
 * `allowed` carries the enclosing key's verdict against {@link METADATA_KEYS}: an object re-decides
 * per key, an array hands its own verdict to every member. It is false at the root, so a `detail`
 * that is somehow a bare string redacts rather than passing through unnamed.
 *
 * ⛔ Function-valued properties are DROPPED, in both modes. Copying them through means
 * `JSON.stringify` later CALLS a copied own `toJSON`, which re-injects its return value into the
 * line — past the preview cap, and past every redaction decision made here.
 */
function sanitize(value: unknown, content: AuditContent = "preview", allowed = false): unknown {
  if (typeof value === "function") return null;
  if (typeof value === "string") {
    // ⛔ A constant, never `⟨n chars⟩`. An exact length is itself content — a 9-character redaction
    // next to a password prompt narrows the secret — and "was anything sent" is already answered by
    // the entry existing at all.
    if (content === "none" && !allowed) return "⟨redacted⟩";
    const oneLine = value.replace(/[\r\n]+/g, " ");
    return oneLine.length > MAX_STR ? `${oneLine.slice(0, MAX_STR)}…` : oneLine;
  }
  if (Array.isArray(value)) return value.map((v) => sanitize(v, content, allowed));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === "function") continue;
      out[k] = sanitize(v, content, METADATA_KEYS.has(k));
    }
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
export function formatAuditLine(
  entry: AuditEntry,
  now: number,
  content: AuditContent = "preview",
): string {
  const line: Record<string, unknown> = { ts: new Date(now).toISOString(), action: entry.action };
  if (entry.paneId !== undefined) line.paneId = entry.paneId;
  if (entry.session !== undefined) line.session = entry.session;
  if (entry.device != null) line.device = entry.device;
  line.detail = sanitize(entry.detail ?? {}, content);
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
  private readonly now: () => number;
  private readonly content: AuditContent;

  // Everything past `append` arrives in an options object, not a positional slot: the same slot is
  // claimed by different arguments on different branches, and a silently-transposed `now`/`content`
  // is a redaction quietly turning itself off.
  constructor(
    private readonly append: AppendFn,
    opts: { now?: () => number; content?: AuditContent } = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.content = opts.content ?? "preview";
  }

  record(entry: AuditEntry): void {
    let line: string;
    try {
      line = formatAuditLine(entry, this.now(), this.content);
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
