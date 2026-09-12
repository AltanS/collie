
// Pure, injectable HTTP cache helpers: ETag + conditional GET + gzip JSON.
//
// Kept separate from server.ts so they can be exercised under `bun test` without
// needing Bun.serve or the Herdr socket — all functions are synchronous or return
// a plain Response, with no I/O.

// Only compress if serialised body is at least this many bytes; below this the
// deflate overhead and header cost outweigh the savings.
const GZIP_MIN_BYTES = 256;

/**
 * The one rule for "should this body go out gzipped": the client offered gzip, and the body is big
 * enough that the saving beats gzip's own framing. Takes a LENGTH rather than the body so a caller
 * that would have to read a file off disk can ask before reading it — that is what
 * `serveStatic` in server.ts does, with its own, larger floor.
 */
export function wantsGzip(
  acceptEncoding: string | null,
  byteLength: number,
  minBytes: number = GZIP_MIN_BYTES,
): boolean {
  return acceptEncoding !== null && acceptEncoding.includes("gzip") && byteLength >= minBytes;
}

/**
 * Compute a strong ETag for the given response body.
 * Uses Bun.hash (Wyhash) — fast and deterministic within a process.
 * Returns a quoted ETag value as required by RFC 7232.
 *
 * Takes BYTES as well as a string because not every body the bridge validates is text: an operator's
 * font file is a woff2, and hashing its content is what makes the tag strong rather than a guess
 * assembled from a size and an mtime.
 */
export function computeEtag(body: string | Uint8Array): string {
  // toString(16) works for both number and bigint, which covers all Bun.hash overloads.
  return `"${Bun.hash(body).toString(16)}"`;
}

/**
 * Return true when the request's If-None-Match header equals the computed ETag,
 * meaning the client already holds the current representation.
 * Returns false for a null header (no previous ETag known to the client).
 */
export function notModified(ifNoneMatch: string | null, etag: string): boolean {
  return ifNoneMatch !== null && ifNoneMatch === etag;
}

/**
 * Build a JSON Response, gzip-compressing the body when the client signals gzip
 * support via Accept-Encoding and the serialised body is large enough to benefit.
 *
 * Behaviour:
 * - Always sets `content-type: application/json` and `cache-control: no-store`.
 * - When compressed: adds `content-encoding: gzip` and `vary: accept-encoding`.
 * - `extraHeaders` are merged in after the standard headers so callers can attach
 *   an ETag or other fields (e.g. `{ etag: '"abc"' }`).
 */
/**
 * The headers this module composes: the two it always sets, the two the gzip branch adds, and
 * whatever the caller attached. Named rather than a bare `Record<string, string>` so the four keys
 * this function owns are visible in the type.
 */
type ResponseHeaders = {
  "content-type": string;
  "cache-control": string;
  "content-encoding"?: string;
  vary?: string;
} & Record<string, string>;

export function gzipJsonResponse<TBody>(
  data: TBody,
  acceptEncoding: string | null,
  extraHeaders: Record<string, string> = {},
): Response {
  const body = JSON.stringify(data);
  const useGzip = wantsGzip(acceptEncoding, body.length);

  const headers: ResponseHeaders = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders,
  };

  if (useGzip) {
    const compressed = Bun.gzipSync(body);
    headers["content-encoding"] = "gzip";
    headers["vary"] = "accept-encoding";
    return new Response(compressed, { headers });
  }

  return new Response(body, { headers });
}
