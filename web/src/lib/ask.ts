import type { JsonObject, JsonValue } from "@/lib/json";
import { asJsonNumber, asJsonObject, asJsonString } from "@/lib/json";
import type { MessageKey } from "@/lib/i18n";
import type { Ask, AskDecided, AskField, AskOption, AskTool } from "@/lib/types";

// THE ASK CARD'S RULES (ADR 0100), apart from the component so each one is a table test.
//
// An ask is DATA the pane carries (`AgentView.asks`), not a dialog read off a screen. It has an id, a
// revision and options with an effect, and a person answers by naming them. This module holds what is
// true of an ask with no React in it: which options show, how heavy each one looks, how the card
// moves when the bridge answers, where the card sits in the stream, and how an ask from a 409 body
// is trusted.
//
// ONLY A PERSON'S TAP POSTS. Nothing here sends anything, and nothing in the component sends without
// a tap: no effect, no timer, no poll result ever calls the answer route (ADR 0024, ADR 0100 point 4).

/** The most options a card draws. The bridge caps at six; a program that sends more is cut here too. */
export const MAX_ASK_OPTIONS = 6;

/** The kinds this version can answer. A card of another kind is shown, with no buttons. */
const ANSWERABLE_KINDS: ReadonlySet<string> = new Set(["permission", "choice", "text", "form"]);

/** The most characters a text ask or field takes when the program names no limit. Mirrors the bridge. */
export const DEFAULT_TEXT_LENGTH = 500;

const EFFECTS = ["allow", "allow-always", "deny", "cancel"] as const;
type Effect = (typeof EFFECTS)[number];

/** How many asks a pane draws as cards before the "N more" row. The bridge lists every open ask (up to 50). */
export const ASKS_SHOWN = 5;

export interface ShownAsks {
  shown: readonly Ask[];
  hidden: number;
}

/**
 * The asks to draw and how many stay folded. The first {@link ASKS_SHOWN}, oldest first (the list's own
 * order), until the person opens the rest; `hidden` is zero once `expanded` or when the list fits.
 */
export function shownAsks(list: readonly Ask[], expanded: boolean): ShownAsks {
  if (expanded || list.length <= ASKS_SHOWN) return { shown: list, hidden: 0 };
  return { shown: list.slice(0, ASKS_SHOWN), hidden: list.length - ASKS_SHOWN };
}

/**
 * Whether "Always allow" may be offered on this ask. It needs a scope to state on the second tap, which
 * is the tool's name, and it is withheld when the bridge cut or changed the program's words: a person
 * must not grant a standing permission on text they were not shown whole.
 */
export function alwaysAllowOffered(ask: Ask): boolean {
  return ask.cleaned !== true && ask.tool !== undefined && ask.tool.name.trim() !== "";
}

/**
 * The options a card draws: the first six of a permission, without an "Always allow" the card cannot scope.
 * A choice draws its own first eight, which have no effect to withhold.
 */
export function visibleOptions(ask: Ask): AskOption[] {
  if (ask.kind === "choice") return ask.options.slice(0, MAX_CHOICE_OPTIONS);
  const offered = alwaysAllowOffered(ask);
  return ask.options.filter((o) => o.effect !== undefined && (offered || o.effect !== "allow-always")).slice(0, MAX_ASK_OPTIONS);
}

/** The most options a choice ask draws. The bridge caps at eight; a program that sends more is cut here too. */
export const MAX_CHOICE_OPTIONS = 8;
/** The most fields a form ask draws. */
export const MAX_FORM_FIELDS = 6;

/** Collie's own wording for an option's effect. The program's label never replaces it. */
export function effectKey(effect: Effect): MessageKey {
  switch (effect) {
    case "allow":
      return "ask.effect.allow";
    case "allow-always":
      return "ask.effect.allowAlways";
    case "deny":
      return "ask.effect.deny";
    case "cancel":
      return "ask.effect.cancel";
  }
}

/** The program's own label as the quiet second line of a button, or `undefined` when it only repeats the main wording. */
export function secondaryLabel(label: string, main: string): string | undefined {
  return label.trim().toLowerCase() === main.trim().toLowerCase() ? undefined : label;
}

/**
 * Whether a person can answer this ask from here: a kind this version knows, with what it needs to be
 * answered. A permission or a choice needs an option. A text ask needs nothing. A form needs a field,
 * and every choice field of it needs an option, or the person could not fill it in.
 */
export function answerable(ask: Ask): boolean {
  if (!ANSWERABLE_KINDS.has(ask.kind)) return false;
  if (ask.kind === "text") return true;
  if (ask.kind === "form") {
    const fields = formFields(ask);
    return fields.length > 0 && fields.every((f) => f.kind !== "choice" || (f.options ?? []).length > 0);
  }
  return ask.options.length > 0;
}

