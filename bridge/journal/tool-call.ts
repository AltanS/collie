// The STRUCTURED form of a tool call, shared by every harness adapter.
//
// WHY THIS EXISTS ALONGSIDE `summary`. `summarizeToolInput` (text.ts) collapses a call to one line,
// which is all the transcript view has ever needed: a row that reads "src/app.ts" under the name
// "Read". A card that draws the call properly needs more than a line — which file, how many lines
// moved, whether the command exited non-zero, whether the person denied it. Those are DIFFERENT
// questions per kind of call, so the answer is a discriminated union rather than more optional
// fields on one shape.
//
// The union is deliberately SMALL and closed. Ten kinds cover every tool the seven adapters have met,
// because tool vocabularies overlap almost completely: each harness has a read, a shell, a grep and
// an edit under some spelling. The tenth, `plan`, is a task list the agent keeps rewriting (ADR 0119):
// it fits none of the nine, and as `other` every update is a line that says only that the list
// changed. A tool outside the ten is not an error, it is `other`, and it still carries a name and a
// summary, so an unrecognised tool degrades to exactly what the view drew before this module existed.
//
// It is ADDITIVE. `TranscriptPart`'s tool branch keeps `name` and `summary`, and `call` sits beside
// them. Nothing that reads the journal today has to change, and an adapter that has not been taught
// to fill `call` simply leaves it absent.

import type { JsonObject, JsonValue } from "../json.ts";
import { clamp, oneLine } from "./text.ts";

/**
 * One hunk of a unified diff.
 *
 * `lines` are the diff's own lines, each already carrying its marker: " ", "+" or "-". They are kept
 * as the harness wrote them rather than re-derived, because a harness that computed the diff against
 * the file it actually wrote knows more than we can reconstruct from the input.
 */
export interface Hunk {
  header: string;
  lines: string[];
}

/**
 * One question an agent put to the operator. Field names follow opencode's `question` tool, which
 * Claude Code's AskUserQuestion matches apart from the spelling of `multiple` (`multiSelect`).
 */
export interface ToolQuestion {
  header?: string;
  question: string;
  multiple: boolean;
  options: readonly { label: string; description?: string }[];
}

/** Where a task stands. Other harnesses' words are mapped onto these five by {@link planTasks}. */
export type PlanStatus = "pending" | "in_progress" | "done" | "blocked" | "dropped";

/** One entry of a plan: a title, where it stands, and the agent's own note on it when it wrote one. */
export interface PlanTask {
  title: string;
  status: PlanStatus;
  note?: string;
}

/**
 * What a tool call did, in the shape the thing it did suggests.
 *
 * Every branch's FIRST field is the one a person would name the call by (the path, the command, the
 * query), so a view can draw a row from `kind` plus one field and fill the rest in when it has room.
 */
export type ToolCall =
  /** A file changed. `added`/`removed` count diff lines, not characters. `created`: the file is new. */
  | { kind: "edit"; path: string; added: number; removed: number; diff?: Hunk[]; created?: boolean }
  /** A command ran. `exitCode` is absent where the harness does not record one. */
  | { kind: "execute"; command: string; description?: string; exitCode?: number; background?: true; ongoing?: true }
  /** A file was read. `range` is [firstLine, lastLine], absent for a whole-file read. */
  | { kind: "read"; path: string; range?: [number, number] }
  /** A search over files or the web. `where` is the path, the glob, or "web". */
  | { kind: "search"; query: string; where?: string; hits?: number }
  /** A page was fetched. */
  | { kind: "fetch"; url: string }
  /** A file was removed or renamed. `to` is the destination of a move. */
  | { kind: "delete" | "move"; path: string; to?: string }
  /**
   * A subagent ran. `agentId` names the subagent's own log when the harness records one. `ongoing`:
   * it returned before its work ended and no end notice has arrived.
   */
  | { kind: "task"; agent?: string; summary: string; agentId?: string; ongoing?: true }
  /** A task list the agent keeps up to date (ADR 0119). The list is the whole list as of this call. */
  | { kind: "plan"; name: string; tasks: readonly PlanTask[] }
  /**
   * The agent asked the operator to choose. One entry per question the call carried. `answers[i]` is
   * the list of chosen labels for question `i`, present only once the call completed with answers.
   * Keyed on the input's SHAPE (see {@link classifyToolCall}), never on the tool's name.
   */
  | { kind: "question"; name: string; summary: string; questions: readonly ToolQuestion[]; answers?: readonly (readonly string[])[] }
  /** Anything else, including a tool this code has never heard of. */
  | { kind: "other"; name: string; summary: string; quiet?: true };

