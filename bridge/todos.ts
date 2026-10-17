import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { JsonObject, JsonValue } from "./json.ts";
import { asRecord, asText, probeTail, type ProbeTail, tokenCount } from "./journal/cache-probe.ts";
import { isSessionId } from "./journal/claude.ts";
import { containedRealpath, statFile } from "./journal/files.ts";
import { adapterFor } from "./journal/registry.ts";
import type { AgentSessionRef, JournalAdapter, TranscriptSource } from "./journal/types.ts";
import { journalAgentOf, type AgentView } from "./types.ts";

export type PaneTodoStatus = "pending" | "in_progress" | "completed";

export interface PaneTodo {
  id: string;
  text: string;
  status: PaneTodoStatus;
  activeForm?: string;
}

export const DEFAULT_TASKS_DIR = join(homedir(), ".claude", "tasks");
export const MAX_TODOS = 50;
export const MAX_TASK_FILES = 200;
export const TODO_TEXT_MAX = 200;
export const DEFAULT_TODO_FLOOR_MS = 5000;
export const DEFAULT_OPENCODE_TODO_FLOOR_MS = 10_000;
export const TODO_TAIL_BYTES = 64 * 1024;

/** Harnesses with file-backed journals that write todo/task tool calls. */
export const TAILED_TODO_AGENTS: ReadonlySet<string> = new Set(["claude", "codex", "grok"]);

/** Database-backed harness whose session is read whole through `source.load`. */
export const LOADED_TODO_AGENTS: ReadonlySet<string> = new Set(["opencode"]);

const TASK_FILE_RE = /^\d+\.json$/;
const TASK_FILE_MAX_BYTES = 64 * 1024;

/** Collapse whitespace to one line and clip with an ellipsis. */
function clipLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function parseJsonObject(text: string): JsonObject | null {
  try {
    // SAFETY: `JSON.parse` output IS a JsonValue by construction; `asRecord` narrows it to an object.
    return asRecord(JSON.parse(text) as JsonValue);
  } catch {
    return null;
  }
}

function asInputObject(raw: JsonValue | undefined): JsonObject | null {
  const text = asText(raw);
  if (text !== undefined) return parseJsonObject(text);
  return asRecord(raw);
}

function asId(raw: JsonValue | undefined): string | undefined {
  const s = asText(raw)?.trim();
  if (s !== undefined && s !== "") return s;
  const n = tokenCount(raw);
  return n !== undefined ? String(n) : undefined;
}

function parseStatus(raw: JsonValue | undefined): PaneTodoStatus | "deleted" | undefined {
  const s = asText(raw)?.trim().toLowerCase();
  if (s === "pending" || s === "todo" || s === "open") return "pending";
  if (s === "in_progress" || s === "doing" || s === "working") return "in_progress";
  if (s === "completed" || s === "done") return "completed";
  if (s === "deleted" || s === "cancelled" || s === "canceled" || s === "dropped") return "deleted";
  return undefined;
}

function buildTodo(
  id: string,
  rawText: string,
  status: PaneTodoStatus,
  rawActive?: string,
): PaneTodo | undefined {
  const text = clipLine(rawText, TODO_TEXT_MAX);
  if (text === "") return undefined;
  const todo: PaneTodo = { id, text, status };
  const active = rawActive === undefined ? undefined : clipLine(rawActive, TODO_TEXT_MAX);
  if (active !== undefined && active !== "") todo.activeForm = active;
  return todo;
}

function parseClaudeTaskRecord(r: JsonObject, fallbackId: string): PaneTodo | "deleted" | undefined {
  const status = parseStatus(r.status) ?? "pending";
  if (status === "deleted") {
    const isTaskEntry =
      asId(r.id) !== undefined ||
      asText(r.subject) !== undefined ||
      asText(r.content) !== undefined ||
      asText(r.description) !== undefined;
    return isTaskEntry ? "deleted" : undefined;
  }
  const id = asId(r.id) ?? fallbackId;
  const subject = asText(r.subject) ?? asText(r.content) ?? asText(r.description);
  if (subject === undefined) return undefined;
  return buildTodo(id, subject, status, asText(r.activeForm));
}

