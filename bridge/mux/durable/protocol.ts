// THE DURABLE WIRE, READ AND CLEANED (WIRE.md sections 2, 4, 5 and 6).
//
// This file decodes what the program sends, in one place, and turns it into types the rest of the
// adapter can trust. Nothing here talks to a socket. The program's JSON is untrusted: every id is
// checked, every display string is cleaned and capped, and an object that breaks a rule is dropped
// with whatever hangs from it. What comes out is the CLEAN view of the program (`DurableSnapshot`),
// and then `toMuxSnapshot` maps that onto the mux port.

import { isAbsolute } from "node:path";

import { type AgentStatus, type Ask, type AskField, type AskPushText, PANE_ACTION_ICONS, type PaneAction } from "../../types.ts";
import type { MuxPane, MuxSnapshot, MuxSpace, MuxTab } from "../types.ts";
import {
  actionLabelOf,
  ANSWER_TEXT_DEFAULT,
  ANSWER_TEXT_MAX,
  BADGE_COUNT_MAX,
  BADGE_TEXT_MAX,
  blockRule,
  byteLength,
  CAPS,
  changedByCleaning,
  cleanText,
  httpsHrefOf,
  isWireId,
  ITEM_RICH_BYTES,
  langOf,
  lineRule,
  LINK_LABEL_MAX,
  PLACEHOLDER_MAX,
  PROGRESS_LABEL_MAX,
  PROGRESS_STEPS_MAX,
  PUSH_LINE_MAX,
  PUSH_TITLE_MAX,
  pushPartOf,
  renameTitleOf,
  shortLine,
  SUBTITLE_MAX,
  type Badge,
  type Progress,
  type ProgressStep,
  type StepState,
} from "./clean.ts";

// ── Versions ──────────────────────────────────────────────────────────────────

/** A range of wire versions, both ends included. */
export interface ProtocolRange {
  readonly min: number;
  readonly max: number;
}

/** The wire version this Collie speaks: N in WIRE.md section 2. */
export const WIRE_VERSION = 1;

/**
 * The version before {@link WIRE_VERSION} that this Collie still accepts, for one minor after N ships (WIRE.md
 * section 2). Null while there is none: version 1 has no predecessor. The minor after that one sets it back to null.
 */
export const PREVIOUS_ACCEPTED: number | null = null;

/** The range a Collie speaks under the policy: N, and N-1 while it is still accepted. */
export function speaksRange(current: number, previous: number | null): ProtocolRange {
  return { min: previous ?? current, max: current };
}

/** What this Collie speaks. Version 1 has no predecessor, so the range is 1..1. */
export const SPEAKS: ProtocolRange = speaksRange(WIRE_VERSION, PREVIOUS_ACCEPTED);

/** The name every durable program sends in `hello` (WIRE.md section 4). A socket without it is something else. */
export const DURABLE_SERVICE = "collie-durable";

/** The refusal detail for a `hello` that does not name {@link DURABLE_SERVICE}. */
export const NOT_A_DURABLE_PROGRAM = "not a durable agent";

/** The highest version inside both ranges, or null when they do not meet (WIRE.md section 2). */
export function negotiateVersion(program: ProtocolRange, speaks: ProtocolRange = SPEAKS): number | null {
  const highest = Math.min(program.max, speaks.max);
  const lowest = Math.max(program.min, speaks.min);
  return highest >= lowest ? highest : null;
}

/**
 * A version refusal (WIRE.md section 2): what each side speaks, as `[min, max]`. Collie builds it when the program's
 * range meets neither N nor N-1; a program puts the same shape in the 409 it answers to a version it does not speak.
 */
export interface VersionRefusal {
  readonly code: "version";
  readonly collie: readonly [number, number];
  readonly program: readonly [number, number];
}

/** The refusal for a program whose range this Collie does not speak, or null when the two ranges meet. */
export function versionRefusal(program: ProtocolRange, speaks: ProtocolRange = SPEAKS): VersionRefusal | null {
  if (negotiateVersion(program, speaks) !== null) return null;
  return { code: "version", collie: [speaks.min, speaks.max], program: [program.min, program.max] };
}

/** The one line a refusal is shown as: in Collie's log, and as the notice row of the program's pane list. */
export function versionNotice(refusal: VersionRefusal): string {
  return `The durable agent speaks wire v${String(refusal.program[1])}, this Collie speaks v${String(refusal.collie[1])}. Update Collie, or the agent's SDK.`;
}

/** The refusal detail for two ranges that do not meet. It starts with `incompatible`. */
export function incompatibleDetail(program: ProtocolRange | null): string {
  if (program === null) return "incompatible";
  return `incompatible: the durable agent speaks ${String(program.min)}..${String(program.max)}, this Collie speaks ${String(SPEAKS.min)}..${String(SPEAKS.max)}`;
}

// ── The clean types ───────────────────────────────────────────────────────────

/** What the program can do. An absent cap is false, and `terminal` is ignored in version 1. */
export interface DurableCaps {
  readonly asks: boolean;
  readonly starters: boolean;
  readonly send: boolean;
  readonly steer: boolean;
  readonly abort: boolean;
  /** It takes a new title for a workspace or a tab (WIRE.md section 7.8). */
  readonly rename: boolean;
  /** It closes a workspace, a tab or a pane when asked (WIRE.md section 7.9). */
  readonly close: boolean;
  /** It lists actions on a pane and runs one when asked (WIRE.md section 7.10). */
  readonly actions: boolean;
  /** It serves its own history: its conversations, open and closed, and their items (WIRE.md section 7.16). */
  readonly history: boolean;
  /** It shows a closed conversation again when asked (WIRE.md section 7.16). */
  readonly reopen: boolean;
}

export interface DurableHello {
  readonly protocol: ProtocolRange;
  readonly hostName: string;
  readonly epoch: string;
  readonly ready: boolean;
  readonly caps: DurableCaps;
}

export type OptionEffect = "allow" | "allow-always" | "deny" | "cancel";

export interface DurableOption {
  readonly id: string;
  readonly label: string;
  /** Set on a `permission` option, absent on every other kind (WIRE.md 7.14). */
  readonly effect?: OptionEffect;
}

/** One field of a `form` ask (WIRE.md 7.14). */
export interface DurableField {
  readonly id: string;
  readonly label: string;
  readonly kind: "text" | "choice" | "toggle";
  readonly required?: boolean;
  /** A `choice` field: 1 to 8 options, none with an effect. */
  readonly options?: readonly DurableOption[];
  /** A `text` field: 1 to 2000 characters, 500 when the program named none. */
  readonly maxLength?: number;
}

export interface DurableToolCall {
  readonly kind: "other";
  readonly name: string;
  readonly summary: string;
  readonly output?: string;
}

/** An open ask, cleaned. The phone draws it and answers it by id (ADR 0100). */
export interface DurableAsk {
  readonly id: string;
  readonly kind: string;
  readonly toolCallId: string;
  readonly revision: number;
  readonly title: string;
  readonly itemId: string;
  readonly options: readonly DurableOption[];
  /** A `choice` ask: more than one option may be picked. */
  readonly multiple?: boolean;
  /** A `text` ask: the hint in the empty field, at most 60 characters. */
  readonly placeholder?: string;
  /** A `text` ask: 1 to 2000 characters, 500 when the program named none. */
  readonly maxLength?: number;
  /** A `form` ask: 1 to 6 fields. */
  readonly fields?: readonly DurableField[];
  readonly reason?: string;
  readonly tool?: DurableToolCall;
  /** True when cleaning cut or changed the title or the reason, so the card says the text was shortened. */
  readonly cleaned?: true;
  /** The program's words for a notification about this ask, cleaned and cut (WIRE.md section 6). */
  readonly push?: AskPushText;
  /** When the ask stops waiting, ISO 8601 (WIRE.md 7.3). Past it the adapter no longer lists the ask as open. */
  readonly expiresAt?: string;
}

export interface DurableWorkspace {
  readonly id: string;
  readonly title: string;
  readonly cwd?: string;
}

export interface DurableTab {
  readonly id: string;
  readonly workspaceId: string;
  readonly title: string;
}

