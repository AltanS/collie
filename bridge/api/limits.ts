// The local API's bounds (M105 spec 03, decision 18), in one place, so the socket, the operations and
// their tests read the same numbers.

/** The longest request line, in bytes of UTF-8 (the newline not counted). */
export const REQUEST_LINE_MAX = 16 * 1024;
/** How long one request line may take, from its first byte to its newline. */
export const REQUEST_LINE_MS = 2000;
/** The most connections open at once; one more gets one error line and is closed. */
export const CONNECTIONS_MAX = 32;
/**
 * The most `events` waits open on one connection. The socket cannot tell callers apart (every caller
 * is the same Unix user, the file mode lets no other in), so the connection is the "connection owner"
 * decision 18 names: a program that opens several connections gets this many on each, up to the total.
 */
export const WAITS_PER_CONNECTION = 4;
/** The most `events` waits open in all. */
export const WAITS_TOTAL = 16;
/** The longest `events` wait, in seconds. */
export const WAIT_MAX_SECONDS = 25;
/** The largest answer line, serialized, in bytes of UTF-8. `read` caps its screen text below it; an answer past it becomes `api.answer_too_large`. */
export const ANSWER_MAX_BYTES = 1024 * 1024;
/** The longest request `id` and the longest cursor a request may carry. */
export const REQUEST_ID_MAX = 64;
export const CURSOR_MAX = 64;
/** The most requests in flight on one connection, waits included; one more answers `api.too_many_requests` at once. */
export const REQUESTS_PER_CONNECTION = 8;
/** How long a connection with no request in flight and no partial line stays open. */
export const IDLE_MS = 5 * 60 * 1000;
/**
 * The most bytes waiting to be written to one connection: what the socket holds (`writableLength`). Above
 * it the bridge stops reading that connection's requests until the caller reads; a connection that stays
 * above it for {@link WRITE_STALL_MS} is dropped (security read 1, item 1).
 */
export const WRITE_BUFFER_MAX = 2 * 1024 * 1024;
/** How long a connection may stay above {@link WRITE_BUFFER_MAX} before it is dropped. */
export const WRITE_STALL_MS = 10_000;
/** The most `read` operations (a screen read each) in progress on the whole socket; one more answers `api.busy`. */
export const SCREEN_READS_MAX = 4;
/** The wait an `api.busy` answer suggests before the caller tries again, in ms. */
export const BUSY_RETRY_MS = 500;
/** The most events one `events` answer carries, a `gap` or `reset` marker counted; `next` pages on. */
export const EVENTS_PER_ANSWER = 256;