interface StatTaskFile {
  readonly name: string;
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

async function statClaudeTaskFiles(
  dir: string,
  sessionId: string,
): Promise<{ readonly sig: string; readonly files: readonly StatTaskFile[] } | null> {
  if (!isSessionId(sessionId)) return null;
  const sessionDir = await containedRealpath(join(dir, sessionId), dir);
  if (sessionDir === null) return null;
  let names: string[];
  try {
    names = await readdir(sessionDir);
  } catch {
    return null;
  }
  const candidates = names
    .filter((name) => TASK_FILE_RE.test(name))
    .toSorted((a, b) => Number(a.slice(0, -5)) - Number(b.slice(0, -5)))
    .slice(0, MAX_TASK_FILES);
  if (candidates.length === 0) return null;

  const files: StatTaskFile[] = [];
  const parts: string[] = [];
  for (const name of candidates) {
    const filePath = await containedRealpath(join(sessionDir, name), sessionDir);
    if (filePath === null) continue;
    const st = await statFile(filePath);
    if (st === null || st.size > TASK_FILE_MAX_BYTES) continue;
    files.push({ name, path: filePath, size: st.size, mtimeMs: st.mtimeMs });
    parts.push(`${name}:${String(st.size)}:${String(st.mtimeMs)}`);
  }
  if (files.length === 0) return null;
  return { sig: parts.join("|"), files };
}

async function readClaudeTaskFiles(files: readonly StatTaskFile[]): Promise<PaneTodo[] | undefined> {
  const todos: PaneTodo[] = [];
  let sawRecord = false;
  for (const file of files) {
    if (todos.length >= MAX_TODOS) break;
    try {
      const text = await Bun.file(file.path).slice(0, TASK_FILE_MAX_BYTES).text();
      const record = parseJsonObject(text);
      if (record === null) continue;
      const parsed = parseClaudeTaskRecord(record, file.name.slice(0, -5));
      if (parsed === undefined) continue;
      sawRecord = true;
      if (parsed !== "deleted") todos.push(parsed);
    } catch {
      continue;
    }
  }
  if (!sawRecord) return undefined;
  return todos;
}

/**
 * Read Claude Code's on-disk `<tasksDir>/<sessionId>/<n>.json` files, when any exist.
 *
 * Every path goes through `containedRealpath` after validating `sessionId` as a canonical UUID.
 * Missing, empty, malformed or escaping directories return `undefined`; a directory whose valid task
 * files are all marked `deleted` returns `[]` so the caller can clear stale journal tasks.
 */
export async function readClaudeTasks(dir: string, sessionId: string): Promise<PaneTodo[] | undefined> {
  const st = await statClaudeTaskFiles(dir, sessionId);
  if (st === null) return undefined;
  return readClaudeTaskFiles(st.files);
}

function parseTodoItems(items: readonly JsonValue[]): PaneTodo[] {
  const out: PaneTodo[] = [];
  for (let i = 0; i < items.length && out.length < MAX_TODOS; i++) {
    const r = asRecord(items[i]);
    if (r === null) continue;
    const status = parseStatus(r.status) ?? "pending";
    if (status === "deleted") continue;
    const text = asText(r.content) ?? asText(r.step) ?? asText(r.subject) ?? asText(r.title);
    if (text === undefined) continue;
    const id = asId(r.id) ?? String(i + 1);
    const todo = buildTodo(id, text, status, asText(r.activeForm));
    if (todo !== undefined) out.push(todo);
  }
  return out;
}

function mergeTodoItems(current: readonly PaneTodo[], items: readonly JsonValue[]): PaneTodo[] {
  const byId = new Map<string, PaneTodo>();
  for (const item of current) byId.set(item.id, item);
  for (let i = 0; i < items.length; i++) {
    const r = asRecord(items[i]);
    if (r === null) continue;
    const id = asId(r.id) ?? String(i + 1);
    const status = parseStatus(r.status);
    if (status === "deleted") {
      byId.delete(id);
      continue;
    }
    const prev = byId.get(id);
    const rawText = asText(r.content) ?? asText(r.step) ?? asText(r.subject) ?? prev?.text;
    if (rawText === undefined) continue;
    const todo = buildTodo(
      id,
      rawText,
      status ?? prev?.status ?? "pending",
      asText(r.activeForm) ?? prev?.activeForm,
    );
    if (todo !== undefined) byId.set(id, todo);
  }
  return [...byId.values()].slice(0, MAX_TODOS);
}

function maxNumericId(todos: Iterable<PaneTodo>): number {
  let max = 0;
  for (const t of todos) {
    const n = Number(t.id);
    if (Number.isInteger(n) && n > max) max = n;
  }
  return max;
}

function sortTasks(tasks: Iterable<PaneTodo>): PaneTodo[] {
  return [...tasks]
    .toSorted((a, b) => {
      const na = Number(a.id);
      const nb = Number(b.id);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      return a.id.localeCompare(b.id);
    })
    .slice(0, MAX_TODOS);
}

/**
 * Extract the latest todo list from raw journal lines (Claude `TaskCreate`/`TaskUpdate`/`TodoWrite`,
 * OpenCode `todowrite`, Codex `update_plan`, Grok `todo_write`).
 *
 * Pure — no fs, no clock. If `lines` holds no todo tool calls at all, returns `previous` unchanged.
 */
export function parseJournalTodos(
  lines: readonly string[],
  previous?: readonly PaneTodo[],
): PaneTodo[] | undefined {
  const parsedRows: JsonObject[] = [];
  const assignedIds = new Map<string, string>();
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed === "") continue;
    const row = parseJsonObject(trimmed);
    if (row === null) continue;
    parsedRows.push(row);
    if (row.type === "user" && row.isSidechain !== true) {
      const result = asRecord(row.toolUseResult);
      const realId = asId(asRecord(result?.task)?.id);
      if (realId === undefined) continue;
      const msg = asRecord(row.message);
      const blocks = Array.isArray(msg?.content) ? msg.content : [];
      for (const block of blocks) {
        const b = asRecord(block);
        const callId = b?.type === "tool_result" ? asText(b.tool_use_id) : undefined;
        if (callId !== undefined) assignedIds.set(callId, realId);
      }
    }
  }

  // Collect task ids whose TaskCreate is inside `lines` so `taskMap` only pre-seeds tasks that were
  // created BEFORE this window (scrolled off the 64 KiB tail), never tasks created later inside `lines`.
  const createdInLines = new Set<string>();
  for (const row of parsedRows) {
    if (row.isSidechain === true || asText(row.type) !== "assistant") continue;
    const msg = asRecord(row.message);
    if (msg === null || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      const b = asRecord(block);
      if (b === null || b.type !== "tool_use" || asText(b.name) !== "TaskCreate") continue;
      const input = asRecord(b.input);
      if (input === null || (asText(input.subject) ?? asText(input.description)) === undefined) continue;
      const callId = asText(b.id);
      if (callId !== undefined) {
        createdInLines.add(assignedIds.get(callId) ?? `pending:${callId}`);
      }
    }
  }

  const previousIds = new Set<string>();
  const taskMap = new Map<string, PaneTodo>();
  if (previous !== undefined) {
    for (const item of previous) {
      if (item.id.startsWith("pending:")) continue;
      previousIds.add(item.id);
      if (!createdInLines.has(item.id)) {
        taskMap.set(item.id, { ...item });
      }
    }
  }
  let nextId = maxNumericId(taskMap.values()) + 1;
  let touched = false;

  const replaceAll = (items: readonly PaneTodo[]): void => {
    touched = true;
    taskMap.clear();
    for (const item of items) taskMap.set(item.id, item);
    nextId = maxNumericId(taskMap.values()) + 1;
  };

  for (const row of parsedRows) {
    // 1. OpenCode composed line: `{ parts: [{ data: { type: "tool", tool|name: "todowrite", state: { input } } }] }`
    if (Array.isArray(row.parts)) {
      for (const part of row.parts) {
        const p = asRecord(part);
        const d = asRecord(p?.data);
        if (d === null || d.type !== "tool") continue;
        const name = (asText(d.tool) ?? asText(d.name) ?? "").toLowerCase();
        if (name !== "todowrite" && name !== "todo_write") continue;
        const state = asRecord(d.state);
        const input = asInputObject(state?.input);
        if (input !== null && Array.isArray(input.todos)) {
          replaceAll(parseTodoItems(input.todos));
        }
      }
      continue;
    }

    const type = asText(row.type);

    // 2. Codex `response_item` -> `function_call` -> `update_plan`
    if (type === "response_item") {
      const payload = asRecord(row.payload);
      if (payload === null || payload.type !== "function_call") continue;
      const name = (asText(payload.name) ?? "").toLowerCase();
      if (name === "update_plan") {
        const input = asInputObject(payload.arguments);
        if (input !== null && Array.isArray(input.plan)) {
          replaceAll(parseTodoItems(input.plan));
        }
      } else if (name === "todowrite" || name === "todo_write") {
        const input = asInputObject(payload.arguments);
        if (input !== null && Array.isArray(input.todos)) {
          replaceAll(parseTodoItems(input.todos));
        }
      }
      continue;
    }

    if (row.isSidechain === true) continue;

    // 3. Grok `assistant` row with `tool_calls`
    if (type === "assistant" && Array.isArray(row.tool_calls)) {
      for (const call of row.tool_calls) {
        const c = asRecord(call);
        if (c === null) continue;
        const name = (asText(c.name) ?? "").toLowerCase();
        if (name !== "todo_write" && name !== "todowrite") continue;
        const input = asInputObject(c.arguments);
        if (input === null || !Array.isArray(input.todos)) continue;
        if (input.merge === true) {
          replaceAll(mergeTodoItems([...taskMap.values()], input.todos));
        } else {
          replaceAll(parseTodoItems(input.todos));
        }
      }
    }

    // 4. Claude `assistant` row with `message.content` `tool_use` blocks
    if (type === "assistant") {
      const msg = asRecord(row.message);
      if (msg === null || !Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        const b = asRecord(block);
        if (b === null || b.type !== "tool_use") continue;
        const name = asText(b.name);
        const input = asRecord(b.input);
        if (name === undefined || input === null) continue;

        if (name === "TodoWrite" && Array.isArray(input.todos)) {
          replaceAll(parseTodoItems(input.todos));
        } else if (name === "TaskCreate") {
          const subject = asText(input.subject) ?? asText(input.description);
          if (subject === undefined) continue;
          const callId = asText(b.id);
          const assigned = callId === undefined ? undefined : assignedIds.get(callId);
          const taskId = assigned ?? (callId !== undefined ? `pending:${callId}` : String(nextId++));
          const numId = Number(taskId);
          if (Number.isInteger(numId) && numId >= nextId) nextId = numId + 1;
          // Start a fresh batch when all prior tasks in `taskMap` are completed, unless `taskId` and
          // every scrolled-off task currently in `taskMap` already coexisted in `previous`.
          const coexistedInPrevious =
            previousIds.has(taskId) && [...taskMap.keys()].every((id) => previousIds.has(id));
          if (
            !taskMap.has(taskId) &&
            !coexistedInPrevious &&
            taskMap.size > 0 &&
            [...taskMap.values()].every((t) => t.status === "completed")
          ) {
            taskMap.clear();
          }
          const todo = buildTodo(taskId, subject, "pending", asText(input.activeForm));
          if (todo === undefined) continue;
          touched = true;
          taskMap.set(taskId, todo);
        } else if (name === "TaskUpdate") {
          const taskId = asId(input.taskId);
          if (taskId === undefined) continue;
          const status = parseStatus(input.status);
          if (status === "deleted") {
            if (taskMap.delete(taskId)) touched = true;
            continue;
          }
          const existing = taskMap.get(taskId);
          if (existing === undefined) continue;
          const rawSubject = asText(input.subject);
          const rawActive = asText(input.activeForm);
          const nextText = rawSubject === undefined ? existing.text : clipLine(rawSubject, TODO_TEXT_MAX);
          const nextActive = rawActive === undefined ? existing.activeForm : clipLine(rawActive, TODO_TEXT_MAX);
          const updated = buildTodo(taskId, nextText, status ?? existing.status, nextActive);
          if (updated !== undefined) {
            touched = true;
            taskMap.set(taskId, updated);
          }
        }
      }
      continue;
    }

    // 5. Claude `user` row with `toolUseResult.tasks` (from `TaskList`)
    if (type === "user") {
      const result = asRecord(row.toolUseResult);
      if (result === null || !Array.isArray(result.tasks)) continue;
      if (result.tasks.length === 0) {
        replaceAll([]);
        continue;
      }
      const listed: PaneTodo[] = [];
      let sawTaskRecord = false;
      for (const item of result.tasks) {
        const r = asRecord(item);
        if (r === null) continue;
        const parsed = parseClaudeTaskRecord(r, String(listed.length + 1));
        if (parsed === undefined) continue;
        sawTaskRecord = true;
        if (parsed !== "deleted") {
          const prev = taskMap.get(parsed.id);
          if (parsed.activeForm === undefined && prev?.activeForm !== undefined) {
            parsed.activeForm = prev.activeForm;
          }
          listed.push(parsed);
        }
      }
      if (sawTaskRecord) replaceAll(listed);
    }
  }

  if (!touched) return previous !== undefined && previous.length > 0 ? [...previous] : undefined;
  const sorted = sortTasks(taskMap.values());
  return sorted.length > 0 ? sorted : undefined;
}