/**
 * The tool names each kind answers to, lower-cased.
 *
 * Harnesses spell the same tool differently and every one of these has been seen in a real log:
 * Claude writes `Bash` and `Edit`, Codex writes `shell` and `apply_patch`, opencode and pi write
 * `bash` and `edit`. Matching on a lower-cased name rather than per adapter is what stops this table
 * from being copied seven times and drifting six ways.
 */
const NAMES = {
  // edit
  edit: "edit",
  multiedit: "edit",
  write: "edit",
  notebookedit: "edit",
  apply_patch: "edit",
  str_replace_editor: "edit",
  patch: "edit",
  // Muse's file verbs (bridge/journal/muse.ts): without these its workhorse calls read as `other`.
  edit_file: "edit",
  write_file: "edit",
  // Kiro's file verbs (bridge/journal/kiro.ts).
  fs_write: "edit",
  str_replace: "edit",
  // execute
  bash: "execute",
  shell: "execute",
  execute: "execute",
  // Codex's `custom_tool_call` names its shell tool `exec`, and it is the one it uses for everything
  // — a read, an `apply_patch`, a command. Without this the common codex call reads as `other`.
  exec: "execute",
  run: "execute",
  bashoutput: "execute",
  exec_command: "execute",
  // Kiro's shell tool.
  execute_bash: "execute",
  // Gentle Shell's jobs return at once and end later; `background` marks them (see below).
  bash_background: "execute",
  monitor: "execute",
  // read
  read: "read",
  read_file: "read",
  view: "read",
  // search
  grep: "search",
  glob: "search",
  websearch: "search",
  web_search: "search",
  search: "search",
  list: "search",
  ls: "search",
  google_search: "search",
  source_check: "search",
  // fetch
  webfetch: "fetch",
  web_fetch: "fetch",
  fetch: "fetch",
  fetch_content: "fetch",
  // delete / move
  delete: "delete",
  remove: "delete",
  rm: "delete",
  move: "move",
  rename: "move",
  // task
  task: "task",
  agent: "task",
  subagent: "task",
  subagent_run: "task",
  subagent_continue: "task",
  subagent_result: "task",
  // plan: Gentle Shell's `todo`, Claude's TodoWrite, Codex's update_plan
  todo: "plan",
  todowrite: "plan",
  update_plan: "plan",
} satisfies Record<string, ToolCall["kind"]>;

/** Read a string field, trimming and rejecting the empty string, so a caller can `??` past it. */
function str(o: JsonObject, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim() !== "") return v;
    // An argv array is how Codex spells a shell command (["bash","-lc","ls"]) and how pi spells a
    // multi-file tool. Joining is what `summarizeToolInput` already does, for the same reason.
    if (Array.isArray(v)) {
      const joined = v.filter((x): x is string => typeof x === "string").join(" ").trim();
      if (joined !== "") return joined;
    }
  }
  return undefined;
}

/** Read a number field. A harness that writes a numeric string still counts. */
function num(o: JsonObject, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  }
  return undefined;
}

/** Most questions one call may carry. A guard against a runaway input, not a limit any harness sets. */
const MAX_QUESTIONS = 9;
/** Most options one question may carry. */
const MAX_OPTIONS = 20;
const MAX_QUESTION_CHARS = 500;
const MAX_HEADER_CHARS = 80;
const MAX_LABEL_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 500;

