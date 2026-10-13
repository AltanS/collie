// The bearer check (WIRE.md section 1B). The token is the whole gate of a public URL, so it runs before anything
// else, before the version, hello and ready, and before the Durable Object is touched: a stranger learns nothing
// and wakes nothing.

/** The shortest token the Worker accepts, in bytes. Collie demands the same of COLLIE_DURABLE_TOKEN. */
export const TOKEN_MIN_BYTES = 32;

const encoder = new TextEncoder();
const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(s)));

/** A configured token that may be used: set, and at least 32 bytes. Anything else matches no request. */
const usable = (configured: string | undefined): configured is string => configured !== undefined && encoder.encode(configured).byteLength >= TOKEN_MIN_BYTES;

/**
 * True when `Authorization: Bearer <token>` carries `COLLIE_TOKEN`, or `COLLIE_TOKEN_NEXT` while a rotation runs.
 * Each is hashed first, so every compare runs over 32 bytes and in constant time, whatever the length of the guess,
 * and both are always compared, so the time does not say which one matched.
 */
export async function tokenAccepted(request: Request, configured: string | undefined, next?: string): Promise<boolean> {
  const tokens = [configured, next].filter(usable);
  if (tokens.length === 0) return false; // fail closed
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header);
  const [guess, held] = await Promise.all([digest(match?.[1] ?? ""), Promise.all(tokens.map(digest))]);
  // An empty guess never matches: every usable token is 32 bytes or more.
  return held.map((b) => crypto.subtle.timingSafeEqual(guess, b)).includes(true);
}

/** The answer to a missing or wrong token: 401 and nothing else, no range, no epoch, no route. */
export const refused = () =>
  new Response(JSON.stringify({ code: "unauthorized" }), { status: 401, headers: { "content-type": "application/json", "www-authenticate": "Bearer" } });
