import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, statSync, type Stats } from "node:fs";
import { resolve } from "node:path";

import { stageImagesForBridge } from "./image-stage.ts";
import { EXIT } from "./io.ts";
import { bodyOf, decisionsOf, failed, imagePathOf, parseImageArg, request, statusLines, windows, type HillAnswer, type HillDeps } from "./hill.ts";
import { shown } from "./walky.ts";
import type { JsonObject, JsonValue } from "../bridge/json.ts";
import { asJsonObject, asJsonString } from "../web/src/lib/json.ts";
import { HILL_POST_ASK_MS } from "../bridge/hill/crew.ts";
import { readDecision } from "../bridge/hill/parse.ts";
import { isBareLabel } from "../bridge/hill/ask-rules.ts";
import { isRequestId } from "../bridge/worktree-receipts.ts";
import {
  HILL_ASK_BECAUSE_MAX,
  HILL_ASK_BODY_MAX,
  HILL_ASK_CANCEL_MAX,
  HILL_ASK_COST_MAX,
  HILL_ASK_DOES_MAX,
  HILL_ASK_FACT_MAX,
  HILL_ASK_FILE_PATH_MAX,
  HILL_ASK_FILES_MAX,
  HILL_ASK_HEADING_MAX,
  HILL_ASK_LABEL_MAX,
  HILL_ASK_OPTIONS_MAX,
  HILL_ASK_OPTIONS_MIN,
  HILL_ASK_QUESTION_MAX,
  HILL_ASK_WHY_MAX,
  HILL_ASK_ID_RE,
  HILL_ID_RE,
  HILL_MEDIA_MAX,
  HILL_MORE_CONTEXT,
  HILL_MORE_CONTEXT_LABEL,
  HILL_OWN_ANSWER_LABEL,
  crewStateLine,
  isHillCrewState,
  isHillOptionIntent,
  type HillAskFileInput,
  type HillDecision,
  type HillImageInput,
} from "../web/src/lib/hill/wire.ts";

// `collie walky ask` (Asks, 2026-11-22): an agent sends one open question to its operator, who reads it
// later with no memory of the session. An ask is a Hill Decision with the `ask` field; it travels over
// the walky socket as `ask.post`, and the bridges are walked as `collie hill` walks them (cli/hill.ts, whose
// helpers this file reuses by import). Every check that needs no bridge runs here first, so `--dry-run`
// says the same refusals; the bridge checks them again (bridge/hill/ask-rules.ts), and checks the linked
// files under the Files rules, which only it can. A refusal names the flag and the limit.

/**
 * How an ask stays open and how it closes (Asks build 2, the reminder that rides on the prompt): the same
 * words in `--help` and in the skill's Asks block (cli/skills/walky-talky.md).
 */
export const ASK_OPEN_RULE: readonly string[] = [
  "An ask stays open until your operator answers it or you close it. Never confirm an ask: silence keeps it.",
  "When your operator answers it in the session, or your work settles it, close it with your next command:",
  '  collie walky cancel <id>... --answered | --because "<reason>".  One that changed: --replaces <id>.',
];

/** `collie walky ask --help`: the flags and the seven rules (spec 2.2). At most 1,500 bytes (cli/ask.test.ts holds it). */
export const ASK_HELP: readonly string[] = [
  'usage: collie walky ask "<question>" --option <id>=<label> ... [flags]',
  "One open question to your operator, who reads it later without your session.",
  '  "<question>"           The decision. At most 90 characters, ends with "?".',
  "  --option <id>=<label>  2 to 5, label starts with a verb, at most 60. Or --words.",
  "Optional:",
  "  --fact <text>  What decides it (240).  --does/--cost <id>=<text>  Then, cost (300).",
  "  --recommend <id> --why <reason>  Both or none (200).",
  "  --body <file.md> or text after --  Background, Markdown.",
  "  --file <path>[#heading|:line] (10)  --image <path>=<caption>  --replaces <id>  --dry-run",
  "Rules:",
  "1. One ask holds one decision. A second question in the body is a second ask.",
  "2. Write for a stranger to your session. Explain each name they would not know.",
  "3. The body adds what you found and what can go wrong. Do not repeat the options in it.",
  "4. Send the ask when you meet the decision, not as a group at the end of the turn.",
  "5. Put no open question in a file or in your reply. Point to the ask id.",
  "6. Do not wait for the answer. Go on with the work that does not need it.",
  "7. A dialog that blocks a command is not an ask.",
  ...ASK_OPEN_RULE,
  "collie walky asks | status <id>",
];