/** Most tasks one plan may carry, and the longest title and note kept. Guards, not limits any harness sets. */
const MAX_TASKS = 200;
const MAX_TITLE_CHARS = 200;
const MAX_NOTE_CHARS = 500;
/** Longest `options` string worth parsing as JSON. */
const MAX_OPTIONS_JSON_CHARS = 20_000;

/** Tools that start work and answer before it ends; the end arrives as a notice (pi.ts). */
const BACKGROUND = new Set(["bash_background", "monitor"]);
/** Tools that only read or write bookkeeping; drawn quieter. */
const QUIET = new Set(["gentle_odd_phase", "job_list"]);
const WEB_SEARCH = new Set(["google_search", "source_check"]);

const PLAN_STATUS = {
  pending: "pending",
  todo: "pending",
  in_progress: "in_progress",
  "in-progress": "in_progress",
  inprogress: "in_progress",
  active: "in_progress",
  done: "done",
  completed: "done",
  complete: "done",
  blocked: "blocked",
  dropped: "dropped",
  cancelled: "dropped",
  canceled: "dropped",
} satisfies Record<string, PlanStatus>;

function isRecord(v: JsonValue | undefined): v is JsonObject {
  return v !== null && v !== undefined && typeof v === "object" && !Array.isArray(v);
}

/** A non-blank string, clamped, or `undefined`. */
function text(v: JsonValue | undefined, max: number): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? clamp(v.trim(), max).text : undefined;
}

/** A question's text exactly as {@link readQuestions} keeps it, so an answer keyed by the raw text can
 *  be matched to its question. */
export function questionKey(v: JsonValue | undefined): string | undefined {
  return text(v, MAX_QUESTION_CHARS);
}

/**
 * Chosen labels from a harness's answer value: one label, a list of them, or `{ answers }`. Clamped
 * and bounded as option labels are, so a picked option's label equals the one on the card.
 */
export function answerLabels(v: JsonValue | undefined): string[] {
  if (Array.isArray(v)) {
    return v.slice(0, MAX_OPTIONS).flatMap((label) => {
      const picked = text(label, MAX_LABEL_CHARS);
      return picked === undefined ? [] : [picked];
    });
  }
  if (isRecord(v)) return Array.isArray(v.answers) ? answerLabels(v.answers) : [];
  const picked = text(v, MAX_LABEL_CHARS);
  return picked === undefined ? [] : [picked];
}

/**
 * A task list as a plan reads it: an array of objects whose title is `title` (Gentle Shell),
 * `content` (Claude's TodoWrite) or `step` (Codex's update_plan). An unknown or missing status is
 * `pending`; an entry with no title is dropped rather than drawn as a blank row. Exported because pi
 * reads the same list off a result's `details.gentleTodo.tasks`, where the input does not hold it.
 */
export function planTasks(value: JsonValue | undefined): PlanTask[] {
  if (!Array.isArray(value)) return [];
  const tasks: PlanTask[] = [];
  for (const t of value.slice(0, MAX_TASKS)) {
    if (!isRecord(t)) continue;
    const title = text(t.title, MAX_TITLE_CHARS) ?? text(t.content, MAX_TITLE_CHARS) ?? text(t.step, MAX_TITLE_CHARS);
    if (title === undefined) continue;
    // SAFETY: an index with an arbitrary key; the miss is typed `undefined` and handled below.
    const status: PlanStatus | undefined =
      typeof t.status === "string" ? PLAN_STATUS[t.status.toLowerCase() as keyof typeof PLAN_STATUS] : undefined;
    const task: PlanTask = { title, status: status ?? "pending" };
    const note = text(t.note, MAX_NOTE_CHARS);
    if (note !== undefined) task.note = note;
    tasks.push(task);
  }
  return tasks;
}

