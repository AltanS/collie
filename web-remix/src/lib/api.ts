// The read half of the bridge API that this shell needs: snapshot and config (the pane mirror reads through web's `fetchPane`, see routes/pane/data.ts).
//
// WHY NOT web/src/lib/api.ts. That module imports busy.ts, connection-health.ts, pairing.ts,
// poll-intent.ts and server-build.ts, and each of those imports React for its hook. Reusing it would
// pull React into this bundle, so this is the smallest replacement: the same wire contract (the XHR
// header, `redirect: "manual"` with a redirect read as 401, the bearer token, the scope query, the
// GET deadline, the pane ETag cache), and nothing the shell does not call yet. Mutations come later.
import { mounted } from "@web/lib/base-path";
import { normalizeScope, type Scope } from "@web/lib/scope";
import type { BridgeConfig, SnapshotResponse } from "@web/lib/types";

import { createStore } from "./store";

/** Same header and value as web/src/lib/api.ts: a fronting proxy answers 401 instead of a redirect. */
const XHR_HEADER = "x-requested-with";
const XHR_HEADER_VALUE = "XMLHttpRequest";
/** The device credential's storage key (web/src/lib/pairing.ts, TOKEN_STORAGE_KEY). */
const TOKEN_STORAGE_KEY = "collie:device-token";
/** The bridge's build header (web/src/lib/server-build.ts). */
const SERVER_BUILD_HEADER = "x-collie-build";
/** GET deadline: a black-holed link must not leave a poll pending forever. */
const GET_TIMEOUT_MS = 10_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const PANE_CACHE_MAX = 20;

