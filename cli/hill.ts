import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { edgeStateDirs, readEnvMarkers } from "./beacon.ts";
import { HILL_RULES, HILL_WRITING, hillWordingWarnings } from "./hill-rules.ts";
import { holdSocketSafe } from "./hold.ts";
import { stageImagesForBridge } from "./image-stage.ts";
import { EXIT } from "./io.ts";
import { AskLate, NO_SOCKET_TEXT, shown, type PaneKind, type WalkyDeps } from "./walky.ts";
import type { JsonObject, JsonValue } from "../bridge/json.ts";
import { asJsonNumber, asJsonObject, asJsonString, parseJson, parseJsonObject } from "../web/src/lib/json.ts";
import { HILL_POST_ASK_MS } from "../bridge/hill/crew.ts";
import { readDecision } from "../bridge/hill/parse.ts";
import { HILL_DEFAULT_EXPIRY_DAYS, HILL_MAX_EXPIRY_DAYS, HILL_MAX_EXPIRY_MS, HILL_STATE_ON_LEAD } from "../bridge/hill/service.ts";
import { deriveMode } from "../bridge/crew/mode.ts";
import { enrollmentOf, parseTrustStore, trustStorePath } from "../bridge/crew/trust-store.ts";
import { readHillSwitch, writeHillSwitch } from "../bridge/hill/switch.ts";
import { hillCrewStatePath, readHillCrewState, writeHillCrewState } from "../bridge/hill/crew-state.ts";
import { readCrewStateView } from "../bridge/hill/crew.ts";
import { parseAddress } from "../bridge/walky/address.ts";
import { BARE_BAD_REQUEST, unknownOp } from "../bridge/walky/refusals.ts";
import { walkySocketPath } from "../bridge/walky/socket.ts";
import {
  HILL_ID_RE,
  HILL_MEDIA_CAPTION_MAX,
  HILL_MEDIA_MAX,
  HILL_PRIORITIES,
  HILL_TEXT_MODES,
  crewStateLine,
  isHillCrewState,
  isHillOptionIntent,
  type HillCrewState,
  type HillCrewStateView,
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

export const HILL_SUBCOMMANDS = ["post", "status", "withdraw", "list", "clear", "state", "on", "off"] as const;

export { HILL_RULES, HILL_WRITING };

/** What the CLI prints when no bridge on this machine answered a hill operation as one it knows. */
export const HILL_UNKNOWN = "no running Collie on this machine knows the hill";
/** What it prints when a bridge took the post and gave no answer in time: it may still post. */
export const HILL_NOT_CONFIRMED = `the bridge took the post and did not answer within ${String(HILL_POST_ASK_MS / 1000)} s; the post is not confirmed and may still reach the Hill`;
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
    "         [--view view.json]   (a small view under the summary, see below) \\",
    '         [-- "<body in Markdown>"]   (no body after --: read from stdin when it is not a terminal)',
    `  With no --expires, a decision closes as expired after ${String(HILL_DEFAULT_EXPIRY_DAYS)} days. --expires is at most ${String(HILL_MAX_EXPIRY_DAYS)} days.`,
    "  To retry a post, send it again with the same --request-id: it posts once. Other content under that id is refused.",
    "  --view names a JSON file (at most 16 KiB) with a list of nodes, drawn under the summary: group, list, row, bar, chip,",
    "  para, line, run, code, link, meter, spacer, number, image, compare, table, diff and spark, as a trick writes them,",
    "  at most 8 KiB, 100 nodes and 4 levels. An image names one of your --image files by its place, from 0:",
    '  {"kind":"image","attrs":{"ref":"0","focus":"50 20 2"}} crops it on the phone, and a compare holds two such images.',
    "  It only shows facts. No buttons: the options are the taps, and only a link opens anything, a web page.",
  ],
  status: ["usage: collie hill status <dc_id> [--json]   (yours, or one whose answer goes to this session)"],
  withdraw: ["usage: collie hill withdraw <dc_id> [--json]"],
  list: ["usage: collie hill list [--json]   (your own decisions, open first)"],
  clear: [
    "usage: collie hill clear [--json]   (remove every closed decision from the Hill; open ones stay)",
    "       collie hill clear --spoken [--json]   (withdraw and clear the open cards you answered in the session; types nothing; not from an agent's pane)",
  ],
  state: ["usage: collie hill state [here|quiet|away] [--json]   (read the crew state; with a word, your person sets it)"],
  on: ["usage: collie hill on    (switch the Hill on for this Collie; it is on unless switched off)"],
  off: ["usage: collie hill off   (switch the Hill off: every post is refused, the open decisions stay)"],
} as const satisfies Record<(typeof HILL_SUBCOMMANDS)[number], readonly string[]>;