/**
 * A single question spelled at the top of the input: `{ question, options }`, as Gentle Shell's
 * `ask_user_choice` and collie's `ask_user` write it. `options` is an array, or a string that parses
 * to one (`ask_user_choice` sometimes writes it as JSON text). Read as a one-entry `questions` list,
 * so the entry rules stay in {@link readQuestions}. A question with no options is not a question.
 */
function readLoneQuestion(o: JsonObject): ToolQuestion[] | undefined {
  if (typeof o.question !== "string") return undefined;
  let options: JsonValue | undefined = o.options;
  if (typeof options === "string" && options.length <= MAX_OPTIONS_JSON_CHARS) {
    try {
      // SAFETY: `JSON.parse` output IS a JsonValue by construction.
      options = JSON.parse(options) as JsonValue;
    } catch {
      return undefined;
    }
  }
  if (!Array.isArray(options)) return undefined;
  const entry: JsonObject = { question: o.question, options };
  if (o.header !== undefined) entry.header = o.header;
  if (o.multiple !== undefined) entry.multiple = o.multiple;
  if (o.multiSelect !== undefined) entry.multiSelect = o.multiSelect;
  return readQuestions({ questions: [entry] });
}

/**
 * Read an input's `questions` list, or `undefined` when it holds nothing a person could answer.
 *
 * The SHAPE is the rule, not the tool name: opencode's `question` and Claude Code's AskUserQuestion
 * spell the same list, and a third harness that copies the shape gets the card for free. An entry
 * needs a string `question` and an `options` array. Options are strings or `{label, description}`.
 * A malformed entry is dropped rather than thrown on, because this is a value off somebody else's
 * disk, and a list with nothing valid left is not a question at all.
 */
function readQuestions(o: JsonObject): ToolQuestion[] | undefined {
  if (!Array.isArray(o.questions) || o.questions.length === 0) return undefined;
  const questions: ToolQuestion[] = [];
  for (const q of o.questions.slice(0, MAX_QUESTIONS)) {
    if (!isRecord(q) || !Array.isArray(q.options)) continue;
    const question = text(q.question, MAX_QUESTION_CHARS);
    if (question === undefined) continue;
    const options: ToolQuestion["options"][number][] = [];
    for (const opt of q.options.slice(0, MAX_OPTIONS)) {
      const label = text(isRecord(opt) ? opt.label : opt, MAX_LABEL_CHARS);
      if (label === undefined) continue;
      const entry: ToolQuestion["options"][number] = { label };
      const description = isRecord(opt) ? text(opt.description, MAX_DESCRIPTION_CHARS) : undefined;
      if (description !== undefined) entry.description = description;
      options.push(entry);
    }
    // Muse spells multi-select as a nested `selection: {mode: "multiple", …}` instead of a flag.
    const selectionMultiple = isRecord(q.selection) && q.selection.mode === "multiple";
    const parsed: ToolQuestion = {
      question,
      multiple: q.multiple === true || q.multiSelect === true || selectionMultiple,
      options,
    };
    const header = text(q.header, MAX_HEADER_CHARS);
    if (header !== undefined) parsed.header = header;
    questions.push(parsed);
  }
  return questions.length > 0 ? questions : undefined;
}

/**
 * Classify a tool call from its name and input alone.
 *
 * This is the part that is the SAME for every harness, and it is all a file-mode adapter can do on
 * its own: the input says what was asked for, never what happened. Diff hunks, exit codes and hit
 * counts live in the RESULT row, which each adapter folds in itself (see `claudeToolCall`), because
 * result shapes are where harnesses genuinely differ.
 *
 * `summary` is passed in rather than recomputed so the `other` branch says exactly what the row's
 * one-line form says. One call, one sentence, whichever field a view reads.
 */
