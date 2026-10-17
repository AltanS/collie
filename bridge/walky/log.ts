// The walky talky log (M62 README, "The log"). Two kinds of file under `<stateDir>/walky/`:
//
//   log.jsonl            one line per message (per target pane) or receipt, append only. Lines older
//                        than 7 days go, and at most 2,000 lines are kept: past that the file is
//                        rewritten with its newest 1,500 lines (oldest dropped on rotate).
//   inbox/<key>.json     the unacknowledged messages of one pane, at most 200, oldest dropped. The key
//                        is a hash of the session and the pane id: no value a client sent ever
//                        becomes a path.
//
// A message to `all` has one message line and one receipt per target pane, all under one id. The
// receipt is written before any key is typed (decision 7), and the same id to the same target
// returns the stored receipt and types nothing.
//
// The folder is 0700 and every file 0600: the log holds message bodies.

import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { asJsonNumber, asJsonObject, asJsonString, parseJsonObject } from "../../web/src/lib/json.ts";
import { readMessage, readReceipt } from "./parse.ts";
import type { WalkyEntry, WalkyMessage, WalkyReceipt } from "./types.ts";

export const LOG_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
export const LOG_MAX_LINES = 2000;
/** What a rotate for size keeps, so the file is not rewritten on every append past the cap. */
export const LOG_ROTATE_TO = 1500;
export const INBOX_MAX = 200;

/** Where a message went on this bridge: a session and a pane, or nowhere here (a crew hop, spec 03). */
export interface Placement {
  readonly session: string | null;
  readonly paneId: string | null;
}

interface MessageLine extends Placement {
  readonly t: "message";
  readonly at: number;
  readonly target: string;
  readonly message: WalkyMessage;
}

interface ReceiptLine {
  readonly t: "receipt";
  readonly at: number;
  readonly receipt: WalkyReceipt;
}

type LogLine = MessageLine | ReceiptLine;

/** One message to one target, with its newest receipt. */
export interface LogRecord extends Placement {
  readonly target: string;
  readonly message: WalkyMessage;
  readonly receipt: WalkyReceipt;
}

function keyOf(id: string, target: string): string {
  return `${id}\u0000${target}`;
}

/** The file stem of a pane's inbox: a hash, never the pane id itself. */
export function inboxKey(session: string, paneId: string): string {
  return createHash("sha256").update(session).update("\u0000").update(paneId).digest("hex").slice(0, 32);
}

function readLine(raw: string): LogLine | null {
  const row = parseJsonObject(raw);
  if (row === undefined) return null;
  const at = asJsonNumber(row.at);
  if (at === undefined) return null;
  if (row.t === "receipt") {
    const receipt = readReceipt(row.receipt);
    return receipt === null ? null : { t: "receipt", at, receipt };
  }
  if (row.t !== "message") return null;
  const message = readMessage(row.message);
  const target = asJsonString(row.target);
  const session = row.session === null ? null : asJsonString(row.session);
  const paneId = row.paneId === null ? null : asJsonString(row.paneId);
  if (message === null || target === undefined || session === undefined || paneId === undefined) return null;
  return { t: "message", at, target, session, paneId, message };
}

export class WalkyLog {
  private readonly dir: string;
  private readonly path: string;
  private readonly inboxDir: string;
  private made = false;
  private lines: LogLine[] = [];
  private readonly records = new Map<string, LogRecord>();

  constructor(
    dir: string,
    private readonly now: () => number = Date.now,
  ) {
    this.dir = dir;
    this.path = join(dir, "log.jsonl");
    this.inboxDir = join(dir, "inbox");
    this.load();
  }

