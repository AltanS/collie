import type { JsonObject, JsonValue } from "@/lib/json";
import { asJsonNumber, asJsonObject, asJsonString } from "@/lib/json";
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

/** The options a card draws: the first six, in the program's order. */
export function visibleOptions(ask: Ask): AskOption[] {
  return ask.options.slice(0, MAX_ASK_OPTIONS);
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
 *  - `late`: someone else answered first. One line, no buttons, gone on the next poll.
 *  - `stale`: the ask changed under the phone. The card shows its new form and asks for a fresh tap.
 *  - `unknown`: the answer may or may not have arrived. "Try again" sends the SAME request id.
 *  - `refused`: nothing ran and the same request would be refused again. The detail is shown.
 */
export type AskPhase = "idle" | "sending" | "taken" | "late" | "stale" | "unknown" | "refused";

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
}

export function freshCard(ask: Ask): AskCardState {
  return { phase: "idle", ask, optionId: null, requestId: null, detail: "", older: false };
}

/** What the answer route said, as the phone reads it. `older` is the old-peer 404, mapped to `stale`. */
export type AnswerResult =
  | { outcome: "taken"; replayed?: true }
  | { outcome: "too-late"; replayed?: true }
  | { outcome: "stale"; ask?: Ask; older?: true }
  | { outcome: "unknown" }
  | { outcome: "refused"; detail: string };

/** A tap: the buttons go off until the answer is in. `requestId` is the one this tap carries. */
export function tapped(state: AskCardState, optionId: string, requestId: string): AskCardState {
  return { ...state, phase: "sending", optionId, requestId, detail: "", older: false };
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
  return ask;
}
