import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { edgeStateDirs, readEnvMarkers } from "./beacon.ts";
import { holdSocketSafe } from "./hold.ts";
import { EXIT } from "./io.ts";
import { NO_SOCKET_TEXT, shown, type WalkyDeps } from "./walky.ts";
import type { JsonObject, JsonValue } from "../bridge/json.ts";
import { asJsonObject, asJsonString, parseJsonObject } from "../web/src/lib/json.ts";
import { readDecision } from "../bridge/hill/parse.ts";
import { parseAddress } from "../bridge/walky/address.ts";
import { BARE_BAD_REQUEST, unknownOp } from "../bridge/walky/refusals.ts";
import { walkySocketPath } from "../bridge/walky/socket.ts";
import {
  HILL_ID_RE,
  HILL_MEDIA_CAPTION_MAX,
  HILL_MEDIA_MAX,
  HILL_PRIORITIES,
  HILL_TEXT_MODES,
  isHillOptionIntent,
  type HillDecision,
  type HillImageInput,
  type HillOption,
  type HillPostInput,
  type HillPriority,
  type HillTextMode,
} from "../web/src/lib/hill/wire.ts";
import { isRequestId } from "../bridge/worktree-receipts.ts";

// `collie hill`: the hill from an agent's terminal (M96). An agent posts a Decision for its person, and
// the answer comes back later as a WalkyTalky message from the operator. The verb talks to the running
// bridge over the walky socket (`<stateDir>/walky/sock`), one JSON request per connection, exactly as
// `collie walky` does: no token, the socket's mode is the credential, and the bridge names the poster
// from the multiplexer's markers this process carries.
//
// Several bridges may run on one machine, of different releases. The CLI asks each live one in turn: a
// bridge that does not know the pane answers `not here`, and one that does not know the hill answers as
// it answers any op it cannot read; both lead to the next. When no bridge knows the hill, it says so.

export const HILL_SUBCOMMANDS = ["post", "status", "withdraw", "list"] as const;

/** The rules every agent reads before it posts, in `collie hill --help` and `collie hill post --help`. */
export const HILL_RULES = [
  "Post a decision only for what needs the person.",
  "Always write the summary in plain words, and recommend one option with a why.",
  "One question per decision. To change one, post again with --supersedes; never repost.",
  "Do not wait in a loop. The answer arrives as a WalkyTalky message and starts your next turn.",
  "A worker with a lead asks its lead first.",
] as const;

/** What the CLI prints when no bridge on this machine answered a hill operation as one it knows. */
export const HILL_UNKNOWN = "no running Collie on this machine knows the hill";
/** What it prints when a bridge that knows the hill answered, and none of them drives this pane. */
export const HILL_NOT_HERE = "no Collie bridge on this machine knows this pane";

const USAGE = {
  post: [
    'usage: collie hill post --title "<question>" --summary "<plain words>" \\',
    '         --option <intent>="<label>" ... --recommend <intent> --why "<reason>" \\',
    '         [--confirm <intent>="<word>"] [--detail <intent>="<line>"] [--priority now|today|later] \\',
    '         [--text none|optional|required] [--link "<label>=https://..."] [--about here|<address>] \\',
    "         [--reply-to <address>] [--supersedes dc_...] [--expires 2h|3d] [--request-id <uuid>] [--json] \\",
    '         [--image shots/a.png[="<caption>"] ...]   (PNG, JPEG or WebP, up to 4, 2 MB each) \\',
    '         [-- "<body in Markdown>"]   (no body after --: read from stdin when it is not a terminal)',
  ],
  status: ["usage: collie hill status <dc_id> [--json]"],
  withdraw: ["usage: collie hill withdraw <dc_id> [--json]"],
  list: ["usage: collie hill list [--json]   (your own decisions, open first)"],
} as const satisfies Record<(typeof HILL_SUBCOMMANDS)[number], readonly string[]>;

/** `collie hill post --help`: the usage, then the rules. */
export function hillPostHelp(): string[] {
  return [...USAGE.post, "", ...HILL_RULES];
}