  /** The folders, made on the first write: an instance that never takes a message writes nothing. */
  private ensureDirs(): void {
    if (this.made) return;
    mkdirSync(this.inboxDir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    chmodSync(this.inboxDir, 0o700);
    this.made = true;
  }

  private load(): void {
    const raw = existsSync(this.path) ? readFileSync(this.path, "utf8") : "";
    this.lines = raw.split("\n").flatMap((line) => {
      if (line.trim() === "") return [];
      const parsed = readLine(line);
      return parsed === null ? [] : [parsed];
    });
    this.rotate();
  }

  /** Drop what retention says, rewrite the file when anything went, and rebuild the index. */
  private rotate(): void {
    const floor = this.now() - LOG_KEEP_MS;
    const before = this.lines.length;
    let kept = this.lines.filter((line) => line.at >= floor);
    if (kept.length > LOG_MAX_LINES) kept = kept.slice(kept.length - LOG_ROTATE_TO);
    this.lines = kept;
    if (kept.length !== before) {
      this.ensureDirs();
      const temp = `${this.path}.tmp`;
      writeFileSync(temp, kept.map((line) => `${JSON.stringify(line)}\n`).join(""), { mode: 0o600 });
      renameSync(temp, this.path);
    }
    this.records.clear();
    for (const line of this.lines) this.index(line);
  }

  private index(line: LogLine): void {
    if (line.t === "message") {
      const key = keyOf(line.message.id, line.target);
      // The first message line for a target wins; a receipt may already be waiting for it.
      if (this.records.has(key)) return;
      const accepted: WalkyReceipt = { id: line.message.id, target: line.target, state: "accepted", verified: "none", at: line.at, by: "-" };
      this.records.set(key, { session: line.session, paneId: line.paneId, target: line.target, message: line.message, receipt: accepted });
      return;
    }
    const key = keyOf(line.receipt.id, line.receipt.target);
    const record = this.records.get(key);
    if (record !== undefined) this.records.set(key, { ...record, receipt: line.receipt });
  }

  private append(line: LogLine): void {
    this.ensureDirs();
    appendFileSync(this.path, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    this.lines.push(line);
    this.index(line);
    const oldest = this.lines[0];
    if (this.lines.length > LOG_MAX_LINES || (oldest !== undefined && oldest.at < this.now() - LOG_KEEP_MS)) this.rotate();
  }

  /** The record of one message to one target, or null. */
  get(id: string, target: string): LogRecord | null {
    return this.records.get(keyOf(id, target)) ?? null;
  }

  /** Every target of one message, in the order they were logged. */
  all(id: string): LogRecord[] {
    return [...this.records.values()].filter((record) => record.message.id === id);
  }

  /** Every record whose newest receipt is still `accepted`. */
  pending(): LogRecord[] {
    return [...this.records.values()].filter((record) => record.receipt.state === "accepted");
  }

  /** Log a message to one target with its first receipt. The caller checked {@link get} first. */
  record(message: WalkyMessage, target: string, placement: Placement, receipt: WalkyReceipt): LogRecord {
    const at = this.now();
    this.append({ t: "message", at, target, session: placement.session, paneId: placement.paneId, message });
    this.append({ t: "receipt", at, receipt });
    return this.get(message.id, target) ?? { ...placement, target, message, receipt };
  }

  /** Write a newer receipt. A receipt for a message the log does not hold is still written. */
  update(receipt: WalkyReceipt): void {
    this.append({ t: "receipt", at: this.now(), receipt });
  }

  /** The messages that went to one pane, newest first. */
  forPane(session: string, paneId: string, limit: number): WalkyEntry[] {
    const out: WalkyEntry[] = [];
    for (const record of [...this.records.values()].toReversed()) {
      if (out.length >= limit) break;
      if (record.session === session && record.paneId === paneId) out.push({ ...record.message, receipt: record.receipt });
    }
    return out;
  }

  /** The newest messages on this bridge, any pane, newest first. */
  newest(limit: number): LogRecord[] {
    return [...this.records.values()].toReversed().slice(0, limit);
  }

  // ── The inbox ──────────────────────────────────────────────────────────────────────────────────

  private inboxPath(session: string, paneId: string): string {
    return join(this.inboxDir, `${inboxKey(session, paneId)}.json`);
  }

  /** The unacknowledged messages of one pane, oldest first. */
  inbox(session: string, paneId: string): WalkyMessage[] {
    const path = this.inboxPath(session, paneId);
    if (!existsSync(path)) return [];
    const row = parseJsonObject(readFileSync(path, "utf8"));
    if (row === undefined || row.session !== session || row.paneId !== paneId || !Array.isArray(row.messages)) return [];
    return row.messages.flatMap((entry) => {
      const message = readMessage(asJsonObject(entry));
      return message === null ? [] : [message];
    });
  }

  private writeInbox(session: string, paneId: string, messages: readonly WalkyMessage[]): void {
    const path = this.inboxPath(session, paneId);
    if (messages.length === 0) {
      if (existsSync(path)) unlinkSync(path);
      return;
    }
    this.ensureDirs();
    const temp = `${path}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ v: 1, session, paneId, messages })}\n`, { mode: 0o600 });
    renameSync(temp, path);
  }

  /** Put a message in a pane's inbox. Once only; past the cap the oldest goes. */
  inboxAdd(session: string, paneId: string, message: WalkyMessage): void {
    const messages = this.inbox(session, paneId).filter((held) => held.id !== message.id);
    messages.push(message);
    this.writeInbox(session, paneId, messages.slice(Math.max(0, messages.length - INBOX_MAX)));
  }

  /** Mark messages read for a pane: the named ids, or every one when `ids` is null. How many went. */
  ack(session: string, paneId: string, ids: readonly string[] | null): number {
    const messages = this.inbox(session, paneId);
    const kept = ids === null ? [] : messages.filter((message) => !ids.includes(message.id));
    this.writeInbox(session, paneId, kept);
    return messages.length - kept.length;
  }

  /** How many inbox files exist. For a test and for a status line. */
  inboxCount(): number {
    if (!existsSync(this.inboxDir)) return 0;
    return readdirSync(this.inboxDir).filter((name) => name.endsWith(".json")).length;
  }
}