/** The fields a form card draws: the first six. */
export function formFields(ask: Ask): AskField[] {
  return (ask.fields ?? []).slice(0, MAX_FORM_FIELDS);
}

// ── What a person answers ─────────────────────────────────────────────────────

/** An answer as the route takes it: exactly one of these members, by the kind of the ask (WIRE.md 7.14). */
export type AskAnswer =
  | { optionId: string }
  | { optionIds: string[] }
  | { text: string }
  | { values: FormValues };

/** The longest text this ask takes, in characters. */
export function textLimit(source: { maxLength?: number }): number {
  return source.maxLength ?? DEFAULT_TEXT_LENGTH;
}

/** Whether a typed line may be sent: something besides spaces, and not over the limit. */
export function textReady(text: string, source: { maxLength?: number }): boolean {
  return text.trim() !== "" && [...text.trim()].length <= textLimit(source);
}

/** The ids picked after a tap on `id`. Without `multiple` the tap replaces; with it, the tap flips that id. */
export function pickedAfter(picked: readonly string[], id: string, multiple: boolean): string[] {
  if (!multiple) return [id];
  return picked.includes(id) ? picked.filter((p) => p !== id) : [...picked, id];
}

/** The values a form sends, by field id: a trimmed line, a picked option id, or a toggle's boolean. */
export type FormValues = Record<string, string | boolean>;

/** What a form draft holds. `lines` has a text field's line or a choice field's picked option id; `flags` has the toggles. */
export interface FormDraft {
  lines: Record<string, string>;
  flags: Record<string, boolean>;
}

export const EMPTY_DRAFT: FormDraft = { lines: {}, flags: {} };

/** Whether the form may be sent: every required field has a value, and no text is over its limit. */
export function formReady(ask: Ask, draft: FormDraft): boolean {
  return formFields(ask).every((field) => {
    if (field.kind === "toggle") return true; // a toggle always has a value: off is an answer
    const line = (draft.lines[field.id] ?? "").trim();
    if (line === "") return field.required !== true;
    return field.kind === "choice" || textReady(line, field);
  });
}

/** The values a form sends: filled fields only, text trimmed, and every toggle with its boolean. */
export function formValues(ask: Ask, draft: FormDraft) {
  const values: FormValues = {};
  for (const field of formFields(ask)) {
    const line = (draft.lines[field.id] ?? "").trim();
    if (field.kind === "toggle") values[field.id] = draft.flags[field.id] === true;
    else if (line !== "") values[field.id] = line;
  }
  return values;
}

/**
 * How heavy an option looks. `allow` is the one primary choice; the rest are plain rows, so a deny
 * or a cancel is never the button the eye lands on. The tone names a row of the shared option
 * surface (components/option-button.tsx), so a durable ask reads like a permission card.
 */
export function optionTone(effect: AskOption["effect"] | undefined): "selected" | "default" {
  return effect === "allow" ? "selected" : "default";
}

// ── The card's state ──────────────────────────────────────────────────────────

/**
 * Where a card stands.
 *
 *  - `idle`: nothing sent. The buttons are live.
 *  - `sending`: a tap is on its way. Every button is off, the tapped one wears a spinner.
 *  - `taken`: the program took the answer. The card closes.
 *  - `late`: the program said `too-late`: the ask was not open when the answer came. Someone else
 *    answered, the turn stopped, or the program woke and has not raised the question again yet (it
 *    keeps its id, M50 spec 14). One line, no buttons; the next poll drops the card or shows it again.
 *    `decided` says who decided first when the program told (M55 spec 14), so the line can say it.
 *  - `stale`: the ask changed under the phone. The card shows its new form and asks for a fresh tap.
 *  - `unknown`: the answer may or may not have arrived. "Try again" sends the SAME request id.
 *  - `maybe`: an earlier try had an unknown outcome and the retry found the ask closed or changed, so
 *    the first try may have landed. No buttons; the person checks the chat.
 *  - `refused`: nothing ran and the same request would be refused again. The detail is shown.
 */
export type AskPhase = "idle" | "sending" | "taken" | "late" | "stale" | "unknown" | "maybe" | "refused";

export interface AskCardState {
  phase: AskPhase;
  /** The ask as the card draws it now: the polled one, or the newer form a 409 returned. */
  ask: Ask;
  /** The tapped option, while `sending`, `unknown` or `refused`. Null for an answer that is not one option. */
  optionId: string | null;
  /** The answer in flight or unknown, so "Try again" sends the same one. */
  answer: AskAnswer | null;
  /** The request id of the tap in flight or unknown. Reused by "Try again", never by a new tap. */
  requestId: string | null;
  /** For `refused`: the line the bridge gave. For `stale`: nothing. */
  detail: string;
  /** For `stale` only: this machine's Collie is too old to take answers, so a fresh tap cannot help. */
  older: boolean;
  /** The option whose first tap is in: "Always allow" posts only on a second tap. Any other tap clears it. */
  armed: string | null;
  /** For `late`: who decided the ask first, and when, when the program said so. Null otherwise. */
  decided: AskDecided | null;
}