export interface DurablePane {
  readonly id: string;
  readonly workspaceId: string;
  readonly tabId: string;
  readonly title: string;
  /** Display text only. It never selects a parser, a grammar or a journal. */
  readonly harness: string;
  /** The program's word: `working`, `waiting`, `idle`, or anything else (read as unknown). */
  readonly state: string;
  readonly lastActiveAt: number;
  readonly turnId: string;
  readonly openAsks: readonly DurableAsk[];
  readonly cwd?: string;
  /** One line under the title (WIRE.md section 3). Absent when the program sent none, or a bad one. */
  readonly subtitle?: string;
  /** A count or a short mark next to the title. Absent when the program sent none, or a bad one. */
  readonly badge?: Badge;
  /** How far a working conversation is (WIRE.md section 7.12). Absent when the program sent none, or a bad one. */
  readonly progress?: Progress;
  /** The program's belt buttons for this pane, cleaned: at most 4, label at most 16 characters. Absent when it lists none. */
  readonly actions?: readonly PaneAction[];
  /**
   * The conversation id the program serves this pane's history under (WIRE.md section 7.16). Absent when the program
   * sent null or an id that breaks the rule: the pane id stands in for it.
   */
  readonly sessionId?: string;
}

export interface DurableStarter {
  readonly id: string;
  readonly label: string;
}

/** The program's layout, after the id rule, cleaning and caps. */
export interface DurableSnapshot {
  readonly rev: number;
  readonly epoch: string;
  readonly workspaces: readonly DurableWorkspace[];
  readonly tabs: readonly DurableTab[];
  readonly panes: readonly DurablePane[];
  readonly starters: readonly DurableStarter[];
}

/** A decode result: the value, or one line saying what was wrong. */
export type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly detail: string };

function good<T>(value: T): Parsed<T> {
  return { ok: true, value };
}

function bad(detail: string): Parsed<never> {
  return { ok: false, detail };
}

// ── Reading JSON ──────────────────────────────────────────────────────────────

type Json = null | boolean | number | string | readonly Json[] | JsonObject;

interface JsonObject {
  readonly [key: string]: Json | undefined;
}

// The guards below are type predicates, so they are the one place a `typeof` is the parse itself.

function isText(value: Json | undefined): value is string {
  return typeof value === "string";
}

function isFlag(value: Json | undefined): value is boolean {
  return typeof value === "boolean";
}