/** `collie hill --help` and a bare `collie hill`: every sub-verb's usage, then the rules. */
export function hillHelp(): string[] {
  const lines: string[] = [`usage: collie hill {${HILL_SUBCOMMANDS.join("|")}}`];
  for (const verb of HILL_SUBCOMMANDS) for (const line of USAGE[verb]) lines.push(`  ${line.replace(/^usage: /u, "")}`);
  return [...lines, "", ...HILL_RULES];
}

/** What `collie hill` needs: walky's own deps (the socket, the markers, stdin), and a request id mint. */
export type HillDeps = Omit<WalkyDeps, "mintId" | "sleep"> & {
  readonly mintRequestId?: () => string;
  /** The folder a relative `--image` path is read from. Defaults to the process's own. */
  readonly cwd?: () => string;
};

/** Every bridge socket on this machine worth asking, this install's own first, as `collie walky` asks them. */
function socketPaths(deps: HillDeps): string[] {
  const own = walkySocketPath(deps.ctx.stateDir);
  const listed = deps.sockets?.() ?? [own, ...edgeStateDirs(deps).map((dir) => walkySocketPath(dir))];
  return [...new Set(listed)].filter((path) => holdSocketSafe(deps, path));
}

type Answer = { readonly ok: true; readonly body: JsonObject; readonly path: string } | { readonly ok: false; readonly error: string; readonly code: string | null; readonly exit: number };

/** Whether a refusal says the bridge does not know this op: today's words for it, or the bare word of a bridge before 2026-10-30. */
export function unknownToBridge(error: string, op: string): boolean {
  return error === BARE_BAD_REQUEST || error === unknownOp(op);
}

/**
 * Ask the bridges in turn until one answers. `not here` leads to the next bridge, and so does an answer
 * that does not know the op (an older bridge); a `missing` sentence is kept and printed only when no
 * bridge held the decision. With `all`, every bridge is asked and the ok answers are all returned.
 */
async function walk(deps: HillDeps, body: JsonObject, all = false): Promise<{ readonly answers: Extract<Answer, { ok: true }>[]; readonly failure: Extract<Answer, { ok: false }> }> {
  const op = asJsonString(body.op) ?? "";
  const line = `${JSON.stringify({ v: 1, markers: readEnvMarkers(deps.ctx.env), ...body })}\n`;
  const answers: Extract<Answer, { ok: true }>[] = [];
  let knows = false;
  let notHere = false;
  let missing: string | null = null;
  for (const path of socketPaths(deps)) {
    const raw = await deps.ask(path, line).catch(() => null);
    const answer = raw === null ? undefined : parseJsonObject(raw);
    if (answer === undefined) continue;
    if (answer.ok === true) {
      answers.push({ ok: true, body: answer, path });
      if (!all) break;
      continue;
    }
    const error = asJsonString(answer.error) ?? "failed";
    if (answer.hill === true) knows = true;
    if (error === "not here") {
      notHere = true;
      missing = asJsonString(answer.missing) ?? missing;
      continue;
    }
    if (unknownToBridge(error, op)) continue;
    if (answer.hill !== true) continue;
    return { answers, failure: { ok: false, error, code: asJsonString(answer.code) ?? null, exit: asJsonString(answer.code) === undefined ? EXIT.STATE : EXIT.REFUSED } };
  }
  if (missing !== null) return { answers, failure: { ok: false, error: missing, code: null, exit: EXIT.STATE } };
  if (knows && notHere) return { answers, failure: { ok: false, error: HILL_NOT_HERE, code: null, exit: EXIT.STATE } };
  return { answers, failure: { ok: false, error: HILL_UNKNOWN, code: null, exit: EXIT.UNREACHABLE } };
}

async function request(deps: HillDeps, body: JsonObject): Promise<Answer> {
  const { answers, failure } = await walk(deps, body);
  return answers[0] ?? failure;
}

function failed(deps: HillDeps, answer: Extract<Answer, { ok: false }>): number {
  deps.io.err(`hill: ${shown(answer.error)}${answer.code === null ? "" : ` (${shown(answer.code)})`}`);
  return answer.error.startsWith(BARE_BAD_REQUEST) ? EXIT.USAGE : answer.exit;
}

function usage(deps: HillDeps, verb: (typeof HILL_SUBCOMMANDS)[number], why: string): number {
  deps.io.err(`error: ${why}`);
  for (const line of USAGE[verb]) deps.io.err(line);
  return EXIT.USAGE;
}