export function freshCard(ask: Ask): AskCardState {
  return { phase: "idle", ask, optionId: null, answer: null, requestId: null, detail: "", older: false, armed: null, decided: null };
}

/** What the answer route said, as the phone reads it. `older` is the old-peer 404, mapped to `stale`. */
export type AnswerResult =
  | { outcome: "taken"; replayed?: true }
  | { outcome: "too-late"; decided?: AskDecided; replayed?: true }
  | { outcome: "stale"; ask?: Ask; older?: true }
  | { outcome: "unknown" }
  | { outcome: "maybe-applied" }
  | { outcome: "refused"; detail: string };

export interface Pressed {
  state: AskCardState;
  post: boolean;
}

/**
 * A press on an option, before anything is sent. "Always allow" needs two: the first arms it (the card
 * then names the tool it would cover) and posts nothing; the second, on the same option, posts. A press
 * on any other option disarms it. Every other effect posts at once.
 */
export function pressed(state: AskCardState, option: AskOption): Pressed {
  if (option.effect !== "allow-always") return { state: { ...state, armed: null }, post: true };
  if (state.armed === option.id) return { state: { ...state, armed: null }, post: true };
  return { state: { ...state, armed: option.id }, post: false };
}

/** A tap: the buttons go off until the answer is in. `requestId` is the one this tap carries. */
export function tapped(state: AskCardState, optionId: string, requestId: string): AskCardState {
  return sent(state, { optionId }, requestId);
}

/** A tap that sends any answer: the buttons go off until the answer is in. */
export function sent(state: AskCardState, answer: AskAnswer, requestId: string): AskCardState {
  const optionId = "optionId" in answer ? answer.optionId : null;
  return { ...state, phase: "sending", optionId, answer, requestId, detail: "", older: false, armed: null };
}

/** The route answered. */
export function answered(state: AskCardState, result: AnswerResult): AskCardState {
  switch (result.outcome) {
    case "taken":
      return { ...state, phase: "taken", detail: "", older: false };
    case "too-late":
      return { ...state, phase: "late", detail: "", older: false, decided: result.decided ?? null };
    case "stale": {
      // The returned ask replaces the card when the program sent one; otherwise the next poll does.
      // Either way the buttons come back and the person taps again, on the new form, with a new id.
      const ask = result.ask ?? state.ask;
      return { ...state, phase: "stale", ask, optionId: null, answer: null, requestId: null, detail: "", older: result.older === true };
    }
    case "unknown":
      // Keep the request id and the choice: "Try again" is the same intent, and the bridge replays it.
      return { ...state, phase: "unknown", detail: "", older: false };
    case "maybe-applied":
      // The retry found the ask closed or changed. The first try may have landed, so no button stays live.
      return { ...state, phase: "maybe", detail: "", older: false };
    case "refused":
      return { ...state, phase: "refused", detail: result.detail, older: false };
  }
}

/**
 * The poll brought this ask again. It changes the card only when it is a NEWER form of the same ask:
 * a higher revision wins over whatever the card holds, and a card in `stale` or `idle` takes it. A
 * card mid-tap (`sending`) or waiting for a retry (`unknown`) keeps its own face, because swapping
 * the options under a finger is how a tap lands on the wrong row.
 */
export function polled(state: AskCardState, ask: Ask): AskCardState {
  if (ask.revision <= state.ask.revision) return state;
  if (state.phase === "sending" || state.phase === "unknown") return state;
  return freshCard(ask);
}

// ── Where a card sits ─────────────────────────────────────────────────────────

/** An item id as a stream block may carry it: the program's own, or `<id>:<n>` for one part of it. */
function sitsUnder(blockItemId: string, itemId: string): boolean {
  return blockItemId === itemId || blockItemId.startsWith(`${itemId}:`);
}

/**
 * Which block of the stream an ask sits under, by index, or `null` for the tail. The block is the
 * first whose items include the ask's item, so a card follows the tool call it is about. An ask
 * whose item is not shown (older than the window, or never logged) goes to the tail.
 */
export function blockOf(blocks: readonly (readonly { id: string }[])[], ask: Ask): number | null {
  const at = blocks.findIndex((block) => block.some((item) => sitsUnder(item.id, ask.itemId)));
  return at < 0 ? null : at;
}