/** A non-negative integer no larger than 2^53 - 1 (WIRE.md section 4). */
function isCount(value: Json | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isList(value: Json | undefined): value is readonly Json[] {
  return Array.isArray(value);
}

function isRecord(value: Json | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The parsed JSON, or undefined when the text is not JSON. */
function decode(text: string): Json | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** A string field, cleaned. A field that is absent or not a string reads as empty. */
function textOf(object: JsonObject, key: string, maxBytes: number): string {
  const value = object[key];
  return isText(value) ? cleanText(value, lineRule(maxBytes)) : "";
}

/** A multi-line string field, cleaned, or undefined when it is absent. */
function blockOf(object: JsonObject, key: string, maxBytes: number): string | undefined {
  const value = object[key];
  return isText(value) ? cleanText(value, blockRule(maxBytes)) : undefined;
}

/** An id field, or null when it is absent or breaks the id rule. */
function idOf(object: JsonObject, key: string): string | null {
  const value = object[key];
  return isText(value) && isWireId(value) ? value : null;
}

/** An absolute path inside its cap, or undefined. A path over the cap is ignored, not cut. */
function cwdOf(object: JsonObject): string | undefined {
  const value = object.cwd;
  if (!isText(value)) return undefined;
  const cleaned = cleanText(value, lineRule(Number.MAX_SAFE_INTEGER));
  if (cleaned.length === 0 || byteLength(cleaned) > CAPS.cwd) return undefined;
  return isAbsolute(cleaned) ? cleaned : undefined;
}

/** A pane's subtitle (WIRE.md section 7.11), or undefined when it is absent, not text, or empty once cleaned. */
function subtitleOf(object: JsonObject): string | undefined {
  const value = object.subtitle;
  return isText(value) ? shortLine(value, SUBTITLE_MAX) : undefined;
}

/**
 * A pane's badge (WIRE.md section 7.11): `{ count }` with an integer from 0 to 9999, or `{ text }` cut to 12
 * characters. A `null` key reads as absent. Both keys, neither, a count out of range and a text with nothing
 * left read as no badge, and never drop the pane.
 */
function badgeOf(object: JsonObject): Badge | undefined {
  const value = object.badge;
  if (!isRecord(value)) return undefined;
  const count = value.count ?? undefined;
  const text = value.text ?? undefined;
  if ((count === undefined) === (text === undefined)) return undefined;
  if (count !== undefined) return isCount(count) && count <= BADGE_COUNT_MAX ? { count } : undefined;
  const word = isText(text) ? shortLine(text, BADGE_TEXT_MAX) : undefined;
  return word === undefined ? undefined : { text: word };
}

const STEP_STATES: ReadonlySet<string> = new Set(["done", "running", "todo"]);

function isStepState(value: string): value is StepState {
  return STEP_STATES.has(value);
}

/** A finite number, for a percent that may carry a fraction. */
function isNumber(value: Json | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function readStep(value: Json): ProgressStep | null {
  if (!isRecord(value)) return null;
  const state = value.state;
  const text = value.label;
  if (!isText(state) || !isStepState(state) || !isText(text)) return null;
  const label = shortLine(text, PROGRESS_LABEL_MAX);
  return label === undefined ? null : { label, state };
}

/**
 * A pane's progress (WIRE.md section 7.12): `{ kind: "steps" }` with 1 to 12 steps, or `{ kind: "percent" }` with
 * a value from 0 to 100 and an optional label. Steps past the 12th are left out. A step with an unknown state or no
 * label, a value out of range, an unknown kind and any other shape read as no progress, because half a progress would
 * mislead. A percent label that is not text is left out alone. Never drops the pane.
 */
function progressOf(object: JsonObject): Progress | undefined {
  const value = object.progress;
  if (!isRecord(value)) return undefined;
  if (value.kind === "steps") {
    if (!isList(value.steps)) return undefined;
    const steps: ProgressStep[] = [];
    for (const entry of value.steps.slice(0, PROGRESS_STEPS_MAX)) {
      const step = readStep(entry);
      if (step === null) return undefined;
      steps.push(step);
    }
    return steps.length === 0 ? undefined : { kind: "steps", steps };
  }
  if (value.kind === "percent") {
    const percent = value.value;
    if (!isNumber(percent) || percent < 0 || percent > 100) return undefined;
    const text = value.label;
    const label = isText(text) ? shortLine(text, PROGRESS_LABEL_MAX) : undefined;
    return label === undefined ? { kind: "percent", value: percent } : { kind: "percent", value: percent, label };
  }
  return undefined;
}

// ── hello ─────────────────────────────────────────────────────────────────────

/** Decode a `hello` reply (WIRE.md section 4). */
export function parseHello(text: string): Parsed<DurableHello> {
  const root = decode(text);
  if (!isRecord(root)) return bad("hello is not a JSON object");
  // First, so a wrong socket path is named as such rather than as a bad range.
  if (root.service !== DURABLE_SERVICE) return bad(NOT_A_DURABLE_PROGRAM);

  const range = root.protocol;
  if (!isRecord(range) || !isCount(range.min) || !isCount(range.max) || range.min > range.max) {
    return bad("hello has no usable protocol range");
  }
  const epoch = idOf(root, "epoch");
  if (epoch === null) return bad("hello has no usable epoch");
  const ready = root.ready;
  if (!isFlag(ready)) return bad("hello has no ready flag");

  const host = root.host;
  const caps = root.caps;
  const flag = (name: string): boolean => isRecord(caps) && caps[name] === true;
  return good({
    protocol: { min: range.min, max: range.max },
    hostName: isRecord(host) ? textOf(host, "name", CAPS.hostName) : "",
    epoch,
    ready,
    caps: {
      asks: flag("asks"),
      starters: flag("starters"),
      send: flag("send"),
      steer: flag("steer"),
      abort: flag("abort"),
      rename: flag("rename"),
      close: flag("close"),
      actions: flag("actions"),
      history: flag("history"),
      reopen: flag("reopen"),
    },
  });
}

/** What an error body says: its code, and the program's range when it sent one. */
export interface ProblemBody {
  readonly code: string;
  /** The program's own words, cleaned and cut to 512 bytes. Empty when it sent none. */
  readonly message: string;
  readonly range: ProtocolRange | null;
}

/** Decode an error body (`Problem`). A body that is not one reads as code `""`. */
export function parseProblem(text: string): ProblemBody {
  const root = decode(text);
  if (!isRecord(root)) return { code: "", message: "", range: null };
  const range = root.range;
  return {
    code: textOf(root, "code", CAPS.askKind),
    message: textOf(root, "message", CAPS.problemMessage),
    range: isRecord(range) && isCount(range.min) && isCount(range.max) ? { min: range.min, max: range.max } : null,
  };
}

// ── starter reply ─────────────────────────────────────────────────────────────

/** What a start answered: the new conversation's pane, and whether this was a replay. */
export interface StarterReply {
  readonly paneId: string;
  readonly replayed: boolean;
}

/** Decode a `StarterReply` (WIRE.md section 4). A reply with no usable pane id is not one. */
export function parseStarterReply(text: string): Parsed<StarterReply> {
  const root = decode(text);
  if (!isRecord(root)) return bad("starter reply is not a JSON object");
  const paneId = idOf(root, "paneId");
  if (paneId === null) return bad("starter reply has no usable paneId");
  return good({ paneId, replayed: root.replayed === true });
}

// ── snapshot ──────────────────────────────────────────────────────────────────

const EFFECTS: ReadonlySet<string> = new Set(["allow", "allow-always", "deny", "cancel"]);

function isEffect(value: string): value is OptionEffect {
  return EFFECTS.has(value);
}

/**
 * An option's label, cleaned and cut like an ask title (WIRE.md section 6), or null when nothing is left. A button with
 * no words is dropped, never drawn: the person must see what a tap does.
 */
function optionLabelOf(value: JsonObject): string | null {
  const label = textOf(value, "label", CAPS.optionLabel).trim();
  return label === "" ? null : label;
}

function readOption(value: Json): DurableOption | null {
  if (!isRecord(value)) return null;
  const id = idOf(value, "id");
  const effect = value.effect;
  const label = optionLabelOf(value);
  if (id === null || label === null || !isText(effect) || !isEffect(effect)) return null;
  return { id, label, effect };
}

/** An option of a `choice` ask or field: an id and a label, and no effect. A stray `effect` is ignored. */
function readPlainOption(value: Json): DurableOption | null {
  if (!isRecord(value)) return null;
  const id = idOf(value, "id");
  const label = optionLabelOf(value);
  return id === null || label === null ? null : { id, label };
}

/** The options of a list, each read by `read`, a repeated id dropped, at most `max`. */
function readOptions(raw: Json | undefined, read: (entry: Json) => DurableOption | null, max: number): DurableOption[] {
  const options: DurableOption[] = [];
  if (!isList(raw)) return options;
  for (const entry of raw) {
    const option = read(entry);
    if (option !== null && !options.some((have) => have.id === option.id)) options.push(option);
  }
  return options.slice(0, max);
}

/** A `maxLength`: a whole number from 1 to 2000, else the default. */
function maxLengthOf(value: Json | undefined): number {
  return isCount(value) && value >= 1 && value <= ANSWER_TEXT_MAX ? value : ANSWER_TEXT_DEFAULT;
}

const FIELD_KINDS: ReadonlySet<string> = new Set(["text", "choice", "toggle"]);

/** One field of a form (WIRE.md 7.14), or null when its id, kind or options break a rule. */
function readField(value: Json): DurableField | null {
  if (!isRecord(value)) return null;
  const id = idOf(value, "id");
  const kind = value.kind;
  if (id === null || !isText(kind) || !FIELD_KINDS.has(kind)) return null;
  // A field with no words left after cleaning is named by its id, so the person still sees what they fill in.
  const label = optionLabelOf(value) ?? id;
  const required = value.required === true ? true : undefined;
  if (kind === "text") return { id, label, kind, required, maxLength: maxLengthOf(value.maxLength) };
  if (kind === "toggle") return { id, label, kind, required };
  const options = readOptions(value.options, readPlainOption, CAPS.choiceOptions);
  return options.length === 0 ? null : { id, label, kind: "choice", required, options };
}

/** The fields of a form: a repeated id and a bad field dropped, at most 6. */
function readFields(raw: Json | undefined): DurableField[] {
  const fields: DurableField[] = [];
  if (!isList(raw)) return fields;
  for (const entry of raw) {
    const field = readField(entry);
    if (field !== null && !fields.some((have) => have.id === field.id)) fields.push(field);
  }
  return fields.slice(0, CAPS.formFields);
}

function readTool(value: Json | undefined): DurableToolCall | undefined {
  if (!isRecord(value)) return undefined;
  const output = blockOf(value, "output", CAPS.toolOutput);
  return {
    kind: "other",
    name: textOf(value, "name", CAPS.toolName),
    summary: blockOf(value, "summary", CAPS.toolSummary) ?? "",
    output,
  };
}

/** What a `choice`, `text` or `form` ask adds to the base shape (WIRE.md 7.14). Nothing for any other kind. */
function kindFields(kind: string, value: JsonObject): Pick<DurableAsk, "multiple" | "placeholder" | "maxLength" | "fields"> {
  if (kind === "choice") return value.multiple === true ? { multiple: true } : {};
  if (kind === "text") {
    const hint = isText(value.placeholder) ? shortLine(value.placeholder, PLACEHOLDER_MAX) : undefined;
    return hint === undefined ? { maxLength: maxLengthOf(value.maxLength) } : { placeholder: hint, maxLength: maxLengthOf(value.maxLength) };
  }
  if (kind === "form") return { fields: readFields(value.fields) };
  return {};
}

/** The push words of an ask: each part cleaned and cut, a part that is empty or not text left out, undefined when none is left. */
function readPush(value: Json | undefined): AskPushText | undefined {
  if (!isRecord(value)) return undefined;
  const out: AskPushText = {};
  const title = isText(value.title) ? pushPartOf(value.title, PUSH_TITLE_MAX) : "";
  const line = isText(value.line) ? pushPartOf(value.line, PUSH_LINE_MAX) : "";
  if (title !== "") out.title = title;
  if (line !== "") out.line = line;
  return out.title === undefined && out.line === undefined ? undefined : out;
}

/** An ask whose id, tool call id or item id breaks the rule is dropped. */
function readAsk(value: Json): DurableAsk | null {
  if (!isRecord(value)) return null;
  const id = idOf(value, "id");
  const toolCallId = idOf(value, "toolCallId");
  const itemId = idOf(value, "itemId");
  const revision = value.revision;
  if (id === null || toolCallId === null || itemId === null) return null;
  if (!isCount(revision) || revision < 1) return null;

  const kind = textOf(value, "kind", CAPS.askKind);
  // A choice ask has plain options (no effect), up to 8. Every other kind reads its options as a permission
  // does: an id, a label and an effect, up to 6. A `text` and a `form` ask carry none.
  const options =
    kind === "choice"
      ? readOptions(value.options, readPlainOption, CAPS.choiceOptions)
      : kind === "text" || kind === "form"
        ? []
        : readOptions(value.options, readOption, CAPS.optionsPerAsk);
  const reason = blockOf(value, "reason", CAPS.reason);
  const tool = readTool(value.tool);
  const rawTitle = value.title;
  const rawReason = value.reason;
  // What the person reads is not what the program sent: the card says so, and offers no lasting grant.
  // A flag already set is kept: the pane log stores the cleaned ask and reads it back through here.
  // A program that sets it only makes its own card more careful.
  const cleaned =
    value.cleaned === true ||
    (isText(rawTitle) && changedByCleaning(rawTitle, lineRule(CAPS.askTitle))) ||
    (isText(rawReason) && changedByCleaning(rawReason, blockRule(CAPS.reason)));
  const ask: DurableAsk = {
    id,
    kind,
    toolCallId,
    revision,
    title: textOf(value, "title", CAPS.askTitle),
    itemId,
    options,
    reason,
    tool,
    ...kindFields(kind, value),
  };
  const push = readPush(value.push);
  const expiresAt = stampField(value, "expiresAt");
  const pushed: DurableAsk = push === undefined ? ask : { ...ask, push };
  const full: DurableAsk = expiresAt === undefined ? pushed : { ...pushed, expiresAt };
  return cleaned ? { ...full, cleaned: true } : full;
}

function readWorkspace(value: Json): DurableWorkspace | null {
  if (!isRecord(value)) return null;
  const id = idOf(value, "id");
  if (id === null) return null;
  const cwd = cwdOf(value);
  return { id, title: textOf(value, "title", CAPS.title), cwd };
}

function readTab(value: Json, workspaces: ReadonlyMap<string, DurableWorkspace>): DurableTab | null {
  if (!isRecord(value)) return null;
  const id = idOf(value, "id");
  const workspaceId = idOf(value, "workspaceId");
  if (id === null || workspaceId === null || !workspaces.has(workspaceId)) return null;
  return { id, workspaceId, title: textOf(value, "title", CAPS.title) };
}

/** One belt action: an id that follows the id rule, a label that is not empty once cleaned, a known icon or none. */
function readAction(value: Json): PaneAction | null {
  if (!isRecord(value)) return null;
  const id = idOf(value, "id");
  const label = isText(value.label) ? actionLabelOf(value.label) : "";
  if (id === null || label === "") return null;
  const action: PaneAction = { id, label };
  const icon = PANE_ACTION_ICONS.find((name) => name === value.icon);
  if (icon !== undefined) action.icon = icon;
  if (value.busy === true) action.busy = true;
  if (value.disabled === true) action.disabled = true;
  return action;
}

/** The first valid entry of each id, up to the cap of 4. Anything else is left out, and an empty list reads as absent. */
function readActions(list: Json | undefined): readonly PaneAction[] | undefined {
  const kept = collect(list, readAction, CAPS.actionsPerPane);
  return kept.length === 0 ? undefined : kept;
}

/**
 * A pane needs its own id, a workspace and a tab the snapshot kept (and the tab must sit in that
 * workspace), and a `turnId`. Without any of them the pane is dropped: a pane that names a tab
 * Collie does not show cannot be placed, and a pane with no turn cannot be controlled later.
 */
function readPane(
  value: Json,
  workspaces: ReadonlyMap<string, DurableWorkspace>,
  tabs: ReadonlyMap<string, DurableTab>,
): DurablePane | null {
  if (!isRecord(value)) return null;
  const id = idOf(value, "id");
  const workspaceId = idOf(value, "workspaceId");
  const tabId = idOf(value, "tabId");
  const turnId = idOf(value, "turnId");
  if (id === null || workspaceId === null || tabId === null || turnId === null) return null;
  if (!workspaces.has(workspaceId)) return null;
  if (tabs.get(tabId)?.workspaceId !== workspaceId) return null;

  const openAsks: DurableAsk[] = [];
  const raw = value.openAsks;
  if (isList(raw)) {
    for (const entry of raw) {
      const ask = readAsk(entry);
      if (ask !== null && !openAsks.some((have) => have.id === ask.id)) openAsks.push(ask);
    }
  }
  const lastActiveAt = value.lastActiveAt;
  const cwd = cwdOf(value);
  const subtitle = subtitleOf(value);
  const badge = badgeOf(value);
  const progress = progressOf(value);
  const actions = readActions(value.actions);
  const sessionId = idOf(value, "sessionId");
  const pane: DurablePane = {
    id,
    workspaceId,
    tabId,
    title: textOf(value, "title", CAPS.title),
    harness: textOf(value, "harness", CAPS.harness),
    state: textOf(value, "state", CAPS.state),
    lastActiveAt: isCount(lastActiveAt) ? lastActiveAt : 0,
    turnId,
    openAsks: openAsks.slice(0, CAPS.openAsksPerPane),
    cwd,
    subtitle,
    badge,
    progress,
  };
  const named = sessionId === null ? pane : { ...pane, sessionId };
  return actions === undefined ? named : { ...named, actions };
}

function readStarter(value: Json): DurableStarter | null {
  if (!isRecord(value)) return null;
  const id = idOf(value, "id");
  return id === null ? null : { id, label: textOf(value, "label", CAPS.starterLabel) };
}

/** Keep the first valid entry of each id, up to a cap. A repeated id is a second object, and dropped. */
function collect<T extends { readonly id: string }>(
  list: Json | undefined,
  read: (entry: Json) => T | null,
  cap: number,
): T[] {
  const kept: T[] = [];
  if (!isList(list)) return kept;
  const seen = new Set<string>();
  for (const entry of list) {
    if (kept.length >= cap) break;
    const item = read(entry);
    if (item === null || seen.has(item.id)) continue;
    seen.add(item.id);
    kept.push(item);
  }
  return kept;
}

/**
 * Decode a `snapshot` reply (WIRE.md sections 4 and 6).
 *
 * `startersOpen` is `caps.starters` from `hello`: with it false the starter list is ignored.
 * A reply without a usable `rev` or `epoch`, or without its three lists, is not a snapshot.
 */
export function parseSnapshot(text: string, startersOpen: boolean): Parsed<DurableSnapshot> {
  const root = decode(text);
  if (!isRecord(root)) return bad("snapshot is not a JSON object");
  const rev = root.rev;
  const epoch = idOf(root, "epoch");
  if (!isCount(rev) || epoch === null) return bad("snapshot has no usable rev or epoch");
  if (!isList(root.workspaces) || !isList(root.tabs) || !isList(root.panes)) {
    return bad("snapshot is missing workspaces, tabs or panes");
  }

  const workspaces = collect(root.workspaces, readWorkspace, CAPS.workspaces);
  const known = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const tabs = collect(root.tabs, (entry) => readTab(entry, known), CAPS.tabs);
  const knownTabs = new Map(tabs.map((tab) => [tab.id, tab]));
  const panes = collect(root.panes, (entry) => readPane(entry, known, knownTabs), CAPS.panes);
  const starters = startersOpen ? collect(root.starters, readStarter, CAPS.starters) : [];
  return good({ rev, epoch, workspaces, tabs, panes, starters });
}

/** True when an ask carries an `expiresAt` that is not after `now` (milliseconds since the Unix epoch). */
export function askExpired(ask: Pick<DurableAsk, "expiresAt">, now: number): boolean {
  return ask.expiresAt !== undefined && Date.parse(ask.expiresAt) <= now;
}

/**
 * The snapshot with every ask past its `expiresAt` taken out of its pane's open asks (WIRE.md 7.3): such an ask reads
 * as decided by `timeout` from the next read on, even when the program has not closed it yet. The same object when
 * nothing expired, so a held read stays the same read.
 */
export function withoutExpired(snapshot: DurableSnapshot, now: number): DurableSnapshot {
  if (!snapshot.panes.some((pane) => pane.openAsks.some((ask) => askExpired(ask, now)))) return snapshot;
  const panes = snapshot.panes.map((pane) =>
    pane.openAsks.some((ask) => askExpired(ask, now)) ? { ...pane, openAsks: pane.openAsks.filter((ask) => !askExpired(ask, now)) } : pane,
  );
  return { ...snapshot, panes };
}

// ── events ────────────────────────────────────────────────────────────────────

export type ToolStatus = "running" | "done" | "failed" | "denied";

const TOOL_STATUSES: ReadonlySet<string> = new Set(["running", "done", "failed", "denied"]);

function isToolStatus(value: string): value is ToolStatus {
  return TOOL_STATUSES.has(value);
}

/** What an item says, by who said it. */
export type TextKind = "user" | "reply" | "thinking" | "notice";

const TEXT_KINDS: ReadonlySet<string> = new Set(["user", "reply", "thinking", "notice"]);

function isTextKind(value: string): value is TextKind {
  return TEXT_KINDS.has(value);
}

/**
 * An item with a known id replaces the earlier one. `ts` is ISO 8601, or absent.
 *
 * `requestId` is on a `user` item only: the request id of the send that made it, so the phone can match its own
 * unsent line to the program's (WIRE.md 7.15). `partial` is on a `reply`, `thinking`, `notice` or `markdown` item
 * only: the text is still growing, and a later item with the same id replaces it (WIRE.md 7.15).
 */
export type DurableItem =
  | { readonly id: string; readonly ts?: string; readonly kind: "user"; readonly text: string; readonly requestId?: string }
  | {
      readonly id: string;
      readonly ts?: string;
      readonly kind: Exclude<TextKind, "user">;
      readonly text: string;
      readonly partial?: true;
    }
  // The rich kinds (WIRE.md section 7.13): markdown, a code block and a link.
  | { readonly id: string; readonly ts?: string; readonly kind: "markdown"; readonly text: string; readonly partial?: true }
  | { readonly id: string; readonly ts?: string; readonly kind: "code"; readonly lang?: string; readonly text: string }
  | { readonly id: string; readonly ts?: string; readonly kind: "link"; readonly href: string; readonly label?: string }
  | {
      readonly id: string;
      readonly ts?: string;
      readonly kind: "tool";
      readonly tool: DurableToolCall;
      readonly status: ToolStatus;
    };

/** The wire's word for who closed an ask (WIRE.md section 4). */
export type ClosedBy = "phone" | "stopped";

/**
 * Who closed an ask, as the adapter reads it: the wire's `by`, made precise by `decidedBy` (WIRE.md 7.3). A `stopped`
 * ask the program decided itself reads `program`, one the clock closed reads `timeout`, so the pane log and the phone
 * can say "decided in the program" or "timed out" rather than "stopped". An older program sends no `decidedBy`, and
 * its stops stay `stopped`.
 */
export type ReadClosedBy = ClosedBy | "program" | "timeout";

/** Who decided an ask (WIRE.md 7.3): the person on the phone, the program itself, or the clock past `expiresAt`. */
export type DecidedBy = "phone" | "program" | "timeout";

const DECIDERS: ReadonlySet<string> = new Set(["phone", "program", "timeout"]);

function isDecidedBy(value: Json | undefined): value is DecidedBy {
  return isText(value) && DECIDERS.has(value);
}

export type DurableEvent =
  | { readonly type: "item"; readonly item: DurableItem }
  | { readonly type: "remove"; readonly id: string }
  | { readonly type: "ask"; readonly ask: DurableAsk }
  | {
      readonly type: "ask-closed";
      readonly askId: string;
      readonly by: ReadClosedBy;
      readonly waitedMs?: number;
      /** The receipt of the decision (WIRE.md 7.3): who decided, and when, ISO 8601. Absent from an older program. */
      readonly decidedBy?: DecidedBy;
      readonly decidedAt?: string;
    }
  | { readonly type: "state"; readonly state: string }
  | {
      readonly type: "settled";
      readonly inputId: string;
      readonly requestId?: string;
      readonly status: "answered" | "unanswered";
      readonly reason?: string;
    }
  | { readonly type: "reset" }
  | { readonly type: "synced" };

/** One `events` reply, after the id rule, cleaning and caps. */
export interface DurableEventsReply {
  readonly epoch: string;
  readonly events: readonly DurableEvent[];
  /** The cursor after the last event sent. */
  readonly next: number;
  readonly reset: boolean;
  readonly more: boolean;
  readonly trimmed: number;
  /** How many `item` events were dropped because the item broke a rule or has a kind this reader does not know. */
  readonly droppedItems: number;
}

/** An ISO stamp inside its cap, or undefined. */
function stampOf(object: JsonObject): string | undefined {
  const value = object.ts;
  if (!isText(value)) return undefined;
  const cleaned = cleanText(value, lineRule(Number.MAX_SAFE_INTEGER));
  if (cleaned === "" || byteLength(cleaned) > CAPS.itemTs) return undefined;
  return Number.isNaN(Date.parse(cleaned)) ? undefined : cleaned;
}

/** An item the wire can carry, or null when its id, kind, tool or status breaks a rule. */
function readItem(value: Json | undefined): DurableItem | null {
  if (!isRecord(value)) return null;
  const id = idOf(value, "id");
  const kind = value.kind;
  if (id === null || !isText(kind)) return null;
  const ts = stampOf(value);
  if (isTextKind(kind)) {
    const text = blockOf(value, "text", CAPS.itemText);
    if (text === undefined) return null;
    if (kind === "user") {
      const requestId = idOf(value, "requestId");
      return requestId === null ? { id, ts, kind, text } : { id, ts, kind, text, requestId };
    }
    return value.partial === true ? { id, ts, kind, text, partial: true } : { id, ts, kind, text };
  }
  if (kind === "markdown") {
    const text = blockOf(value, "text", ITEM_RICH_BYTES);
    if (text === undefined) return null;
    return value.partial === true ? { id, ts, kind, text, partial: true } : { id, ts, kind, text };
  }
  if (kind === "code") {
    const text = blockOf(value, "text", ITEM_RICH_BYTES);
    if (text === undefined) return null;
    const name = value.lang;
    const lang = isText(name) ? langOf(name) : undefined;
    return lang === undefined ? { id, ts, kind, text } : { id, ts, kind, lang, text };
  }
  if (kind === "link") {
    const target = value.href;
    const href = isText(target) ? httpsHrefOf(target) : undefined;
    if (href === undefined) return null;
    const words = value.label;
    const label = isText(words) ? shortLine(words, LINK_LABEL_MAX) : undefined;
    return label === undefined ? { id, ts, kind, href } : { id, ts, kind, href, label };
  }
  if (kind !== "tool") return null;
  const status = value.status;
  const tool = readTool(value.tool);
  if (tool === undefined || !isText(status) || !isToolStatus(status)) return null;
  return { id, ts, kind, tool, status };
}

function readEvent(value: Json): DurableEvent | null {
  if (!isRecord(value)) return null;
  const type = value.type;
  if (type === "reset") return { type };
  if (type === "synced") return { type };
  if (type === "item") {
    const item = readItem(value.item);
    return item === null ? null : { type, item };
  }
  if (type === "remove") {
    const id = idOf(value, "id");
    return id === null ? null : { type, id };
  }
  if (type === "ask") {
    const ask = readAsk(value.ask ?? null);
    return ask === null ? null : { type, ask };
  }
  if (type === "ask-closed") {
    const askId = idOf(value, "askId");
    if (askId === null) return null;
    const waited = value.waitedMs;
    const decidedBy = value.decidedBy;
    const decidedAt = stampField(value, "decidedAt");
    return {
      type,
      askId,
      by: value.by === "phone" ? "phone" : decidedBy === "program" || decidedBy === "timeout" ? decidedBy : "stopped",
      waitedMs: isCount(waited) ? waited : undefined,
      decidedBy: isDecidedBy(decidedBy) ? decidedBy : undefined,
      decidedAt,
    };
  }
  if (type === "state") {
    const state = textOf(value, "state", CAPS.state);
    return state === "" ? null : { type, state };
  }
  if (type === "settled") {
    const inputId = idOf(value, "inputId");
    const status = value.status;
    if (inputId === null || (status !== "answered" && status !== "unanswered")) return null;
    const reason = textOf(value, "reason", CAPS.settledReason);
    return {
      type,
      inputId,
      requestId: idOf(value, "requestId") ?? undefined,
      status,
      reason: reason === "" ? undefined : reason,
    };
  }
  // A reader ignores an event type it does not know (WIRE.md section 4).
  return null;
}

// ── the pane log's rows ───────────────────────────────────────────────────────

/** Who closed an ask. `reset` is the bridge's own word: the program's view no longer listed it. */
export type LogClosedBy = ReadClosedBy | "reset";

const LOG_CLOSERS: ReadonlySet<string> = new Set(["phone", "program", "timeout", "reset"]);

function isLogCloser(value: Json | undefined): value is Exclude<LogClosedBy, "stopped"> {
  return isText(value) && LOG_CLOSERS.has(value);
}

/** One line of the bridge's pane log (bridge/durable/log.ts), after its header line. */
export type LogRow =
  | { readonly k: "item"; readonly at: string; readonly item: DurableItem }
  | { readonly k: "ask"; readonly at: string; readonly ask: DurableAsk }
  | {
      readonly k: "ask-closed";
      readonly at: string;
      readonly askId: string;
      readonly by: LogClosedBy;
      readonly waitedMs?: number;
      /** The ask's title, so Chat can name a question nobody tapped. Absent from a row an older build wrote. */
      readonly title?: string;
    }
  | { readonly k: "state"; readonly at: string; readonly state: string }
  | {
      readonly k: "settled";
      readonly at: string;
      readonly inputId: string;
      readonly requestId?: string;
      readonly status: "answered" | "unanswered";
      readonly reason?: string;
    };

/**
 * Decode one line of the pane log, or null for a line that is not a row.
 *
 * The log is the bridge's own file, but it is read back as untrusted all the same: a torn write, a
 * hand edit or an older build must cost one row, never the log. The items and asks inside a row go
 * through the readers the wire uses, so a row that would not have passed the wire does not pass here.
 */
export function parseLogRow(line: string): LogRow | null {
  const root = decode(line);
  if (!isRecord(root) || !isText(root.at)) return null;
  const at = root.at;
  switch (root.k) {
    case "item": {
      const item = readItem(root.item);
      return item === null ? null : { k: "item", at, item };
    }
    case "ask": {
      const ask = readAsk(root.ask ?? null);
      return ask === null ? null : { k: "ask", at, ask };
    }
    case "ask-closed": {
      const askId = idOf(root, "askId");
      if (askId === null) return null;
      const waited = root.waitedMs;
      const by = isLogCloser(root.by) ? root.by : "stopped";
      const title = textOf(root, "title", CAPS.askTitle);
      return { k: "ask-closed", at, askId, by, waitedMs: isCount(waited) ? waited : undefined, title: title === "" ? undefined : title };
    }
    case "state": {
      const state = textOf(root, "state", CAPS.state);
      return state === "" ? null : { k: "state", at, state };
    }
    case "settled": {
      const inputId = idOf(root, "inputId");
      const status = root.status;
      if (inputId === null || (status !== "answered" && status !== "unanswered")) return null;
      const reason = textOf(root, "reason", CAPS.settledReason);
      return {
        k: "settled",
        at,
        inputId,
        requestId: idOf(root, "requestId") ?? undefined,
        status,
        reason: reason === "" ? undefined : reason,
      };
    }
    default:
      return null;
  }
}

/** Most events a reset reply may carry: the item cap, every open ask, and the three markers. */
const RESET_EVENTS_MAX = CAPS.resetItems + CAPS.openAsksPerPane + 3;

/**
 * Decode an `events` reply (WIRE.md sections 4, 6 and 7.2).
 *
 * An event of a type this reader does not know, or one that breaks a rule, is dropped alone. A reply
 * over its event cap is not read at all: the cap is 1000 for a plain reply, and a reset reply may
 * also carry the whole view (up to 2000 items, the open asks, and the markers), which WIRE.md 7.2
 * describes without a separate event cap.
 */
export function parseEvents(text: string): Parsed<DurableEventsReply> {
  const root = decode(text);
  if (!isRecord(root)) return bad("events is not a JSON object");
  const epoch = idOf(root, "epoch");
  const next = root.next;
  if (epoch === null || !isCount(next) || !isList(root.events)) return bad("events has no usable epoch, next or list");
  const reset = root.reset === true;
  if (root.events.length > (reset ? RESET_EVENTS_MAX : CAPS.eventsPerReply)) {
    return bad(`events carries ${String(root.events.length)} events, over its cap`);
  }
  const events: DurableEvent[] = [];
  let droppedItems = 0;
  for (const entry of root.events) {
    const event = readEvent(entry);
    if (event !== null) events.push(event);
    else if (isRecord(entry) && entry.type === "item") droppedItems += 1;
  }
  const trimmed = root.trimmed;
  return good({ epoch, events, next, reset, more: root.more === true, trimmed: isCount(trimmed) ? trimmed : 0, droppedItems });
}

// ── history (WIRE.md section 7.16) ────────────────────────────────────────────

/** A history cursor: 1 to 512 bytes of printable ASCII, no space. Opaque: only the program reads it. */
export function isHistoryCursor(value: string): boolean {
  return value.length > 0 && value.length <= CAPS.historyCursor && /^[\x21-\x7e]+$/.test(value);
}

/** One conversation in the program's list, cleaned. */
export interface DurableConversationRow {
  readonly id: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly workspaceId?: string;
  readonly tabId?: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly state: "open" | "closed";
  readonly items: number;
}

type MutableConversationRow = { -readonly [K in keyof DurableConversationRow]: DurableConversationRow[K] };

export interface DurableConversations {
  readonly items: readonly DurableConversationRow[];
  readonly next?: string;
}

export interface DurableConversationItems {
  readonly items: readonly DurableItem[];
  readonly next?: string;
  readonly more: boolean;
  /** How many items were dropped because they broke a rule or have a kind this reader does not know. */
  readonly droppedItems: number;
}

/** An ISO stamp field inside its cap, or undefined. */
function stampField(object: JsonObject, key: string): string | undefined {
  const value = object[key];
  return isText(value) ? stampOf({ ts: value }) : undefined;
}

/** A row needs an id, a start stamp, a known state and a count. Without one of them it is dropped. */
function readConversationRow(value: Json): DurableConversationRow | null {
  if (!isRecord(value)) return null;
  const id = idOf(value, "id");
  const startedAt = stampField(value, "startedAt");
  const state = value.state;
  const items = value.items;
  if (id === null || startedAt === undefined || (state !== "open" && state !== "closed") || !isCount(items)) return null;
  const row: MutableConversationRow = {
    id,
    title: textOf(value, "title", CAPS.title),
    startedAt,
    state,
    items,
  };
  const subtitle = subtitleOf(value);
  if (subtitle !== undefined) row.subtitle = subtitle;
  const workspaceId = idOf(value, "workspaceId");
  if (workspaceId !== null) row.workspaceId = workspaceId;
  const tabId = idOf(value, "tabId");
  if (tabId !== null) row.tabId = tabId;
  const endedAt = stampField(value, "endedAt");
  if (endedAt !== undefined) row.endedAt = endedAt;
  return row;
}

/** The next cursor of a history page: a good one, absent, or a broken reply. */
function nextCursorOf(root: JsonObject): { ok: true; next?: string } | { ok: false } {
  const next = root.next;
  if (next === undefined || next === null) return { ok: true };
  return isText(next) && isHistoryCursor(next) ? { ok: true, next } : { ok: false };
}

/**
 * Decode a `conversations` reply (WIRE.md 7.16). A row that breaks a rule is dropped alone, and the first of each
 * id is kept, up to 100. A reply without its list, or with a `next` that is not a cursor, is not read at all: a page
 * that cannot go on must not look like the last one.
 */
export function parseConversations(text: string): Parsed<DurableConversations> {
  const root = decode(text);
  if (!isRecord(root) || !isList(root.items)) return bad("conversations has no list");
  if (root.items.length > CAPS.conversationsPerPage) return bad(`conversations carries ${String(root.items.length)} rows, over its cap`);
  const next = nextCursorOf(root);
  if (!next.ok) return bad("conversations has a next that is not a cursor");
  const items = collect(root.items, readConversationRow, CAPS.conversationsPerPage);
  return good(next.next === undefined ? { items } : { items, next: next.next });
}

/**
 * Decode a conversation's `items` reply (WIRE.md 7.16): oldest first, at most 1000. An item that breaks a rule is
 * dropped alone and counted; a second version of an id replaces the first in place.
 */
export function parseConversationItems(text: string): Parsed<DurableConversationItems> {
  const root = decode(text);
  if (!isRecord(root) || !isList(root.items)) return bad("items has no list");
  if (root.items.length > CAPS.historyItems) return bad(`items carries ${String(root.items.length)} items, over its cap`);
  const next = nextCursorOf(root);
  if (!next.ok) return bad("items has a next that is not a cursor");
  const items: DurableItem[] = [];
  const at = new Map<string, number>();
  let droppedItems = 0;
  for (const entry of root.items) {
    const item = readItem(entry);
    if (item === null) {
      droppedItems += 1;
      continue;
    }
    const place = at.get(item.id);
    if (place === undefined) {
      at.set(item.id, items.length);
      items.push(item);
    } else items[place] = item;
  }
  const more = root.more === true && next.next !== undefined;
  return good(next.next === undefined ? { items, more, droppedItems } : { items, next: next.next, more, droppedItems });
}

// ── answer ────────────────────────────────────────────────────────────────────

/** What a 200 to `POST /pane/:id/answer` said (WIRE.md section 4, `AnswerReply`). */
export interface DurableAnswerReply {
  readonly result: "taken" | "too-late";
  readonly replayed: boolean;
}

/** What a 409 `decided` carries (WIRE.md 7.3): the first decision of the ask, as the program recorded it. */
export interface DurableAskOutcome {
  readonly decidedBy: DecidedBy;
  readonly decidedAt: string;
  /** A `permission` the phone decided: the option it took, and that option's effect. */
  readonly optionId?: string;
  readonly effect?: OptionEffect;
}

/** The outcome of a 409 `decided`, or null when the body names none or one that breaks a rule. */
export function parseDecided(text: string): DurableAskOutcome | null {
  const root = decode(text);
  if (!isRecord(root)) return null;
  const outcome = root.outcome;
  if (!isRecord(outcome)) return null;
  const decidedBy = outcome.decidedBy;
  const decidedAt = stampField(outcome, "decidedAt");
  if (!isDecidedBy(decidedBy) || decidedAt === undefined) return null;
  const optionId = idOf(outcome, "optionId");
  const effect = outcome.effect;
  return {
    decidedBy,
    decidedAt,
    optionId: optionId ?? undefined,
    effect: isText(effect) && isEffect(effect) ? effect : undefined,
  };
}

/** Decode an `AnswerReply`, or null when the body is not one. */
export function parseAnswerReply(text: string): DurableAnswerReply | null {
  const root = decode(text);
  if (!isRecord(root)) return null;
  const result = root.result;
  if (result !== "taken" && result !== "too-late") return null;
  return { result, replayed: root.replayed === true };
}

/** An `AnswerRequest` (WIRE.md section 4) as a program reads it off `POST /pane/:id/answer`. */
export interface DurableAnswerPost {
  readonly requestId: string;
  readonly askId: string;
  readonly revision: number;
  /** The one shape the body's `answer` member names (WIRE.md 7.14). */
  readonly answer: DurableAnswerBody;
}

/** What `answer` holds: an option of a permission, the picks of a choice, a line of text, or a form's values. */
export type DurableAnswerBody =
  | { readonly kind: "option"; readonly optionId: string }
  | { readonly kind: "options"; readonly optionIds: readonly string[] }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "values"; readonly values: Readonly<Record<string, string | string[] | boolean>> };

function answerBodyOf(choice: Json | undefined): DurableAnswerBody | null {
  if (!isRecord(choice)) return null;
  if (isText(choice.optionId)) return { kind: "option", optionId: choice.optionId };
  if (isList(choice.optionIds) && choice.optionIds.every(isText)) return { kind: "options", optionIds: choice.optionIds.filter(isText) };
  if (isText(choice.text)) return { kind: "text", text: choice.text };
  const values = choice.values;
  if (!isRecord(values)) return null;
  const out: Record<string, string | string[] | boolean> = {};
  for (const [key, entry] of Object.entries(values)) {
    if (isText(entry) || typeof entry === "boolean") out[key] = entry;
    else if (isList(entry) && entry.every(isText)) out[key] = entry.filter(isText);
    else return null;
  }
  return { kind: "values", values: out };
}

/**
 * The program's side of the answer body: `"bad-json"`, `null` for a body that is not an answer, or
 * the fields. The test program reads the adapter's POST with this, so the body the adapter writes
 * and the body a program reads are checked by one rule.
 */
export function parseAnswerPost(text: string): DurableAnswerPost | "bad-json" | null {
  const root = text === "" ? {} : decode(text);
  if (root === undefined) return "bad-json";
  if (!isRecord(root)) return null;
  const { requestId, askId, revision } = root;
  const answer = answerBodyOf(root.answer);
  if (!isText(requestId) || !isText(askId) || !isCount(revision) || answer === null) return null;
  return { requestId, askId, revision, answer };
}

/**
 * The ask a 409 `stale` to an answer carries, cleaned like any other (WIRE.md section 7.3), or null
 * when the body names none or one that breaks a rule.
 */
export function parseStaleAsk(text: string): DurableAsk | null {
  const root = decode(text);
  if (!isRecord(root)) return null;
  const ask = root.ask;
  return ask === undefined ? null : readAsk(ask);
}

// ── send and abort ────────────────────────────────────────────────────────────

/** What a 200 to `POST /pane/:id/send` or `/abort` said (WIRE.md section 4, `ControlReply`). */
export interface DurableControlReply {
  readonly replayed: boolean;
}

/** Decode a `ControlReply`, or null when the body is not one. */
export function parseControlReply(text: string): DurableControlReply | null {
  const root = decode(text);
  if (!isRecord(root) || root.ok !== true) return null;
  return { replayed: root.replayed === true };
}

/** What a 409 `stale` to a send or abort says is current (WIRE.md section 7.4). */
export interface DurableStaleControl {
  /** Null when the program sent none, or one that breaks the id rule. */
  readonly turnId: string | null;
  /** The open ask ids it listed, each under the id rule, at most the open ask cap. */
  readonly askIds: readonly string[];
}

/** Decode the current turn and ask ids a 409 `stale` carries. */
export function parseStaleControl(text: string): DurableStaleControl {
  const root = decode(text);
  if (!isRecord(root)) return { turnId: null, askIds: [] };
  const list = root.askIds;
  const askIds = isList(list) ? list.filter((id): id is string => isText(id) && isWireId(id)).slice(0, CAPS.openAsksPerPane) : [];
  return { turnId: idOf(root, "turnId"), askIds };
}

/** The body the adapter writes for a send or an abort (WIRE.md section 4, `SendRequest`, `AbortRequest`). */
export interface DurableControlBody {
  requestId: string;
  /** A send only. */
  text?: string;
  /** A send only, and only when true: absent is the wire's default, a follow-up. */
  steer?: true;
  /** Exactly one of `turnId` and `askId`. */
  turnId?: string;
  askId?: string;
}

/** The body the adapter writes for a belt action (WIRE.md section 4, `ActionRequest`). */
export interface DurableActionBody {
  requestId: string;
  actionId: string;
  /** The turn the phone saw. Absent when the phone named none. */
  turnId?: string;
}

/** An `ActionRequest` (WIRE.md section 4) as a program reads it off the socket. */
export interface DurableActionPost {
  readonly requestId: string;
  readonly actionId: string;
  readonly turnId: string | null;
}

/**
 * The program's side of an action body: `"bad-json"`, `null` for a body that breaks WIRE.md section 7.10 (no request id,
 * no action id, a `turnId` that is not text), or the fields. The test program reads the adapter's POST with this.
 */
export function parseActionPost(text: string): DurableActionPost | "bad-json" | null {
  const root = text === "" ? {} : decode(text);
  if (root === undefined) return "bad-json";
  if (!isRecord(root)) return null;
  const requestId = root.requestId ?? undefined;
  const actionId = root.actionId ?? undefined;
  const turnId = root.turnId ?? undefined;
  if (!isText(requestId) || !isText(actionId)) return null;
  if (turnId !== undefined && !isText(turnId)) return null;
  return { requestId, actionId, turnId: isText(turnId) ? turnId : null };
}

/** A `SendRequest` or `AbortRequest` (WIRE.md section 4) as a program reads it off the socket. */
export interface DurableControlPost {
  readonly requestId: string;
  readonly turnId: string | null;
  readonly askId: string | null;
  /** For a send. Empty for an abort. */
  readonly text: string;
  readonly steer: boolean;
}

/**
 * The program's side of a send or abort body: `"bad-json"`, `null` for a body that breaks WIRE.md
 * section 7.4 (no request id, both or neither of `turnId` and `askId`, a send with no text or one
 * over its cap), or the fields. The test program reads the adapter's POST with this, so the body the
 * adapter writes and the body a program reads are checked by one rule.
 */
export function parseControlPost(text: string, act: "send" | "abort"): DurableControlPost | "bad-json" | null {
  const root = text === "" ? {} : decode(text);
  if (root === undefined) return "bad-json";
  if (!isRecord(root)) return null;
  // A reader treats `null` as absent (WIRE.md section 4).
  const field = (key: string): Json | undefined => root[key] ?? undefined;
  const requestId = field("requestId");
  const turnId = field("turnId");
  const askId = field("askId");
  const steer = field("steer");
  const body = field("text");
  if (!isText(requestId)) return null;
  // Exactly one of the two names, and it is text.
  if ((turnId === undefined) === (askId === undefined)) return null;
  if ((turnId !== undefined && !isText(turnId)) || (askId !== undefined && !isText(askId))) return null;
  if (steer !== undefined && !isFlag(steer)) return null;
  if (act === "send" && (!isText(body) || body === "" || byteLength(body) > CAPS.sendText)) return null;
  return {
    requestId,
    turnId: isText(turnId) ? turnId : null,
    askId: isText(askId) ? askId : null,
    text: act === "send" && isText(body) ? body : "",
    steer: steer === true,
  };
}

/** The body the adapter writes for a rename (WIRE.md section 4, `RenameRequest`). */
export interface DurableRenameBody {
  requestId: string;
  kind: "workspace" | "tab";
  id: string;
  title: string;
}

/**
 * The program's side of a rename body: `"bad-json"`, `null` for a body that breaks WIRE.md section 7.8
 * (no request id, a kind that is neither word, no id, a title outside the rule), or the fields with the
 * title trimmed. The test program reads the adapter's POST with this, so the body the adapter writes and
 * the body a program reads are checked by one rule.
 */
export function parseRenamePost(text: string): DurableRenameBody | "bad-json" | null {
  const root = text === "" ? {} : decode(text);
  if (root === undefined) return "bad-json";
  if (!isRecord(root)) return null;
  const requestId = root.requestId ?? undefined;
  const kind = root.kind ?? undefined;
  const id = root.id ?? undefined;
  const title = root.title ?? undefined;
  if (!isText(requestId) || !isText(id) || !isText(title)) return null;
  if (kind !== "workspace" && kind !== "tab") return null;
  const trimmed = renameTitleOf(title);
  if (trimmed === null) return null;
  return { requestId, kind, id, title: trimmed };
}

/** The body the adapter writes for a close (WIRE.md section 4, `CloseRequest`). */
export interface DurableCloseBody {
  requestId: string;
  kind: "pane" | "tab" | "workspace";
  id: string;
}

/**
 * The program's side of a close body: `"bad-json"`, `null` for a body that breaks WIRE.md section 7.9 (no request
 * id, a kind that is none of the three words, no id), or the fields. The test program reads the adapter's POST with
 * this, so the body the adapter writes and the body a program reads are checked by one rule.
 */
export function parseClosePost(text: string): DurableCloseBody | "bad-json" | null {
  const root = text === "" ? {} : decode(text);
  if (root === undefined) return "bad-json";
  if (!isRecord(root)) return null;
  const requestId = root.requestId ?? undefined;
  const kind = root.kind ?? undefined;
  const id = root.id ?? undefined;
  if (!isText(requestId) || !isText(id)) return null;
  if (kind !== "pane" && kind !== "tab" && kind !== "workspace") return null;
  return { requestId, kind, id };
}

/** The body of `POST /reopen` (WIRE.md 7.16). */
export interface DurableReopenBody {
  readonly requestId: string;
  readonly id: string;
}

/** Decode a `POST /reopen` body, as a program reads it (the test fake does). */
export function parseReopenPost(text: string): DurableReopenBody | "bad-json" | null {
  const root = text === "" ? {} : decode(text);
  if (root === undefined) return "bad-json";
  if (!isRecord(root)) return null;
  const requestId = root.requestId ?? undefined;
  const id = root.id ?? undefined;
  if (!isText(requestId) || !isText(id) || id === "") return null;
  return { requestId, id };
}

/** Where the events reader stopped for one pane log, as the bridge saves it beside the log (bridge/durable/log.ts). */
export interface SavedCursor {
  readonly epoch: string;
  readonly after: number;
}

/** Decode a saved cursor file, or null for one that is absent, torn or not a cursor: the reader then starts at 0. */
export function parseSavedCursor(text: string): SavedCursor | null {
  const root = decode(text);
  if (!isRecord(root)) return null;
  const epoch = idOf(root, "epoch");
  const after = root.after;
  if (epoch === null || !isCount(after)) return null;
  return { epoch, after };
}

/** One clean ask as the phone reads it (`Ask` in `bridge/types.ts`). Optional fields stay absent. */
function fieldForWire(field: DurableField): AskField {
  const wire: AskField = { id: field.id, label: field.label, kind: field.kind };
  if (field.required === true) wire.required = true;
  if (field.options !== undefined) wire.options = field.options.map((option) => ({ id: option.id, label: option.label }));
  if (field.maxLength !== undefined) wire.maxLength = field.maxLength;
  return wire;
}

export function askForWire(ask: DurableAsk): Ask {
  const wire: Ask = {
    id: ask.id,
    kind: ask.kind,
    toolCallId: ask.toolCallId,
    revision: ask.revision,
    title: ask.title,
    itemId: ask.itemId,
    options: ask.options.map((option) => (option.effect === undefined ? { id: option.id, label: option.label } : { id: option.id, label: option.label, effect: option.effect })),
  };
  if (ask.multiple === true) wire.multiple = true;
  if (ask.placeholder !== undefined) wire.placeholder = ask.placeholder;
  if (ask.maxLength !== undefined) wire.maxLength = ask.maxLength;
  if (ask.fields !== undefined) wire.fields = ask.fields.map(fieldForWire);
  if (ask.reason !== undefined) wire.reason = ask.reason;
  if (ask.cleaned === true) wire.cleaned = true;
  if (ask.push !== undefined) wire.push = ask.push;
  if (ask.expiresAt !== undefined) wire.expiresAt = ask.expiresAt;
  if (ask.tool !== undefined) {
    wire.tool = { name: ask.tool.name, summary: ask.tool.summary };
    if (ask.tool.output !== undefined) wire.tool.output = ask.tool.output;
  }
  return wire;
}

// ── The mapping onto the port ─────────────────────────────────────────────────

/**
 * How a pane is doing (WIRE.md section 5). An open ask wins over `state`, so a program that
 * forgets to say `waiting` still shows as needing a person. Any state Collie does not know is
 * `unknown`. The program never sends `done`: the bridge derives it from working then idle.
 */
export function statusOf(pane: Pick<DurablePane, "state" | "openAsks">): AgentStatus {
  if (pane.openAsks.length > 0 || pane.state === "waiting") return "blocked";
  if (pane.state === "working") return "working";
  if (pane.state === "idle") return "idle";
  return "unknown";
}

/** Every durable pane reports this agent name. The `harness` string is display text only. */
export const DURABLE_AGENT = "durable";

type MutableMuxPane = { -readonly [K in keyof MuxPane]: MuxPane[K] };

/**
 * The clean layout as a mux snapshot (WIRE.md section 5).
 *
 * Spaces are numbered from the program's own order, 1-based, among the workspaces that were kept.
 * Tabs are numbered inside their workspace. A tab or workspace with no pane is still listed.
 */
export function toMuxSnapshot(snapshot: DurableSnapshot): MuxSnapshot {
  const spaceNumber = new Map(snapshot.workspaces.map((workspace, index) => [workspace.id, index + 1]));
  const workspaceById = new Map(snapshot.workspaces.map((workspace) => [workspace.id, workspace]));
  const tabById = new Map(snapshot.tabs.map((tab) => [tab.id, tab]));

  const panesInTab = new Map<string, number>();
  const panesInSpace = new Map<string, number>();
  for (const pane of snapshot.panes) {
    panesInTab.set(pane.tabId, (panesInTab.get(pane.tabId) ?? 0) + 1);
    panesInSpace.set(pane.workspaceId, (panesInSpace.get(pane.workspaceId) ?? 0) + 1);
  }

  const tabsOfSpace = new Map<string, DurableTab[]>();
  for (const tab of snapshot.tabs) tabsOfSpace.set(tab.workspaceId, [...(tabsOfSpace.get(tab.workspaceId) ?? []), tab]);

  const spaces: MuxSpace[] = [];
  const tabs: MuxTab[] = [];
  for (const workspace of snapshot.workspaces) {
    const own = tabsOfSpace.get(workspace.id) ?? [];
    spaces.push({
      spaceId: workspace.id,
      number: spaceNumber.get(workspace.id) ?? 0,
      label: workspace.title === "" ? workspace.id : workspace.title,
      focused: false,
      activeTabId: own[0]?.id ?? "",
      tabCount: own.length,
      paneCount: panesInSpace.get(workspace.id) ?? 0,
      folder: workspace.cwd,
    });
    own.forEach((tab, index) => {
      tabs.push({
        tabId: tab.id,
        spaceId: workspace.id,
        number: index + 1,
        label: tab.title === "" ? String(index + 1) : tab.title,
        focused: false,
        paneCount: panesInTab.get(tab.id) ?? 0,
      });
    });
  }

  const panes: MuxPane[] = [];
  for (const pane of snapshot.panes) {
    const workspace = workspaceById.get(pane.workspaceId);
    const tab = tabById.get(pane.tabId);
    if (workspace === undefined || tab === undefined) continue;
    const mux: MutableMuxPane = {
      paneId: pane.id,
      spaceId: workspace.id,
      spaceLabel: workspace.title === "" ? workspace.id : workspace.title,
      spaceNumber: spaceNumber.get(workspace.id) ?? 0,
      tabId: tab.id,
      // The program is not the operator, so `tabNamed` is never set (WIRE.md section 5).
      tabLabel: tab.title === "" ? undefined : tab.title,
      cwd: pane.cwd ?? workspace.cwd ?? "",
      focused: false,
      alive: true,
      agent: DURABLE_AGENT,
      status: statusOf(pane),
      terminalTitle: pane.title === "" ? undefined : pane.title,
      // The conversation id names the bridge's own log of it, which the `durable` journal adapter
      // reads (bridge/journal/durable.ts). The ref is server-side only, like every other.
      // It is the program's session id when it sends one (WIRE.md 7.16), so the log outlives a pane id.
      agentSession: { kind: "id", value: pane.sessionId ?? pane.id },
    };
    // Optional pane marks (WIRE.md section 7.11). Assigned only when present, so a pane without them is unchanged.
    if (pane.subtitle !== undefined) mux.subtitle = pane.subtitle;
    if (pane.badge !== undefined) mux.badge = pane.badge;
    if (pane.progress !== undefined) mux.progress = pane.progress;
    panes.push(mux);
  }
  return { panes, spaces, tabs };
}
