// THE DURABLE WIRE, READ AND CLEANED (WIRE.md sections 2, 4, 5 and 6).
//
// This file decodes what the program sends, in one place, and turns it into types the rest of the
// adapter can trust. Nothing here talks to a socket. The program's JSON is untrusted: every id is
// checked, every display string is cleaned and capped, and an object that breaks a rule is dropped
// with whatever hangs from it. What comes out is the CLEAN view of the program (`DurableSnapshot`),
// and then `toMuxSnapshot` maps that onto the mux port.

import { isAbsolute } from "node:path";

import type { AgentStatus, Ask } from "../../types.ts";
import type { MuxPane, MuxSnapshot, MuxSpace, MuxTab } from "../types.ts";
import { blockRule, byteLength, CAPS, changedByCleaning, cleanText, isWireId, lineRule } from "./clean.ts";

// ── Versions ──────────────────────────────────────────────────────────────────

/** A range of wire versions, both ends included. */
export interface ProtocolRange {
  readonly min: number;
  readonly max: number;
}

/** What this Collie speaks. This document is version 1, so the range is 1..1. */
export const SPEAKS: ProtocolRange = { min: 1, max: 1 };

/** The name every durable program sends in `hello` (WIRE.md section 4). A socket without it is something else. */
export const DURABLE_SERVICE = "collie-durable";

/** The refusal detail for a `hello` that does not name {@link DURABLE_SERVICE}. */
export const NOT_A_DURABLE_PROGRAM = "not a durable program";

/** The highest version inside both ranges, or null when they do not meet (WIRE.md section 2). */
export function negotiateVersion(program: ProtocolRange): number | null {
  const highest = Math.min(program.max, SPEAKS.max);
  const lowest = Math.max(program.min, SPEAKS.min);
  return highest >= lowest ? highest : null;
}

/** The refusal detail for two ranges that do not meet. It starts with `incompatible`. */
export function incompatibleDetail(program: ProtocolRange | null): string {
  if (program === null) return "incompatible";
  return `incompatible: program speaks ${String(program.min)}..${String(program.max)}, this Collie speaks ${String(SPEAKS.min)}..${String(SPEAKS.max)}`;
}

// ── The clean types ───────────────────────────────────────────────────────────

/** What the program can do. An absent cap is false, and `terminal` is ignored in version 1. */
export interface DurableCaps {
  readonly asks: boolean;
  readonly starters: boolean;
  readonly send: boolean;
  readonly steer: boolean;
  readonly abort: boolean;
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
  readonly effect: OptionEffect;
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
  readonly reason?: string;
  readonly tool?: DurableToolCall;
  /** True when cleaning cut or changed the title or the reason, so the card says the text was shortened. */
  readonly cleaned?: true;
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

function readOption(value: Json): DurableOption | null {
  if (!isRecord(value)) return null;
  const id = idOf(value, "id");
  const effect = value.effect;
  if (id === null || !isText(effect) || !isEffect(effect)) return null;
  return { id, label: textOf(value, "label", CAPS.optionLabel), effect };
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

/** An ask whose id, tool call id or item id breaks the rule is dropped. */
function readAsk(value: Json): DurableAsk | null {
  if (!isRecord(value)) return null;
  const id = idOf(value, "id");
  const toolCallId = idOf(value, "toolCallId");
  const itemId = idOf(value, "itemId");
  const revision = value.revision;
  if (id === null || toolCallId === null || itemId === null) return null;
  if (!isCount(revision) || revision < 1) return null;

  const options: DurableOption[] = [];
  const raw = value.options;
  if (isList(raw)) {
    for (const entry of raw) {
      const option = readOption(entry);
      if (option !== null && !options.some((have) => have.id === option.id)) options.push(option);
    }
  }
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
    kind: textOf(value, "kind", CAPS.askKind),
    toolCallId,
    revision,
    title: textOf(value, "title", CAPS.askTitle),
    itemId,
    options: options.slice(0, CAPS.optionsPerAsk),
    reason,
    tool,
  };
  return cleaned ? { ...ask, cleaned: true } : ask;
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
  return {
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
  };
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

/** An item with a known id replaces the earlier one. `ts` is ISO 8601, or absent. */
export type DurableItem =
  | { readonly id: string; readonly ts?: string; readonly kind: TextKind; readonly text: string }
  | {
      readonly id: string;
      readonly ts?: string;
      readonly kind: "tool";
      readonly tool: DurableToolCall;
      readonly status: ToolStatus;
    };

export type ClosedBy = "phone" | "stopped";

export type DurableEvent =
  | { readonly type: "item"; readonly item: DurableItem }
  | { readonly type: "remove"; readonly id: string }
  | { readonly type: "ask"; readonly ask: DurableAsk }
  | { readonly type: "ask-closed"; readonly askId: string; readonly by: ClosedBy; readonly waitedMs?: number }
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
    return text === undefined ? null : { id, ts, kind, text };
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
    return {
      type,
      askId,
      by: value.by === "phone" ? "phone" : "stopped",
      waitedMs: isCount(waited) ? waited : undefined,
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
export type LogClosedBy = ClosedBy | "reset";

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
      const by = root.by === "phone" || root.by === "reset" ? root.by : "stopped";
      return { k: "ask-closed", at, askId, by, waitedMs: isCount(waited) ? waited : undefined };
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
  for (const entry of root.events) {
    const event = readEvent(entry);
    if (event !== null) events.push(event);
  }
  const trimmed = root.trimmed;
  return good({ epoch, events, next, reset, more: root.more === true, trimmed: isCount(trimmed) ? trimmed : 0 });
}

// ── answer ────────────────────────────────────────────────────────────────────

/** What a 200 to `POST /pane/:id/answer` said (WIRE.md section 4, `AnswerReply`). */
export interface DurableAnswerReply {
  readonly result: "taken" | "too-late";
  readonly replayed: boolean;
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
  readonly optionId: string;
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
  const choice = root.answer;
  const optionId = isRecord(choice) ? choice.optionId : undefined;
  if (!isText(requestId) || !isText(askId) || !isCount(revision) || !isText(optionId)) return null;
  return { requestId, askId, revision, optionId };
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

/** One clean ask as the phone reads it (`Ask` in `bridge/types.ts`). Optional fields stay absent. */
export function askForWire(ask: DurableAsk): Ask {
  const wire: Ask = {
    id: ask.id,
    kind: ask.kind,
    toolCallId: ask.toolCallId,
    revision: ask.revision,
    title: ask.title,
    itemId: ask.itemId,
    options: ask.options.map((option) => ({ id: option.id, label: option.label, effect: option.effect })),
  };
  if (ask.reason !== undefined) wire.reason = ask.reason;
  if (ask.cleaned === true) wire.cleaned = true;
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
    panes.push({
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
      agentSession: { kind: "id", value: pane.id },
    });
  }
  return { panes, spaces, tabs };
}
