// THE SECOND TRANSPORT: the same wire over HTTPS, with a bearer token (WIRE.md section 1B, ADR 0103).
//
// A durable program the person deployed behind TLS (a Cloudflare Worker with a Durable Object, or
// any host with a certificate) has a public URL. The peer dials it with fetch and sends
// `Authorization: Bearer <token>` on every request. The routes, the bodies, the version header and
// the ETag are the bytes of the socket wire, so the adapter above does not know which transport it
// has, past the budgets it reads from `kind`.
//
// Three rules live here:
//
//  • THE TOKEN NEVER LEAVES THIS CLASS AS TEXT. It sits in an ES private field, so neither a log
//    line, `Bun.inspect`, nor `JSON.stringify` of the client can print it. No detail, refusal or
//    error this file throws names it. A reply body is never echoed, because a broken program could
//    echo the header back.
//  • A REFUSED TOKEN IS AN ANSWER THAT SAYS STOP. A 401 or a 403 is `DurableUnreachable` with the
//    detail `token-refused: ...`, read or write. Nothing ran. The adapter's hysteresis and its
//    down-gap (adapter.ts) then govern how soon it asks again, so a wrong token is never a storm.
//  • A WEAKENED ETAG IS THE SAME ETAG. A proxy that compresses a reply may turn `"e-12"` into
//    `W/"e-12"`. The reply hands the adapter the strong form, so the next `If-None-Match` is the
//    program's own value, and a program that strips `W/` itself compares equal either way.
//
// What it does not do: no path walk and no 103-byte cap (there is no file), no redirect follow (a
// 3xx is passed up as a status, so the token never reaches another host), no retry of a POST.

import { byteLength } from "./clean.ts";
import {
  describeFailure,
  DurableOutcomeUnknown,
  DurableUnreachable,
  readCapped,
  ROUTE_PREFIX,
  type DurableGet,
  type DurablePost,
  type DurableReply,
  type DurableTransport,
} from "./client.ts";

/** The variable that names the program's base URL. */
export const DURABLE_URL_ENV = "COLLIE_DURABLE_URL";

/** The variable that holds the bearer token. Its value is never printed anywhere. */
export const DURABLE_TOKEN_ENV = "COLLIE_DURABLE_TOKEN";

/** The longest URL, in bytes. */
export const URL_MAX_BYTES = 2048;

/** The shortest token, in bytes after trimming: 32 random bytes is the floor the docs ask for. */
export const TOKEN_MIN_BYTES = 32;

/** The token rule, as the config error and the docs state it (M50 spec 14). */
export const TOKEN_RULE = `it must be at least ${String(TOKEN_MIN_BYTES)} bytes, for example 64 hex characters from \`openssl rand -hex 32\``;

/** The longest token, in bytes. A header past this is a mistake, not a token. */
export const TOKEN_MAX_BYTES = 4096;

/** The start of the detail for a 401 or 403. The status follows it. */
export const TOKEN_REFUSED = "token-refused";

/** The two hosts a plain `http://` URL may name, for `wrangler dev` on this machine. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost"]);

// ── The URL rule ──────────────────────────────────────────────────────────────

/** A usable URL, or the reason it is not. The reason names the variable and never echoes the value. */
export type DurableUrl =
  | {
      readonly ok: true;
      /** The origin and the optional prefix, with no trailing slash. The client appends `/session/v1/...`. */
      readonly base: string;
      /** True for the `http://127.0.0.1:<port>` or `http://localhost:<port>` of `wrangler dev`. */
      readonly loopback: boolean;
      readonly bytes: number;
    }
  | { readonly ok: false; readonly detail: string };

/**
 * Check the configured URL (ADR 0103 point 2). `https://` only, with one exception: `http://` to
 * 127.0.0.1 or localhost with an explicit port. No user name or password, no query, no fragment, no
 * `/session/v1` of its own; an optional path prefix is kept. At most {@link URL_MAX_BYTES} bytes.
 */
