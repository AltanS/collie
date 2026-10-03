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

/**
 * One signed-identity front door, in its own vocabulary. A table of these is the shape (ADR 0081):
 * the verification below is generic and a preset only says where the token is, which one algorithm
 * it pins, which headers prove the request crossed the vendor's edge, how a setting names the
 * issuer, and where that issuer publishes its keys.
 */
export interface DoorPreset {
  name: "cloudflare";
  /** The request header that carries the signed token. */
  header: string;
  /** The one algorithm this preset pins. A token that says anything else is refused. */
  alg: "RS256";
  /** Headers the vendor's edge stamps on every request it proxies. Their presence means "not local". */
  edgeHeaders: readonly string[];
  /** The issuer for the preset's team setting, or null when the value cannot name one. */
  issuer(setting: string): string | null;
  /** The URL the issuer publishes its JWKS at. */
  jwksUrl(issuer: string): string;
}

/** One DNS label: letters, digits and inner hyphens, 1 to 63 characters. */
const DNS_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
/** The three spellings of a team, anchored whole: no userinfo, port, path, query or other domain. */
const TEAM_FORMS = [
  new RegExp(`^(${DNS_LABEL})$`, "i"),
  new RegExp(`^(${DNS_LABEL})\\.cloudflareaccess\\.com$`, "i"),
  new RegExp(`^https://(${DNS_LABEL})\\.cloudflareaccess\\.com/?$`, "i"),
] as const;

/**
 * Cloudflare Access. `myteam`, `myteam.cloudflareaccess.com` and `https://myteam.cloudflareaccess.com`
 * all mean `https://myteam.cloudflareaccess.com`, and nothing else is accepted. The issuer is also
 * where the keys come from, so the host is always exactly `<label>.cloudflareaccess.com` over https:
 * a value that could steer the fetch elsewhere (`evil.com/x?`, `a.cloudflareaccess.com.evil.com`,
 * userinfo, a port, a path, plain http) names no issuer, and the gate then refuses everything.
 *
 * The edge stamps `cf-*` on every request it proxies and `cloudflared` forwards them, so a request
 * that came through Cloudflare cannot look local, even through a tunnel set to
 * `httpHostHeader: localhost`.
 */
const CLOUDFLARE: DoorPreset = {
  name: "cloudflare",
  header: "cf-access-jwt-assertion",
  alg: "RS256",
  edgeHeaders: ["cf-ray", "cf-connecting-ip", "cf-visitor"],
  issuer(team) {
    const t = team.trim();
    for (const form of TEAM_FORMS) {
      const label = form.exec(t)?.[1];
      if (label !== undefined) return `https://${label.toLowerCase()}.cloudflareaccess.com`;
    }
    return null;
  },
  jwksUrl: (issuer) => `${issuer}/cdn-cgi/access/certs`,
};

/** The presets Collie knows. Which one applies is implied by which settings are set. */
export const DOOR_PRESETS = { cloudflare: CLOUDFLARE } as const;

/** The header Cloudflare Access adds to every request it lets through. */
export const ACCESS_JWT_HEADER = CLOUDFLARE.header;

/**
 * Headers every other proxy adds (`tailscale serve`, Caddy, Traefik) to say a request did not start
 * on this machine. A request carrying none of them, nor a preset's edge headers or token, addressed
 * to a loopback Host, is a local process (`collie doctor`, `curl`): it can already reach the
 * loopback port directly, so the gate has nothing to protect there, and pairing still guards it.
 */
const FORWARDING_HEADERS = ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "forwarded", "x-real-ip"] as const;

const LOOPBACK_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/i;

/** Seconds of clock skew tolerated on `exp` and `nbf`. */
const SKEW_S = 60;
/** How often the keys are refreshed while all is well. */
const REFRESH_MS = 60 * 60 * 1000;
/** The fastest an unknown `kid` may trigger a refetch. Guards Cloudflare against a token spray. */
const UNKNOWN_KID_REFETCH_MS = 30 * 1000;
/** A certs fetch that has not answered by then has failed; a request may be waiting on it. */
const FETCH_TIMEOUT_MS = 5_000;
/** The largest certs body read. Cloudflare's is about 4 KiB; anything far past it is not a key set. */
const MAX_CERTS_BYTES = 64 * 1024;
/**
 * Retry ladder after a failed fetch. Before the first load, a request may also nudge a fetch, but
 * no faster than the first rung: the 30 s unknown-kid window is for a gate that has keys.
 */
