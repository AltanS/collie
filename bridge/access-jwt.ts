// ── THE CLOUDFLARE ACCESS GATE (#341, ADR 0081) ──────────────────────────────
//
// Off unless the operator names both an Access team and the application's audience tag. When on,
// a request that came through Cloudflare must carry a `Cf-Access-Jwt-Assertion` that verifies
// against the team's published keys, with this application's `aud`, the team's `iss`, and an `exp`
// in the future. Anything else is refused, so a deleted Access app, a bypass rule or a policy that
// has not propagated yet no longer leaves the panes open to whoever finds the hostname.
//
// WHY THE AUDIENCE IS THE CHECK THAT MATTERS. Every self-hosted Access application in a team is
// signed with the same key, so a signature-only check accepts a token Cloudflare issued for any
// other application in that team. The `aud` tag names this one.
//
// WHAT IS NOT READ. `Cf-Access-Authenticated-User-Email` is a plain header that Cloudflare writes
// only while Access is in the path; without Access it is whatever the client sent. Only the signed
// token is evidence.
//
// FAIL CLOSED, BOTH WAYS. Half a configuration refuses every gated request rather than serving
// open. Keys that were never fetched refuse every gated request (503) and the fetch retries; keys
// fetched once are kept when a refresh fails, because Cloudflare keeps the previous key valid for
// days after a rotation.
//
// No dependency: WebCrypto verifies RS256, and the JWT envelope is three base64url segments.

import type { JsonObject, JsonValue } from "./json.ts";

/** The settings this gate reads. Both empty = the gate is off. */
export interface AccessGateSettings {
  /** `COLLIE_ACCESS_TEAM`: `myteam`, `myteam.cloudflareaccess.com`, or the https issuer URL. */
  accessTeam: string;
  /** `COLLIE_ACCESS_AUD`: the Access application's audience tag(s). */
  accessAud: readonly string[];
}

/** One answer from the gate: null admits, a Response refuses. */
export type AccessDecision = Response | null;

/** The header Cloudflare Access adds to every request it lets through. */
export const ACCESS_JWT_HEADER = "cf-access-jwt-assertion";

/**
 * Headers the Cloudflare edge stamps on every request it proxies. A request carrying none of them,
 * addressed to a loopback Host, did not come through the tunnel: it is a local process (`collie
 * doctor`, `curl`), and a local process can already reach the loopback port directly, so the gate
 * has nothing to protect there. The edge adds these itself; a remote client cannot strip them.
 */
const EDGE_HEADERS = ["cf-ray", "cf-connecting-ip", "cf-visitor", ACCESS_JWT_HEADER] as const;

const LOOPBACK_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/i;

/** Seconds of clock skew tolerated on `exp` and `nbf`. */
const SKEW_S = 60;
/** How often the keys are refreshed while all is well. */
const REFRESH_MS = 60 * 60 * 1000;
/** The fastest an unknown `kid` may trigger a refetch. Guards Cloudflare against a token spray. */
const UNKNOWN_KID_REFETCH_MS = 30 * 1000;
/** A certs fetch that has not answered by then has failed; a request may be waiting on it. */
const FETCH_TIMEOUT_MS = 10_000;
/** Retry ladder while no key was ever loaded. */
const FIRST_LOAD_RETRY_MS = [2_000, 5_000, 15_000, 30_000, 60_000] as const;

/**
 * The issuer for a configured team, or null when the value cannot name one.
 *
 * `myteam` and `myteam.cloudflareaccess.com` both mean `https://myteam.cloudflareaccess.com`. A full
 * `https://` URL is taken as the issuer verbatim (minus a trailing slash). Plain `http://` is refused,
 * because the keys would then travel unauthenticated.
 */
export function accessIssuer(team: string): string | null {
  const t = team.trim();
  if (t === "") return null;
  if (/^https:\/\//i.test(t)) {
    try {
      const u = new URL(t);
      if (u.pathname !== "/" || u.search || u.hash || u.username || u.password) return null;
      return `https://${u.host.toLowerCase()}`;
    } catch {
      return null;
    }
  }
  if (/^[a-z0-9-]+$/i.test(t)) return `https://${t.toLowerCase()}.cloudflareaccess.com`;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(t)) return `https://${t.toLowerCase()}`;
  return null;
}

/** The certs URL Cloudflare publishes for an issuer. */
export function accessCertsUrl(issuer: string): string {
  return `${issuer}/cdn-cgi/access/certs`;
}

/** Whether the operator asked for the gate at all (either setting present). */
export function accessGateRequested(s: AccessGateSettings): boolean {
  return s.accessTeam.trim() !== "" || s.accessAud.some((a) => a.trim() !== "");
}

/**
 * Whether this request is outside the gate's reach.
 *
 * `/api/health` is the one route the bridge has always left ungated (the updater polls it before any
 * browser exists, and it discloses only the version, which every response carries anyway). The rest
 * is a local caller: a loopback Host and no Cloudflare edge header.
 */