export function resolveDurableUrl(configured: string | undefined): DurableUrl {
  const raw = (configured ?? "").trim();
  if (raw === "") return { ok: false, detail: `${DURABLE_URL_ENV} is not set` };
  const bytes = byteLength(raw);
  if (bytes > URL_MAX_BYTES) return { ok: false, detail: `${DURABLE_URL_ENV} is longer than ${String(URL_MAX_BYTES)} bytes` };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, detail: `${DURABLE_URL_ENV} is not a URL` };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, detail: `${DURABLE_URL_ENV} must not carry a user name or password; the token goes in ${DURABLE_TOKEN_ENV}` };
  }
  if (url.search !== "" || url.hash !== "") return { ok: false, detail: `${DURABLE_URL_ENV} must not carry a query or a fragment` };
  let loopback = false;
  if (url.protocol === "http:") {
    if (!LOOPBACK_HOSTS.has(url.hostname)) {
      return {
        ok: false,
        detail: `${DURABLE_URL_ENV} uses plain http to ${url.hostname}, so the token would cross the network unencrypted; use https://, or http://127.0.0.1:<port> for wrangler dev`,
      };
    }
    if (url.port === "") {
      return { ok: false, detail: `${DURABLE_URL_ENV} uses plain http on loopback without a port; name the port, for example http://127.0.0.1:8801` };
    }
    loopback = true;
  } else if (url.protocol !== "https:") {
    return { ok: false, detail: `${DURABLE_URL_ENV} must start with https://` };
  }
  const prefix = url.pathname.replace(/\/+$/u, "");
  // A URL path, not a file path: a `session` segment anywhere would double the route prefix.
  if (/(?:^|\/)session(?:\/|$)/u.test(prefix)) {
    return { ok: false, detail: `${DURABLE_URL_ENV} names the durable agent's base only; leave out /session/v1, the adapter adds it` };
  }
  return { ok: true, base: `${url.origin}${prefix}`, loopback, bytes };
}

// ── The token rule ────────────────────────────────────────────────────────────

/** A usable token, or the reason it is not. Neither branch carries the value in a printable field. */
export type DurableToken =
  | { readonly ok: true; readonly bytes: number; reveal(): string }
  | { readonly ok: false; readonly detail: string };

/** Printable ASCII with no space: what an `Authorization` header can carry unchanged. */
const TOKEN_CHARS = /^[\x21-\x7e]+$/u;

/**
 * Check the configured token (ADR 0103 point 3): at least {@link TOKEN_MIN_BYTES} bytes after a
 * trim, printable ASCII with no space. The value is reached only through `reveal()`, so a test that
 * prints the result, or a log line that spreads it, shows the byte count and nothing else.
 */
export function resolveDurableToken(configured: string | undefined): DurableToken {
  const token = (configured ?? "").trim();
  if (token === "") return { ok: false, detail: `${DURABLE_TOKEN_ENV} is not set` };
  if (!TOKEN_CHARS.test(token)) return { ok: false, detail: `${DURABLE_TOKEN_ENV} must be printable ASCII with no spaces` };
  const bytes = byteLength(token);
  if (bytes < TOKEN_MIN_BYTES) {
    return { ok: false, detail: `${DURABLE_TOKEN_ENV} is ${String(bytes)} bytes; ${TOKEN_RULE}` };
  }
  if (bytes > TOKEN_MAX_BYTES) return { ok: false, detail: `${DURABLE_TOKEN_ENV} is longer than ${String(TOKEN_MAX_BYTES)} bytes` };
  return { ok: true, bytes, reveal: () => token };
}

// ── The ETag ──────────────────────────────────────────────────────────────────

/** An ETag with any weak prefix (`W/`) taken off, or null for none (ADR 0103 point 6). */
export function strongEtag(etag: string | null): string | null {
  if (etag === null) return null;
  return etag.startsWith("W/") ? etag.slice(2) : etag;
}

// ── The failures ──────────────────────────────────────────────────────────────

/** Whether a failed fetch never reached the program: no address, no connect, no TLS. */
function neverReached(err: Error, timedOut: boolean): boolean {
  if (timedOut) return false;
  const code = "code" in err ? String(err.code) : "";
  if (["ConnectionRefused", "ECONNREFUSED", "FailedToOpenSocket", "ENOTFOUND", "EAI_AGAIN"].includes(code)) return true;
  // A certificate Bun refuses fails the handshake, before a byte of the request is sent.
  return /CERT|SSL|TLS|SELF_SIGNED/u.test(code);
}