function windows(deps: HillDeps): boolean {
  if (deps.platform !== "win32") return false;
  deps.io.err(NO_SOCKET_TEXT);
  return true;
}

/** `2h`, `3d`, `30m`, `1w` as milliseconds, or null. */
export function durationMs(raw: string): number | null {
  const match = /^(\d{1,6})([mhdw])$/u.exec(raw.trim());
  if (match === null) return null;
  const n = Number(match[1]);
  const unit = match[2] === "m" ? 60_000 : match[2] === "h" ? 3_600_000 : match[2] === "d" ? 86_400_000 : 604_800_000;
  return n > 0 ? n * unit : null;
}

/** `<key>=<value>` split at the first `=`, or null when there is none or either side is empty. */
function pair(raw: string): { readonly key: string; readonly value: string } | null {
  const at = raw.indexOf("=");
  if (at <= 0 || at === raw.length - 1) return null;
  return { key: raw.slice(0, at).trim(), value: raw.slice(at + 1) };
}

/** What `post`'s flags come to: the fields to send (no request id yet), the body source, and `--json`. */
export interface PostArgs {
  readonly fields: Omit<HillPostInput, "requestId" | "expiresAt" | "images">;
  /** Each `--image` as given, the path not yet resolved. */
  readonly images: readonly HillImageInput[];
  readonly requestId: string | null;
  readonly expiresInMs: number | null;
  /** The body after `--`, or null to read stdin. */
  readonly body: string | null;
  readonly json: boolean;
}

function isPriority(value: string): value is HillPriority {
  return HILL_PRIORITIES.some((priority) => priority === value);
}

function isTextMode(value: string): value is HillTextMode {
  return HILL_TEXT_MODES.some((mode) => mode === value);
}

const VALUE_FLAGS = new Set(["--title", "--summary", "--option", "--recommend", "--why", "--confirm", "--detail", "--priority", "--text", "--link", "--about", "--reply-to", "--supersedes", "--expires", "--request-id", "--image"]);

/** One `--image` value: `<path>` or `<path>=<caption>`, split at the first `=`. An error is the one-line reason. */
export function parseImageArg(raw: string): HillImageInput | { readonly error: string } {
  const at = raw.indexOf("=");
  const path = at < 0 ? raw : raw.slice(0, at);
  if (path.trim() === "") return { error: `\`--image\` takes <path> or <path>="<caption>", got \`${raw}\`` };
  if (at < 0) return { path };
  const caption = raw.slice(at + 1).trim();
  if (caption === "") return { error: `\`--image ${raw}\` has an empty caption; leave out the = for none` };
  if ([...caption].length > HILL_MEDIA_CAPTION_MAX) return { error: `an image caption is at most ${String(HILL_MEDIA_CAPTION_MAX)} characters` };
  return { path, caption };
}

/**
 * The path the bridge is sent for an `--image`: absolute, with every folder on the way resolved to
 * its real path, so the bridge's own "no symlink in the path" rule holds for a home reached through a
 * link (`/home` on some systems). The file's own name is kept as given, never followed: a symlink
 * named as the image is still a symlink, and the bridge refuses it with the reason.
 */
export function imagePathOf(raw: string, cwd: string, realpath: (path: string) => string = (path) => realpathSync(path)): { readonly path: string } | { readonly error: string } {
  const absolute = resolve(cwd, raw);
  try {
    return { path: join(realpath(dirname(absolute)), basename(absolute)) };
  } catch {
    return { error: `\`--image ${raw}\`: no such folder` };
  }
}

