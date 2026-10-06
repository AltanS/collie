// The hardening headers every bridge response carries, and the one function that sets them.
//
// Not a router-wide middleware, on purpose. Every response the bridge emits already funnels through
// `json()`, `text()`, `jsonError()`, `serveStatic()` or an inline `secure(new Response(...))`, so the
// headers are set exactly once, where the response is made. A wrapper on the way out would also touch
// the few responses that never carried them (the Access gate's 401/503), which would be new
// behaviour. The two places the old dispatch secured a response it did not make itself, a crew
// answer and the deposed page, call `secure()` directly (server.ts and ./deposed.ts).

// Hardening headers set on EVERY response (static + API).
// nosniff stops content-type confusion; no-referrer keeps the tailnet URL out of any Referer.
export const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
} satisfies Record<string, string>;

/** Apply the shared hardening headers (nosniff / no-referrer) to a response, in place. */
export function secure(res: Response): Response {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
  return res;
}