export interface TodoTrackerOptions {
  floorMs?: number;
  opencodeFloorMs?: number;
  /** Where Claude Code writes per-session task JSON files. A containment root, never a request input. */
  tasksDir?: string;
  /** The tail read, injectable so a test counts reads instead of opening files. */
  tail?: (source: TranscriptSource, ref: AgentSessionRef, bytes?: number) => Promise<ProbeTail | null>;
}

interface Seen {
  size: number;
  mtimeMs: number;
}

interface TasksSeen {
  sig: string;
  todos: PaneTodo[] | undefined;
}

interface Entry {
  session: string | undefined;
  paneId: string;
  lastProbedAt: number;
  journalSeen?: Seen;
  tasksSeen?: TasksSeen;
  todos?: PaneTodo[];
}

interface Found {
  session: string | undefined;
  harness: string;
  cwd: string;
  at: number;
  ref: AgentSessionRef | undefined;
}

export class TodoTracker {
  private readonly bySession = new Map<string, Entry>();

  /** The session a ref-less pane was found to run, per pane id, held for one floor. */
  private readonly found = new Map<string, Found>();

  private readonly floorMs: number;

  private readonly opencodeFloorMs: number;

  private readonly tasksDir: string;

  private readonly tail: NonNullable<TodoTrackerOptions["tail"]>;

