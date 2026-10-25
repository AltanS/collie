// THE PANE'S RUNNING SUBAGENTS, FOR THE BELT'S AGENTS PILL.
//
// Claude Code keeps one folder per session beside its log, `<session-uuid>/subagents/`, with two files
// per subagent: `agent-<id>.jsonl` (the subagent's own transcript, which the subagent sheet reads) and
// `agent-<id>.meta.json` (who it is). A real meta file:
//
//   {"agentType":"general-purpose","description":"Walky docs trial, haiku A","toolUseId":"toolu_…",
//    "spawnDepth":1,"requestShape":"background","requestNonInteractive":true,"model":"haiku",
//    "finished":true}
//
// WHAT "RUNNING" MEANS HERE, AND WHY. Checked on 2026-10-19 against every session folder on the
// maintainer's machine (7,540 subagents, Claude Code 2.1.303):
//
//   1. The meta file is written when the subagent starts, about 100 ms before its first jsonl line,
//      with no `finished` key. When the subagent ends, Claude Code writes the meta again with
//      `"finished": true` (the file is new: its birth time is the finish time). So a meta whose
//      `finished` is not `true` is a subagent that has not reported back.
//   2. `finished` is new. Only metas written since 2026-10-15 carry it; the 7,000 older ones have no
//      `finished` key although every one of them ended long ago. Of the 539 metas written since, 67
//      lack it too with logs untouched for days: subagents of a session still on an older Claude
//      Code, or ones that died with their session (a killed terminal, a crash) before the second write.
//      So an unfinished meta alone is not enough. It counts as running only while the subagent's log
//      (or the meta itself) was written in the last {@link QUIET_RUNNING_MS}. A live subagent writes
//      its log on every step, but it can go quiet for longer than one tool call: a Bash call (ten
//      minutes by default, longer with BASH_MAX_TIMEOUT_MS), a permission it waits on while the
//      operator is away, a rate-limit retry, a nested subagent it waits for. Thirty minutes is a
//      trade. A subagent quiet for longer leaves the pill while it still runs, and a ghost leaves
//      it thirty minutes after its last line instead of never. The bound is one constant
//      (`QUIET_RUNNING_MS`), so it can move once real sessions show which way it errs.
//   3. A log with NO meta file beside it is a Claude Code from before meta files. None exist on this
//      machine (7,540 logs, 7,540 metas), so this is a fallback only: such a log counts as running
//      while it was written in the last {@link METALESS_RUNNING_MS}, the window the feature was
//      specified with. It has no description to show, so its row reads by its label alone.
//
// The main session log is never read for this. It does carry a line when a background subagent is
// launched ("Async agent launched successfully … agentId: …"), but the meta file says the same thing
// first and says when it ended, so it is the one source.
//
// COST. A session folder can hold hundreds of files, so this follows the todo tracker's discipline
// (bridge/todos.ts): a pane is read at most once per floor; a read lists each folder once, stats every
// meta file, and re-parses a meta only when its mtime or size moved. A log is statted only for a meta
// that is not finished.
//
// A FINISHED META IS NOT FINAL. SendMessage can resume a subagent after it finished, and Claude Code
// then writes its meta again WITHOUT `finished` (seen on 2026-10-19: `afaccaef48d594a12` of session
// `21fc21e5`, meta rewritten at 11:51:47, log written at 11:52:01, its siblings still finished). So
// every meta is statted on every read past the floor, and one that turns unfinished with a fresh log
// is running again. That is one readdir plus one stat per meta; the parse is what the cache saves.
//
// SAFETY. The folders come from the journal adapter's own `subagentDirs` (bridge/journal/claude.ts),
// contained in its roots; the file names come from `readdir`, and an id that fails `isAgentId` is
// skipped before any path is built from it. Every file is opened through `containedRealpath` against
// its folder. Nothing here takes a value from a request.
//
// OTHER HARNESSES. Only Claude Code writes subagent files, and only a source that implements
// `TranscriptSource.subagentDirs` (bridge/journal/types.ts) reaches this tracker. A source that
// implements it gets the tracker, the wire field and the pill with no change here, provided its files
// keep this shape. Since 2026-10-25 a pane whose source has no `subagentDirs` gets a second source
// instead, consulted where this one answers nothing: bridge/subagents-journal.ts lists the ongoing
// task cards of the session's live Chat window, which is how Oh My Pi's background `task` jobs and
// Gentle Shell's background subagents reach the pill. Those rows carry `transcript: false`, because
// the transcript route below serves Claude logs only.

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import type { JsonValue } from "./json.ts";
import { asRecord, asText, tokenCount } from "./journal/cache-probe.ts";
import { isAgentId } from "./journal/claude.ts";
import { containedRealpath } from "./journal/files.ts";
import { adapterFor } from "./journal/registry.ts";
import type { AgentSessionRef, JournalAdapter } from "./journal/types.ts";
import { journalAgentOf, type AgentView } from "./types.ts";