const FIRST_LOAD_RETRY_MS = [2_000, 5_000, 15_000, 30_000, 60_000] as const;

/** The issuer for a configured team, or null when the value cannot name one. */
export function accessIssuer(team: string): string | null {
  return CLOUDFLARE.issuer(team);
}

/** Whether the operator asked for the gate at all (either setting present). */
export function accessGateRequested(s: AccessGateSettings): boolean {
  return s.accessTeam.trim() !== "" || s.accessAud.some((a) => a.trim() !== "");
}

/**
 * What is wrong with half a configuration, as one operator-facing sentence, or null when whole.
 * Names the missing setting; never prints the audience tag.
 */
export function accessConfigProblem(s: AccessGateSettings): string | null {
  const hasAud = s.accessAud.some((a) => a.trim() !== "");
  if (s.accessTeam.trim() === "") return "COLLIE_ACCESS_AUD is set but COLLIE_ACCESS_TEAM is not";
  if (!hasAud) return "COLLIE_ACCESS_TEAM is set but COLLIE_ACCESS_AUD is not";
  if (accessIssuer(s.accessTeam) === null) {
    return "COLLIE_ACCESS_TEAM is not a Cloudflare Access team (use myteam, myteam.cloudflareaccess.com or https://myteam.cloudflareaccess.com)";
  }
  return null;
}

/**
 * Whether this request is outside the gate's reach.
 *
 * `/api/health` is the one route the bridge has always left ungated (the updater polls it before any
 * browser exists, and it discloses only the version, which every response carries anyway). The rest
 * is a local caller: a loopback Host and none of the forwarding, edge and token headers. Spoofing that takes a
 * process that already reaches the loopback port with a crafted request, which is a local caller.
 * The exemption reaches past this gate only; pairing still decides what the caller may do.
 */
export function accessExempt(req: Request, pathname: string, preset: DoorPreset = CLOUDFLARE): boolean {
  if (pathname === "/api/health") return true;
  const host = req.headers.get("host") ?? "";
  if (!LOOPBACK_HOST.test(host)) return false;
  const notLocal = [...FORWARDING_HEADERS, ...preset.edgeHeaders, preset.header];
  return notLocal.every((h) => !req.headers.has(h));
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

/** Read at most `max` bytes of a body as text, or throw. A lying Content-Length changes nothing. */
async function boundedText(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > max) throw new Error(`response larger than ${max} bytes`);
  if (res.body === null) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new Error(`response larger than ${max} bytes`);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/**
 * Verify one token against a key set. Pure apart from WebCrypto; exported for the tests.
 *
 * Only the preset's one algorithm is accepted. The algorithm is never taken from the
 * token to choose a verifier: the header's `alg` must equal the one we verify with, so `none` and
 * HS256 key-confusion tokens fail before any key is looked at.
 */
export async function verifyAccessToken(
  token: string,
  keys: ReadonlyMap<string, CryptoKey>,
  expect: { issuer: string; aud: readonly string[]; nowS: number },
  preset: DoorPreset = CLOUDFLARE,
): Promise<TokenVerdict> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [h = "", p = "", s = ""] = parts;
  const header = b64urlJson(h);
  if (header === null) return { ok: false, reason: "malformed" };
  // The algorithm first, before the payload, the signature bytes or any key: `none` (with or
  // without a signature), HS256 key confusion, RS512 and a missing `alg` all stop here.
  if (header.alg !== preset.alg) return { ok: false, reason: "alg" };
  const payload = b64urlJson(p);
  const sig = b64urlBytes(s);
  if (payload === null || sig === null || sig.length === 0) return { ok: false, reason: "malformed" };
  // The key is the one the `kid` names, exactly. No kid, or one the team does not publish, is
  // refused; there is no fallback to the first or the only key.
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
  // `nbf` is optional; when present it is honoured with the same skew as `exp`.
  if (payload.nbf !== undefined && (typeof payload.nbf !== "number" || payload.nbf - SKEW_S > expect.nowS)) {
    return { ok: false, reason: "nbf" };
  }
  return { ok: true };
}

