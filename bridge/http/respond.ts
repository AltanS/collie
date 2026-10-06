// The three response builders every handler uses. Each one passes through `secure()`, which is how
// every bridge response gets its hardening headers (./middleware/secure.ts).

import type { ApiErrorBody } from "../error-codes.ts";
import { gzipJsonResponse } from "../http-cache.ts";
import { secure } from "./middleware/secure.ts";

export function json<TBody>(data: TBody, acceptEncoding: string | null, status = 200): Response {
  const response = gzipJsonResponse(data, acceptEncoding);
  if (status === 200) return secure(response);
  return secure(new Response(response.body, { status, headers: response.headers }));
}

/**
 * A JSON error body with a non-200 status (e.g. an unknown-session 404). The body is tiny (below the
 * gzip threshold), so a plain uncompressed JSON response is the whole story — no need for the gzip
 * path. `acceptEncoding` is accepted for call-site symmetry with {@link json} but not needed here.
 *
 * It takes a BODY rather than a message so a caller must have gone through {@link apiError} to get
 * one — which is what keeps a refusal's English and its code in the catalogue together. The bare
 * `{ error }` shape stays legal for two callers that must not carry a code: the crew link's 404, and
 * the Files view's `404 { error: "unknown-path" }` (ADR 0083), whose `error` IS the machine word, as
 * Changes' `reason: "unknown-path"` is, and which the web tells apart from an older member's 404 by it.
 */
export function jsonError(
  body: ApiErrorBody | { error: string },
  status: number,
  _acceptEncoding: string | null,
): Response {
  return secure(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    }),
  );
}

export function text(body: string, status: number): Response {
  return secure(new Response(body, { status }));
}