/** The line `walky ask` prints after a posted ask's card: how it stays open, and the way to close it. */
export function askOpenLine(id: string): string {
  return `Open until answered. Settled first? collie walky cancel ${id} [--answered]`;
}

/** What the result says when an ask has no background. */
export const ASK_NO_BACKGROUND = "No background. Your operator gets only the fact.";
/** What the result says when an ask has no fact and no background. */
export const ASK_NO_FACT_NO_BACKGROUND = "No fact and no background. Your operator gets only the question and its answers.";

/** What the CLI says on a dry run, before the card. */
export const ASK_DRY_RUN = "dry run: nothing was sent. Your operator would see:";

/** The flags that take a value. */
const VALUE_FLAGS = new Set(["--fact", "--option", "--does", "--cost", "--recommend", "--why", "--body", "--file", "--image", "--replaces", "--request-id"]);
/** The flags that may be given more than once. */
const REPEAT_FLAGS = new Set(["--option", "--does", "--cost", "--file", "--image"]);
/** The flags that take no value. */
const BARE_FLAGS = new Set(["--words", "--dry-run", "--json"]);

/** One option as the CLI read it. */
export interface AskOptionArg {
  readonly intent: string;
  readonly label: string;
  /** `--does`, absent when not given. */
  readonly detail?: string;
  /** `--cost`, absent when not given. */
  readonly cost?: string;
}

/** An `ask`'s arguments, checked as far as the CLI can check them without a file or a bridge. */
export interface AskArgs {
  readonly question: string;
  /** `--fact`, or `""` when not given. */
  readonly fact: string;
  readonly options: readonly AskOptionArg[];
  readonly recommends: { readonly intent: string; readonly why: string } | null;
  /** `--body <file>`, unread yet. */
  readonly bodyPath: string | null;
  /** The text after `--`, or null. */
  readonly inline: string | null;
  /** Each `--file` as given: the path and its place, unresolved. */
  readonly files: readonly HillAskFileInput[];
  readonly images: readonly HillImageInput[];
  readonly words: boolean;
  readonly replaces: string | null;
  readonly dryRun: boolean;
  readonly json: boolean;
  readonly requestId: string | null;
}

type Refusal = { readonly error: string };

/** Characters as a person counts them (code points). */
function chars(text: string): number {
  return [...text].length;
}

/** `<id>=<value>`, split at the first `=`. */
function idValue(flag: string, raw: string, what: string): { readonly id: string; readonly value: string } | Refusal {
  const at = raw.indexOf("=");
  if (at <= 0) return { error: `${flag} needs the form <id>="<${what}>", for example ${flag} a="..."` };
  return { id: raw.slice(0, at).trim(), value: raw.slice(at + 1).trim() };
}

/**
 * One `--file` value: `<path>`, `<path>#<heading>` or `<path>:<line>`. A `:` followed by digits at the end
 * is a line; else the first `#` after the last `/` starts a heading. Neither is ever used to read.
 */
export function parseFileArg(raw: string): HillAskFileInput | Refusal {
  const line = /^(.+):(\d+)$/u.exec(raw);
  if (line !== null) {
    const n = Number(line[2]);
    if (!Number.isSafeInteger(n) || n < 1) return { error: `--file ${raw}: the :line is a positive whole number` };
    return { path: line[1]!, line: n };
  }
  const slash = raw.lastIndexOf("/");
  const hash = raw.indexOf("#", slash + 1);
  if (hash < 0) return raw.trim() === "" ? { error: "--file needs a path" } : { path: raw };
  const path = raw.slice(0, hash);
  const heading = raw.slice(hash + 1).trim();
  if (path === "") return { error: `--file ${raw}: the path is missing before #` };
  if (heading === "") return { error: `--file ${raw}: the heading after # is empty; leave out the # for none` };
  if (chars(heading) > HILL_ASK_HEADING_MAX) return { error: `--file ${raw}: the #heading has ${String(chars(heading))} characters. The limit is ${String(HILL_ASK_HEADING_MAX)}.` };
  return { path, heading };
}