export function classifyToolCall(name: string, input: JsonValue | undefined, summary: string): ToolCall {
  const o: JsonObject = input !== null && typeof input === "object" && !Array.isArray(input) ? input : {};
  // A question is recognised by its input, so it outranks the name table: opencode calls the tool
  // `question`, Claude Code `AskUserQuestion`, and neither spelling is worth a table entry.
  const questions = readQuestions(o) ?? readLoneQuestion(o);
  if (questions !== undefined) {
    // `oneLine` of the first question, so the one-line row reads as what was asked.
    return { kind: "question", name, summary: oneLine(questions[0]?.question ?? summary), questions };
  }
  // SAFETY: an index into a lookup table with an arbitrary key. The assertion widens the key, not the
  // value: the result is typed as possibly `undefined` above, and `default` handles that miss.
  const kind: ToolCall["kind"] | undefined = NAMES[name.toLowerCase() as keyof typeof NAMES];
  switch (kind) {
    case "edit":
      return { kind: "edit", path: str(o, "file_path", "notebook_path", "path", "filePath") ?? "", added: 0, removed: 0 };
    case "execute": {
      // Optional fields are ASSIGNED, never set to `undefined`: a key holding `undefined` survives a
      // deep compare and a structured clone, so "absent" has to mean absent (the repo's convention,
      // see `toolResult`).
      const call: ToolCall = { kind: "execute", command: str(o, "command", "cmd", "script") ?? "" };
      const description = str(o, "description", "label");
      if (description !== undefined) call.description = description;
      if (BACKGROUND.has(name.toLowerCase())) call.background = true;
      return call;
    }
    case "read": {
      const offset = num(o, "offset", "line", "startLine");
      const limit = num(o, "limit", "count");
      // A range is only meaningful when the call asked for one. `offset` alone means "from here to
      // the end", which has no last line to name, so it reads as a whole-file read with a start.
      const call: ToolCall = { kind: "read", path: str(o, "file_path", "path", "filePath") ?? "" };
      if (offset !== undefined && limit !== undefined) call.range = [offset, offset + limit];
      return call;
    }
    case "search": {
      // `pattern` outranks `path` for the same reason it does in `summarizeToolInput`: a Grep carries
      // both, and the pattern is what you searched for. A test pins that order there; this follows it.
      const call: ToolCall = { kind: "search", query: str(o, "pattern", "query", "q", "claim") ?? "" };
      const lower = name.toLowerCase();
      const where = str(o, "path", "glob", "include") ?? (lower.includes("web") || WEB_SEARCH.has(lower) ? "web" : undefined);
      if (where !== undefined) call.where = where;
      return call;
    }
    case "fetch":
      return { kind: "fetch", url: str(o, "url", "uri") ?? "" };
    case "delete":
    case "move": {
      const call: ToolCall = { kind, path: str(o, "file_path", "path", "source", "from") ?? "" };
      const to = str(o, "to", "destination", "new_path");
      if (to !== undefined) call.to = to;
      return call;
    }
    case "task": {
      // NO WORD STANDS IN FOR A MISSING NAME. A Claude Code Agent call that names no subagent type
      // carries its `model` ("opus", "sonnet") instead, and that says more than the word "agent" did.
      // With neither, the field is absent and the card draws plain "Agent".
      // Never `prompt`: it is the whole message to the agent, and the one-line summary is its name.
      const call: ToolCall = { kind: "task", summary: str(o, "description", "label", "task") ?? summary };
      const agent = str(o, "subagent_type", "agent", "agent_type") ?? str(o, "model");
      if (agent !== undefined) call.agent = agent;
      return call;
    }
    case "plan":
      // Hermes's `todo` with `merge: true` carries only the items it changed: drawn as the list, it
      // would claim every other task was gone.
      if (o.merge !== true) return { kind: "plan", name, tasks: planTasks(o.tasks ?? o.todos ?? o.plan) };
    // falls through
    default: {
      const call: ToolCall = { kind: "other", name, summary };
      const lower = name.toLowerCase();
      if (lower.startsWith("mem_") || QUIET.has(lower)) call.quiet = true;
      return call;
    }
  }
}
