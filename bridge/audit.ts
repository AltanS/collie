import { appendFile, rename, stat } from "node:fs/promises";

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
  /** The outermost component of the `(host, session, paneId)` address triple (PACK_PROTOCOL.md §4):
   *  the pack member the action targeted. Absent (not null) when the action targeted this collie
   *  itself, exactly as `session` is absent on pre-multi-session lines (PACK_PROTOCOL.md §11). */
  host?: string;
  /** Target pane, when the action is pane-scoped. */
  paneId?: string;
  /** The herdr session the action targeted (registry name); absent on pre-multi-session lines. */
  session?: string;
  /** Attributed device (from the per-device auth header), or null/absent when the feature is off. */
  device?: string | null;
  /**
   * How the action arrived. Absent ⇒ the phone talked to THIS collie directly (every pre-pack line,
   * and every line on a solo instance). `"pack"` ⇒ it arrived over a pack link, i.e. a lead forwarded
   * it (PACK_PROTOCOL.md §12) — written on the PEER, whose terminals actually moved.
   */
  via?: "pack";
  /**
   * Who forwarded it: the originating pack member id, as proven by the link's two factors (§8.1).
   * Peer-side counterpart of {@link AuditEntry.host}, which is what the LEAD writes on the same event
   * — the two logs are independent records, so neither machine needs the other's disk (§12).
   */
  from?: string;
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
 * (ts, action, host?, paneId?, session?, device?, via?, from?, detail) — `host` sits right after
 * `action` since it is the outermost component of the `(host, session, paneId)` triple
 * (PACK_PROTOCOL.md §4), and `via`/`from` sit next to `device` because all three answer "who did
 * this" — so lines are grep/diff-friendly; optional attribution is omitted (not null) when absent,
 * keeping a zero-peer line byte-identical to today's (PACK_PROTOCOL.md §11). Pure — `now` (epoch ms)
 * is injected so tests are deterministic.
 */
export function formatAuditLine(
  entry: AuditEntry,
  now: number,
  content: AuditContent = "preview",
): string {
  const line: Record<string, unknown> = { ts: new Date(now).toISOString(), action: entry.action };
  if (entry.host !== undefined) line.host = entry.host;
  if (entry.paneId !== undefined) line.paneId = entry.paneId;
  if (entry.session !== undefined) line.session = entry.session;
  if (entry.device != null) line.device = entry.device;
  if (entry.via !== undefined) line.via = entry.via;
  if (entry.from !== undefined) line.from = entry.from;
  line.detail = sanitize(entry.detail ?? {}, content);
  return JSON.stringify(line);
}

/**
 * Cap on the live `audit.log` before it rotates.
 *
 * The trail records lines that no factor has authenticated yet — a refused pack call is written
 * before the link's factors pass (`bridge/pack/router.ts`), which is the point: a refusal nobody can
 * see is not an audit trail. But it also means anyone who can reach the listener can make this file
 * grow, so its growth must be bounded here rather than by who is calling. Not an env var and not a
 * config key: a knob whose only wrong setting is "unbounded" is not a choice worth offering.
 */
export const AUDIT_MAX_BYTES = 5 * 1024 * 1024;

/** The filesystem operations the appender needs, injected so rotation is testable without a disk. */
export interface AuditFileIo {
  /** Size of the file in bytes, or 0 when it does not exist. */
  size(path: string): Promise<number>;
  /** Replace `to` with `from`. Rejects like `rename(2)`. */
  rotate(from: string, to: string): Promise<void>;
  /** Append to the file, creating it owner-only (0600) — it may echo reply text. */
  append(path: string, line: string): Promise<void>;
}

/** The real filesystem. A missing file is size 0, not an error — the first line creates it. */
export function fsAuditFileIo(): AuditFileIo {
  return {
    async size(path) {
      try {
        return (await stat(path)).size;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
        throw err;
      }
    },
    rotate: (from, to) => rename(from, to),
    append: (path, line) => appendFile(path, line, { mode: 0o600 }),
  };
}