/**
 * Import every RS256-usable RSA key out of a JWKS body. Keys without a `kid` are skipped. Only
 * `keys` is read: the `public_cert` and `public_certs` fields Cloudflare also publishes are ignored.
 */
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
  /** True while fetches keep failing, so a failure streak logs one line, not one per retry. */
  private failing = false;
  private readonly fetchFn: (url: string, init?: RequestInit) => Promise<Response>;
  private readonly nowMs: () => number;
  private readonly log: (line: string) => void;
  private readonly schedule: (fn: () => void, ms: number) => void;

  constructor(
    /** Null when the settings cannot name an issuer and audience: every gated request is refused. */
    readonly issuer: string | null,
    readonly aud: readonly string[],
    deps: AccessGateDeps = {},
    /** The operator-facing sentence for half a configuration; logged once at start. */
    private readonly problem: string | null = null,
    private readonly preset: DoorPreset = CLOUDFLARE,
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
      const why = this.problem ?? "set both COLLIE_ACCESS_TEAM and COLLIE_ACCESS_AUD";
      this.log(
        `[bridge] ERROR: Cloudflare Access gate is half configured: ${why}. Every request that is not a local caller is refused (503) until both are set.`,
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
    const url = this.preset.jwksUrl(this.issuer);
    this.lastFetchMs = this.nowMs();
    this.inflight = (async () => {
      try {
        const res = await this.fetchFn(url, {
          headers: { accept: "application/json" },
          // A redirect is a failure, never followed: the keys come from the team's host or nowhere.
          redirect: "error",
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (res.redirected || !res.ok) throw new Error(`HTTP ${res.status}${res.redirected ? " after a redirect" : ""}`);
        const text = await boundedText(res, MAX_CERTS_BYTES);
        // SAFETY: `JSON.parse` output IS a JsonValue by construction; the importer checks it.
        const keys = await importAccessKeys(JSON.parse(text) as JsonValue);
        if (keys.size === 0) throw new Error("no usable RS256 key in the response");
        this.keys = keys;
        if (!this.loadedOnce || this.failing) {
          this.log(`[bridge] Cloudflare Access gate armed: ${keys.size} key(s) from ${url}`);
        }
        this.loadedOnce = true;
        this.failing = false;
        return true;
      } catch (err) {
        // One line per failure streak: the first failure names the cause, the retries stay quiet.
        if (!this.failing) {
          const msg = this.loadedOnce
            ? `[bridge] WARNING: Cloudflare Access keys from ${url} failed (${String(err)}), keeping the cached keys`
            : `[bridge] ERROR: Cloudflare Access keys from ${url} failed (${String(err)}). Every request that is not a local caller is refused (503) until they load; retrying.`;
          this.log(msg);
        }
        this.failing = true;
        return false;
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  /** Admit or refuse one request. Null admits. */
  async admit(req: Request, pathname: string): Promise<AccessDecision> {
    if (accessExempt(req, pathname, this.preset)) return null;
    if (!this.configured) return refuse(503, "access gate misconfigured");
    if (!this.loadedOnce) {
      // A request is also a nudge: the first load may have failed a moment ago.
      if (this.nowMs() - this.lastFetchMs >= FIRST_LOAD_RETRY_MS[0]) await this.refresh();
      if (!this.loadedOnce) return refuse(503, "access keys not loaded");
    }
    const token = req.headers.get(this.preset.header);
    // 401, not 403: the phone's refusal banner offers a sign-in on 401/403 alike, and a top-level
    // reload is what sends the browser back through Access.
    if (!token) return refuse(401, "access token required");
    const expect = { issuer: this.issuer!, aud: this.aud, nowS: Math.floor(this.nowMs() / 1000) };
    let verdict = await verifyAccessToken(token, this.keys, expect, this.preset);
    if (!verdict.ok && verdict.reason === "unknown-kid" && this.nowMs() - this.lastFetchMs >= UNKNOWN_KID_REFETCH_MS) {
      // Cloudflare rotated its key ahead of our hourly refresh. The window is global: it reads the
      // time of the last fetch of any kind, and concurrent callers share the one in flight, so a
      // spray of made-up kids costs Cloudflare one fetch per 30 seconds at most.
      await this.refresh();
      verdict = await verifyAccessToken(token, this.keys, expect, this.preset);
    }
    return verdict.ok ? null : refuse(401, "access token rejected");
  }
}

/** The gate for these settings, or null when the operator did not ask for one. */
export function createAccessGate(s: AccessGateSettings, deps: AccessGateDeps = {}): AccessGate | null {
  if (!accessGateRequested(s)) return null;
  const aud = s.accessAud.map((a) => a.trim()).filter((a) => a !== "");
  return new AccessGate(CLOUDFLARE.issuer(s.accessTeam), aud, deps, accessConfigProblem(s), CLOUDFLARE);
}