/** `collie hill post --help`: the usage, how to word the card, then the rules. */
export function hillPostHelp(): string[] {
  return [...USAGE.post, "", ...HILL_WRITING, "", ...HILL_RULES];
}

/** `collie hill --help` and a bare `collie hill`: every sub-verb's usage, how to word the card, then the rules. */
export function hillHelp(): string[] {
  const lines: string[] = [`usage: collie hill {${HILL_SUBCOMMANDS.join("|")}}`];
  for (const verb of HILL_SUBCOMMANDS) for (const line of USAGE[verb]) lines.push(`  ${line.replace(/^usage: /u, "")}`);
  return [...lines, "", ...HILL_WRITING, "", ...HILL_RULES];
}

/** What `collie hill` needs: walky's own deps (the socket, the markers, stdin), and a request id mint. */
export type HillDeps = Omit<WalkyDeps, "mintId" | "sleep"> & {
  readonly mintRequestId?: () => string;
  /** The folder a relative `--image` path is read from. Defaults to the process's own. */
  readonly cwd?: () => string;
  /** Where a picture under /tmp is copied for the bridge. Defaults to `<XDG_CACHE_HOME or ~/.cache>/collie/image-staging`. */
  readonly stagingRoot?: () => string;
  /**
   * What the local bridge says of the pane this runs in (`askPaneKind`, cli/walky.ts), for the person's
   * verbs (`state <word>`, `clear --spoken`), as `collie trick on` asks it. None: not asked, so allowed.
   */
  readonly paneKind?: () => Promise<PaneKind>;
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
async function walk(deps: HillDeps, body: JsonObject, all = false, ms?: number): Promise<{ readonly answers: Extract<Answer, { ok: true }>[]; readonly failure: Extract<Answer, { ok: false }> }> {
  const op = asJsonString(body.op) ?? "";
  const line = `${JSON.stringify({ v: 1, markers: readEnvMarkers(deps.ctx.env), ...body })}\n`;
  const answers: Extract<Answer, { ok: true }>[] = [];
  let knows = false;
  let notHere = false;
  let missing: string | null = null;
  for (const path of socketPaths(deps)) {
    const { raw, late } = await deps.ask(path, line, ms).then(
      (text) => ({ raw: text, late: false }),
      (err) => ({ raw: null, late: err instanceof AskLate }),
    );
    // A bridge took the request and did not answer in time: it may still be posting. Asking the next
    // bridge could post twice, and "no Collie answers" would be untrue, so the walk ends here.
    if (late) return { answers, failure: { ok: false, error: HILL_NOT_CONFIRMED, code: null, exit: EXIT.UNREACHABLE } };
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
    const code = asJsonString(answer.code) ?? null;
    return { answers, failure: { ok: false, error, code, exit: refusalExit(code) } };
  }
  if (missing !== null) return { answers, failure: { ok: false, error: missing, code: null, exit: EXIT.STATE } };
  if (knows && notHere) return { answers, failure: { ok: false, error: HILL_NOT_HERE, code: null, exit: EXIT.STATE } };
  return { answers, failure: { ok: false, error: HILL_UNKNOWN, code: null, exit: EXIT.UNREACHABLE } };
}

/**
 * The exit code of a bridge's refusal. A post the bridge refused for its content is `REFUSED` (4); a
 * refusal with no code, and the Hill switched off on this Collie, are a state of the machine, `STATE`
 * (3): a retry of the same post can pass once the person switches the Hill on. A crew member whose lead
 * did not answer the forwarded post is `UNREACHABLE` (5): the same post with the same `--request-id`
 * may go again, and the lead keeps one decision for it (CREW_PROTOCOL §22).
 */
export function refusalExit(code: string | null): number {
  if (code === "lead_unreachable") return EXIT.UNREACHABLE;
  return code === null || code === "hill_off" ? EXIT.STATE : EXIT.REFUSED;
}

async function request(deps: HillDeps, body: JsonObject, ms?: number): Promise<Answer> {
  const { answers, failure } = await walk(deps, body, false, ms);
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
  /** The `--view` file as given, not yet read, or null. */
  readonly viewPath: string | null;
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

const VALUE_FLAGS = new Set(["--title", "--summary", "--option", "--recommend", "--why", "--confirm", "--detail", "--priority", "--text", "--link", "--about", "--reply-to", "--supersedes", "--expires", "--request-id", "--image", "--view"]);

/** The most bytes `--view` reads of its file. The bridge holds the view itself to 8 KiB of compact JSON. */
export const HILL_VIEW_FILE_MAX = 16 * 1024;

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
  if (expiresInMs !== null && expiresInMs > HILL_MAX_EXPIRY_MS) return { error: `\`--expires ${expires ?? ""}\` is longer than ${String(HILL_MAX_EXPIRY_DAYS)} days, the most a decision stays open` };
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
    viewPath: one.get("--view") ?? null,
    body,
    json,
  };
}