/** `post`'s flags, checked as far as the CLI can check them. An error is the one-line reason. */
export function parsePostArgs(args: readonly string[]): PostArgs | { readonly error: string } {
  const one = new Map<string, string>();
  const options: HillOption[] = [];
  const confirms: Array<{ key: string; value: string }> = [];
  const details: Array<{ key: string; value: string }> = [];
  const links: Array<{ label: string; href: string }> = [];
  const images: HillImageInput[] = [];
  let json = false;
  let body: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      body = args.slice(i + 1).join(" ");
      break;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (!VALUE_FLAGS.has(arg)) return { error: arg.startsWith("-") ? `unknown flag \`${arg}\`` : `unexpected \`${arg}\`: put the body after \`--\`` };
    const value = args[i + 1];
    if (value === undefined) return { error: `\`${arg}\` needs a value` };
    i += 1;
    if (arg === "--option" || arg === "--confirm" || arg === "--detail") {
      const split = pair(value);
      if (split === null) return { error: `\`${arg}\` takes <intent>=<text>, got \`${value}\`` };
      if (!isHillOptionIntent(split.key)) return { error: `\`${split.key}\` is not an option intent: a lowercase word of at most 32 characters (letters, digits, -), not answer or dismiss` };
      if (arg === "--option") {
        if (options.some((option) => option.intent === split.key)) return { error: `two options share the intent \`${split.key}\`` };
        options.push({ intent: split.key, label: split.value });
      } else (arg === "--confirm" ? confirms : details).push(split);
      continue;
    }
    if (arg === "--image") {
      const image = parseImageArg(value);
      if ("error" in image) return image;
      if (images.length >= HILL_MEDIA_MAX) return { error: `a decision has at most ${String(HILL_MEDIA_MAX)} \`--image\`` };
      images.push(image);
      continue;
    }
    if (arg === "--link") {
      const split = pair(value);
      if (split === null) return { error: `\`--link\` takes "<label>=https://...", got \`${value}\`` };
      links.push({ label: split.key, href: split.value });
      continue;
    }
    if (one.has(arg)) return { error: `\`${arg}\` is given twice` };
    one.set(arg, value);
  }
  const title = one.get("--title");
  const summary = one.get("--summary");
  if (title === undefined) return { error: "a decision needs `--title`" };
  if (summary === undefined) return { error: "a decision needs `--summary`, in plain words" };
  for (const extra of [...confirms, ...details]) {
    const option = options.find((candidate) => candidate.intent === extra.key);
    if (option === undefined) return { error: `\`${extra.key}\` names no \`--option\`` };
  }
  const withExtras = options.map((option): HillOption => {
    const confirm = confirms.find((entry) => entry.key === option.intent)?.value;
    const detail = details.find((entry) => entry.key === option.intent)?.value;
    const base: HillOption = detail === undefined ? option : { ...option, detail };
    return confirm === undefined ? base : { ...base, confirm };
  });
  const recommend = one.get("--recommend");
  const why = one.get("--why");
  if ((recommend === undefined) !== (why === undefined)) return { error: "`--recommend` and `--why` go together: name one option and say why" };
  if (recommend !== undefined && !options.some((option) => option.intent === recommend)) return { error: `\`--recommend ${recommend}\` names no \`--option\`` };
  const priority = one.get("--priority") ?? "today";
  if (!isPriority(priority)) return { error: "`--priority` is now, today or later" };
  const text = one.get("--text") ?? "optional";
  if (!isTextMode(text)) return { error: "`--text` is none, optional or required" };
  if (text === "none" && options.length === 0) return { error: "`--text none` needs at least one `--option`" };
  const about = one.get("--about") ?? null;
  if (about !== null && about !== "here" && parseAddress(about)?.kind !== "pane") return { error: `\`--about ${about}\` is not a session: here, or <member>/<pane> as \`collie walky who\` prints it` };
  const replyTo = one.get("--reply-to") ?? null;
  if (replyTo !== null && parseAddress(replyTo)?.kind !== "pane") return { error: `\`--reply-to ${replyTo}\` is not a session: <member>/<pane> as \`collie walky who\` prints it` };
  const supersedes = one.get("--supersedes") ?? null;
  if (supersedes !== null && !HILL_ID_RE.test(supersedes)) return { error: `\`--supersedes ${supersedes}\` is not a decision id (dc_ and 12 characters)` };
  const expires = one.get("--expires");
  const expiresInMs = expires === undefined ? null : durationMs(expires);
  if (expires !== undefined && expiresInMs === null) return { error: `\`--expires ${expires}\` is a duration such as 30m, 2h, 3d or 1w` };
  const requestId = one.get("--request-id") ?? null;
  if (requestId !== null && !isRequestId(requestId)) return { error: `\`--request-id ${requestId}\` is not a UUID` };
  return {
    fields: {
      title,
      summary,
      options: withExtras,
      text,
      recommends: recommend === undefined || why === undefined ? null : { intent: recommend, why },
      links,
      priority,
      about,
      replyTo,
      supersedes,
    },
    images,
    requestId,
    expiresInMs,
    body,
    json,
  };
}