/** One subagent of a pane's session that has not finished yet. Attached to `AgentView.subagents`. */
export interface PaneSubagent {
  /**
   * Claude Code's own id for it, the one `GET /api/pane/<id>/subagent/<agentId>` takes. On a row read
   * from the journal, the job id the harness named (Oh My Pi), else the tool call's id.
   */
  agentId: string;
  /** The subagent type the call named or defaulted to (`general-purpose`, `Explore`, a plugin's). */
  agentType?: string;
  /** The model it runs on, as the call named it (`opus`, `haiku`, `inherit`). */
  model?: string;
  /** The call's own short description, on one line and clipped. Empty for a log with no meta file. */
  description: string;
  /** When it started, ISO 8601: the log's birth time, else the unfinished meta's mtime. */
  startedAt?: string;
  /** 1 for a subagent of the session itself, 2 for a subagent's subagent, and so on. */
  spawnDepth?: number;
  /**
   * `false` for a row read from the session's journal (bridge/subagents-journal.ts): no transcript
   * route serves it, so the phone draws the row without a tap. Absent on a Claude Code subagent.
   */
  transcript?: false;
}

export const MAX_SUBAGENTS = 50;
export const SUBAGENT_DESCRIPTION_MAX = 200;
export const DEFAULT_SUBAGENT_FLOOR_MS = 5000;
/** How long an unfinished meta counts as running after its last write (point 2 in the header). */
export const QUIET_RUNNING_MS = 30 * 60_000;
/** How long a log with no meta file counts as running after its last write (point 3 in the header). */
export const METALESS_RUNNING_MS = 10 * 60_000;

const META_MAX_BYTES = 16 * 1024;
const AGENT_FILE_RE = /^agent-(.+)\.(jsonl|meta\.json)$/;

/** Collapse whitespace to one line and clip with an ellipsis. The same rule as todos.ts. */
export function clipLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function clipWord(raw: JsonValue | undefined): string | undefined {
  const text = asText(raw);
  if (text === undefined) return undefined;
  const word = clipLine(text, 80);
  return word === "" ? undefined : word;
}

interface ParsedMeta {
  finished: boolean;
  agentType?: string;
  model?: string;
  description: string;
  spawnDepth?: number;
}

/** A meta file's text, parsed. Null when it is not a JSON object. Pure. */
export function parseSubagentMeta(text: string): ParsedMeta | null {
  let raw: JsonValue;
  try {
    // SAFETY: `JSON.parse` output IS a JsonValue by construction; `asRecord` narrows it to an object.
    raw = JSON.parse(text) as JsonValue;
  } catch {
    return null;
  }
  const r = asRecord(raw);
  if (r === null) return null;
  const meta: ParsedMeta = {
    finished: r.finished === true,
    description: clipLine(asText(r.description) ?? "", SUBAGENT_DESCRIPTION_MAX),
  };
  const agentType = clipWord(r.agentType);
  if (agentType !== undefined) meta.agentType = agentType;
  const model = clipWord(r.model);
  if (model !== undefined) meta.model = model;
  const depth = tokenCount(r.spawnDepth);
  if (depth !== undefined && Number.isInteger(depth) && depth >= 0) meta.spawnDepth = depth;
  return meta;
}

/** The file system this tracker touches, injectable so a test counts calls instead of guessing. */
export interface SubagentFs {
  readdir(dir: string): Promise<string[]>;
  stat(path: string): Promise<{ mtimeMs: number; size: number; birthtimeMs: number } | null>;
  readText(path: string, maxBytes: number): Promise<string>;
}

