import { createHash } from "node:crypto";
import { appendFile, chmod, mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { maskSentAnswer } from "./answer-mask.ts";
import type { AuditLog } from "./audit.ts";
import type { JsonObject, JsonValue } from "./json.ts";
import { stateFileIo } from "./launchers-added.ts";
import { SENT_MAX_LINE, sentLineOf } from "./secret-line.ts";
import type { SentAnswer, SentEntry, SentMachine, SentRemoveResponse } from "./types.ts";

// ── SENT: THE SHELL LINES A PERSON SENT THROUGH COLLIE, ON THIS MACHINE (ADR 0107) ──────────────
//
// A command history in the spirit of a shell's own, for the lines that went in through Collie: a
// line sent to a pane the bridge reads as a bare shell (`kind: "shell"`), and a one-off run from the
// New page. Prompts to agents, programs and panes with an agent Collie has no profile for stay out.
// Each machine keeps its own file; a crew lead asks its members over the link and keeps no copy.
//
// ── WHERE A RECORD IS MADE ──────────────────────────────────────────────────────────────────────
// Only on the machine that owns the pane, and only after the fact: the Send Protocol's blind send,
// once the text went in and Enter went out (`SendDeps.blindSent`, wired by {@link sentRecorder}),
// and `POST /api/launch` with `{ run }`, once the line was typed and Enter sent. Keys never record.
//
// ── A SKIPPED LINE LEAVES NOTHING ───────────────────────────────────────────────────────────────
// `sentLineOf` (bridge/secret-line.ts) decides. A line it refuses is sent as usual, and here it
// leaves no record, no counter and no log line with its text. `COLLIE_SENT=off` refuses every line.
//
// ── THE FILE ────────────────────────────────────────────────────────────────────────────────────
// `<stateDir>/sent.jsonl`, owner-only (0600) in an owner-only folder (0700), absent until the first
// line is kept. One JSON object per line, `{"v":1,"line","cwd","at","kind"}`, appended. Past
// {@link SENT_COMPACT_AT} records the file is rewritten atomically (`stateFileIo`) with the newest
// {@link SENT_CAP}, and no record older than {@link SENT_MAX_AGE_MS} survives a rewrite or a read. A
// line that does not parse is skipped on read; a record with another `v` reads as absent. Writes go
// through one promise queue, as `RecentRunStore`'s do.

/** The file's name inside the state dir. */
export const SENT_FILE = "sent.jsonl";
/** The record version this build writes and reads. Another number reads as absent. */
export const SENT_VERSION = 1;
/** The most records a rewrite keeps. */
export const SENT_CAP = 5000;
/** The record count past which the next record rewrites the file down to {@link SENT_CAP}. */
export const SENT_COMPACT_AT = 5500;
/** The oldest record kept: 365 days. */
export const SENT_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
/** `limit` when the query names none, and the most it may name. */
export const SENT_LIMIT_DEFAULT = 50;
export const SENT_LIMIT_MAX = 200;
/** How long a lead waits for each member's answer to `scope=all`. */
export const SENT_MEMBER_BUDGET_MS = 2000;
/** The longest folder a record keeps. A longer one is kept as `null`. */
const MAX_CWD_CHARS = 4096;
/** The longest `q` a query may carry. */
const MAX_QUERY_CHARS = 4096;

/** Where a line came from: a shell pane, or a one-off run. Never a harness name. */
export type SentKind = "shell" | "run";

/** One line as it sits in the file. */
export interface SentRecord {
  line: string;
  /** Absolute, or `null` for home. */
  cwd: string | null;
  /** Epoch ms. */
  at: number;
  kind: SentKind;
}

/** The stable id of a line on its machine: the first 16 hex characters of its sha256. */
export function sentId(line: string): string {
  return createHash("sha256").update(line).digest("hex").slice(0, 16);
}

function asRecord(value: JsonValue | undefined): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

/** One line of the file as a record, or `null`: a line that does not parse, or another version. */
export function parseSentRecord(text: string): SentRecord | null {
  let raw: JsonValue;
  try {
    // SAFETY: `JSON.parse` output IS a JsonValue by construction; every field is checked below.
    raw = JSON.parse(text) as JsonValue;
  } catch {
    return null;
  }
  const r = asRecord(raw);
  if (r === null || r.v !== SENT_VERSION) return null;
  const { line, cwd, at, kind } = r;
  if (typeof line !== "string" || line === "" || line.length > SENT_MAX_LINE) return null;
  if (cwd !== null && (typeof cwd !== "string" || !isAbsolute(cwd))) return null;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  if (kind !== "shell" && kind !== "run") return null;
  return { line, cwd, at, kind };
}

/** Every record a file's text holds, oldest line first, minus any older than the age cut. */
export function parseSentText(text: string | null, now: number): SentRecord[] {
  if (text === null) return [];
  const out: SentRecord[] = [];
  for (const row of text.split("\n")) {
    if (row.trim() === "") continue;
    const record = parseSentRecord(row);
    if (record !== null && now - record.at <= SENT_MAX_AGE_MS) out.push(record);
  }
  return out;
}

/** One record as the line the file holds, newline included. */
export function formatSentRecord(record: SentRecord): string {
  return `${JSON.stringify({ v: SENT_VERSION, line: record.line, cwd: record.cwd, at: record.at, kind: record.kind })}\n`;
}

/** The disk half, behind an interface so the store is testable without the real state dir. */
export interface SentIo {
  /** The file's text, or null when it is absent. */
  read(): Promise<string | null>;
  /** Add to the end, creating the file owner-only. */
  append(text: string): Promise<void>;
  /** Replace the whole file atomically, owner-only. */
  replace(text: string): Promise<void>;
}

/** The real io over `<stateDir>/sent.jsonl`. */
export function sentFileIo(stateDir: string): SentIo {
  const file = join(stateDir, SENT_FILE);
  const atomic = stateFileIo(stateDir, file);
  let tightened = false;
  return {
    read: () => atomic.read(),
    replace: (text) => atomic.write(text),
    async append(text) {
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      await appendFile(file, text, { mode: 0o600 });
      // `mode` applies only when the append creates the file; a file made some other way is made
      // owner-only once per process.
      if (!tightened) {
        tightened = true;
        await chmod(file, 0o600).catch(() => undefined);
      }
    },
  };
}

/** An io over an in-memory file, for a server built without a state dir and for tests. */
export function memorySentIo(initial: string | null = null): SentIo & { text: string | null; replaces: number } {
  const io = {
    text: initial,
    replaces: 0,
    read: () => Promise.resolve(io.text),
    append: (text: string) => {
      io.text = (io.text ?? "") + text;
      return Promise.resolve();
    },
    replace: (text: string) => {
      io.text = text;
      io.replaces++;
      return Promise.resolve();
    },
  };
  return io;
}

/** What the routes and the record points need of the store. */
export interface SentSurface {
  /** `COLLIE_SENT=off`: nothing records, and a read lists nothing. */
  readonly off: boolean;
  /** Keep one line, or nothing when {@link sentLineOf} refuses it or the switch is off. Never throws. */
  record(raw: string, cwd: string | null, kind: SentKind): Promise<"recorded" | "skipped" | "unwritable">;
  /** Every record on disk now, oldest line first. */
  list(): Promise<SentRecord[]>;
  /** Remove every record of the line with this id. Answers how many went. */
  remove(id: string): Promise<number | "unwritable">;
  /** Empty the file. Answers how many records went. */
  clear(): Promise<number | "unwritable">;
}

export interface SentStoreOptions {
  /** `COLLIE_SENT=off`. */
  off?: boolean;
  /** This machine's home: a record in it keeps `cwd: null`. */
  home?: string;
  now?: () => number;
  warn?: (line: string) => void;
}

/** The file-backed store `bridge/index.ts` builds once. */
export class SentStore implements SentSurface {
  private queue: Promise<void> = Promise.resolve();
  /** The records in the file, known after the first record; `null` until then. */
  private count: number | null = null;
  private readonly now: () => number;
  private readonly warn: (line: string) => void;

  constructor(
    private readonly io: SentIo,
    private readonly opts: SentStoreOptions = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.warn = opts.warn ?? ((line) => console.warn(line));
  }

  get off(): boolean {
    return this.opts.off === true;
  }

  /** Absolute and bounded, or `null`; home is `null` too. */
  private folder(cwd: string | null): string | null {
    if (cwd === null || cwd === "" || cwd.length > MAX_CWD_CHARS || !isAbsolute(cwd)) return null;
    return cwd === this.opts.home ? null : cwd;
  }

  /** Run one write after every earlier one. A failure is one warning with no text, and `failed`. */
  private serial<T>(work: () => Promise<T>, failed: T): Promise<T> {
    const run = this.queue.then(async () => {
      try {
        return await work();
      } catch (err) {
        // The error names the file and the call, never the line: an fs error carries no data written.
        this.warn(`[sent] ${SENT_FILE} could not be written: ${err instanceof Error ? err.message : String(err)}`);
        this.count = null;
        return failed;
      }
    });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  record(raw: string, cwd: string | null, kind: SentKind): Promise<"recorded" | "skipped" | "unwritable"> {
    if (this.off) return Promise.resolve("skipped");
    const line = sentLineOf(raw);
    if (line === null) return Promise.resolve("skipped");
    const record: SentRecord = { line, cwd: this.folder(cwd), at: this.now(), kind };
    return this.serial<"recorded" | "skipped" | "unwritable">(async () => {
      if (this.count === null) this.count = countRows(await this.io.read());
      await this.io.append(formatSentRecord(record));
      this.count++;
      if (this.count > SENT_COMPACT_AT) await this.compact();
      return "recorded";
    }, "unwritable");
  }

  /** Rewrite the file with the newest {@link SENT_CAP} records inside the age cut. Inside the queue. */
  private async compact(): Promise<void> {
    const kept = parseSentText(await this.io.read(), this.now())
      .map((record, index) => ({ record, index }))
      .toSorted((a, b) => a.record.at - b.record.at || a.index - b.index)
      .slice(-SENT_CAP)
      .map(({ record }) => record);
    await this.io.replace(kept.map(formatSentRecord).join(""));
    this.count = kept.length;
  }

  async list(): Promise<SentRecord[]> {
    return parseSentText(await this.io.read(), this.now());
  }

  remove(id: string): Promise<number | "unwritable"> {
    return this.serial<number | "unwritable">(async () => {
      const text = await this.io.read();
      if (text === null) return 0;
      // Every other row stays as it is, a newer Collie's record and a row that does not parse too.
      let removed = 0;
      const kept: string[] = [];
      for (const row of text.split("\n")) {
        if (row.trim() === "") continue;
        const record = parseSentRecord(row);
        if (record !== null && sentId(record.line) === id) removed++;
        else kept.push(row);
      }
      if (removed === 0) return 0;
      await this.io.replace(kept.map((row) => `${row}\n`).join(""));
      this.count = kept.length;
      return removed;
    }, "unwritable");
  }

  clear(): Promise<number | "unwritable"> {
    return this.serial<number | "unwritable">(async () => {
      const text = await this.io.read();
      // No file stays no file: a clear on a machine that never kept a line writes nothing.
      if (text === null) return 0;
      const removed = text.split("\n").filter((row) => row.trim() !== "" && parseSentRecord(row) !== null).length;
      await this.io.replace("");
      this.count = 0;
      return removed;
    }, "unwritable");
  }
}

/** The rows a file's text holds, valid or not: what the compaction count starts from. */
function countRows(text: string | null): number {
  if (text === null) return 0;
  let n = 0;
  for (const row of text.split("\n")) if (row.trim() !== "") n++;
  return n;
}

/** A store over an in-memory file. */
export function memorySent(opts: SentStoreOptions = {}): SentStore {
  return new SentStore(memorySentIo(), { warn: () => {}, ...opts });
}

// ── The record point on a shell pane ────────────────────────────────────────────────────────────

/** A blind send that went out, as the Send Protocol reports it (`SendDeps.blindSent`). */
export interface BlindSent {
  readonly session: string;
  readonly paneId: string;
  readonly text: string;
}

/**
 * The Send Protocol's `blindSent` for one session: the line is kept only when the pane is one of the
 * engine's shell panes (`kind: "shell"`, the list the snapshot's `shellPanes` is made from). An agent
 * pane, a pane whose agent has no profile, and a program are never in that list. Fired and not
 * awaited, so a slow disk never holds a send's answer; the store never throws.
 */
export function sentRecorder(
  store: Pick<SentSurface, "record">,
  shellPanes: () => readonly { readonly paneId: string; readonly cwd: string }[],
): (sent: BlindSent) => void {
  return (sent) => {
    const pane = shellPanes().find((p) => p.paneId === sent.paneId);
    if (pane === undefined) return;
    void store.record(sent.text, pane.cwd, "shell");
  };
}

// ── The read ────────────────────────────────────────────────────────────────────────────────────

/** `GET /api/sent`'s query, checked. */
export interface SentQuery {
  scope: "here" | "all";
  /** Exact folder match, absolute; `null` for every folder. */
  cwd: string | null;
  q: string;
  limit: number;
  /** Only entries whose newest record is older than this; `null` for the first page. */
  before: number | null;
}

/** The query `params` name, or the sentence a 400 says. */
export function parseSentQuery(params: URLSearchParams): SentQuery | string {
  const scope = params.get("scope") ?? "here";
  if (scope !== "here" && scope !== "all") return "bad scope";
  const cwdRaw = params.get("cwd") ?? "";
  if (cwdRaw !== "" && (!isAbsolute(cwdRaw) || cwdRaw.length > MAX_CWD_CHARS)) return "bad cwd";
  const q = params.get("q") ?? "";
  if (q.length > MAX_QUERY_CHARS) return "bad q";
  const limitRaw = params.get("limit");
  let limit = SENT_LIMIT_DEFAULT;
  if (limitRaw !== null && limitRaw !== "") {
    if (!/^\d{1,4}$/u.test(limitRaw)) return "bad limit";
    limit = Number(limitRaw);
    if (limit < 1 || limit > SENT_LIMIT_MAX) return "bad limit";
  }
  const beforeRaw = params.get("before");
  let before: number | null = null;
  if (beforeRaw !== null && beforeRaw !== "") {
    if (!/^\d{1,16}$/u.test(beforeRaw)) return "bad before";
    before = Number(beforeRaw);
  }
  return { scope, cwd: cwdRaw === "" ? null : cwdRaw, q, limit, before };
}

/** The same query as a member is asked it: `scope=here`, every other field unchanged. */
export function sentMemberParams(query: SentQuery): URLSearchParams {
  const params = new URLSearchParams({ scope: "here", limit: String(query.limit) });
  if (query.cwd !== null) params.set("cwd", query.cwd);
  if (query.q !== "") params.set("q", query.q);
  if (query.before !== null) params.set("before", String(query.before));
  return params;
}

/** One page of entries, and whether a later page exists. */
export interface SentPage {
  entries: SentEntry[];
  more: boolean;
}

/**
 * The entries a list of records makes under a query: the folder first, then one entry per line with
 * its newest record and the count of all, then the words, then `before`, newest first and cut to the
 * limit. A query folder equal to `home` matches the records kept as `null`. `before` is on the entry's
 * newest record, so a line lands on exactly one page.
 */
export function sentEntries(records: readonly SentRecord[], query: SentQuery, host: string, home?: string): SentPage {
  const inFolder = (r: SentRecord): boolean => query.cwd === null || r.cwd === query.cwd || (r.cwd === null && query.cwd === home);
  const byLine = new Map<string, { newest: SentRecord; count: number }>();
  for (const record of records) {
    if (!inFolder(record)) continue;
    const seen = byLine.get(record.line);
    if (seen === undefined) byLine.set(record.line, { newest: record, count: 1 });
    else {
      seen.count++;
      if (record.at >= seen.newest.at) seen.newest = record;
    }
  }
  const words = query.q.toLowerCase().split(/\s+/u).filter((w) => w !== "");
  const entries: SentEntry[] = [];
  for (const [line, { newest, count }] of byLine) {
    const lower = line.toLowerCase();
    if (!words.every((w) => lower.includes(w))) continue;
    if (query.before !== null && newest.at >= query.before) continue;
    entries.push({ id: sentId(line), line, cwd: newest.cwd, at: newest.at, kind: newest.kind, count, host });
  }
  entries.sort((a, b) => b.at - a.at);
  return { entries: entries.slice(0, query.limit), more: entries.length > query.limit };
}

/** This machine's name on the wire: the crew's member id, or `local`, and its label. */
export interface SentSelf {
  readonly id: string;
  readonly name: string;
}

/** This bridge's own answer to a query. Every line goes out masked when `redact` is on. */
export async function sentAnswerHere(store: Pick<SentSurface, "off" | "list">, query: SentQuery, self: SentSelf, redact: boolean, home?: string): Promise<SentAnswer> {
  if (store.off) return { entries: [], more: false, off: true, machines: [{ host: self.id, label: self.name, ok: true, off: true }] };
  const { entries, more } = sentEntries(await store.list(), query, self.id, home);
  const answer: SentAnswer = { entries, more, off: false, machines: [{ host: self.id, label: self.name, ok: true }] };
  return redact ? maskSentAnswer(answer) : answer;
}

// ── The lead's merge ────────────────────────────────────────────────────────────────────────────

/** What one member's answer came to. */
export type SentMemberReply =
  | { readonly ok: true; readonly entries: SentEntry[]; readonly more: boolean; readonly off: boolean }
  | { readonly ok: false; readonly reason: NonNullable<SentMachine["reason"]> };

/** One member a lead asks: its id, its label, and the call that asks it over the crew link. */
export interface SentMember {
  readonly host: string;
  readonly label: string;
  readonly ask: (params: URLSearchParams) => Promise<Response>;
}

/** One entry off a member's answer, or `null` when it is not one. Its `host` is the lead's name for it. */
function memberEntry(raw: JsonValue, host: string): SentEntry | null {
  const r = asRecord(raw);
  if (r === null) return null;
  const { id, line, cwd, at, kind, count } = r;
  if (typeof id !== "string" || id === "" || id.length > 64) return null;
  if (typeof line !== "string" || line === "" || line.length > SENT_MAX_LINE) return null;
  if (cwd !== null && typeof cwd !== "string") return null;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  if (kind !== "shell" && kind !== "run") return null;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1) return null;
  return { id, line, cwd, at, kind, count, host };
}

/**
 * A member's response, read: a 404 is a member that predates Sent, a crew error that says it timed
 * out is `timeout`, and every other failure, an answer that is not a Sent answer included, is
 * `unreachable`.
 */
export async function readSentReply(res: Response, host: string): Promise<SentMemberReply> {
  if (res.status === 404) {
    await res.body?.cancel();
    return { ok: false, reason: "old_version" };
  }
  const text = await res.text().catch(() => "");
  if (res.status !== 200) return { ok: false, reason: /timed out/iu.test(text) ? "timeout" : "unreachable" };
  let body: JsonValue;
  try {
    // SAFETY: `JSON.parse` output IS a JsonValue by construction; every field is checked below.
    body = JSON.parse(text) as JsonValue;
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  const r = asRecord(body);
  if (r === null || !Array.isArray(r.entries)) return { ok: false, reason: "unreachable" };
  const entries: SentEntry[] = [];
  for (const raw of r.entries) {
    const entry = memberEntry(raw, host);
    if (entry !== null) entries.push(entry);
  }
  return { ok: true, entries, more: r.more === true, off: r.off === true };
}

/** Ask one member, with its own budget: no answer in `budgetMs` is `timeout`, a throw `unreachable`. */
export async function askSentMember(member: SentMember, params: URLSearchParams, budgetMs = SENT_MEMBER_BUDGET_MS): Promise<SentMemberReply> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), budgetMs);
  });
  const asked = member.ask(params);
  try {
    const first = await Promise.race([asked, late]);
    if (first === "timeout") {
      // The answer that comes later is read by nobody: its body is let go.
      void asked.then(
        (res) => res.body?.cancel(),
        () => undefined,
      );
      return { ok: false, reason: "timeout" };
    }
    return await readSentReply(first, member.host);
  } catch {
    return { ok: false, reason: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The lead's `scope=all`: its own answer and every member's, asked in parallel, merged by `at`, cut
 * to the limit. `more` is set when any machine has a later page or the merge cut something. A
 * member's lines are masked again here when `redact` is on (idempotent), whatever that member did.
 */
export async function mergeSentAnswers(local: SentAnswer, members: readonly SentMember[], query: SentQuery, redact: boolean, budgetMs = SENT_MEMBER_BUDGET_MS): Promise<SentAnswer> {
  const params = sentMemberParams(query);
  const replies = await Promise.all(members.map(async (member) => ({ member, reply: await askSentMember(member, params, budgetMs) })));
  const machines: SentMachine[] = [...local.machines];
  const all: SentEntry[] = [...local.entries];
  let more = local.more;
  for (const { member, reply } of replies) {
    if (!reply.ok) {
      machines.push({ host: member.host, label: member.label, ok: false, reason: reply.reason });
      continue;
    }
    const machine: SentMachine = { host: member.host, label: member.label, ok: true };
    if (reply.off) machine.off = true;
    machines.push(machine);
    more ||= reply.more;
    all.push(...reply.entries);
  }
  all.sort((a, b) => b.at - a.at);
  const merged: SentAnswer = { entries: all.slice(0, query.limit), more: more || all.length > query.limit, off: local.off, machines };
  return redact ? maskSentAnswer(merged) : merged;
}

// ── The two writes ──────────────────────────────────────────────────────────────────────────────

/** A write route's answer, for bridge/server.ts to send. A plain-text refusal carries `text`. */
export type SentWriteAnswer = { status: 200; body: SentRemoveResponse } | { status: 400 | 503; text: string };

/** Who is asking, and where the audit line goes. */
export interface SentWriteContext {
  sent: Pick<SentSurface, "remove" | "clear">;
  device: string | null;
  audit: AuditLog;
  session?: string;
}

/** The body's `requestId`: absent, or a string the audit line may keep. `false` for anything else. */
function requestIdOf(body: JsonObject): string | undefined | false {
  const id = body.requestId;
  if (id === undefined) return undefined;
  return typeof id === "string" && id.length >= 1 && id.length <= 128 ? id : false;
}

/**
 * `POST /api/sent/remove` `{ id, requestId }`: every record of that line on this machine goes. A
 * missing id answers ok with `removed: 0`. The audit line keeps the count and the request id, never
 * the line or its id.
 */
export async function removeSent(raw: JsonValue, ctx: SentWriteContext): Promise<SentWriteAnswer> {
  const body = asRecord(raw);
  const id = body?.id;
  const requestId = body === null ? false : requestIdOf(body);
  if (typeof id !== "string" || id === "" || id.length > 64 || requestId === false) return { status: 400, text: "bad body" };
  const removed = await ctx.sent.remove(id);
  if (removed === "unwritable") return { status: 503, text: `${SENT_FILE} cannot be written` };
  ctx.audit.record({ action: "sent.remove", session: ctx.session, device: ctx.device, detail: { removed, requestId } });
  return { status: 200, body: { ok: true, removed } };
}

/** `POST /api/sent/clear` `{ requestId }`: this machine's record is emptied. */
export async function clearSent(raw: JsonValue, ctx: SentWriteContext): Promise<SentWriteAnswer> {
  const body = asRecord(raw);
  const requestId = body === null ? false : requestIdOf(body);
  if (requestId === false) return { status: 400, text: "bad body" };
  const removed = await ctx.sent.clear();
  if (removed === "unwritable") return { status: 503, text: `${SENT_FILE} cannot be written` };
  ctx.audit.record({ action: "sent.clear", session: ctx.session, device: ctx.device, detail: { removed, requestId } });
  return { status: 200, body: { ok: true, removed } };
}