/** The body: the words after `--`, else stdin when it is not a terminal, else none. */
async function bodyOf(deps: HillDeps, body: string | null): Promise<string> {
  if (body !== null) return body;
  if (deps.stdinIsTty) return "";
  return (await deps.readStdin()).trim();
}

/** The `hill.post` request, field by field. The bridge fills `from` from this process's pane, never from here. */
function postLine(fields: PostArgs["fields"], requestId: string, body: string, expiresAt: number | null, images: readonly HillImageInput[]): JsonObject {
  const options = (fields.options ?? []).map((option): JsonObject => {
    const row: JsonObject = { intent: option.intent, label: option.label };
    if (option.detail !== undefined) row.detail = option.detail;
    if (option.confirm !== undefined) row.confirm = option.confirm;
    return row;
  });
  const links = (fields.links ?? []).map((link): JsonObject => ({ label: link.label, href: link.href }));
  const recommends = fields.recommends === undefined || fields.recommends === null ? null : { intent: fields.recommends.intent, why: fields.recommends.why };
  const line: JsonObject = {
    op: "hill.post",
    requestId,
    title: fields.title,
    summary: fields.summary,
    body,
    options,
    text: fields.text ?? "optional",
    recommends,
    links,
    priority: fields.priority ?? "today",
    about: fields.about ?? null,
    replyTo: fields.replyTo ?? null,
    supersedes: fields.supersedes ?? null,
    expiresAt,
  };
  // Paths, never bytes: the bridge reads each file itself (bridge/hill/media.ts). Sent only when there
  // are images, so a post without them is the line it was.
  if (images.length > 0) line.images = images.map((image): JsonObject => (image.caption === undefined ? { path: image.path } : { path: image.path, caption: image.caption }));
  return line;
}

/** What the CLI says when a bridge took the post and kept none of its images: a build from before images. */
export const HILL_IMAGES_DROPPED = "the bridge posted the decision without its images: it is older than images on the hill";

/** `hill post ...`: post one decision and print its id. It never waits for the answer. */
export async function cmdHillPost(deps: HillDeps, args: readonly string[]): Promise<number> {
  if (windows(deps)) return EXIT.STATE;
  const parsed = parsePostArgs(args);
  if ("error" in parsed) return usage(deps, "post", parsed.error);
  const cwd = (deps.cwd ?? (() => process.cwd()))();
  const images: HillImageInput[] = [];
  for (const image of parsed.images) {
    const resolved = imagePathOf(image.path, cwd);
    if ("error" in resolved) return usage(deps, "post", resolved.error);
    images.push(image.caption === undefined ? { path: resolved.path } : { path: resolved.path, caption: image.caption });
  }
  const body = await bodyOf(deps, parsed.body);
  const requestId = parsed.requestId ?? (deps.mintRequestId ?? randomUUID)();
  const expiresAt = parsed.expiresInMs === null ? null : (deps.now ?? Date.now)() + parsed.expiresInMs;
  const answer = await request(deps, postLine(parsed.fields, requestId, body, expiresAt, images));
  if (!answer.ok) return failed(deps, answer);
  const decision = readDecision(answer.body.decision);
  if (decision === null) return failed(deps, { ok: false, error: "the bridge answered without a decision", code: null, exit: EXIT.FAIL });
  if (images.length > 0 && decision.media.length === 0) deps.io.err(`hill: ${HILL_IMAGES_DROPPED}`);
  if (parsed.json) deps.io.out(JSON.stringify({ decision }));
  else deps.io.out(decision.id);
  return EXIT.OK;
}

/** One id and `--json`, the grammar of `status` and `withdraw`. */
function idArgs(args: readonly string[]): { readonly id: string; readonly json: boolean } | { readonly error: string } {
  const json = args.includes("--json");
  const rest = args.filter((arg) => arg !== "--json");
  const id = rest[0];
  if (id === undefined || rest.length > 1 || !HILL_ID_RE.test(id)) return { error: "name one decision id (dc_ and 12 characters)" };
  return { id, json };
}