/** Read the flags, once each where one is meant. */
function readFlags(args: readonly string[]): { readonly values: Map<string, string[]>; readonly bare: Set<string>; readonly positional: string[]; readonly inline: string | null } | Refusal {
  const values = new Map<string, string[]>();
  const bare = new Set<string>();
  const positional: string[] = [];
  const dd = args.indexOf("--");
  const before = dd < 0 ? args : args.slice(0, dd);
  const inline = dd < 0 ? null : args.slice(dd + 1).join(" ");
  for (let i = 0; i < before.length; i += 1) {
    const arg = before[i]!;
    if (BARE_FLAGS.has(arg)) {
      bare.add(arg);
      continue;
    }
    if (VALUE_FLAGS.has(arg)) {
      const value = before[i + 1];
      if (value === undefined) return { error: `${arg} needs a value.` };
      i += 1;
      const held = values.get(arg) ?? [];
      if (held.length > 0 && !REPEAT_FLAGS.has(arg)) return { error: `${arg} may be given only once.` };
      values.set(arg, [...held, value]);
      continue;
    }
    if (arg.startsWith("--")) return { error: `unknown flag ${arg}. See: collie walky ask --help` };
    positional.push(arg);
  }
  return { values, bare, positional, inline };
}

/**
 * The `--does` or `--cost` lines, one per option at most, each for an id that is an option. An empty text
 * counts as not given. A refusal names the flag and the id.
 */
function optionLines(flag: "--does" | "--cost", raws: readonly string[], labels: ReadonlyMap<string, string>, max: number): Map<string, string> | Refusal {
  const lines = new Map<string, string>();
  for (const raw of raws) {
    const pair = idValue(flag, raw, "text");
    if ("error" in pair) return pair;
    if (!labels.has(pair.id)) return { error: `${flag} id "${pair.id}" is not one of the options (${[...labels.keys()].join(", ") || "none"}).` };
    if (lines.has(pair.id)) return { error: `${flag} is given twice for option ${pair.id}. Give one per option.` };
    if (chars(pair.value) > max) return { error: `${flag} ${pair.id} text has ${String(chars(pair.value))} characters. The limit is ${String(max)}.` };
    if (pair.value !== "") lines.set(pair.id, pair.value);
  }
  return lines;
}

