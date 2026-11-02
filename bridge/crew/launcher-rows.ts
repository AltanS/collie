import { statSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import type { JsonObject, JsonValue } from "../json.ts";
import { addingBody, launcherItems, type MergedLaunchers } from "../launcher-adds.ts";
import type { Launcher, LauncherItem, LaunchersResponse } from "../types.ts";
import { expandHome } from "../worktree-folder.ts";
import { forwardError, type LeadMerge } from "./forward.ts";

// ── The lead's launcher rows, offered for every host of its crew (ADR 0127) ─────────────────────────
//
// `GET /api/launchers?host=<member>` still forwards to the member: only the member knows its agents,
// its home, its own rows and its one-off history. The lead then adds its own rows to that answer,
// each evaluated for the member: built from the member's harness list, marked `from: "lead"`, and
// unavailable with `no_folder` where the member said a pinned folder is not there. The member's own
// row wins on the same `command`, so every `key` in one answer stays unique.
//
// The folder question rides the forward as `?cwd=<path>`, once per pinned folder. A folder under the
// lead's home is asked as `~/...`, so the member reads it under ITS home: `/var/home/op/src` on the
// lead is `/home/op/src` on a member whose home is `/home/op`. A member that predates 0127 answers no
// `folders`, and the lead's rows then read as available, as the harness check alone says.

/** The query key of one folder question on the forwarded read. */
export const CWD_PARAM = "cwd";

/** The most folder questions one forward carries, and the most a member answers. */
export const MAX_FOLDER_QUESTIONS = 50;

/** What the lead brings to a member's answer. */
export interface LeadRows {
  /** The lead's merged rows: its `launchers.toml`, then the rows phones added there. */
  merged: MergedLaunchers;
  /** The lead's `launchers.toml` path, for the `adding` block. */
  file: string;
  /** The lead's home: a pinned `cwd` under it is asked, and shown, under the member's home. */
  home: string;
}

/**
 * A pinned `cwd` of the lead's as the member is asked it: `~` or `~/rel` when it sits under the
 * lead's home, written with `/`, else the path unchanged.
 */
export function folderQuestion(cwd: string, leadHome: string): string {
  if (!isAbsolute(cwd)) return cwd;
  if (cwd === leadHome) return "~";
  const rel = relative(leadHome, cwd);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return cwd;
  return `~/${rel.replaceAll(sep, "/")}`;
}

/** A folder question as a path on the member, under `memberHome` when it starts with `~`. */
export function folderOnMember(question: string, memberHome: string): string {
  if (question === "~") return memberHome;
  if (!question.startsWith("~/")) return question;
  // The member's own separator, read off its home: a Windows member answers `C:\Users\op`.
  const memberSep = memberHome.includes("\\") && !memberHome.includes("/") ? "\\" : "/";
  // The question is wire text, `/`-separated whatever either machine runs (see {@link folderQuestion}).
  const rel = question.slice(2).replaceAll("/", memberSep);
  return memberHome.endsWith(memberSep) ? `${memberHome}${rel}` : `${memberHome}${memberSep}${rel}`;
}

/**
 * Every pinned folder of the lead's rows, as asked, once each, at most {@link MAX_FOLDER_QUESTIONS}.
 * A `cwd` that is not absolute names no folder anyone can check, so it is not asked.
 */
export function folderQuestions(merged: MergedLaunchers, leadHome: string): string[] {
  const asked = new Set<string>();
  for (const row of merged.rows) {
    if (row.cwd === undefined || !isAbsolute(row.cwd)) continue;
    asked.add(folderQuestion(row.cwd, leadHome));
  }
  return [...asked].slice(0, MAX_FOLDER_QUESTIONS);
}

/** The phone's URL with the lead's folder questions in place of any `cwd` the phone sent. */
export function withFolderQuestions(url: URL, questions: readonly string[]): URL {
  const asked = new URL(url);
  asked.searchParams.delete(CWD_PARAM);
  for (const question of questions) asked.searchParams.append(CWD_PARAM, question);
  return asked;
}

/** Whether `path` is a folder on this machine. Never throws: a path with a NUL byte is no folder. */
function isFolderOnDisk(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
  } catch {
    return false;
  }
}