/**
 * The `--view` file, read and parsed as JSON, or the one-line reason it cannot be sent. What the nodes
 * may be is the bridge's to judge (`parseDecisionView`): it refuses a bad view with the path of the node.
 */
export function readViewFile(raw: string, cwd: string): { readonly view: JsonValue } | { readonly error: string } {
  const path = resolve(cwd, raw);
  let size: number;
  try {
    const st = statSync(path);
    if (!st.isFile()) return { error: `\`--view ${raw}\` is not a file` };
    size = st.size;
  } catch {
    return { error: `\`--view ${raw}\`: no such file` };
  }
  if (size > HILL_VIEW_FILE_MAX) return { error: `\`--view ${raw}\` is larger than ${String(HILL_VIEW_FILE_MAX / 1024)} KiB` };
  const view = parseJson(readFileSync(path, "utf8"));
  if (view === undefined) return { error: `\`--view ${raw}\` is not JSON` };
  return { view };
}

/** The body: the words after `--`, else stdin when it is not a terminal, else none. */
async function bodyOf(deps: HillDeps, body: string | null): Promise<string> {
  if (body !== null) return body;
  if (deps.stdinIsTty) return "";
  return (await deps.readStdin()).trim();
}

/** The `hill.post` request, field by field. The bridge fills `from` from this process's pane, never from here. */
function postLine(fields: PostArgs["fields"], requestId: string, body: string, expiresAt: number | null, images: readonly HillImageInput[], view: JsonValue | null): JsonObject {
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
  // Sent only when there is one, as images are.
  if (view !== null) line.view = view;
  return line;
}

/** What the CLI says when a bridge took the post and kept none of its images: a build from before images. */
export const HILL_IMAGES_DROPPED = "the bridge posted the decision without its images: it is older than images on the hill";
/** What the CLI says when a bridge took the post without its view: a build from before views. */
export const HILL_VIEW_DROPPED = "the bridge posted the decision without its view: it is older than views on the hill";