/** A non-2xx answer, thrown. `status` is what callers branch on. */
export class ApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(path: string, status: number, body: string) {
    super(`${path} → ${String(status)} ${body}`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/** The bridge build id off the last response that carried one. */
export const serverBuild = createStore<string | undefined>(undefined);
/** Wall-clock time of the last answer that proves the bridge is live. */
export const lastLiveAt = createStore<number>(0);

function authHeader(): Record<string, string> {
  let token: string | null = null;
  try {
    token = localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    token = null;
  }
  return token ? { authorization: `Bearer ${token}` } : {};
}

function withScope(path: string, scope?: Scope): string {
  const { host, session } = normalizeScope(scope);
  let out = path;
  if (host) out += `${out.includes("?") ? "&" : "?"}host=${encodeURIComponent(host)}`;
  if (session) out += `${out.includes("?") ? "&" : "?"}session=${encodeURIComponent(session)}`;
  return out;
}

function deadline(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(GET_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function get(path: string, headers: Headers, signal: AbortSignal | undefined): Promise<Response> {
  headers.set(XHR_HEADER, XHR_HEADER_VALUE);
  for (const [name, value] of Object.entries(authHeader())) headers.set(name, value);
  const res = await fetch(mounted(path), { headers, signal: deadline(signal), redirect: "manual" });
  const build = res.headers.get(SERVER_BUILD_HEADER);
  if (build) serverBuild.set(build);
  if (res.type === "opaqueredirect" || REDIRECT_STATUSES.has(res.status)) {
    throw new ApiError(path, 401, "fronting identity proxy requires sign-in");
  }
  return res;
}

async function failure(path: string, res: Response): Promise<ApiError> {
  let body = res.statusText;
  try {
    body = (await res.text()) || res.statusText;
  } catch {
    // keep the status text
  }
  return new ApiError(path, res.status, body);
}

// ── Conditional reads: an ETag kept together with the body it belongs to ────────────────────────
// The pane cache mirrors web/src/lib/api.ts: the ETag is recorded only with its parsed body, so a
// 304 can never hand back an empty mirror. The snapshot uses the same cache when the bridge sends
// an ETag for it, and sends no If-None-Match when it does not, so either bridge works.

interface Cached<T> {
  etag: string;
  body: T;
}

function remember<T>(cache: Map<string, Cached<T>>, key: string, entry: Cached<T>): void {
  cache.delete(key);
  cache.set(key, entry);
  if (cache.size > PANE_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

async function conditional<T>(
  path: string,
  cache: Map<string, Cached<T>>,
  key: string,
  extra: Headers,
  signal: AbortSignal | undefined,
): Promise<{ body: T; notModified: boolean }> {
  const cached = cache.get(key);
  if (cached) extra.set("if-none-match", cached.etag);
  const res = await get(path, extra, signal);
  if (res.status === 304 && cached) return { body: cached.body, notModified: true };
  if (!res.ok) throw await failure(path, res);
  // SAFETY: a 200 on these endpoints is the bridge's own response type by contract (the same
  // contract web/src/lib/api.ts rests on); every non-ok answer threw above.
  const body = (await res.json()) as T;
  const etag = res.headers.get("etag");
  if (etag) remember(cache, key, { etag, body });
  return { body, notModified: false };
}

const snapshotCache = new Map<string, Cached<SnapshotResponse>>();

export interface Fetched<T> {
  body: T;
  /** The bridge answered 304: the body is the one already on screen. */
  notModified: boolean;
}

/** The herd snapshot. `all` widens it to every session on the addressed machine. */
export async function fetchSnapshot(scope?: Scope, signal?: AbortSignal, all = false): Promise<Fetched<SnapshotResponse>> {
  const scoped = withScope("/api/snapshot", scope);
  const path = all ? `${scoped}${scoped.includes("?") ? "&" : "?"}sessions=all` : scoped;
  const got = await conditional(path, snapshotCache, path, new Headers(), signal);
  if (got.body.bridge !== "disconnected") lastLiveAt.set(Date.now());
  return got;
}

/** The bridge's capability and settings payload. */
export async function fetchConfig(scope?: Scope, signal?: AbortSignal): Promise<BridgeConfig> {
  const path = withScope("/api/config", scope);
  const res = await get(path, new Headers({ "content-type": "application/json" }), signal);
  if (!res.ok) throw await failure(path, res);
  // SAFETY: a 200 on /api/config is the bridge's BridgeConfig by contract; non-ok threw above.
  return (await res.json()) as BridgeConfig;
}

/** True when `error` is an aborted fetch (a superseded poll), not a failure to show. */
export function isAbort(error: Error): boolean {
  return error.name === "AbortError";
}

// ── Generic reads and writes for the routes beyond the dashboard and the pane ────────────────────
// One door for Crew, Machines, History, Changes, Files and the Settings sections: the same wire
// contract as `get` above (XHR header, bearer token, `redirect: "manual"` read as 401, the build
// header), plus the write half web/'s `req` has: JSON content type, a longer deadline and every
// answer through `notePairing`, so a refused write raises the read-only latch (lib/pairing.ts).
import type { JsonValue } from "@web/lib/json";

import { notePairing } from "./pairing";

const WRITE_TIMEOUT_MS = 20_000;

/** The body of a 2xx answer. An empty body (a 204, or `Content-Length: 0`) reads as `undefined`. */
async function bodyOf<T>(res: Response): Promise<T> {
  const text = await res.text();
  // SAFETY: a 2xx on these endpoints is the bridge's own response type by contract (the contract
  // web/src/lib/api.ts rests on); the caller names it. An empty body is `void`.
  return (text === "" ? undefined : JSON.parse(text)) as T;
}

/** GET `path` (scope query added when given). Throws `ApiError` on a non-2xx answer. */
export async function bridgeGet<T>(path: string, scope?: Scope, signal?: AbortSignal, headers?: Record<string, string>): Promise<T> {
  const scoped = withScope(path, scope);
  const res = await get(scoped, new Headers({ "content-type": "application/json", ...headers }), signal);
  if (!res.ok) throw await failure(scoped, res);
  return bodyOf<T>(res);
}

/**
 * Send a JSON write. A refused answer goes through `notePairing` first, so "device not paired"
 * raises the latch, and a success clears it (REMIX3.md: "writes call `notePairing`").
 */
export async function bridgeSend<T>(
  method: "POST" | "PUT" | "DELETE",
  path: string,
  body?: JsonValue,
  scope?: Scope,
  signal?: AbortSignal,
): Promise<T> {
  const scoped = withScope(path, scope);
  const timeout = AbortSignal.timeout(WRITE_TIMEOUT_MS);
  const init: RequestInit = {
    method,
    headers: { "content-type": "application/json", [XHR_HEADER]: XHR_HEADER_VALUE, ...authHeader() },
    redirect: "manual",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(mounted(scoped), init);
  const build = res.headers.get(SERVER_BUILD_HEADER);
  if (build) serverBuild.set(build);
  if (res.type === "opaqueredirect" || REDIRECT_STATUSES.has(res.status)) {
    throw new ApiError(scoped, 401, "fronting identity proxy requires sign-in");
  }
  if (!res.ok) {
    const error = await failure(scoped, res);
    notePairing(method, res.status, error.body);
    throw error;
  }
  notePairing(method, res.status);
  return bodyOf<T>(res);
}