/** `ask`'s flags, checked as far as the CLI can without a file or a bridge. A refusal is one line that names the flag. */
export function parseAskArgs(args: readonly string[]): AskArgs | Refusal {
  const read = readFlags(args);
  if ("error" in read) return read;
  const { values, bare, positional } = read;
  const one = (flag: string): string | null => values.get(flag)?.[0] ?? null;
  if (positional.length === 0) return { error: 'the question is missing. Give one argument that ends with "?".' };
  if (positional.length > 1) return { error: "only one argument is allowed, the question. Quote it as one string." };
  const question = positional[0]!.trim();
  if (chars(question) > HILL_ASK_QUESTION_MAX) return { error: `the question has ${String(chars(question))} characters. The limit is ${String(HILL_ASK_QUESTION_MAX)}.` };
  if (!question.endsWith("?")) return { error: 'the question must end with "?".' };
  const fact = (one("--fact") ?? "").trim();
  if (chars(fact) > HILL_ASK_FACT_MAX) return { error: `--fact has ${String(chars(fact))} characters. The limit is ${String(HILL_ASK_FACT_MAX)}.` };
  const words = bare.has("--words");
  const labels = new Map<string, string>();
  for (const raw of values.get("--option") ?? []) {
    const pair = idValue("--option", raw, "label");
    if ("error" in pair) return pair;
    if (pair.id === HILL_MORE_CONTEXT || !isHillOptionIntent(pair.id)) return { error: `--option id "${pair.id}" is not valid. Use a-z, 0-9 and -, start with a letter, at most 32 characters.` };
    if (labels.has(pair.id)) return { error: `--option id "${pair.id}" is used twice. Each id must be unique.` };
    if (pair.value === "") return { error: `--option ${pair.id} has an empty label. Give a label of at most ${String(HILL_ASK_LABEL_MAX)} characters.` };
    if (chars(pair.value) > HILL_ASK_LABEL_MAX) return { error: `--option ${pair.id} label has ${String(chars(pair.value))} characters. The limit is ${String(HILL_ASK_LABEL_MAX)}.` };
    if (isBareLabel(pair.value)) return { error: `--option ${pair.id} label "${pair.value}" is not allowed: an option says what happens, start it with a verb.` };
    labels.set(pair.id, pair.value);
  }
  if (words && labels.size > 0) return { error: "--words takes no --option: the answer is your operator's own words." };
  if (!words && (labels.size < HILL_ASK_OPTIONS_MIN || labels.size > HILL_ASK_OPTIONS_MAX)) {
    return { error: `--option must be given ${String(HILL_ASK_OPTIONS_MIN)} to ${String(HILL_ASK_OPTIONS_MAX)} times. You gave ${String(labels.size)}. An ask with no options takes --words.` };
  }
  const does = optionLines("--does", values.get("--does") ?? [], labels, HILL_ASK_DOES_MAX);
  if ("error" in does) return does;
  const cost = optionLines("--cost", values.get("--cost") ?? [], labels, HILL_ASK_COST_MAX);
  if ("error" in cost) return cost;
  const recommend = one("--recommend");
  const why = one("--why");
  if ((recommend === null) !== (why === null)) return { error: "--recommend and --why go together. Give both or neither." };
  let recommends: AskArgs["recommends"] = null;
  if (recommend !== null && why !== null) {
    if (words) return { error: "--recommend needs options; a --words ask has none." };
    if (!labels.has(recommend)) return { error: `--recommend id "${recommend}" is not one of the options (${[...labels.keys()].join(", ")}).` };
    const reason = why.trim();
    if (reason === "" || chars(reason) > HILL_ASK_WHY_MAX) return { error: `--why is 1 to ${String(HILL_ASK_WHY_MAX)} characters. You gave ${String(chars(reason))}.` };
    recommends = { intent: recommend, why: reason };
  }
  const bodyPath = one("--body");
  if (bodyPath !== null && read.inline !== null) return { error: "give the body either with --body <file.md> or as text after --, not both." };
  if (read.inline !== null && chars(read.inline) > HILL_ASK_BODY_MAX) return { error: `the body after -- has ${String(chars(read.inline))} characters. The limit is ${String(HILL_ASK_BODY_MAX)}.` };
  const rawFiles = values.get("--file") ?? [];
  if (rawFiles.length > HILL_ASK_FILES_MAX) return { error: `--file may be given at most ${String(HILL_ASK_FILES_MAX)} times. You gave ${String(rawFiles.length)}.` };
  const files: HillAskFileInput[] = [];
  for (const raw of rawFiles) {
    const file = parseFileArg(raw);
    if ("error" in file) return file;
    files.push(file);
  }
  const rawImages = values.get("--image") ?? [];
  if (rawImages.length > HILL_MEDIA_MAX) return { error: `--image may be given at most ${String(HILL_MEDIA_MAX)} times. You gave ${String(rawImages.length)}.` };
  const images: HillImageInput[] = [];
  for (const raw of rawImages) {
    const image = parseImageArg(raw);
    if ("error" in image) return { error: `--image: ${image.error}` };
    images.push(image);
  }
  const replaces = one("--replaces");
  if (replaces !== null && HILL_ID_RE.test(replaces) && !HILL_ASK_ID_RE.test(replaces)) return { error: oldIdLine(replaces) };
  if (replaces !== null && !HILL_ASK_ID_RE.test(replaces)) return { error: `--replaces "${replaces}" is not an ask id. An ask id is ak_ and 12 characters.` };
  const requestId = one("--request-id");
  if (requestId !== null && !isRequestId(requestId)) return { error: "--request-id is a UUID, for example 1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b." };
  const options: AskOptionArg[] = [];
  for (const [intent, label] of labels) {
    const detail = does.get(intent);
    const price = cost.get(intent);
    // An absent field stays absent: no `detail: undefined` key reaches the wire.
    if (detail !== undefined && price !== undefined) options.push({ intent, label, detail, cost: price });
    else if (detail !== undefined) options.push({ intent, label, detail });
    else if (price !== undefined) options.push({ intent, label, cost: price });
    else options.push({ intent, label });
  }
  return { question, fact, options, recommends, bodyPath, inline: read.inline, files, images, words, replaces, dryRun: bare.has("--dry-run"), json: bare.has("--json"), requestId };
}

/** The `--body` file's text, or why not: it must be a UTF-8 text file of at most 20,000 characters. */
export function readBodyFile(path: string, cwd: string): { readonly body: string } | Refusal {
  const absolute = resolve(cwd, path);
  const st = statOf(absolute);
  if (st === null) return { error: `--body file ${path} does not exist.` };
  if (!st.isFile()) return { error: `--body path ${path} is not a regular file.` };
  let bytes: Buffer;
  try {
    bytes = readFileSync(absolute);
  } catch {
    return { error: `--body file ${path} cannot be read.` };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { error: `--body file ${path} is not UTF-8 text.` };
  }
  if (chars(text) > HILL_ASK_BODY_MAX) return { error: `--body file ${path} has ${String(chars(text))} characters. The limit is ${String(HILL_ASK_BODY_MAX)}.` };
  return { body: text.trim() };
}