/**
 * The member's answer to the lead's folder questions: for each path as asked, whether it is a
 * folder here, `~` read as this machine's home. A path that is not absolute once expanded is no
 * folder. At most {@link MAX_FOLDER_QUESTIONS} are answered; the rest are left out.
 */
export function folderAnswers(
  asked: readonly string[],
  home: string,
  isFolder: (path: string) => boolean = isFolderOnDisk,
): Record<string, boolean> {
  const answers = asked.slice(0, MAX_FOLDER_QUESTIONS).map((question): [string, boolean] => {
    const path = expandHome(question, home);
    return [question, isAbsolute(path) && isFolder(path)];
  });
  // `fromEntries` defines each key as an own property, so a question named `__proto__` is one too.
  return Object.fromEntries(answers);
}

/**
 * Whether the member lacks the harness an agent row names (ADR 0127 point 2): its list has no entry
 * with that id that it found. A member with no list at all is not judged here.
 */
function harnessMissing(item: LauncherItem, member: LaunchersResponse): boolean {
  if (item.harness === undefined || member.harnesses === undefined) return false;
  return !member.harnesses.some((h) => h.id === item.harness && h.found);
}

/**
 * One of the lead's items as the member's answer carries it, judged on the member: `not_found` when
 * its harness is missing there, `no_folder` when its pinned folder is. The folder wins when both
 * apply, because it is the more concrete reason.
 */
function leadItem(item: LauncherItem, lead: LeadRows, member: LaunchersResponse): LauncherItem {
  const out: LauncherItem = { ...item, from: "lead" };
  if (harnessMissing(item, member)) {
    out.available = false;
    out.reason = "not_found";
  }
  if (item.cwd === undefined) return out;
  const question = folderQuestion(item.cwd, lead.home);
  out.cwd = folderOnMember(question, member.home);
  if (member.folders?.[question] !== false) return out;
  out.available = false;
  out.reason = "no_folder";
  return out;
}

/**
 * The member's answer with the lead's rows in it (ADR 0127): `items` is the member's own list
 * (starters first, ADR 0102), then the lead's rows the member does not hold under the same `command`;
 * `adding` is the lead's, where a phone's row now lands; `folders` goes, it was the lead's question.
 * `launchers`, `home`, `harnesses` and `recentRuns` stay the member's. A member with no `items` (older
 * than 1.19.0) is answered as forwarded: the phone reads it as an older Collie.
 */