/** The asks under block `index`, and (with `null`) the asks that go to the tail. Order is kept. */
export function asksAt(
  blocks: readonly (readonly { id: string }[])[],
  asks: readonly Ask[],
  index: number | null,
): Ask[] {
  return asks.filter((ask) => blockOf(blocks, ask) === index);
}

// ── An ask from a 409 body ───────────────────────────────────────────────────

function str(v: JsonValue | undefined): string | undefined {
  const s = asJsonString(v);
  return s === undefined || s === "" ? undefined : s;
}

function optionOf(v: JsonValue | undefined): AskOption | undefined {
  const o = asJsonObject(v);
  if (!o) return undefined;
  const id = str(o.id);
  const label = str(o.label);
  if (id === undefined || label === undefined) return undefined;
  if (o.effect === undefined) return { id, label };
  const effect = EFFECTS.find((e) => e === o.effect);
  return effect === undefined ? undefined : { id, label, effect };
}

function fieldOf(v: JsonValue | undefined): AskField | undefined {
  const o = asJsonObject(v);
  if (!o) return undefined;
  const id = str(o.id);
  const label = str(o.label);
  const kind = (["text", "choice", "toggle"] as const).find((k) => k === o.kind);
  if (id === undefined || label === undefined || kind === undefined) return undefined;
  const field: AskField = { id, label, kind };
  if (o.required === true) field.required = true;
  const maxLength = asJsonNumber(o.maxLength);
  if (maxLength !== undefined) field.maxLength = maxLength;
  if (Array.isArray(o.options)) {
    const options: AskOption[] = [];
    for (const raw of o.options) {
      const option = optionOf(raw);
      if (option === undefined) return undefined;
      options.push(option);
    }
    field.options = options;
  }
  return field;
}

function toolOf(v: JsonValue | undefined): AskTool | undefined {
  const o = asJsonObject(v);
  if (!o) return undefined;
  const name = str(o.name);
  const summary = asJsonString(o.summary);
  if (name === undefined || summary === undefined) return undefined;
  const tool: AskTool = { name, summary };
  const output = str(o.output);
  if (output !== undefined) tool.output = output;
  return tool;
}

/** An ISO 8601 moment, or undefined when the value is not a string or not a time. */
function isoOf(v: JsonValue | undefined): string | undefined {
  const text = asJsonString(v);
  return text !== undefined && Number.isFinite(Date.parse(text)) ? text : undefined;
}

/** A too-late answer's `decided`, or undefined when it is not one: a known word and a time. */
export function decidedOf(v: JsonValue | undefined): AskDecided | undefined {
  const o = asJsonObject(v);
  if (!o) return undefined;
  const at = isoOf(o.at);
  if (at === undefined) return undefined;
  if (o.by === "phone" || o.by === "program" || o.by === "timeout") return { by: o.by, at };
  return undefined;
}

/**
 * An ask read out of a response body. The bridge cleaned every string, but this body crossed a crew
 * link, so a field of the wrong type drops the whole ask: a card is never drawn from half a shape.
 */
export function parseAsk(v: JsonValue | undefined): Ask | undefined {
  const o: JsonObject | undefined = asJsonObject(v);
  if (!o) return undefined;
  const id = str(o.id);
  const kind = str(o.kind);
  const toolCallId = str(o.toolCallId);
  const title = asJsonString(o.title);
  const itemId = asJsonString(o.itemId);
  const revision = asJsonNumber(o.revision);
  if (id === undefined || kind === undefined || toolCallId === undefined) return undefined;
  if (title === undefined || itemId === undefined || revision === undefined) return undefined;
  if (!Array.isArray(o.options)) return undefined;
  const options: AskOption[] = [];
  for (const raw of o.options) {
    const option = optionOf(raw);
    if (option === undefined) return undefined;
    options.push(option);
  }
  const ask: Ask = { id, kind, toolCallId, revision, title, itemId, options };
  const reason = str(o.reason);
  if (reason !== undefined) ask.reason = reason;
  const tool = toolOf(o.tool);
  if (tool !== undefined) ask.tool = tool;
  if (o.cleaned === true) ask.cleaned = true;
  const expiresAt = isoOf(o.expiresAt);
  if (expiresAt !== undefined) ask.expiresAt = expiresAt;
  if (o.multiple === true) ask.multiple = true;
  const placeholder = str(o.placeholder);
  if (placeholder !== undefined) ask.placeholder = placeholder;
  const maxLength = asJsonNumber(o.maxLength);
  if (maxLength !== undefined) ask.maxLength = maxLength;
  if (Array.isArray(o.fields)) {
    const fields: AskField[] = [];
    for (const raw of o.fields) {
      const field = fieldOf(raw);
      if (field === undefined) return undefined;
      fields.push(field);
    }
    ask.fields = fields;
  }
  return ask;
}
