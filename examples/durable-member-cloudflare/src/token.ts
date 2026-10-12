// The bearer check (WIRE.md section 1B). The token is the whole gate of a public URL, so it runs before anything
// else, before the version, hello and ready, and before the Durable Object is touched: a stranger learns nothing
// and wakes nothing.

/** The shortest token the Worker accepts, in bytes. Collie demands the same of COLLIE_DURABLE_TOKEN. */
export const TOKEN_MIN_BYTES = 32;

const encoder = new TextEncoder();
const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(s)));

/**
 * True when `Authorization: Bearer <token>` carries the configured token. The two are hashed first, so the compare
 * always runs over 32 bytes and in constant time, whatever the length of the guess.
 */
export async function tokenAccepted(request: Request, configured: string | undefined): Promise<boolean> {
  if (configured === undefined || encoder.encode(configured).byteLength < TOKEN_MIN_BYTES) return false; // fail closed
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header);
  const given = match?.[1] ?? "";
  const [a, b] = await Promise.all([digest(given), digest(configured)]);
  return crypto.subtle.timingSafeEqual(a, b); // an empty guess never matches: the configured token is 32 bytes or more
}

/** The answer to a missing or wrong token: 401 and nothing else, no range, no epoch, no route. */
export const refused = () =>
  new Response(JSON.stringify({ code: "unauthorized" }), { status: 401, headers: { "content-type": "application/json", "www-authenticate": "Bearer" } });
