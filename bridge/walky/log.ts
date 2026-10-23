// The walky talky log (M62 README, "The log"). Two kinds of file under `<stateDir>/walky/`:
//
//   log.jsonl            one line per message (per target pane) or receipt, append only. Lines older
//                        than 7 days go, and at most 2,000 lines are kept: past that the file is
//                        rewritten with its newest 1,500 lines (oldest dropped on rotate).
//   inbox/<key>.json     the unacknowledged messages of one pane instance, at most 200, oldest dropped.
//                        The key is a hash of the session, the pane id and the instance token
//                        (instances.ts): no value a client sent ever becomes a path, and a new pane
//                        that took an old pane id starts with an empty inbox. The file goes when the
//                        instance does (`inboxDrop`), and any file whose newest message is past the 7
//                        days goes on the log's rotate, an inbox from before instances included.
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
import { INSTANCE_TOKEN } from "./address.ts";
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
  /**
   * The pane's instance token (instances.ts). Null on a crew hop, and on a line written before
   * instances: such a record matches whatever instance holds the pane now.
   */
  readonly instance: string | null;
}

/** Whether a stored instance matches the pane's current one: a stored null matches any. */
export function sameInstance(stored: string | null, current: string): boolean {
  return stored === null || stored === current;
}

interface MessageLine extends Placement {
  readonly t: "message";
  readonly at: number;
  readonly target: string;
  readonly message: WalkyMessage;
  /** The pane this bridge took the message from, when its sender was one of its own panes. */
  readonly sender?: Placement;
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
  /**
   * The session and pane this bridge took the message from, when the sender was one of its own panes;
   * null for a message from a phone or from another machine. A reply goes back to exactly that pane.
   */
  readonly sender: Placement | null;
  /**
   * When this bridge logged the message for this target: the acceptance. A held send's one clock
   * counts from here (deliver.ts `HELD_LIMIT_MS`), so a newer receipt or a restart never moves it.
   */
  readonly acceptedAt: number;
}

function keyOf(id: string, target: string): string {
  return `${id}\u0000${target}`;
}

/**
 * The file stem of a pane instance's inbox: a hash, never the pane id itself. A null instance is the
 * key an inbox had before instances, which only the prune still meets.
 */
export function inboxKey(session: string, paneId: string, instance: string | null): string {
  const hash = createHash("sha256").update(session).update("\u0000").update(paneId);
  if (instance !== null) hash.update("\u0000").update(instance);
  return hash.digest("hex").slice(0, 32);
}

/** A stored instance field: a token, or null for anything else (a line from before instances). */
function instanceField(raw: string | undefined): string | null {
  return raw !== undefined && INSTANCE_TOKEN.test(raw) ? raw : null;
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
  const from = asJsonObject(row.sender);
  const senderSession = from === undefined ? undefined : asJsonString(from.session);
  const senderPane = from === undefined ? undefined : asJsonString(from.paneId);
  const line: MessageLine = { t: "message", at, target, session, paneId, instance: instanceField(asJsonString(row.instance)), message };
  return senderSession === undefined || senderPane === undefined ? line : { ...line, sender: { session: senderSession, paneId: senderPane, instance: instanceField(asJsonString(from?.instance)) } };
}