function statOf(path: string): Stats | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

/**
 * Each `--file` as the bridge takes it: an absolute real path (every link on the way followed, so a link
 * that leaves the workspace shows as the outside path it is), of at most 4096 bytes, that names a regular
 * file. Whether it is under the workspace and one the Files view opens is the bridge's to say.
 */
export function resolveFiles(files: readonly HillAskFileInput[], cwd: string, realpath: (path: string) => string = (path) => realpathSync(path)): { readonly files: HillAskFileInput[] } | Refusal {
  const out: HillAskFileInput[] = [];
  for (const file of files) {
    let real: string;
    try {
      real = realpath(resolve(cwd, file.path));
    } catch {
      return { error: `--file ${file.path} does not exist.` };
    }
    if (new TextEncoder().encode(real).byteLength > HILL_ASK_FILE_PATH_MAX) return { error: `--file ${file.path}: the path has more than ${String(HILL_ASK_FILE_PATH_MAX)} bytes.` };
    if (statOf(real)?.isFile() !== true) return { error: `--file ${file.path} is not a regular file.` };
    out.push({ ...file, path: real });
  }
  return { files: out };
}

/** The lines of a background the card shows: the first few, and how many more. */
const CARD_BODY_LINES = 6;

/** A file's place, as the card says it. */
function fileWords(file: { readonly path: string; readonly heading?: string; readonly line?: number }): string {
  if (file.heading !== undefined) return `${file.path}#${file.heading}`;
  return file.line === undefined ? file.path : `${file.path}:${String(file.line)}`;
}

/** What a card shows; a posted ask and a dry run's arguments both give it. */
export interface AskCardFields {
  readonly question: string;
  readonly fact: string;
  readonly options: readonly { readonly intent: string; readonly label: string; readonly detail?: string; readonly cost?: string }[];
  readonly recommends: { readonly intent: string; readonly why: string } | null;
  readonly body: string;
  readonly words: boolean;
  readonly files: readonly { readonly path: string; readonly heading?: string; readonly line?: number }[];
  readonly images: number;
}

/**
 * The card as the operator sees it, as plain text: question, fact, options with what each does and costs, the
 * recommendation, the fixed answers, the background's first lines, the files. Each optional line only when sent.
 */
export function askCard(card: AskCardFields): string[] {
  const lines = [`Question: ${shown(card.question)}`];
  if (card.fact !== "") lines.push(`Fact: ${shown(card.fact)}`);
  if (card.words) lines.push("Answer: in your operator's own words");
  for (const option of card.options) {
    const mark = card.recommends?.intent === option.intent ? " (recommended)" : "";
    lines.push(`  ${option.intent}: ${shown(option.label)}${mark}`);
    if (option.detail !== undefined && option.detail !== "") lines.push(`    Then: ${shown(option.detail)}`);
    if (option.cost !== undefined && option.cost !== "") lines.push(`    Cost: ${shown(option.cost)}`);
  }
  if (card.recommends !== null) lines.push(`Why: ${shown(card.recommends.why)}`);
  lines.push(card.words ? `  ${HILL_MORE_CONTEXT}: ${HILL_MORE_CONTEXT_LABEL}` : `  ${HILL_MORE_CONTEXT}: ${HILL_MORE_CONTEXT_LABEL}  ·  own: ${HILL_OWN_ANSWER_LABEL}`);
  if (card.body !== "") {
    const body = card.body.split("\n");
    lines.push("Background:");
    for (const line of body.slice(0, CARD_BODY_LINES)) lines.push(`  ${shown(line)}`);
    if (body.length > CARD_BODY_LINES) lines.push(`  ... ${String(body.length - CARD_BODY_LINES)} more lines`);
  }
  if (card.images > 0) lines.push(`Pictures: ${String(card.images)}`);
  if (card.files.length > 0) {
    lines.push("Files:");
    for (const file of card.files) lines.push(`  ${shown(fileWords(file))}`);
  }
  return lines;
}

/** A posted ask's card. */
export function cardOf(decision: HillDecision): string[] {
  return askCard({
    question: decision.title,
    fact: decision.summary,
    options: decision.options,
    recommends: decision.recommends,
    body: decision.body,
    words: decision.ask?.words === true,
    files: decision.ask?.files ?? [],
    images: decision.media.length,
  });
}