  private pendingRefresh: Promise<void> = Promise.resolve();

  constructor(
    private readonly registry: Record<string, JournalAdapter>,
    private readonly now: () => number,
    options: TodoTrackerOptions = {},
  ) {
    this.floorMs = options.floorMs ?? DEFAULT_TODO_FLOOR_MS;
    this.opencodeFloorMs = options.opencodeFloorMs ?? DEFAULT_OPENCODE_TODO_FLOOR_MS;
    this.tasksDir = options.tasksDir ?? DEFAULT_TASKS_DIR;
    this.tail = options.tail ?? ((source, ref, bytes = TODO_TAIL_BYTES) => probeTail(source, ref, bytes));
  }

  /** The active todo list for this pane as it is now, or undefined when there are none. */
  get(pane: AgentView): PaneTodo[] | undefined {
    const harness = journalAgentOf(pane);
    const found = this.found.get(pane.paneId);
    const discovered =
      found !== undefined && found.harness === harness && found.cwd === pane.cwd ? found.ref?.value : undefined;
    const key = pane.agentSession?.value ?? discovered;
    const list = key === undefined ? undefined : this.bySession.get(key)?.todos;
    return list !== undefined && list.length > 0 ? list : undefined;
  }

  /** Walk the panes and bring their todo readings up to date. Serialised and NEVER THROWS. */
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
        const harness = journalAgentOf(pane);
        const loaded = LOADED_TODO_AGENTS.has(harness);
        const tailed = TAILED_TODO_AGENTS.has(harness);
        const adapter = tailed || loaded ? adapterFor(this.registry, harness) : undefined;
        const floor = loaded ? this.opencodeFloorMs : this.floorMs;
        if (pane.agentSession !== undefined) {
          this.found.delete(pane.paneId);
        }
        const ref = pane.agentSession ?? (await this.discover(adapter, pane, harness, at, session, floor));
        named.set(pane.paneId, ref?.value);
        if (ref === undefined) continue;
        // Only a multiplexer-reported Claude session id may read `<tasksDir>/<sessionId>`.
        const explicitClaudeId =
          harness === "claude" && pane.agentSession?.kind === "id" ? pane.agentSession.value : undefined;
        if (adapter === undefined && explicitClaudeId === undefined) continue;
        const previous = this.bySession.get(ref.value);
        const owner = { session, paneId: pane.paneId };
        if (previous !== undefined && at - previous.lastProbedAt < floor) {
          this.bySession.set(ref.value, { ...previous, ...owner });
          continue;
        }
        const next: Entry = { ...previous, ...owner, lastProbedAt: at };
        if (adapter !== undefined) await this.lookJournal(adapter, ref, next, loaded);
        if (explicitClaudeId !== undefined) await this.lookTasks(explicitClaudeId, next);
        this.bySession.set(ref.value, next);
      }
      for (const [key, entry] of this.bySession) {
        if (entry.session === session && departed(named, key, entry.paneId)) this.bySession.delete(key);
      }
      for (const [paneId, found] of this.found) {
        if (found.session === session && !named.has(paneId)) this.found.delete(paneId);
      }
    } catch {
      // Never throws: a poll failure leaves the previous readings intact.
    }
  }

  private async discover(
    adapter: JournalAdapter | undefined,
    pane: AgentView,
    harness: string,
    at: number,
    session: string | undefined,
    floor: number,
  ): Promise<AgentSessionRef | undefined> {
    if (adapter?.discover === undefined) {
      this.found.delete(pane.paneId);
      return undefined;
    }
    const seen = this.found.get(pane.paneId);
    const sameContext = seen !== undefined && seen.harness === harness && seen.cwd === pane.cwd;
    if (sameContext && at - seen.at < floor) return seen.ref;
    let ref = sameContext ? seen.ref : undefined;
    try {
      ref = (await adapter.discover(pane.cwd)) ?? undefined;
    } catch {
      // A walk that threw: the last answer for this same harness + cwd stands until the next floor.
    }
    this.found.set(pane.paneId, { session, harness, cwd: pane.cwd, at, ref });
    return ref;
  }

  private async lookJournal(
    adapter: JournalAdapter,
    ref: AgentSessionRef,
    entry: Entry,
    loaded: boolean,
  ): Promise<void> {
    let seen: Seen | null;
    try {
      const path = await adapter.source.resolve(ref);
      seen = path === null ? null : await adapter.source.stat(path);
    } catch {
      seen = null;
    }
    if (seen === null) return;
    if (entry.journalSeen?.size === seen.size && entry.journalSeen.mtimeMs === seen.mtimeMs) return;
    try {
      const tail = loaded ? await loadWhole(adapter.source, ref) : await this.tail(adapter.source, ref, TODO_TAIL_BYTES);
      if (tail === null) return;
      const todos = parseJournalTodos(tail.lines, entry.todos);
      if (todos === undefined) delete entry.todos;
      else entry.todos = todos;
      entry.journalSeen = seen;
    } catch {
      // An I/O or grammar error on a foreign line: keep the last reading, retry at the next floor.
    }
  }

  private async lookTasks(sessionId: string, entry: Entry): Promise<void> {
    try {
      const st = await statClaudeTaskFiles(this.tasksDir, sessionId);
      if (st === null) {
        delete entry.tasksSeen;
        return;
      }
      let disk: PaneTodo[] | undefined;
      if (entry.tasksSeen?.sig === st.sig) {
        disk = entry.tasksSeen.todos;
      } else {
        disk = await readClaudeTaskFiles(st.files);
        entry.tasksSeen = { sig: st.sig, todos: disk };
      }
      if (disk !== undefined) {
        if (disk.length === 0) delete entry.todos;
        else entry.todos = disk;
      }
    } catch {
      // An I/O failure mid-read: the journal or last reading stands until the next floor.
    }
  }
}

/** A database-backed session read whole through `source.load`, shaped like a tail read. */
async function loadWhole(source: TranscriptSource, ref: AgentSessionRef): Promise<ProbeTail | null> {
  try {
    const path = await source.resolve(ref);
    if (path === null) return null;
    const read = await source.load(path);
    return { path, lines: read.text.split("\n"), mtimeMs: read.mtimeMs };
  } catch {
    return null;
  }
}

/** Has the pane this entry was read for left the session's list? Same rule as the cache tracker. */
function departed(named: Map<string, string | undefined>, key: string, paneId: string): boolean {
  if (!named.has(paneId)) return true;
  const now = named.get(paneId);
  return now !== undefined && now !== key;
}