/**
 * A real fs appender for `<stateDir>/audit.log`, size-capped at {@link AUDIT_MAX_BYTES} with exactly
 * one rotated generation: at the cap the live file becomes `audit.log.1`, replacing any previous one,
 * and the line lands in a fresh `audit.log`.
 *
 * Appends are chained for the same reason `push.ts` chains its writes: the size is tracked in memory
 * (seeded by one `stat`, incremented per write) rather than `stat`ed per line, and interleaved writes
 * would make that counter fiction. A rejected link never wedges the next one.
 *
 * ⛔ A failed rotation still appends. An oversized trail beats a missing line — the cap is a bound on
 * disk, not a reason to drop the record of an action that happened.
 */
export function fileAuditAppender(
  path: string,
  io: AuditFileIo = fsAuditFileIo(),
  maxBytes: number = AUDIT_MAX_BYTES,
): AppendFn {
  // null ⇒ unknown (start of process, or a failed rotation left the size in doubt): re-`stat`.
  let bytes: number | null = null;
  let chain: Promise<void> = Promise.resolve();

  const write = async (line: string): Promise<void> => {
    if (bytes === null) {
      try {
        bytes = await io.size(path);
      } catch {
        bytes = 0; // Can't measure it — write the line rather than lose it.
      }
    }
    if (bytes >= maxBytes) {
      try {
        await io.rotate(path, `${path}.1`);
        bytes = 0;
      } catch (err) {
        bytes = null;
        console.warn(`[audit] could not rotate ${path}: ${(err as Error).message}`);
      }
    }
    await io.append(path, line);
    if (bytes !== null) bytes += Buffer.byteLength(line, "utf8");
  };

  return (line) => {
    const next = chain.then(
      () => write(line),
      () => write(line),
    );
    // The caller sees this line's own failure; the chain forgets it so the next line still runs.
    chain = next.catch(() => {});
    return next;
  };
}

/**
 * The write side of the audit trail. `record()` is fire-and-forget: it formats the line and hands it
 * to the injected append, swallowing any failure (format or write) so a full disk or a bad entry can
 * never break the user action it was auditing.
 */
export class AuditLog {
  private readonly now: () => number;
  private readonly content: AuditContent;
  private readonly defaults: Readonly<Partial<AuditEntry>>;

  // Everything past `append` arrives in an options object, not a positional slot: the same slot is
  // claimed by different arguments on different branches, and a silently-transposed `now`/`content`
  // is a redaction quietly turning itself off.
  constructor(
    private readonly append: AppendFn,
    opts: {
      now?: () => number;
      content?: AuditContent;
      /**
       * Fields stamped on every entry this instance records. Empty for the process-wide log, which
       * is why a solo line is byte-identical to a pre-pack one — see {@link AuditLog.scoped}.
       */
      defaults?: Readonly<Partial<AuditEntry>>;
    } = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.content = opts.content ?? "preview";
    this.defaults = opts.defaults ?? {};
  }

  /**
   * A view of this log that stamps `defaults` onto every entry.
   *
   * Exists for exactly one caller: the peer's pack dispatch, which hands the *unmodified* handler
   * closures an audit log that already knows the action arrived over a pack link (§12). The handlers
   * therefore need no `via` parameter and cannot forget to pass one — a route reachable from both a
   * browser and a lead audits correctly in both directions with one code path.
   */
  scoped(defaults: Readonly<Partial<AuditEntry>>): AuditLog {
    return new AuditLog(this.append, {
      now: this.now,
      content: this.content,
      defaults: { ...this.defaults, ...defaults },
    });
  }

  record(entry: AuditEntry): void {
    let line: string;
    try {
      line = formatAuditLine({ ...this.defaults, ...entry }, this.now(), this.content);
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