/** The `ask.post` request line. The bridge fills `from` from this process's pane, never from here. */
function askLine(parsed: AskArgs, requestId: string, body: string, files: readonly HillAskFileInput[], images: readonly HillImageInput[]): JsonObject {
  const line: JsonObject = {
    op: "ask.post",
    requestId,
    title: parsed.question,
    summary: parsed.fact,
    body,
    options: parsed.options.map((option): JsonObject => {
      const out: JsonObject = { intent: option.intent, label: option.label };
      if (option.detail !== undefined) out.detail = option.detail;
      if (option.cost !== undefined) out.cost = option.cost;
      return out;
    }),
    text: parsed.words ? "required" : "optional",
    recommends: parsed.recommends === null ? null : { intent: parsed.recommends.intent, why: parsed.recommends.why },
    links: [],
    priority: "today",
    about: null,
    replyTo: null,
    supersedes: parsed.replaces,
    expiresAt: null,
    ask: { words: parsed.words, files: files.map((file): JsonObject => (file.heading !== undefined ? { path: file.path, heading: file.heading } : file.line !== undefined ? { path: file.path, line: file.line } : { path: file.path })) },
  };
  if (images.length > 0) line.images = images.map((image): JsonObject => (image.caption === undefined ? { path: image.path } : { path: image.path, caption: image.caption }));
  return line;
}

function usage(deps: HillDeps, why: string): number {
  deps.io.err(`ask: ${why}`);
  return EXIT.USAGE;
}

/** `walky ask --help`, or a refusal of the help flag in another place. */
export function askHelpWanted(args: readonly string[]): boolean {
  const dd = args.indexOf("--");
  return (dd < 0 ? args : args.slice(0, dd)).some((arg) => arg === "--help" || arg === "-h");
}

/** `walky ask ...`: send one ask (or, with `--dry-run`, only print its card) and print its id and card. */
export async function cmdWalkyAsk(deps: HillDeps, args: readonly string[]): Promise<number> {
  if (askHelpWanted(args)) {
    for (const line of ASK_HELP) deps.io.out(line);
    return EXIT.OK;
  }
  const parsed = parseAskArgs(args);
  if ("error" in parsed) return usage(deps, parsed.error);
  const cwd = (deps.cwd ?? (() => process.cwd()))();
  let body = "";
  if (parsed.bodyPath !== null) {
    const read = readBodyFile(parsed.bodyPath, cwd);
    if ("error" in read) return usage(deps, read.error);
    body = read.body;
  } else if (parsed.inline !== null) body = parsed.inline.trim();
  else body = await bodyOf(deps, null);
  if (chars(body) > HILL_ASK_BODY_MAX) return usage(deps, `the body has ${String(chars(body))} characters. The limit is ${String(HILL_ASK_BODY_MAX)}.`);
  const files = resolveFiles(parsed.files, cwd);
  if ("error" in files) return usage(deps, files.error);
  const images: HillImageInput[] = [];
  for (const image of parsed.images) {
    const resolved = imagePathOf(image.path, cwd);
    if ("error" in resolved) return usage(deps, resolved.error);
    images.push(image.caption === undefined ? { path: resolved.path } : { path: resolved.path, caption: image.caption });
  }
  const background = body === "" ? [parsed.fact === "" ? ASK_NO_FACT_NO_BACKGROUND : ASK_NO_BACKGROUND] : [];
  if (parsed.dryRun) {
    deps.io.out(ASK_DRY_RUN);
    for (const line of askCard({ question: parsed.question, fact: parsed.fact, options: parsed.options, recommends: parsed.recommends, body, words: parsed.words, files: files.files, images: images.length })) deps.io.out(line);
    for (const line of background) deps.io.out(line);
    return EXIT.OK;
  }
  if (windows(deps)) return EXIT.STATE;
  const requestId = parsed.requestId ?? (deps.mintRequestId ?? randomUUID)();
  const staged = stageImagesForBridge({ env: deps.ctx.env, home: deps.ctx.home, now: deps.now, stagingRoot: deps.stagingRoot }, images);
  if (!staged.ok) return failed(deps, { ok: false, error: staged.error, code: staged.code, exit: staged.code === null ? EXIT.FAIL : EXIT.REFUSED });
  let answer: HillAnswer;
  try {
    answer = await request(deps, askLine(parsed, requestId, body, files.files, staged.images), HILL_POST_ASK_MS);
  } finally {
    staged.cleanup();
  }
  if (!answer.ok) {
    const exit = failed(deps, { ...answer, error: staged.unstage(answer.error) });
    if (exit === EXIT.UNREACHABLE || (exit === EXIT.STATE && answer.code !== "hill_off")) deps.io.err(`ask: send it again with --request-id ${requestId}`);
    return exit;
  }
  const decision = readDecision(answer.body.decision);
  if (decision === null || decision.ask === undefined) return failed(deps, { ok: false, error: "the bridge answered without an ask", code: null, exit: EXIT.FAIL });
  const crewState = answer.body.crewState;
  const crew = isHillCrewState(crewState) && crewState !== "here" ? crewState : null;
  if (parsed.json) {
    deps.io.out(JSON.stringify(crew === null ? { ask: decision } : { ask: decision, crewState: crew }));
    return EXIT.OK;
  }
  deps.io.out(decision.id);
  for (const line of cardOf(decision)) deps.io.out(line);
  for (const line of background) deps.io.out(line);
  if (crew !== null) deps.io.out(crewStateLine(crew));
  deps.io.out(askOpenLine(decision.id));
  return EXIT.OK;
}