export class WalkyLog {
  private readonly dir: string;
  private readonly path: string;
  private readonly inboxDir: string;
  private made = false;
  private lines: LogLine[] = [];
  private readonly records = new Map<string, LogRecord>();
  private readonly listeners: Array<(record: LogRecord) => void> = [];

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
    this.pruneInboxes(floor);
  }

  /**
   * Drop every inbox file whose newest message is older than the log's 7 days, or that holds no
   * message at all: past that the log no longer has the record, and nothing else ever deletes an
   * inbox of a pane that closed. A read of a pruned inbox is empty. Only files named as this log
   * names them (a 32-character hash) are touched.
   */
  private pruneInboxes(floor: number): void {
    if (!existsSync(this.inboxDir)) return;
    for (const name of readdirSync(this.inboxDir)) {
      if (!/^[0-9a-f]{32}\.json$/u.test(name)) continue;
      const path = join(this.inboxDir, name);
      const row = parseJsonObject(readFileSync(path, "utf8"));
      const messages = row !== undefined && Array.isArray(row.messages) ? row.messages.flatMap((entry) => readMessage(asJsonObject(entry)) ?? []) : [];
      const newest = Math.max(-Infinity, ...messages.map((message) => message.at));
      if (newest < floor) unlinkSync(path);
    }
  }

  private index(line: LogLine): void {
    if (line.t === "message") {
      const key = keyOf(line.message.id, line.target);
      // The first message line for a target wins; a receipt may already be waiting for it.
      if (this.records.has(key)) return;
      const accepted: WalkyReceipt = { id: line.message.id, target: line.target, state: "accepted", verified: "none", at: line.at, by: "-" };
      this.records.set(key, { session: line.session, paneId: line.paneId, instance: line.instance, target: line.target, message: line.message, receipt: accepted, sender: line.sender ?? null, acceptedAt: line.at });
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
    if (line.t === "receipt") {
      const record = this.records.get(keyOf(line.receipt.id, line.receipt.target));
      if (record !== undefined) for (const listener of this.listeners) listener(record);
    }
    const oldest = this.lines[0];
    if (this.lines.length > LOG_MAX_LINES || (oldest !== undefined && oldest.at < this.now() - LOG_KEEP_MS)) this.rotate();
  }

  /**
   * Call `listener` with the record each time a receipt is written for a message the log holds. The
   * crew report (crew.ts) listens, so a member can tell its lead how a message from elsewhere ended.
   */
  onReceipt(listener: (record: LogRecord) => void): void {
    this.listeners.push(listener);
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
  record(message: WalkyMessage, target: string, placement: Placement, receipt: WalkyReceipt, sender: Placement | null = null): LogRecord {
    const at = this.now();
    const line: MessageLine = { t: "message", at, target, session: placement.session, paneId: placement.paneId, instance: placement.instance, message };
    this.append(sender === null ? line : { ...line, sender });
    this.append({ t: "receipt", at, receipt });
    return this.get(message.id, target) ?? { ...placement, target, message, receipt, sender, acceptedAt: at };
  }

  /** The first record of a message id, or null: what a reply and a thread walk read. */
  first(id: string): LogRecord | null {
    for (const record of this.records.values()) if (record.message.id === id) return record;
    return null;
  }

  /** Write a newer receipt. A receipt for a message the log does not hold is still written. */
  update(receipt: WalkyReceipt): void {
    this.append({ t: "receipt", at: this.now(), receipt });
  }

  /**
   * The messages that went to one pane instance, newest first. A record from before instances counts for
   * any. With `sent`, also the ones that pane instance sent (added 2026-10-18): the phone's list shows
   * the receipt of an agent's own message too, and tells the two apart by `from.address`.
   */
  forPane(session: string, paneId: string, instance: string, limit: number, sent = false): WalkyEntry[] {
    const out: WalkyEntry[] = [];
    const at = (place: Placement | null): boolean => place !== null && place.session === session && place.paneId === paneId && sameInstance(place.instance, instance);
    for (const record of [...this.records.values()].toReversed()) {
      if (out.length >= limit) break;
      if (at(record) || (sent && at(record.sender))) out.push({ ...record.message, receipt: record.receipt });
    }
    return out;
  }

  /** The newest messages on this bridge, any pane, newest first. */
  newest(limit: number): LogRecord[] {
    return [...this.records.values()].toReversed().slice(0, limit);
  }

  // ── The inbox ──────────────────────────────────────────────────────────────────────────────────

  private inboxPath(session: string, paneId: string, instance: string | null): string {
    return join(this.inboxDir, `${inboxKey(session, paneId, instance)}.json`);
  }

  /** The unacknowledged messages of one pane instance, oldest first. */
  inbox(session: string, paneId: string, instance: string): WalkyMessage[] {
    const path = this.inboxPath(session, paneId, instance);
    if (!existsSync(path)) return [];
    const row = parseJsonObject(readFileSync(path, "utf8"));
    if (row === undefined || row.session !== session || row.paneId !== paneId || row.instance !== instance || !Array.isArray(row.messages)) return [];
    return row.messages.flatMap((entry) => {
      const message = readMessage(asJsonObject(entry));
      return message === null ? [] : [message];
    });
  }

  private writeInbox(session: string, paneId: string, instance: string, messages: readonly WalkyMessage[]): void {
    const path = this.inboxPath(session, paneId, instance);
    if (messages.length === 0) {
      if (existsSync(path)) unlinkSync(path);
      return;
    }
    this.ensureDirs();
    const temp = `${path}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ v: 1, session, paneId, instance, messages })}\n`, { mode: 0o600 });
    renameSync(temp, path);
  }

  /** Put a message in a pane instance's inbox. Once only; past the cap the oldest goes. */
  inboxAdd(session: string, paneId: string, instance: string, message: WalkyMessage): void {
    const messages = this.inbox(session, paneId, instance).filter((held) => held.id !== message.id);
    messages.push(message);
    this.writeInbox(session, paneId, instance, messages.slice(Math.max(0, messages.length - INBOX_MAX)));
  }

  /** Mark messages read for a pane instance: the named ids, or every one when `ids` is null. How many went. */
  ack(session: string, paneId: string, instance: string, ids: readonly string[] | null): number {
    const messages = this.inbox(session, paneId, instance);
    const kept = ids === null ? [] : messages.filter((message) => !ids.includes(message.id));
    this.writeInbox(session, paneId, instance, kept);
    return messages.length - kept.length;
  }

  /**
   * Drop a pane instance's inbox, read or not: the instance is gone (instances.ts `onDrop`), and no
   * other pane may ever read it. The log keeps the records.
   */
  inboxDrop(session: string, paneId: string, instance: string): void {
    const path = this.inboxPath(session, paneId, instance);
    if (existsSync(path)) unlinkSync(path);
  }

  /** How many inbox files exist. For a test and for a status line. */
  inboxCount(): number {
    if (!existsSync(this.inboxDir)) return 0;
    return readdirSync(this.inboxDir).filter((name) => name.endsWith(".json")).length;
  }
}
