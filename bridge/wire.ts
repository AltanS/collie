// Pure decoders for Herdr's newline-delimited JSON wire protocol. Kept separate from the socket
// adapter (herdr-client.ts) so the parsing/discrimination is importable and unit-testable without
// touching Bun.connect. Protocol facts are documented in HERDR_API.md.

/**
 * Decode one reply line into its `result` payload, or throw a descriptive Error. Herdr replies are
 * `{"id", "result": {...}}` on success or `{"id", "error": {code, message}}` on failure; anything
 * else (bad JSON, or valid JSON of neither shape) is a protocol violation and throws. `method` only
 * decorates the message.
 */
export function decodeReplyLine<T>(line: string, method: string): T {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch (e) {
    throw new Error(`herdr ${method}: bad reply: ${(e as Error).message}`);
  }
  if (msg !== null && typeof msg === "object") {
    if ("error" in msg) {
      const err = (msg as { error: { code: string; message: string } }).error;
      throw new Error(`herdr ${method}: ${err.code}: ${err.message}`);
    }
    if ("result" in msg) return (msg as { result: T }).result;
  }
  throw new Error(`herdr ${method}: unexpected reply shape: ${line}`);
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
  | { kind: "event"; event: string; data: unknown }
  | { kind: "error"; code: string; message: string };

/**
 * Decode one stream line. Subscription ack is `{"id","result":{"type":"subscription_started"}}`;
 * events are `{"event":"<snake_case>","data":{...}}`; a pre-ack failure is `{"id","error":{...}}`.
 * Bad JSON or a shape that is none of those is a protocol violation and throws.
 */
export function decodeStreamLine(line: string): StreamLine {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch (e) {
    throw new Error(`herdr events: bad stream line: ${(e as Error).message}`);
  }
  if (msg !== null && typeof msg === "object") {
    if ("error" in msg) {
      const err = (msg as { error: { code: string; message: string } }).error;
      return { kind: "error", code: err.code, message: err.message };
    }
    if ("result" in msg) {
      const result = (msg as { result: unknown }).result;
      if (
        result !== null &&
        typeof result === "object" &&
        "type" in result &&
        (result as { type: unknown }).type === "subscription_started"
      ) {
        return { kind: "ack" };
      }
      throw new Error(`herdr events: unexpected ack shape: ${line}`);
    }
    if ("event" in msg) {
      const event = (msg as { event: unknown }).event;
      if (typeof event !== "string") throw new Error(`herdr events: event name not a string: ${line}`);
      return { kind: "event", event, data: (msg as { data?: unknown }).data };
    }
  }
  throw new Error(`herdr events: unrecognized stream line: ${line}`);
}
