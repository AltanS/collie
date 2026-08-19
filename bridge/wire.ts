// Pure decoders for Herdr's newline-delimited JSON wire protocol. Kept separate from the socket
// transport (mux/herdr/client.ts) so the parsing/discrimination is importable and unit-testable without
// touching Bun.connect. Protocol facts are documented in HERDR_API.md.

import type { JsonValue } from "./json.ts";

/**
 * Decode one reply line into its `result` payload, or throw a descriptive Error. Herdr replies are
 * `{"id", "result": {...}}` on success or `{"id", "error": {code, message}}` on failure; anything
 * else (bad JSON, or valid JSON of neither shape) is a protocol violation and throws. `method` only
 * decorates the message.
 */
export function decodeReplyLine<T>(line: string, method: string): T {
  let msg: JsonValue;
  try {
    // SAFETY: `JSON.parse` returns exactly a JsonValue by construction — string, number, boolean,
    // null, or an array/object of those. TS types it `any`; this names what it already is, and is
    // what lets every field read below stay checked instead of re-asserted.
    msg = JSON.parse(line) as JsonValue;
  } catch (e) {
    throw new Error(`herdr ${method}: bad reply: ${e instanceof Error ? e.message : String(e)}`, {
      cause: e,
    });
  }
  // An array is `typeof "object"` but can carry neither key, so it lands on the same throw below.
  if (msg !== null && typeof msg === "object" && !Array.isArray(msg)) {
    if ("error" in msg) {
      const err = wireError(msg.error);
      if (err) throw new Error(`herdr ${method}: ${err.code}: ${err.message}`);
    } else if ("result" in msg) {
      // SAFETY: `T` is the CALLER's declared shape for this method's `result` — the wire carries no
      // type tag to check it against, so this cast is the documented boundary of the decoder
      // (HERDR_API.md names the result shape per method). Nothing here can verify it.
      return msg.result as T;
    }
  }
  throw new Error(`herdr ${method}: unexpected reply shape: ${line}`);
}

/** Herdr's error object, as it appears on both a one-shot reply and a stream line. */
type WireError = { code: string; message: string };

/**
 * Read `{code, message}` off a line's `error` field. Returns null when the field is not that shape,
 * which leaves the caller on its "unrecognized line" path — a reply claiming `error` but carrying
 * something else is a protocol violation, not an error to relay.
 */
function wireError(raw: JsonValue | undefined): WireError | null {
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { code, message } = raw;
  if (typeof code !== "string" || typeof message !== "string") return null;
  return { code, message };
}

/**
 * A single line off a live `events.subscribe` stream. The first line is the ack; every line after
 * is an event; an error line can arrive instead of the ack (then the server closes). Unlike a
 * one-shot reply, an error line here is a normal terminal outcome (returned, not thrown) so the
 * caller can report the reason — only a genuine protocol violation (bad JSON / unrecognized shape)
 * throws, matching {@link decodeReplyLine}'s spirit.
 */
export type StreamLine =
  | { kind: "ack" }
  | { kind: "event"; event: string; data: EventData }
  | { kind: "error"; code: string; message: string };

/**
 * The `data` an event line carries: whatever JSON herdr attached, or nothing. Deliberately not
 * narrowed per event — Collie treats events purely as a poke to re-poll and never reads the payload
 * (see mux/herdr/client.ts's `subscribeEvents` doc), so there is no shape to parse against.
 */
export type EventData = JsonValue | undefined;

/**
 * The pane an event's payload names, or null when it names none.
 *
 * The ONE field Collie ever reads out of {@link EventData}, and it is read here rather than at the
 * adapter because this file is the wire boundary. It decides which half of a mux watch an event
 * pokes (bridge/mux/herdr/events.ts) — never what the state is, which stays the poll's job.
 */
export function eventPaneId(data: EventData): string | null {
  if (data === null || data === undefined || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  const paneId = data.pane_id;
  return typeof paneId === "string" && paneId !== "" ? paneId : null;
}

/**
 * Decode one stream line. Subscription ack is `{"id","result":{"type":"subscription_started"}}`;
 * events are `{"event":"<snake_case>","data":{...}}`; a pre-ack failure is `{"id","error":{...}}`.
 * Bad JSON or a shape that is none of those is a protocol violation and throws.
 */
export function decodeStreamLine(line: string): StreamLine {
  let msg: JsonValue;
  try {
    // SAFETY: as in decodeReplyLine — `JSON.parse` output IS a JsonValue by construction.
    msg = JSON.parse(line) as JsonValue;
  } catch (e) {
    throw new Error(`herdr events: bad stream line: ${e instanceof Error ? e.message : String(e)}`, {
      cause: e,
    });
  }
  // An array carries none of the three keys, so it lands on the same throw below.
  if (msg !== null && typeof msg === "object" && !Array.isArray(msg)) {
    if ("error" in msg) {
      const err = wireError(msg.error);
      if (err) return { kind: "error", code: err.code, message: err.message };
    } else if ("result" in msg) {
      const result = msg.result;
      if (
        result !== null &&
        result !== undefined &&
        typeof result === "object" &&
        !Array.isArray(result) &&
        result.type === "subscription_started"
      ) {
        return { kind: "ack" };
      }
      throw new Error(`herdr events: unexpected ack shape: ${line}`);
    } else if ("event" in msg) {
      const event = msg.event;
      if (typeof event !== "string") throw new Error(`herdr events: event name not a string: ${line}`);
      return { kind: "event", event, data: msg.data };
    }
  }
  throw new Error(`herdr events: unrecognized stream line: ${line}`);
}
