import type { ControlResult, ControlTarget } from "@/lib/api";
import type { MessageKey } from "@/lib/i18n";
import type { AgentStatus, Ask } from "@/lib/types";

// THE COMPOSER'S RULES FOR A PANE WITH NO SCREEN (ADR 0101), apart from the component.
//
// Text for such a pane goes through `POST /api/pane/:id/send`, and a stop through `/abort`. Both name
// what the phone saw, so the program cannot be steered onto a turn the person never read. This module
// holds the choices a table can pin: which name a control carries, when the steer switch and the Stop
// button show, when a request id may be reused, and what each answer does to the draft.
//
// NOTHING HERE SENDS. The component calls the api on a tap and asks this module what the answer meant.

/** What the pane has shown so far that a control may name. */
export interface ControlPane {
  /** The newest turn (`AgentView.turnId`). Absent until the program has one. */
  turnId?: string;
  /** The open asks, oldest first. */
  asks?: readonly Ask[];
}

/**
 * The name a control carries: the turn the phone saw, else the oldest open ask. A turn id is the
 * rule (ADR 0101 point 2). The ask is the fallback for a program that has asked something before it
 * has a turn to name, so a person can still answer it in words. `null` when the pane has shown
 * neither, and then the bridge refuses with its own reason, which the composer prints.
 */
export function controlTarget(pane: ControlPane): ControlTarget | null {
  if (pane.turnId !== undefined && pane.turnId !== "") return { turnId: pane.turnId };
  const ask = pane.asks?.[0];
  return ask === undefined ? null : { askId: ask.id };
}

/** The steer switch shows only while a turn is running: steering a turn that is not there is a new turn. */
export function steerOffered(status: AgentStatus | undefined): boolean {
  return status === "working";
}

/** Stop shows while a turn runs or waits on a person, and only when there is something to name. */
export function stopOffered(status: AgentStatus | undefined, target: ControlTarget | null): boolean {
  return target !== null && (status === "working" || status === "blocked");
}

/**
 * One request id per INTENT. A retry after `unknown` is the same intent (same text, same switch, same
 * name) and so carries the same id, which is what lets the bridge answer from its receipt instead of
 * sending twice (ADR 0101 point 4). Any change to the intent mints a new id.
 */
export interface IntentId {
  key: string;
  requestId: string;
}

export function intentKey(text: string, steer: boolean, target: ControlTarget | null): string {
  return JSON.stringify([text, steer, target]);
}

export function requestIdFor(held: IntentId | null, key: string, mint: () => string): IntentId {
  return held !== null && held.key === key ? held : { key, requestId: mint() };
}

/** What an answer means for the composer. The caller turns `note` into words with `t()`. */
export interface ControlReading {
  /** The words left the draft: clear it. A refusal, a stale name and an unknown outcome keep it. */
  clear: boolean;
  /** Keep this intent's request id for "send again": only an unknown outcome may have arrived. */
  keepId: boolean;
  /** Read the pane again: the turn moved, so the phone must show what is current before the next tap. */
  reload: boolean;
  /** Which sentence to say. `refused` and `failed` carry the bridge's own detail. */
  note: "sent" | "moved" | "older" | "refused" | "unknown" | "maybe";
  detail: string;
}

export function readControl(result: ControlResult): ControlReading {
  switch (result.outcome) {
    case "ok":
      return { clear: true, keepId: false, reload: true, note: "sent", detail: "" };
    case "stale":
      return {
        clear: false,
        keepId: false,
        // An old machine has nothing newer to show; reading again would change nothing.
        reload: result.older !== true,
        note: result.older === true ? "older" : "moved",
        detail: "",
      };
    case "refused":
      return { clear: false, keepId: false, reload: false, note: "refused", detail: result.detail };
    case "unknown":
      return { clear: false, keepId: true, reload: false, note: "unknown", detail: "" };
    case "maybe-applied":
      // An earlier try had an unknown outcome and the retry found the turn moved. The first try may have
      // landed, so the draft stays for the person to check against the chat, and the next send is new.
      return { clear: false, keepId: false, reload: true, note: "maybe", detail: "" };
  }
}

/**
 * A transport error is read like the bridge not answering: the text may have arrived, so the id is
 * kept. The exception is a refusal the bridge made on purpose (400, 401, 403: a body it could not
 * read, a device that is not paired, one that may not write). That one ran nothing, and "try again"
 * would only be refused again, so it is a `refused` with the error's own words.
 */
export function readThrown(status: number | undefined, message: string): ControlReading {
  if (status === 400 || status === 401 || status === 403) {
    return { clear: false, keepId: false, reload: false, note: "refused", detail: message };
  }
  return { clear: false, keepId: true, reload: false, note: "unknown", detail: "" };
}

/** Which write a reading is about: text to the pane, a stop, or a program's belt action. Their sentences differ. */
export type ControlKind = "send" | "stop" | "action";

/**
 * The sentence for a reading, as a catalog key. A refusal that carries the bridge's own detail is
 * said in that detail instead (the caller prefers `reading.detail` when it is not empty); the key is
 * the fallback for a refusal with no words.
 */
export function noteKey(reading: ControlReading, kind: ControlKind): MessageKey {
  if (kind === "action") return actionNoteKey(reading);
  const stop = kind === "stop";
  switch (reading.note) {
    case "sent":
      return stop ? "durable.composer.stopped" : "durable.composer.sent";
    case "moved":
      return stop ? "durable.composer.stopMoved" : "durable.composer.moved";
    case "older":
      return "durable.composer.older";
    case "refused":
      return stop ? "durable.composer.stopRefused" : "durable.composer.refused";
    case "unknown":
      return stop ? "durable.composer.stopUnknown" : "durable.composer.unknown";
    case "maybe":
      return stop ? "durable.composer.stopMaybe" : "durable.composer.maybe";
  }
}

function actionNoteKey(reading: ControlReading): MessageKey {
  switch (reading.note) {
    case "sent":
      return "durable.action.done";
    case "moved":
      return "durable.action.moved";
    case "older":
      return "durable.action.older";
    case "refused":
      return "durable.action.refused";
    case "unknown":
      return "durable.action.unknown";
    case "maybe":
      return "durable.action.maybe";
  }
}