const nodeFs: SubagentFs = {
  readdir: (dir) => readdir(dir),
  stat: async (path) => {
    try {
      const st = await stat(path);
      return { mtimeMs: st.mtimeMs, size: st.size, birthtimeMs: st.birthtimeMs };
    } catch {
      return null;
    }
  },
  readText: (path, maxBytes) => Bun.file(path).slice(0, maxBytes).text(),
};

export interface SubagentTrackerOptions {
  floorMs?: number;
  fs?: SubagentFs;
}

/**
 * What is remembered about one subagent's meta file between reads: the parse at this mtime and size,
 * finished or not, or null when it did not parse. Nothing here is final (see FINISHED META in the header).
 */
interface Seen {
  mtimeMs: number;
  size: number;
  meta: ParsedMeta | null;
}

interface Entry {
  session: string | undefined;
  paneId: string;
  lastProbedAt: number;
  /** Per folder, per subagent id. */
  seen: Map<string, Map<string, Seen>>;
  running?: PaneSubagent[];
}

export class SubagentTracker {
  private readonly bySession = new Map<string, Entry>();

  private readonly floorMs: number;

  private readonly fs: SubagentFs;

  private pendingRefresh: Promise<void> = Promise.resolve();

  constructor(
    private readonly registry: Record<string, JournalAdapter>,
    private readonly now: () => number,
    options: SubagentTrackerOptions = {},
  ) {
    this.floorMs = options.floorMs ?? DEFAULT_SUBAGENT_FLOOR_MS;
    this.fs = options.fs ?? nodeFs;
  }

  /** The pane's running subagents as last read, or undefined when none is running. Never a `[]`. */
  get(pane: AgentView): PaneSubagent[] | undefined {
    const key = pane.agentSession?.value;
    const list = key === undefined ? undefined : this.bySession.get(key)?.running;
    return list !== undefined && list.length > 0 ? list : undefined;
  }

  /** Walk the panes and bring their readings up to date. Serialised and NEVER THROWS. */
  refresh(panes: readonly AgentView[], scope: { session?: string } = {}): Promise<void> {
    const run = this.pendingRefresh.then(() => this.runRefresh(panes, scope));
    this.pendingRefresh = run.catch(() => {});
    return run;
  }

  private async runRefresh(panes: readonly AgentView[], scope: { session?: string }): Promise<void> {
    try {
      const at = this.now();
      const session = scope.session;
      const named = new Map<string, string | undefined>();
      for (const pane of panes) {
        const ref = pane.agentSession;
        named.set(pane.paneId, ref?.value);
        if (ref === undefined) continue;
        const source = adapterFor(this.registry, journalAgentOf(pane))?.source;
        if (source?.subagentDirs === undefined) continue;
        const previous = this.bySession.get(ref.value);
        const owner = { session, paneId: pane.paneId };
        if (previous !== undefined && at - previous.lastProbedAt < this.floorMs) {
          this.bySession.set(ref.value, { ...previous, ...owner });
          continue;
        }
        const next: Entry = { seen: new Map(), ...previous, ...owner, lastProbedAt: at };
        await this.look(source.subagentDirs.bind(source), ref, next, at);
        this.bySession.set(ref.value, next);
      }
      for (const [key, entry] of this.bySession) {
        if (entry.session === session && departed(named, key, entry.paneId)) this.bySession.delete(key);
      }
    } catch {
      // Never throws: a poll failure leaves the previous readings intact.
    }
  }

