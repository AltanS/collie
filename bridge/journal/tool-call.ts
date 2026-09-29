// The STRUCTURED form of a tool call, shared by every harness adapter.
//
// WHY THIS EXISTS ALONGSIDE `summary`. `summarizeToolInput` (text.ts) collapses a call to one line,
// which is all the transcript view has ever needed: a row that reads "src/app.ts" under the name
// "Read". A card that draws the call properly needs more than a line — which file, how many lines
// moved, whether the command exited non-zero, whether the person denied it. Those are DIFFERENT
// questions per kind of call, so the answer is a discriminated union rather than more optional
// fields on one shape.
//
// The union is deliberately SMALL and closed. Nine kinds cover every tool the six adapters have met,
// because tool vocabularies overlap almost completely: each harness has a read, a shell, a grep and
// an edit under some spelling. A tool outside the nine is not an error, it is `other`, and it still
// carries a name and a summary, so an unrecognised tool degrades to exactly what the view drew
// before this module existed.
//
// It is ADDITIVE. `TranscriptPart`'s tool branch keeps `name` and `summary`, and `call` sits beside
// them. Nothing that reads the journal today has to change, and an adapter that has not been taught
// to fill `call` simply leaves it absent.

import type { JsonObject, JsonValue } from "../json.ts";

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
 * What a tool call did, in the shape the thing it did suggests.
 *
 * Every branch's FIRST field is the one a person would name the call by (the path, the command, the
 * query), so a view can draw a row from `kind` plus one field and fill the rest in when it has room.
 */
export type ToolCall =
  /** A file changed. `added`/`removed` count diff lines, not characters. `created`: the file is new. */
  | { kind: "edit"; path: string; added: number; removed: number; diff?: Hunk[]; created?: boolean }
  /** A command ran. `exitCode` is absent where the harness does not record one. */
  | { kind: "execute"; command: string; description?: string; exitCode?: number }
  /** A file was read. `range` is [firstLine, lastLine], absent for a whole-file read. */
  | { kind: "read"; path: string; range?: [number, number] }
  /** A search over files or the web. `where` is the path, the glob, or "web". */
  | { kind: "search"; query: string; where?: string; hits?: number }
  /** A page was fetched. */
  | { kind: "fetch"; url: string }
  /** A file was removed or renamed. `to` is the destination of a move. */
  | { kind: "delete" | "move"; path: string; to?: string }
  /** A subagent ran. */
  | { kind: "task"; agent: string; summary: string }
  /** Anything else, including a tool this code has never heard of. */
  | { kind: "other"; name: string; summary: string };

/**
 * The tool names each kind answers to, lower-cased.
 *
 * Harnesses spell the same tool differently and every one of these has been seen in a real log:
 * Claude writes `Bash` and `Edit`, Codex writes `shell` and `apply_patch`, opencode and pi write
 * `bash` and `edit`. Matching on a lower-cased name rather than per adapter is what stops this table
 * from being copied six times and drifting five ways.
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
  // execute
  bash: "execute",
  shell: "execute",
  execute: "execute",
  run: "execute",
  bashoutput: "execute",
  exec_command: "execute",
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
  // fetch
  webfetch: "fetch",
  web_fetch: "fetch",
  fetch: "fetch",
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
      const description = str(o, "description");
      if (description !== undefined) call.description = description;
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
      const call: ToolCall = { kind: "search", query: str(o, "pattern", "query", "q") ?? "" };
      const where = str(o, "path", "glob", "include") ?? (name.toLowerCase().includes("web") ? "web" : undefined);
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
    case "task":
      return {
        kind: "task",
        agent: str(o, "subagent_type", "agent", "agent_type") ?? "agent",
        summary: str(o, "description", "task") ?? summary,
      };
    default:
      return { kind: "other", name, summary };
  }
}