/** A decision's state as `status` prints it: the state, why it closed, and the answer when there is one. */
export function statusLines(decision: HillDecision): string[] {
  const lines = [`${decision.id} ${decision.state}`];
  if (decision.closedReason !== null) lines.push(`reason: ${shown(decision.closedReason)}`);
  if (decision.supersededBy !== null) lines.push(`replaced by: ${decision.supersededBy}`);
  const answer = decision.answer;
  if (answer === null) return lines;
  const picked = answer.intent === "answer" || answer.intent === "dismiss" ? answer.intent : `${answer.intent}${answer.label === null ? "" : ` (${shown(answer.label)})`}`;
  lines.push(`answer: ${picked}`);
  if (answer.text !== null) for (const line of answer.text.split("\n")) lines.push(`  ${shown(line)}`);
  lines.push(`by: ${shown(answer.by)}`, `delivery: ${answer.delivery}`);
  return lines;
}

async function oneDecision(deps: HillDeps, verb: "status" | "withdraw", args: readonly string[]): Promise<number> {
  if (windows(deps)) return EXIT.STATE;
  const parsed = idArgs(args);
  if ("error" in parsed) return usage(deps, verb, parsed.error);
  const answer = await request(deps, { op: `hill.${verb}`, id: parsed.id });
  if (!answer.ok) return failed(deps, answer);
  const decision = readDecision(answer.body.decision);
  if (decision === null) return failed(deps, { ok: false, error: "the bridge answered without a decision", code: null, exit: EXIT.FAIL });
  if (parsed.json) deps.io.out(JSON.stringify({ decision }));
  else for (const line of statusLines(decision)) deps.io.out(line);
  return EXIT.OK;
}

/** `hill status <id>`: the state, and the answer when there is one. */
export function cmdHillStatus(deps: HillDeps, args: readonly string[]): Promise<number> {
  return oneDecision(deps, "status", args);
}

/** `hill withdraw <id>`: take an open decision back. */
export function cmdHillWithdraw(deps: HillDeps, args: readonly string[]): Promise<number> {
  return oneDecision(deps, "withdraw", args);
}

function decisionsOf(value: JsonValue | undefined): HillDecision[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const decision = readDecision(asJsonObject(entry));
    return decision === null ? [] : [decision];
  });
}

/** `hill list`: the caller's own decisions, open first. Every bridge on the machine is asked. */
export async function cmdHillList(deps: HillDeps, args: readonly string[]): Promise<number> {
  if (windows(deps)) return EXIT.STATE;
  const unknown = args.find((arg) => arg !== "--json");
  if (unknown !== undefined) return usage(deps, "list", `unknown argument \`${unknown}\``);
  const { answers, failure } = await walk(deps, { op: "hill.list", mine: true }, true);
  if (answers.length === 0) return failed(deps, failure);
  const decisions: HillDecision[] = [];
  for (const decision of answers.flatMap((answer) => decisionsOf(answer.body.decisions))) {
    if (!decisions.some((held) => held.id === decision.id)) decisions.push(decision);
  }
  if (args.includes("--json")) {
    deps.io.out(JSON.stringify({ decisions }));
    return EXIT.OK;
  }
  if (decisions.length === 0) {
    deps.io.out("no decisions");
    return EXIT.OK;
  }
  for (const decision of decisions) deps.io.out(`${decision.id}  ${decision.state.padEnd(13)}  ${decision.priority.padEnd(5)}  ${shown(decision.title)}`);
  return EXIT.OK;
}

/** A bare, misspelt or `--help` `collie hill`: the sub-verbs and the rules. `--help` exits 0, the others 2. */
export function cmdHill(deps: Pick<HillDeps, "io">, args: readonly string[]): number {
  const help = args[0] === "--help" || args[0] === "-h";
  if (!help && args[0] !== undefined) deps.io.err(`error: unknown hill command \`${args[0]}\``);
  const print = help ? deps.io.out : deps.io.err;
  for (const line of hillHelp()) print(line);
  return help ? EXIT.OK : EXIT.USAGE;
}