  private async look(
    dirsOf: (ref: AgentSessionRef) => Promise<string[]>,
    ref: AgentSessionRef,
    entry: Entry,
    at: number,
  ): Promise<void> {
    let dirs: string[];
    try {
      dirs = await dirsOf(ref);
    } catch {
      return;
    }
    const running = new Map<string, PaneSubagent>();
    const seen = new Map<string, Map<string, Seen>>();
    for (const dir of dirs) {
      let names: string[];
      try {
        names = await this.fs.readdir(dir);
      } catch {
        continue;
      }
      const before = entry.seen.get(dir) ?? new Map<string, Seen>();
      const after = new Map<string, Seen>();
      seen.set(dir, after);
      const files = new Map<string, { log: boolean; meta: boolean }>();
      for (const name of names) {
        const m = AGENT_FILE_RE.exec(name);
        const id = m?.[1];
        // An id that fails the guard never becomes a path: traversal, `acompact-*`, a fork's named id.
        if (m === null || id === undefined || !isAgentId(id)) continue;
        const has = files.get(id) ?? { log: false, meta: false };
        if (m[2] === "jsonl") has.log = true;
        else has.meta = true;
        files.set(id, has);
      }
      for (const [id, has] of files) {
        const found = has.meta
          ? await this.readMeta(dir, id, has.log, before.get(id), at)
          : await this.readMetaless(dir, id, at);
        if (found.seen !== undefined) after.set(id, found.seen);
        if (found.running !== undefined && !running.has(id)) running.set(id, found.running);
      }
    }
    entry.seen = seen;
    const list = [...running.values()]
      .toSorted((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? "") || a.agentId.localeCompare(b.agentId))
      .slice(0, MAX_SUBAGENTS);
    if (list.length === 0) delete entry.running;
    else entry.running = list;
  }

  private async readMeta(
    dir: string,
    id: string,
    hasLog: boolean,
    prior: Seen | undefined,
    at: number,
  ): Promise<{ seen?: Seen; running?: PaneSubagent }> {
    const metaPath = await containedRealpath(join(dir, `agent-${id}.meta.json`), dir);
    if (metaPath === null) return {};
    const st = await this.fs.stat(metaPath);
    if (st === null) return {};
    let meta: ParsedMeta | null;
    if (prior !== undefined && prior.mtimeMs === st.mtimeMs && prior.size === st.size) {
      meta = prior.meta;
    } else {
      try {
        meta = parseSubagentMeta(await this.fs.readText(metaPath, META_MAX_BYTES));
      } catch {
        return {};
      }
    }
    const seen: Seen = { mtimeMs: st.mtimeMs, size: st.size, meta };
    // A finished meta is not shown, and a meta that does not parse is not shown either. Both are read
    // again when the file moves: a resumed subagent's meta loses `finished`.
    if (meta === null || meta.finished) return { seen };
    const log = hasLog ? await this.statLog(dir, id) : null;
    const lastWrite = Math.max(st.mtimeMs, log?.mtimeMs ?? 0);
    if (at - lastWrite >= QUIET_RUNNING_MS) return { seen };
    // The log's birth is the first start, also for a resumed subagent. With no birth time on this
    // file system, the unfinished meta's mtime stands in: the start, or the resume.
    const started = log !== null && log.birthtimeMs > 0 ? log.birthtimeMs : st.mtimeMs;
    return { seen, running: toPaneSubagent(id, meta, started) };
  }

  private async readMetaless(dir: string, id: string, at: number): Promise<{ seen?: Seen; running?: PaneSubagent }> {
    const log = await this.statLog(dir, id);
    if (log === null) return {};
    if (at - log.mtimeMs >= METALESS_RUNNING_MS) return {};
    const running: PaneSubagent = { agentId: id, description: "" };
    if (log.birthtimeMs > 0) running.startedAt = new Date(log.birthtimeMs).toISOString();
    return { running };
  }

  private async statLog(dir: string, id: string): Promise<{ mtimeMs: number; size: number; birthtimeMs: number } | null> {
    const logPath = await containedRealpath(join(dir, `agent-${id}.jsonl`), dir);
    return logPath === null ? null : this.fs.stat(logPath);
  }
}

function toPaneSubagent(agentId: string, meta: ParsedMeta, startedMs: number): PaneSubagent {
  const out: PaneSubagent = { agentId, description: meta.description };
  if (meta.agentType !== undefined) out.agentType = meta.agentType;
  if (meta.model !== undefined) out.model = meta.model;
  if (Number.isFinite(startedMs) && startedMs > 0) out.startedAt = new Date(startedMs).toISOString();
  if (meta.spawnDepth !== undefined) out.spawnDepth = meta.spawnDepth;
  return out;
}

/** Has the pane this entry was read for left the session's list? Same rule as the todo tracker. */
function departed(named: Map<string, string | undefined>, key: string, paneId: string): boolean {
  if (!named.has(paneId)) return true;
  const now = named.get(paneId);
  return now !== undefined && now !== key;
}