/** `walky asks`: this session's open asks, oldest first, one line each. */
export async function cmdWalkyAsks(deps: HillDeps, args: readonly string[]): Promise<number> {
  const json = args.includes("--json");
  const rest = args.filter((arg) => arg !== "--json");
  if (rest.length > 0) return usage(deps, "walky asks takes no argument.");
  if (windows(deps)) return EXIT.STATE;
  const answer = await request(deps, { op: "ask.list" });
  if (!answer.ok) return failed(deps, answer);
  const asks = decisionsOf(answer.body.decisions).filter((decision) => decision.ask !== undefined && decision.state === "open");
  if (json) {
    deps.io.out(JSON.stringify({ asks }));
    return EXIT.OK;
  }
  if (asks.length === 0) {
    deps.io.out("No open asks.");
    return EXIT.OK;
  }
  for (const ask of asks) deps.io.out(`${ask.id} ${shown(ask.title)}`);
  return EXIT.OK;
}

/**
 * Whether `status` or `cancel` names an ask rather than a message: its id's prefix, `ak_`, or the old `dc_` of
 * a card from before ADR 0179, which the ask verbs then refuse with {@link oldIdLine}.
 */
export function namesAnAsk(args: readonly string[]): boolean {
  const id = args.find((arg) => !arg.startsWith("-"));
  return id !== undefined && HILL_ID_RE.test(id);
}

/** `--because`'s value, the 1 to 5 ids, and the flags of `cancel` for an ask. */
function cancelArgs(args: readonly string[]): { readonly ids: readonly string[]; readonly answered: boolean; readonly because: string | null; readonly json: boolean } | Refusal {
  let because: string | null = null;
  let answered = false;
  let json = false;
  const ids: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--answered") answered = true;
    else if (arg === "--json") json = true;
    else if (arg === "--because") {
      if (because !== null) return { error: "--because may be given only once." };
      const value = args[i + 1];
      if (value === undefined) return { error: "--because needs a value." };
      because = value.trim();
      i += 1;
    } else if (arg.startsWith("-")) return { error: `unknown flag ${arg}. See: collie walky ask --help` };
    else ids.push(arg);
  }
  const unique = [...new Set(ids)];
  if (unique.length === 0 || unique.length > HILL_ASK_CANCEL_MAX) return { error: `walky cancel takes 1 to ${String(HILL_ASK_CANCEL_MAX)} ask ids (ak_ and 12 characters).` };
  const old = unique.find((id) => HILL_ID_RE.test(id) && !HILL_ASK_ID_RE.test(id));
  if (old !== undefined) return { error: oldIdLine(old) };
  const bad = unique.find((id) => !HILL_ASK_ID_RE.test(id));
  if (bad !== undefined) return { error: `"${shown(bad)}" is not an ask id. An ask id is ak_ and 12 characters.` };
  if (answered && because !== null) return { error: "--answered and --because do not go together: an ask answered in the session needs no reason." };
  if (because !== null && (because === "" || chars(because) > HILL_ASK_BECAUSE_MAX)) return { error: `--because is 1 to ${String(HILL_ASK_BECAUSE_MAX)} characters.` };
  return { ids: unique, answered, because, json };
}

/** The line an old `dc_` id gets (ADR 0179): ids are `ak_` for every ask now, and the old cards stayed behind. */
export function oldIdLine(id: string): string {
  return `${shown(id)} is an old id: that ask is gone. An ask id is ak_ and 12 characters.`;
}