export function accessExempt(req: Request, pathname: string): boolean {
  if (pathname === "/api/health") return true;
  const host = req.headers.get("host") ?? "";
  if (!LOOPBACK_HOST.test(host)) return false;
  return EDGE_HEADERS.every((h) => !req.headers.has(h));
}

function b64urlBytes(s: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function b64urlJson(s: string): JsonObject | null {
  const bytes = b64urlBytes(s);
  if (bytes === null) return null;
  try {
    // SAFETY: `JSON.parse` output IS a JsonValue by construction; the object check follows.
    const v = JSON.parse(new TextDecoder().decode(bytes)) as JsonValue;
    return v !== null && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** Why a token failed, for the log and the tests. Never sent to the client in detail. */
export type TokenVerdict =
  | { ok: true }
  | { ok: false; reason: "malformed" | "alg" | "unknown-kid" | "signature" | "iss" | "aud" | "exp" | "nbf" };

/**
 * Verify one token against a key set. Pure apart from WebCrypto; exported for the tests.
 *
 * Only RS256 is accepted, which is what Cloudflare signs with. The algorithm is never taken from the
 * token to choose a verifier: the header's `alg` must equal the one we verify with, so `none` and
 * HS256 key-confusion tokens fail before any key is looked at.
 */
export async function verifyAccessToken(
  token: string,
  keys: ReadonlyMap<string, CryptoKey>,
  expect: { issuer: string; aud: readonly string[]; nowS: number },
): Promise<TokenVerdict> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [h = "", p = "", s = ""] = parts;
  const header = b64urlJson(h);
  const payload = b64urlJson(p);
  const sig = b64urlBytes(s);
  if (header === null || payload === null || sig === null || sig.length === 0) {
    return { ok: false, reason: "malformed" };
  }
  if (header.alg !== "RS256") return { ok: false, reason: "alg" };
  const kid = header.kid;
  const key = typeof kid === "string" ? keys.get(kid) : undefined;
  if (key === undefined) return { ok: false, reason: "unknown-kid" };
  const signed = new TextEncoder().encode(`${h}.${p}`);
  const good = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, signed);
  if (!good) return { ok: false, reason: "signature" };

  if (payload.iss !== expect.issuer) return { ok: false, reason: "iss" };
  const aud = payload.aud;
  const auds = typeof aud === "string" ? [aud] : Array.isArray(aud) ? aud.filter((a) => typeof a === "string") : [];
  if (!auds.some((a) => expect.aud.includes(a))) return { ok: false, reason: "aud" };
  // `exp` is required: a token with no expiry is not one Cloudflare issues.
  if (typeof payload.exp !== "number" || payload.exp + SKEW_S <= expect.nowS) return { ok: false, reason: "exp" };
  if (payload.nbf !== undefined && (typeof payload.nbf !== "number" || payload.nbf - SKEW_S > expect.nowS)) {
    return { ok: false, reason: "nbf" };
  }
  return { ok: true };
}

/** Import every RS256-usable RSA key out of a JWKS body. Keys without a `kid` are skipped. */
export async function importAccessKeys(body: JsonValue): Promise<Map<string, CryptoKey>> {
  const out = new Map<string, CryptoKey>();
  if (body === null || typeof body !== "object" || Array.isArray(body)) return out;
  const list = body.keys;
  if (!Array.isArray(list)) return out;
  for (const k of list) {
    if (k === null || typeof k !== "object" || Array.isArray(k)) continue;
    const { kty, kid, alg, use, n, e } = k;
    if (kty !== "RSA" || typeof kid !== "string" || typeof n !== "string" || typeof e !== "string") continue;
    if (alg !== undefined && alg !== "RS256") continue;
    if (use !== undefined && use !== "sig") continue;
    try {
      const key = await crypto.subtle.importKey(
        "jwk",
        { kty: "RSA", n, e, alg: "RS256", ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      out.set(kid, key);
    } catch {
      // One bad key does not poison the set.
    }
  }
  return out;
}

export interface AccessGateDeps {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  nowMs?: () => number;
  log?: (line: string) => void;
  /** Schedule a retry or refresh. Tests pass a no-op and drive {@link AccessGate.refresh} by hand. */
  schedule?: (fn: () => void, ms: number) => void;
}

function refuse(status: 401 | 403 | 503, body: string): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * The gate itself. One per bridge process. Construct it with {@link createAccessGate}, which returns
 * null when the operator did not ask for it.
 */
export class AccessGate {
  private keys = new Map<string, CryptoKey>();
  private loadedOnce = false;
  private lastFetchMs = Number.NEGATIVE_INFINITY;
  private inflight: Promise<boolean> | null = null;
  private retryStep = 0;
  private readonly fetchFn: (url: string, init?: RequestInit) => Promise<Response>;
  private readonly nowMs: () => number;
  private readonly log: (line: string) => void;
  private readonly schedule: (fn: () => void, ms: number) => void;

  constructor(
    /** Null when the settings cannot name an issuer and audience: every gated request is refused. */
    readonly issuer: string | null,
    readonly aud: readonly string[],
    deps: AccessGateDeps = {},
  ) {
    this.fetchFn = deps.fetch ?? ((url, init) => fetch(url, init));
    this.nowMs = deps.nowMs ?? Date.now;
    this.log = deps.log ?? ((l) => console.warn(l));
    this.schedule =
      deps.schedule ??
      ((fn, ms) => {
        // Never hold the process open for a key refresh.
        setTimeout(fn, ms).unref();
      });
  }

  /** Whether the settings are whole. False means the gate refuses everything it guards. */
  get configured(): boolean {
    return this.issuer !== null && this.aud.length > 0;
  }

  /** Start the first key load and the refresh loop. Safe to call once. */
  start(): void {
    if (!this.configured) {
      this.log(
        "[bridge] ERROR: Cloudflare Access gate is half configured — set both COLLIE_ACCESS_TEAM and COLLIE_ACCESS_AUD. Every request through the tunnel is refused until then.",
      );
      return;
    }
    void this.cycle();
  }

  private async cycle(): Promise<void> {
    const ok = await this.refresh();
    if (ok) {
      this.retryStep = 0;
      this.schedule(() => void this.cycle(), REFRESH_MS);
      return;
    }
    // Before the first load, retry soon; after it, the cached keys carry on and the hourly
    // refresh is enough, but a failed refresh still retries on the short ladder.
    const ms = FIRST_LOAD_RETRY_MS[Math.min(this.retryStep, FIRST_LOAD_RETRY_MS.length - 1)]!;
    this.retryStep++;
    this.schedule(() => void this.cycle(), ms);
  }

  /** Fetch the team's keys. Keeps the old set on any failure. Concurrent calls share one fetch. */
  refresh(): Promise<boolean> {
    if (this.issuer === null) return Promise.resolve(false);
    if (this.inflight) return this.inflight;
    const url = accessCertsUrl(this.issuer);
    this.lastFetchMs = this.nowMs();
    this.inflight = (async () => {
      try {
        const res = await this.fetchFn(url, {
          headers: { accept: "application/json" },
          redirect: "error",
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // SAFETY: `Response.json()` output IS a JsonValue by construction; the importer checks it.
        const keys = await importAccessKeys((await res.json()) as JsonValue);
        if (keys.size === 0) throw new Error("no usable RS256 key in the response");
        this.keys = keys;
        if (!this.loadedOnce) this.log(`[bridge] Cloudflare Access gate armed: ${keys.size} key(s) from ${url}`);
        this.loadedOnce = true;
        return true;
      } catch (err) {
        const keep = this.loadedOnce ? "keeping the cached keys" : "refusing tunnel requests until it loads";
        this.log(`[bridge] WARNING: Cloudflare Access keys from ${url} failed (${String(err)}), ${keep}`);
        return false;
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  /** Admit or refuse one request. Null admits. */
  async admit(req: Request, pathname: string): Promise<AccessDecision> {
    if (accessExempt(req, pathname)) return null;
    if (!this.configured) return refuse(503, "access gate misconfigured");
    if (!this.loadedOnce) {
      // A request is also a nudge: the first load may have failed a moment ago.
      if (this.nowMs() - this.lastFetchMs >= UNKNOWN_KID_REFETCH_MS) await this.refresh();
      if (!this.loadedOnce) return refuse(503, "access keys not loaded");
    }
    const token = req.headers.get(ACCESS_JWT_HEADER);
    // 401, not 403: the phone's refusal banner offers a sign-in on 401/403 alike, and a top-level
    // reload is what sends the browser back through Access.
    if (!token) return refuse(401, "access token required");
    const expect = { issuer: this.issuer!, aud: this.aud, nowS: Math.floor(this.nowMs() / 1000) };
    let verdict = await verifyAccessToken(token, this.keys, expect);
    if (!verdict.ok && verdict.reason === "unknown-kid" && this.nowMs() - this.lastFetchMs >= UNKNOWN_KID_REFETCH_MS) {
      // Cloudflare rotated its key ahead of our hourly refresh.
      await this.refresh();
      verdict = await verifyAccessToken(token, this.keys, expect);
    }
    return verdict.ok ? null : refuse(401, "access token rejected");
  }
}

/** The gate for these settings, or null when the operator did not ask for one. */
export function createAccessGate(s: AccessGateSettings, deps: AccessGateDeps = {}): AccessGate | null {
  if (!accessGateRequested(s)) return null;
  const aud = s.accessAud.map((a) => a.trim()).filter((a) => a !== "");
  return new AccessGate(accessIssuer(s.accessTeam), aud, deps);
}
