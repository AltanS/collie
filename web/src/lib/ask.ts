import type { JsonObject, JsonValue } from "@/lib/json";
import { asJsonNumber, asJsonObject, asJsonString } from "@/lib/json";
import type { MessageKey } from "@/lib/i18n";
import type { Ask, AskOption, AskTool } from "@/lib/types";

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

/** The one kind this version can answer. A card of another kind is shown, with no buttons. */
const ANSWERABLE_KIND = "permission";

const EFFECTS: readonly AskOption["effect"][] = ["allow", "allow-always", "deny", "cancel"];

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

/** The options a card draws: the first six, in the program's order, without an "Always allow" the card cannot scope. */
export function visibleOptions(ask: Ask): AskOption[] {
  const offered = alwaysAllowOffered(ask);
  return ask.options.filter((o) => offered || o.effect !== "allow-always").slice(0, MAX_ASK_OPTIONS);
}

/** Collie's own wording for an option's effect. The program's label never replaces it. */
export function effectKey(effect: AskOption["effect"]): MessageKey {
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

/** Whether a person can answer this ask from here: a kind this version knows, and at least one option. */
export function answerable(ask: Ask): boolean {
  return ask.kind === ANSWERABLE_KIND && ask.options.length > 0;
}

/**
 * How heavy an option looks. `allow` is the one primary choice; the rest are plain rows, so a deny
 * or a cancel is never the button the eye lands on. The tone names a row of the shared option
 * surface (components/option-button.tsx), so a durable ask reads like a permission card.
 */
export function optionTone(effect: AskOption["effect"]): "selected" | "default" {
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
  /** The tapped option, while `sending`, `unknown` or `refused`. */
  optionId: string | null;
  /** The request id of the tap in flight or unknown. Reused by "Try again", never by a new tap. */
  requestId: string | null;
  /** For `refused`: the line the bridge gave. For `stale`: nothing. */
  detail: string;
  /** For `stale` only: this machine's Collie is too old to take answers, so a fresh tap cannot help. */
  older: boolean;
  /** The option whose first tap is in: "Always allow" posts only on a second tap. Any other tap clears it. */
  armed: string | null;
}

export function freshCard(ask: Ask): AskCardState {
  return { phase: "idle", ask, optionId: null, requestId: null, detail: "", older: false, armed: null };
}

/** What the answer route said, as the phone reads it. `older` is the old-peer 404, mapped to `stale`. */
export type AnswerResult =
  | { outcome: "taken"; replayed?: true }
  | { outcome: "too-late"; replayed?: true }
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
  return { ...state, phase: "sending", optionId, requestId, detail: "", older: false, armed: null };
}

/** The route answered. */
export function answered(state: AskCardState, result: AnswerResult): AskCardState {
  switch (result.outcome) {
    case "taken":
      return { ...state, phase: "taken", detail: "", older: false };
    case "too-late":
      return { ...state, phase: "late", detail: "", older: false };
    case "stale": {
      // The returned ask replaces the card when the program sent one; otherwise the next poll does.
      // Either way the buttons come back and the person taps again, on the new form, with a new id.
      const ask = result.ask ?? state.ask;
      return { ...state, phase: "stale", ask, optionId: null, requestId: null, detail: "", older: result.older === true };
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
  const effect = EFFECTS.find((e) => e === o.effect);
  return id === undefined || label === undefined || effect === undefined ? undefined : { id, label, effect };
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
  return ask;
}