/** One word as a POSIX shell reads it back: bare when it is plain, else single-quoted. */
function shellWord(word: string): string {
  return /^[A-Za-z0-9_./:=@%+,-]+$/u.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/** The `collie hill post` command that sends the same post again: the same flags, with `--request-id` before any body. */
export function retryCommand(args: readonly string[], requestId: string): string {
  // Read as `parsePostArgs` reads them: a flag's value is never taken for a flag, nor for the `--` before the body.
  let end = args.length;
  let named = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--") {
      end = i;
      break;
    }
    if (!VALUE_FLAGS.has(args[i]!)) continue;
    if (args[i] === "--request-id") named = true;
    i += 1;
  }
  const flags = args.slice(0, end);
  const words = [...(named ? flags : [...flags, "--request-id", requestId]), ...args.slice(end)];
  return ["collie", "hill", "post", ...words.map(shellWord)].join(" ");
}

/** `hill post ...`: post one decision and print its id. It never waits for the answer. */
export async function cmdHillPost(deps: HillDeps, args: readonly string[]): Promise<number> {
  if (windows(deps)) return EXIT.STATE;
  const parsed = parsePostArgs(args);
  if ("error" in parsed) return usage(deps, "post", parsed.error);
  // Soft: the words are the poster's. Said before the post, so a refused or unanswered post shows them too.
  for (const warning of hillWordingWarnings(parsed.fields)) deps.io.err(`warning: ${warning}`);
  const cwd = (deps.cwd ?? (() => process.cwd()))();
  const images: HillImageInput[] = [];
  for (const image of parsed.images) {
    const resolved = imagePathOf(image.path, cwd);
    if ("error" in resolved) return usage(deps, "post", resolved.error);
    images.push(image.caption === undefined ? { path: resolved.path } : { path: resolved.path, caption: image.caption });
  }
  let view: JsonValue | null = null;
  if (parsed.viewPath !== null) {
    const read = readViewFile(parsed.viewPath, cwd);
    if ("error" in read) return usage(deps, "post", read.error);
    view = read.view;
  }
  const body = await bodyOf(deps, parsed.body);
  const requestId = parsed.requestId ?? (deps.mintRequestId ?? randomUUID)();
  const expiresAt = parsed.expiresInMs === null ? null : (deps.now ?? Date.now)() + parsed.expiresInMs;
  // The bridge runs under PrivateTmp and cannot see /tmp: a picture there is copied for it, and the copy
  // is removed when the request is over, whatever it came to (an answer, a refusal, a timeout, a throw).
  const staged = stageImagesForBridge({ env: deps.ctx.env, home: deps.ctx.home, now: deps.now, stagingRoot: deps.stagingRoot }, images);
  if (!staged.ok) return failed(deps, { ok: false, error: staged.error, code: staged.code, exit: staged.code === null ? EXIT.FAIL : EXIT.REFUSED });
  let answer: Answer;
  try {
    // The wait covers a crew member's whole forward to its lead (CREW_PROTOCOL §22), so the CLI does not
    // give up on a post that is still on its way.
    answer = await request(deps, postLine(parsed.fields, requestId, body, expiresAt, staged.images, view), HILL_POST_ASK_MS);
  } finally {
    staged.cleanup();
  }
  if (!answer.ok) {
    // A refusal names the picture as the agent typed it, not the copy.
    const exit = failed(deps, { ...answer, error: staged.unstage(answer.error) });
    // Every failure names the request id and the command that sends the same post once.
    deps.io.err(`hill: request id ${requestId}; to send this post again, it posts once: ${shown(retryCommand(args, requestId))}${parsed.body === null && body !== "" ? " (with the same body on stdin)" : ""}`);
    return exit;
  }
  const decision = readDecision(answer.body.decision);
  if (decision === null) return failed(deps, { ok: false, error: "the bridge answered without a decision", code: null, exit: EXIT.FAIL });
  if (images.length > 0 && decision.media.length === 0) deps.io.err(`hill: ${HILL_IMAGES_DROPPED}`);
  if (view !== null && decision.view === undefined) deps.io.err(`hill: ${HILL_VIEW_DROPPED}`);
  // The crew state at the moment of the post, when it is not `here` (1.29.0): one last line.
  const crewState = answer.body.crewState;
  const crew = isHillCrewState(crewState) && crewState !== "here" ? crewState : null;
  if (parsed.json) deps.io.out(JSON.stringify(crew === null ? { decision } : { decision, crewState: crew }));
  else {
    deps.io.out(decision.id);
    if (crew !== null) deps.io.out(crewStateLine(crew));
  }
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

/** Where the answer goes, as the card's "goes to" line names it: the session's name, and its machine. */
function targetWords(target: NonNullable<HillDecision["target"]>): string {
  return target.host === null ? shown(target.label) : `${shown(target.label)} on ${shown(target.host)}`;
}

/**
 * A decision's state as `status` prints it: the state, the question, where the answer goes, why it
 * closed, and the answer with its delivery when there is one. A session that missed the typed answer,
 * or got one with no title (it went to a session other than the poster's), reads it here.
 */
export function statusLines(decision: HillDecision): string[] {
  const lines = [`${decision.id} ${decision.state}`, `title: ${shown(decision.title)}`];
  if (decision.target !== null) lines.push(`goes to: ${targetWords(decision.target)}`);
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
  // Printed only: Collie's own card (a trick proposal, read by the proposing session) reads too.
  const decision = readDecision(answer.body.decision, { collie: true });
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
  for (const decision of decisions) {
    const to = decision.target === null ? "" : `  (to ${targetWords(decision.target)})`;
    deps.io.out(`${decision.id}  ${decision.state.padEnd(13)}  ${decision.priority.padEnd(5)}  ${shown(decision.title)}${to}`);
  }
  return EXIT.OK;
}

/** What `collie hill clear` prints for a count. */
export function clearedWords(count: number): string {
  if (count === 0) return "Nothing to clear: no closed decisions.";
  return `Cleared ${String(count)} closed ${count === 1 ? "decision" : "decisions"}.`;
}

/**
 * `hill clear`: remove every closed decision from the Hill, through the running bridge's socket. It names
 * no pane and no id, and never removes an open decision. Prints one line with the count.
 */
export async function cmdHillClear(deps: HillDeps, args: readonly string[]): Promise<number> {
  if (windows(deps)) return EXIT.STATE;
  const unknown = args.find((arg) => arg !== "--json" && arg !== "--spoken");
  if (unknown !== undefined) return usage(deps, "clear", `unknown argument \`${unknown}\``);
  const spoken = args.includes("--spoken");
  // The second Clear is the person's choice: refused in an agent's pane, here and again by the bridge.
  if (spoken && (await inAgentPane(deps))) {
    for (const line of personOnlyRefusal("collie hill clear --spoken")) deps.io.err(line);
    return EXIT.REFUSED;
  }
  const answer = await request(deps, { op: spoken ? "hill.spoken.clear" : "hill.clear" });
  if (!answer.ok) return failed(deps, answer);
  const count = asJsonNumber(answer.body.cleared);
  if (count === undefined) return failed(deps, { ok: false, error: "the bridge answered without a count", code: null, exit: EXIT.FAIL });
  deps.io.out(args.includes("--json") ? JSON.stringify({ cleared: count }) : spoken ? spokenClearedWords(count) : clearedWords(count));
  return EXIT.OK;
}

/** What `collie hill clear --spoken` prints for a count. */
export function spokenClearedWords(count: number): string {
  if (count === 0) return "Nothing to clear: no open card you answered in its session.";
  return `Withdrew and cleared ${String(count)} ${count === 1 ? "card" : "cards"} you answered in the session. Nothing was typed.`;
}

// ── The crew state (1.29.0) ──────────────────────────────────────────────────────────────────────────

/** What each crew state means, one line, the words the phone shows under its control. */
export const CREW_STATE_MEANING = {
  here: "Agents post as usual.",
  quiet: "No push. Agents post but do not wait.",
  away: "No push. Agents hold questions that need an answer now.",
} as const satisfies Record<HillCrewState, string>;

/**
 * The line a person's verb refuses with inside an agent's pane: the crew state and the Clear of the
 * cards answered in the session are the person's choice. A SPEED BUMP, NOT A WALL, as `collie trick on`'s
 * (cli/trick.ts `agentPaneRefusal`): the bridge is asked whether this pane runs an agent, and only a yes refuses.
 */
export function personOnlyRefusal(command: string): string[] {
  return [
    `error: ${command} is your person's choice, and this runs in a pane where an agent works.`,
    "Tell your operator what you would change and why. They do it on the phone, on the Hill, or with this command in a shell pane or a terminal.",
  ];
}

/** Whether the bridge says this pane runs an agent. Outside a pane, or with no answer, it is not. */
async function inAgentPane(deps: HillDeps): Promise<boolean> {
  if (readEnvMarkers(deps.ctx.env).length === 0 || deps.paneKind === undefined) return false;
  return (await deps.paneKind().catch(() => "unknown" as const)) === "agent";
}

/** The second line of `collie hill state`: since when, and who set it. */
export function crewStateSince(view: HillCrewStateView): string {
  if (view.at === null) return "since always: nobody set it, so it is the default";
  const when = `${new Date(view.at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  return view.by === null ? `since ${when}` : `since ${when}, set by ${shown(view.by)}`;
}

/** The crew state of this machine's file, for when no bridge answers. */
function localCrewState(deps: HillDeps): HillCrewStateView {
  return readHillCrewState(deps.ctx.stateDir).view;
}

/**
 * Why `collie hill state` says `unknown` on a crew member no running bridge answers for (C-N3, review 8):
 * the state is the lead's, and this machine's own file is not it. An agent reads this before each post.
 */
export const HILL_STATE_UNKNOWN_ON_MEMBER = "no running Collie here could ask the crew's lead, and the crew state lives there; start Collie, or look on the phone";

/** Whether this machine is a crew member by its trust store on disk (cli/serve.ts `crewModeOnDisk`). */
function memberOnDisk(deps: HillDeps): boolean {
  const raw = deps.files.read(trustStorePath(deps.ctx.stateDir));
  return deriveMode(enrollmentOf(raw === null ? null : parseTrustStore(raw))).mode === "peer";
}

/**
 * `hill state [here|quiet|away] [--json]`: with no word, the crew state, read from the running bridge (on
 * a crew member, from its lead), else this machine's file: one word, then a line with since when. A lead
 * too old to say is a plain line and exit 4; so is a crew member no running bridge answers for, which
 * prints `unknown` (its own file is not the lead's). With a word, the person sets it: refused inside an agent's
 * pane (exit 4, as `collie trick on`), refused on a crew member (the state is the lead's), written by the
 * running bridge, which audits it, or into the file when no bridge answers.
 */
export async function cmdHillState(deps: HillDeps, args: readonly string[]): Promise<number> {
  const json = args.includes("--json");
  const words = args.filter((arg) => arg !== "--json");
  const word = words[0];
  if (words.length > 1 || (word !== undefined && !isHillCrewState(word))) return usage(deps, "state", word === undefined ? `unexpected \`${words[1] ?? ""}\`` : `\`${words.join(" ")}\` is not a crew state: here, quiet or away`);
  const print = (view: HillCrewStateView): void => {
    if (json) deps.io.out(JSON.stringify({ crewState: view }));
    else {
      deps.io.out(view.state);
      deps.io.out(crewStateSince(view));
    }
  };
  const socket = deps.platform !== "win32";
  // The file fallback for a read: on a member it is not the lead's state, so the answer is `unknown`.
  const fallback = (): number => {
    if (!memberOnDisk(deps)) {
      print(localCrewState(deps));
      return EXIT.OK;
    }
    deps.io.out(json ? JSON.stringify({ crewState: null }) : "unknown");
    if (!json) deps.io.err(`hill: ${HILL_STATE_UNKNOWN_ON_MEMBER}`);
    return EXIT.REFUSED;
  };
  if (word === undefined) {
    if (!socket) return fallback();
    const answer = await request(deps, { op: "hill.state" });
    if (answer.ok) {
      const view = readCrewStateView(answer.body.crewState);
      if (view === null) return failed(deps, { ok: false, error: "the bridge answered without a crew state", code: null, exit: EXIT.FAIL });
      print(view);
      return EXIT.OK;
    }
    // No running Collie here knows the crew state: this machine's own file is the answer, on a lead.
    if (answer.error === HILL_UNKNOWN) return fallback();
    return failed(deps, answer);
  }
  if (await inAgentPane(deps)) {
    for (const line of personOnlyRefusal(`collie hill state ${word}`)) deps.io.err(line);
    return EXIT.REFUSED;
  }
  const said = (view: HillCrewStateView): number => {
    if (json) deps.io.out(JSON.stringify({ crewState: view }));
    else {
      deps.io.out(`${crewStateLine(view.state)} ${CREW_STATE_MEANING[view.state]}`);
      if (view.state !== "here") deps.io.out("To tell the sessions waiting on the Hill now, tap Tell all sessions now on the Hill.");
    }
    return EXIT.OK;
  };
  if (socket) {
    const answer = await request(deps, { op: "hill.state", state: word });
    if (answer.ok) {
      const view = readCrewStateView(answer.body.crewState);
      if (view === null) return failed(deps, { ok: false, error: "the bridge answered without a crew state", code: null, exit: EXIT.FAIL });
      return said(view);
    }
    if (answer.error !== HILL_UNKNOWN) return failed(deps, answer);
  }
  // No running Collie here knows the crew state: write this machine's file, as `collie hill on|off` does.
  // Not on a member: the state is the lead's, and a file here would only mislead its next read.
  if (memberOnDisk(deps)) return failed(deps, { ok: false, error: HILL_STATE_ON_LEAD, code: "not_on_lead", exit: EXIT.REFUSED });
  try {
    writeHillCrewState(deps.ctx.stateDir, { state: word, by: "terminal" }, (deps.now ?? Date.now)());
  } catch (err) {
    deps.io.err(`hill: could not write ${hillCrewStatePath(deps.ctx.stateDir)}: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.FAIL;
  }
  if (!json) deps.io.err(`hill: no running Collie answered; written to ${hillCrewStatePath(deps.ctx.stateDir)}, which the bridge reads when it runs`);
  return said(localCrewState(deps));
}

/** What `collie hill off` says once the switch is written. */
export const HILL_OFF_WORDS = "The Hill is off on this Collie. Agents and tricks cannot post, and the Hill leaves the phone's bar. The open decisions stay and show again when you switch it on: collie hill on";
/** What `collie hill on` says once the switch is written. */
export const HILL_ON_WORDS = "The Hill is on. Agents and tricks can ask you again, and the open decisions are back on the phone.";

/**
 * `hill on|off`: the Hill's switch for this Collie (bridge/hill/switch.ts). Written straight into this
 * instance's state folder, as `collie trick on|off` writes the tricks' switch; the running bridge reads
 * it again within seconds, with no restart. Works with no bridge running.
 */
export function cmdHillSwitch(deps: Pick<HillDeps, "ctx" | "io" | "now">, verb: "on" | "off", args: readonly string[]): number {
  const unknown = args.find((arg) => arg !== "--json");
  if (unknown !== undefined) {
    deps.io.err(`error: unknown argument \`${unknown}\``);
    for (const line of USAGE[verb]) deps.io.err(line);
    return EXIT.USAGE;
  }
  const on = verb === "on";
  const json = args.includes("--json");
  const held = readHillSwitch(deps.ctx.stateDir);
  if (held.on === on && held.problem === null) {
    if (json) deps.io.out(JSON.stringify({ on }));
    else deps.io.out(on ? "The Hill is already on." : "The Hill is already off.");
    return EXIT.OK;
  }
  try {
    writeHillSwitch(deps.ctx.stateDir, on, (deps.now ?? Date.now)());
  } catch (err) {
    deps.io.err(`hill: could not write the switch in ${deps.ctx.stateDir}: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.FAIL;
  }
  if (json) deps.io.out(JSON.stringify({ on }));
  else deps.io.out(on ? HILL_ON_WORDS : HILL_OFF_WORDS);
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