export function withLeadRows(member: LaunchersResponse, lead: LeadRows): LaunchersResponse {
  if (member.items === undefined) return member;
  const own = new Set<string>();
  for (const item of member.items) if (item.command !== undefined) own.add(item.command);
  const leads = launcherItems(member.harnesses, lead.merged)
    .filter((item) => item.command !== undefined && !own.has(item.command))
    .map((item) => leadItem(item, lead, member));
  const out: LaunchersResponse = { ...member, items: [...member.items, ...leads], adding: addingBody(lead.merged, lead.file) };
  delete out.folders;
  return out;
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHarness(value: JsonValue): boolean {
  return isObject(value) && typeof value.id === "string" && typeof value.label === "string" && typeof value.found === "boolean";
}

function isItem(value: JsonValue): boolean {
  if (!isObject(value)) return false;
  if (typeof value.key !== "string" || typeof value.available !== "boolean") return false;
  return value.command === undefined || typeof value.command === "string";
}

/** Only the answers that are booleans: anything else is no answer, and the row stays as it is. */
function foldersOf(value: JsonValue | undefined): Record<string, boolean> | undefined {
  if (!isObject(value)) return undefined;
  const answers: [string, boolean][] = [];
  for (const [question, answer] of Object.entries(value)) if (typeof answer === "boolean") answers.push([question, answer]);
  return Object.fromEntries(answers);
}

/**
 * Whether a parsed body is a member's `GET /api/launchers` answer. Only the fields the merge reads are
 * checked: `home`, `launchers`, the harness list, and each item's `key`, `available` and `command`.
 * The rest goes on to the phone exactly as the forward has always passed it.
 */
function isMemberLaunchers(body: JsonValue): body is JsonObject & LaunchersResponse {
  if (!isObject(body) || typeof body.home !== "string" || !Array.isArray(body.launchers)) return false;
  if (body.harnesses !== undefined && !(Array.isArray(body.harnesses) && body.harnesses.every(isHarness))) return false;
  return body.items === undefined || (Array.isArray(body.items) && body.items.every(isItem));
}

/** A member's `GET /api/launchers` body, or `null` when it is not one. `folders` keeps its booleans only. */
export function parseMemberLaunchers(raw: string): LaunchersResponse | null {
  let body: JsonValue;
  try {
    // SAFETY: `JSON.parse` returns a JSON value by definition; `JsonValue` is the name for that type.
    body = JSON.parse(raw) as JsonValue;
  } catch {
    return null;
  }
  if (!isMemberLaunchers(body)) return null;
  const folders = foldersOf(body.folders);
  const member: LaunchersResponse = { ...body };
  if (folders === undefined) delete member.folders;
  else member.folders = folders;
  return member;
}

/**
 * The lead's merge into a forwarded `GET /api/launchers` (ADR 0127): the member is asked the lead's
 * folder questions, and its answer comes back with the lead's rows in it. `lead` is read once, on the
 * first use. An error, or a body that is not a launcher answer, goes on to the phone as forwarded.
 */
export function leadRowsRead(lead: () => Promise<LeadRows>, respond: (body: LaunchersResponse) => Response): LeadMerge {
  let read: Promise<LeadRows> | null = null;
  const rows = (): Promise<LeadRows> => {
    read ??= lead();
    return read;
  };
  return {
    ask: async (url) => {
      const { merged, home } = await rows();
      return withFolderQuestions(url, folderQuestions(merged, home));
    },
    answer: async (res) => {
      if (res.status !== 200 || res.body === null) return res;
      let raw: string;
      try {
        raw = await res.text();
      } catch (err) {
        return forwardError("host_unreachable", `the member's launcher rows broke off (${String(err)})`, 503);
      }
      const member = parseMemberLaunchers(raw);
      if (member === null) return new Response(raw, { status: res.status, headers: res.headers });
      return respond(withLeadRows(member, await rows()));
    },
  };
}

// ── A launch of a lead row on a member carries the row (ADR 0127 point 3) ───────────────────────────
//
// The phone names a row by its `command` and never sends a line. A member's allowlist is its own
// list, so a lead row it does not hold would be `launch.not_allowlisted` there. The lead therefore
// writes the row itself onto a forwarded `POST /api/launch` or `POST /api/worktree` body, under
// `row`, and marks that forward with {@link LEAD_ROW_HEADER}. The member runs a `row` only when the
// call came over the crew link AND carries the mark. Any `row` a phone sent is dropped on the way, so
// a phone can never name a line through the lead either.

/** The body field a lead row rides under. */
export const ROW_FIELD = "row";

/**
 * The request header that says "the lead itself carried this `row`" (ADR 0127 point 3). The lead adds
 * it on the forward, after `forwardHeaders` has built its allowlist and beside `X-Crew-Device`, and
 * only when {@link leadRowCarry} set `row` on the body.
 *
 * A header and not a body field, because a lead on a build before 0127 forwards a launch body
 * UNCHANGED: a `row` a phone wrote into its body would reach the member over the crew link exactly as
 * a carried one does. A header never crosses that way. `forwardHeaders` copies three named request
 * headers from the phone and no other, so a phone's own `X-Collie-Lead-Row` stops at the lead, and an
 * old lead never adds it. A body `row` without it is `launch.row_not_from_lead`, whoever calls.
 */
export const LEAD_ROW_HEADER = "X-Collie-Lead-Row";

/** The one value of {@link LEAD_ROW_HEADER}. Any other value is no mark. */
export const LEAD_ROW_MARK = "1";

/** Whether a request carries the lead's mark. Means something only on a call over the crew link. */
export function leadRowMarked(headers: Headers): boolean {
  return headers.get(LEAD_ROW_HEADER) === LEAD_ROW_MARK;
}

/** What a forwarded launch carries of a lead row. A type, not an interface, so it is a JSON object. */
export type CarriedRow = {
  command: string;
  label: string;
  /** The row's pinned folder as {@link folderQuestion} writes it: `~/rel` under the lead's home. */
  cwd?: string;
  harness?: string;
  noPrompts: boolean;
};

/** One of the lead's rows as the member is sent it: its folder written for the member's home. */
export function carriedRow(row: Launcher, leadHome: string): CarriedRow {
  const out: CarriedRow = { command: row.command, label: row.label, noPrompts: row.noPrompts === true };
  if (row.cwd !== undefined) out.cwd = folderQuestion(row.cwd, leadHome);
  if (row.harness !== undefined) out.harness = row.harness;
  return out;
}

/**
 * A launch body as the lead forwards it to a member: any `row` the phone sent is gone, and when the
 * body's `command` is one of `rows`, that row is set. The member's own row still wins there.
 */
export function withLeadRow(fields: JsonObject, rows: readonly Launcher[], leadHome: string): JsonObject {
  const out: JsonObject = { ...fields };
  delete out[ROW_FIELD];
  const command = typeof fields.command === "string" ? fields.command.trim() : "";
  const row = command === "" ? undefined : rows.find((r) => r.command === command);
  if (row === undefined) return out;
  out[ROW_FIELD] = carriedRow(row, leadHome);
  return out;
}

/** A forwarded write as the lead sends it: the request, and whether the lead carried its own row. */
export interface LeadWritten {
  request: Request;
  /**
   * True only when the lead set `row` on this body itself. The forward then adds
   * {@link LEAD_ROW_HEADER}; nothing else ever does.
   */
  leadRow: boolean;
}

/**
 * How the lead changes one forwarded write before the member gets it. Two routes pass one,
 * `POST /api/launch` and `POST /api/worktree`, and it runs only on a forward: a call the lead
 * answers itself keeps its body as the phone sent it.
 */
export interface LeadWrite {
  request(req: Request): Promise<LeadWritten>;
}

/**
 * The lead's {@link LeadWrite} for a launch: the body with {@link withLeadRow} applied, and `leadRow`
 * set when that put a row on it. `rows` is read once per forward, the list a launch on the lead itself
 * would match. A body that is not a JSON object, or one with no `row` that names no lead row, goes on
 * untouched and unmarked.
 */
export function leadRowCarry(rows: () => Promise<Launcher[]>, leadHome: string): LeadWrite {
  return {
    request: async (req) => {
      const untouched: LeadWritten = { request: req, leadRow: false };
      let body: JsonValue;
      try {
        // SAFETY: `Request.json()` output IS a JsonValue by construction; only `command` and `row` are read.
        body = (await req.clone().json()) as JsonValue;
      } catch {
        return untouched;
      }
      if (!isObject(body)) return untouched;
      const out = withLeadRow(body, await rows(), leadHome);
      if (body[ROW_FIELD] === undefined && out[ROW_FIELD] === undefined) return untouched;
      const headers = new Headers(req.headers);
      headers.delete("content-length");
      return {
        request: new Request(req.url, { method: req.method, headers, body: JSON.stringify(out) }),
        leadRow: out[ROW_FIELD] !== undefined,
      };
    },
  };
}

/**
 * A carried `row` as this member runs it, or `null` when it is not one: it must name the body's own
 * `command`, a label, and a `noPrompts`; a `cwd` must be absolute once `~` is read as `home`.
 */
export function rowFromLead(value: JsonValue | undefined, command: string, home: string): Launcher | null {
  if (!isObject(value)) return null;
  if (value.command !== command || command === "") return null;
  if (typeof value.label !== "string" || value.label === "") return null;
  if (typeof value.noPrompts !== "boolean") return null;
  if (value.harness !== undefined && typeof value.harness !== "string") return null;
  if (value.cwd !== undefined && typeof value.cwd !== "string") return null;
  const row: Launcher = { command, label: value.label, kind: value.harness === undefined ? "command" : "agent", noPrompts: value.noPrompts };
  if (value.harness !== undefined) row.harness = value.harness;
  if (value.cwd === undefined) return row;
  const cwd = expandHome(value.cwd, home);
  if (!isAbsolute(cwd)) return null;
  row.cwd = cwd;
  return row;
}