/** `walky status <ak_ id>`: the ask's state, and the answer when there is one. */
export async function cmdAskStatus(deps: HillDeps, args: readonly string[]): Promise<number> {
  const json = args.includes("--json");
  const rest = args.filter((arg) => arg !== "--json");
  if (rest.length === 1 && HILL_ID_RE.test(rest[0]!) && !HILL_ASK_ID_RE.test(rest[0]!)) return usage(deps, oldIdLine(rest[0]!));
  if (rest.length !== 1 || !HILL_ASK_ID_RE.test(rest[0]!)) return usage(deps, "walky status takes exactly one id: an ask (ak_) or a message (wt_).");
  if (windows(deps)) return EXIT.STATE;
  return printOne(deps, await request(deps, { op: "ask.status", id: rest[0]! }), json);
}

/** One closed ask as `cancel` prints it: its id, its state and reason, its question. */
export function cancelBlock(decision: HillDecision): string[] {
  const reason = decision.closedReason === null ? "" : ` (${shown(decision.closedReason)})`;
  return [`${decision.id} ${decision.state}${reason}`, `  ${shown(decision.title)}`];
}

/**
 * `walky cancel <id>... [--answered] [--because <reason>]`: close 1 to 5 asks at once, with one flag for all.
 * One id goes as `id`, as an older bridge reads it; more go as `ids`, and the bridge answers one result per id,
 * in order: one bad id does not stop the others. One short block per id; the exit is not 0 when any failed.
 */
export async function cmdAskCancel(deps: HillDeps, args: readonly string[]): Promise<number> {
  const parsed = cancelArgs(args);
  if ("error" in parsed) return usage(deps, parsed.error);
  if (windows(deps)) return EXIT.STATE;
  const line: JsonObject = parsed.ids.length === 1 ? { op: "ask.cancel", id: parsed.ids[0]! } : { op: "ask.cancel", ids: [...parsed.ids] };
  if (parsed.answered) line.answered = true;
  if (parsed.because !== null) line.because = parsed.because;
  const answer = await request(deps, line);
  if (!answer.ok) return failed(deps, answer);
  if (parsed.ids.length === 1) {
    const decision = readDecision(answer.body.decision, { collie: true });
    if (decision === null) return failed(deps, { ok: false, error: "the bridge answered without an ask", code: null, exit: EXIT.FAIL });
    if (parsed.json) deps.io.out(JSON.stringify({ ask: decision }));
    else for (const out of cancelBlock(decision)) deps.io.out(out);
    return EXIT.OK;
  }
  const results = cancelResultsOf(answer.body.results, parsed.ids);
  if (results === null) return failed(deps, { ok: false, error: "the bridge answered without a result per id", code: null, exit: EXIT.FAIL });
  if (parsed.json) {
    deps.io.out(JSON.stringify({ results: results.map((result) => (result.decision === null ? { id: result.id, error: result.error } : { id: result.id, ask: result.decision })) }));
  } else {
    for (const result of results) {
      if (result.decision !== null) for (const out of cancelBlock(result.decision)) deps.io.out(out);
      else deps.io.err(`ask: ${result.id}: ${shown(result.error)}`);
    }
  }
  return results.every((result) => result.decision !== null) ? EXIT.OK : EXIT.STATE;
}

/** One id's result of a cancel with several ids. */
interface CancelResult {
  readonly id: string;
  readonly decision: HillDecision | null;
  readonly error: string;
}

/** The bridge's results, one per id in the order asked, or null when they do not fit that. */
function cancelResultsOf(value: JsonValue | undefined, ids: readonly string[]): CancelResult[] | null {
  if (!Array.isArray(value) || value.length !== ids.length) return null;
  const out: CancelResult[] = [];
  for (const [i, entry] of value.entries()) {
    const row = asJsonObject(entry);
    if (row === undefined || row.id !== ids[i]) return null;
    if (row.ok === true) {
      const decision = readDecision(row.decision, { collie: true });
      if (decision === null) return null;
      out.push({ id: ids[i]!, decision, error: "" });
      continue;
    }
    out.push({ id: ids[i]!, decision: null, error: asJsonString(row.error) ?? "failed" });
  }
  return out;
}

function printOne(deps: HillDeps, answer: HillAnswer, json: boolean): number {
  if (!answer.ok) return failed(deps, answer);
  const decision = readDecision(answer.body.decision, { collie: true });
  if (decision === null) return failed(deps, { ok: false, error: "the bridge answered without an ask", code: null, exit: EXIT.FAIL });
  if (json) deps.io.out(JSON.stringify({ ask: decision }));
  else for (const line of statusLines(decision)) deps.io.out(line);
  return EXIT.OK;
}
