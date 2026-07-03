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