/** One line for a failed fetch. A refused certificate is named as such. */
function describeHttpFailure(err: Error, timeoutMs: number, timedOut: boolean): string {
  const code = "code" in err ? String(err.code) : "";
  if (!timedOut && /CERT|SSL|TLS|SELF_SIGNED/u.test(code)) return `tls refused: ${err.message === "" ? code : err.message}`;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "the host name does not resolve";
  return describeFailure(err, timeoutMs, timedOut);
}

/** The refusal for a 401 or a 403, or null for any other status. The body is dropped unread. */
function tokenRefusal(response: Response): DurableUnreachable | null {
  if (response.status !== 401 && response.status !== 403) return null;
  void response.body?.cancel();
  return new DurableUnreachable(`${TOKEN_REFUSED}: the durable agent answered ${String(response.status)}`);
}

// ── The client ────────────────────────────────────────────────────────────────

/** The HTTPS transport. Built only from a URL and a token that passed their rules (transport.ts). */
export class DurableHttpClient implements DurableTransport {
  readonly kind = "https";
  readonly #base: string;
  readonly #authorization: string;

  /** `base` is {@link DurableUrl.base}; `token` is the revealed value of a {@link DurableToken}. */
  constructor(base: string, token: string) {
    this.#base = base;
    this.#authorization = `Bearer ${token}`;
  }

  /** The URL this client dials, without the token: safe for a log line or a doctor row. */
  get base(): string {
    return this.#base;
  }

  async get(request: DurableGet): Promise<DurableReply> {
    const headers = new Headers({ accept: "application/json", authorization: this.#authorization });
    if (request.version !== null) headers.set("x-collie-session", String(request.version));
    if (request.ifNoneMatch !== null) headers.set("if-none-match", request.ifNoneMatch);

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, request.timeoutMs);
    try {
      const response = await fetch(`${this.#base}${ROUTE_PREFIX}${request.path}`, {
        headers,
        signal: controller.signal,
        redirect: "manual",
      });
      const refused = tokenRefusal(response);
      if (refused !== null) throw refused;
      const text = await readCapped(response, request.maxBytes);
      return { status: response.status, etag: strongEtag(response.headers.get("etag")), text };
    } catch (err) {
      if (err instanceof DurableUnreachable) throw err;
      const failure = err instanceof Error ? err : new Error(String(err));
      throw new DurableUnreachable(describeHttpFailure(failure, request.timeoutMs, timedOut));
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * One POST, never retried. A refused token is `DurableUnreachable`: the program refuses before it
   * acts (WIRE.md section 1B), so nothing ran. A request that may have left is `DurableOutcomeUnknown`.
   */
  async post(request: DurablePost): Promise<DurableReply> {
    const headers = new Headers({
      accept: "application/json",
      authorization: this.#authorization,
      "content-type": "application/json",
      "x-collie-session": String(request.version),
    });
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, request.timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.#base}${ROUTE_PREFIX}${request.path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(request.body),
        signal: controller.signal,
        redirect: "manual",
      });
    } catch (err) {
      clearTimeout(timer);
      const failure = err instanceof Error ? err : new Error(String(err));
      const detail = describeHttpFailure(failure, request.timeoutMs, timedOut);
      if (neverReached(failure, timedOut)) throw new DurableUnreachable(detail);
      throw new DurableOutcomeUnknown(detail);
    }
    const refused = tokenRefusal(response);
    if (refused !== null) {
      clearTimeout(timer);
      throw refused;
    }
    try {
      const text = await readCapped(response, request.maxBytes);
      return { status: response.status, etag: strongEtag(response.headers.get("etag")), text };
    } catch (err) {
      // The program answered, and the answer could not be read whole: the outcome is unknown.
      const detail = err instanceof DurableUnreachable ? err.detail : describeHttpFailure(err instanceof Error ? err : new Error(String(err)), request.timeoutMs, timedOut);
      throw new DurableOutcomeUnknown(detail);
    } finally {
      clearTimeout(timer);
    }
  }
}
