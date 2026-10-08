// Thin REST client for the bridge. Everything is same-origin, so credentials/headers are
// minimal. Each call throws on a non-2xx so callers (route loaders / action handlers) surface errors.

import { parseApiErrorFields, type ApiErrorDetail, type ApiErrorFields } from "./api-error-codes";
import { trackBusy } from "./busy";
import {
  beginLongUpload,
  endLongUpload,
  markLive,
  noteNetworkFailure,
  noteReadStart,
  noteServerFailure,
  type ReadFailureKind,
} from "./connection-health";
import { markDead as markPaneDead, markLive as markPaneLive } from "./liveness";
import { abortSignalAfter, abortSignalAny } from "./env";
import { asJsonString, parseJsonObject, type JsonObject } from "./json";
import { authHeader, clearNotPaired, EXPIRED_BODY, markExpired, markNotPaired, NOT_PAIRED_BODY } from "./pairing";
import { pairingRefused } from "./wipe";
import { fileVersionOf } from "./file-image-cache";
import { isLead, normalizeScope, paneScopeKey, type Scope } from "./scope";
import { stampSend } from "./poll-intent";
import { observeServerBuild, SERVER_BUILD_HEADER } from "./server-build";
import { mounted } from "./base-path";
import { CHAT_UNCHANGED, type ChatAnswer } from "./chat-window";
import type {
  ActionResponse,
  BridgeConfig,
  ChatAfter,
  ChatBefore,
  PaneChatResponse,
  CreateResponse,
  DismissScope,
  DevicesResponse,
  CacheRulesResponse,
  CacheWatchListResponse,
  CacheWatchState,
  FoldersResponse,
  LaunchersResponse,
  GithubWorkResponse,
  NotifyPrefs,
  ChangeCommitDiffResponse,
  ChangeCommitResponse,
  ChangeDiffResponse,
  ChangesResponse,
  FileReadResponse,
  FilesListResponse,
  PaneHistoryResponse,
  CrewStatusResponse,
  MachineAlerts,
  MachineHistoryResponse,
  MachinesResponse,
  PaneReadResponse,
  PairFailure,
  SnapshotResponse,
  UpdateCheckResponse,
  UpdateInfo,
  UpdateRun,
  UpdateStartResponse,
  UploadResponse,
  WorktreeListResponse,
  WorktreeCreateResponse,
  WorktreeOpenResponse,
} from "./types";
import type { SubscribeBody } from "./push";

export type { NotifyPrefs, UpdateInfo };

/**
 * Marks every API request as XHR so a fronting identity proxy answers it with a status we can read.
 *
 * The refusal banner (components/connection-banner.tsx) is reached only through `isAuthError`
 * (lib/loaders.ts), which matches 401/403 on an {@link ApiError}. A proxy that answers an
 * unauthenticated request with a REDIRECT never produces one: `fetch` follows the 302 to the
 * identity provider's origin, that response carries no CORS headers, and the call rejects as a
 * `TypeError` — a transport failure with no status. The user then gets the connection banner
 * ("can't reach Collie") and, worse, loses the Sign-in link that would have fixed it, since a
 * missing session is precisely the thing it recovers from.
 *
 * Measured against Cloudflare Access with no session: a plain request, `Accept: application/json`
 * and `Sec-Fetch-Mode: cors` all still redirect; only this header flips the answer to a same-origin
 * 401. `X-Requested-With: XMLHttpRequest` is the conventional "this is XHR, don't redirect me"
 * signal rather than one vendor's feature — oauth2-proxy and Authelia read it too — so it stays a
 * single unconditional header with no proxy-specific branching, in keeping with a bridge that gates
 * on vendor-neutral headers and manages nobody else's front door (ADR 0001).
 *
 * Some forward-auth deployments still turn that 401 back into a 3xx at the reverse-proxy layer.
 * Every API fetch therefore uses `redirect: "manual"`; a returned redirect is normalised to a local
 * 401 below so the same refusal banner appears instead of a CORS/transport failure. Collie never
 * follows or discovers the proxy's login flow itself — the banner's ordinary `/auth/` link remains
 * the operator-owned recovery path.
 *
 * Costs nothing against the bridge itself: it is same-origin by design, so no preflight in practice,
 * and the bridge ignores headers it does not read.
 */
export const XHR_HEADER = "x-requested-with";
export const XHR_HEADER_VALUE = "XMLHttpRequest";

/**
 * A non-2xx answer, thrown.
 *
 * `message` stays what it always was — `path → status body` — because it is what a log, a route error
 * boundary and a test read. What is NEW is `fields`: the code/detail/sentence parsed out of that body
 * at the moment of the throw, so `lib/api-error-message.ts` can say the refusal in the operator's
 * language instead of putting a URL and a status code on a phone screen. Absent (`undefined`) for
 * every non-JSON refusal — a proxy's HTML, a plain-text 403, an empty body.
 */
class ApiError extends Error {
  readonly status: number;
  readonly fields: ApiErrorFields | undefined;
  constructor(message: string, status: number, fields?: ApiErrorFields) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.fields = fields;
  }
}

/** True when an API request failed with the given HTTP status. */
export function isApiErrorStatus<TThrown>(error: TThrown, status: number): boolean {
  return error instanceof ApiError && error.status === status;
}

/**
 * True when the bridge (or a proxy in front of it) answered and REFUSED the request: a 4xx. A pairing
 * refusal, a proxy's sign-in, a gone pane. Not a transport failure, not a timeout and not a 5xx, which
 * is what a proxy answers when the bridge behind it is down. The Chat tail reads its saved copy back
 * only on the other kind (hooks/use-chat-window.ts): a refusal is an answer, not an outage.
 */
export function isRefusalStatus<TThrown>(error: TThrown): boolean {
  return error instanceof ApiError && error.status >= 400 && error.status < 500;
}

/**
 * What a failed read says about the connection (lib/connection-health.ts `ReadFailureKind`).
 *
 * `network` is a read that got NO answer: `fetch` threw a TypeError (no route, the radio off) or the
 * poll deadline ran out (a `TimeoutError`, see {@link POLL_TIMEOUT_MS}). `server` is a 5xx. Everything
 * else, a refusal included, is `other`. A superseded poll (an `AbortError`) is `other` too: the app
 * aborted it, the bridge did not fail it.
 */
export function readFailureKind<TThrown>(error: TThrown): ReadFailureKind {
  if (error instanceof ApiError) return error.status >= 500 ? "server" : "other";
  // The deadline's own DOMException, an Error subclass in every engine Collie runs in (the loaders'
  // `isAbortError` reads the superseded case the same way).
  if (error instanceof Error && error.name === "TimeoutError") return "network";
  // `fetch` rejects a network failure with a plain TypeError in every engine Collie runs in.
  if (error instanceof TypeError) return "network";
  return "other";
}

/**
 * The bridge's error fields off a caught throw, or `undefined` when it did not come from here.
 *
 * The accessor exists so `ApiError` itself stays private to this module: `lib/api-error-message.ts`
 * needs the fields, not the class, and exporting the class would invite `instanceof` checks in
 * components that should be branching on {@link isApiErrorStatus} or on a code.
 */
export function apiErrorFields<TThrown>(thrown: TThrown): ApiErrorFields | undefined {
  return thrown instanceof ApiError ? thrown.fields : undefined;
}

// Every request gets a deadline so a black-holed connection (phone sleep/wake, a Tailscale route
// that goes dark) can't leave a fetch pending forever — which would zombify the app: the poller
// gates on `revalidator.state === "idle"` and never fires again, and route navigations wait on a
// loader that never settles. On timeout the fetch aborts with a DOMException named "TimeoutError";
// the loaders rethrow ONLY "AbortError" (a superseded revalidation), so a timeout falls into their
// catch → stale-data-with-error, and the poller/nav can retry. Budgets by request class:
//   - GET reads (snapshot/pane polls) are small and frequent — a short leash surfaces a dead link
//     fast so the UI can show "reconnecting…" and retry on the next tick.
const GET_TIMEOUT_MS = 10_000;
//   - THE POLL READS (the herd snapshot, the pane mirror, the Chat window, the config read) get a
//     shorter one still: 6s, decided 2026-10-07 (M46 pass 3). On a phone with a VPN up and the radio
//     off, a request to the tailnet address does not fail, it hangs, and the 10s leash plus the 15s
//     escalation made Collie slow to admit the network was gone. A poll read that runs out counts as
//     a network failure (`readFailureKind`). 6s is one second above the bridge's own 5s mux timeout
//     (bridge/mux/herdr/client.ts DEFAULT_TIMEOUT_MS), so a Herdr call that uses its whole budget
//     comes back as the bridge's own answer and never reads as an outage on the phone. Long reads
//     keep the 10s leash: the History page's 5000 turns, a `?before=` page, a file. Uploads keep
//     their own budget below.
export const POLL_TIMEOUT_MS = 6_000;
//   - Mutations drive a real terminal on the host, which can legitimately take a beat — more slack.
const MUTATION_TIMEOUT_MS = 20_000;
//   - Uploads carry a whole file over the phone's uplink — the most generous budget.
const UPLOAD_TIMEOUT_MS = 60_000;
//   - A worktree create or open waits on `git worktree add`, which Herdr gives 60 s, and a create
//     may then wait for the new shell and type a launcher into it. 75 s covers both and stays under
//     the bridge's own 90 s hold on the connection (ADR 0089). A create that outlives it is retried
//     with the same request id, and the bridge answers from its receipt instead of creating twice.
export const WORKTREE_TIMEOUT_MS = 75_000;
//   - GitHub work (ADR 0091): a read with no cache behind it waits on the host's `gh api graphql`,
//     which the bridge kills at 20 s (measured 7–9 s for 30 items a list). 30 s lets the bridge's
//     own `timeout` answer arrive instead of the phone giving up first and calling it an outage.
const GITHUB_TIMEOUT_MS = 30_000;

// ── THE TRANSCRIPTION DEADLINE IS A FUNCTION OF THE CLIP, NOT A CONSTANT ────────────────────────
//
// A flat budget is dishonest for a body whose size is known and varies by two orders of magnitude.
// A five-second reply is a few kilobytes; a five-minute one is megabytes, and on a phone's uplink
// those are not the same request. The flat 60 s that shipped in the beta failed the long clip on a
// mobile connection — reported by a beta tester — while being far more slack than the short one
// needs.
//
// The floor this assumes is a SUSTAINED, PROGRESSING 256 kb/s uplink. It is not a promise of
// completion: a slower path, or a tunnel that stops mid-body, still fails, and it should — the
// operator is standing there waiting and would rather be told than watch a spinner. What it does
// buy is that a clip Collie was willing to RECORD is a clip Collie is willing to WAIT for.
const STT_UPLINK_BITS_PER_SECOND = 256_000;
// The bridge's own provider deadline (bridge/stt/openai.ts STT_TIMEOUT_MS), which starts only once
// the whole body has arrived — so it is added to the upload allowance rather than overlapping it.
const STT_PROVIDER_BUDGET_MS = 60_000;
// Request set-up, the bridge's own parse, and the response coming back down. Small and flat: none
// of it scales with the audio.
const STT_OVERHEAD_MS = 20_000;

/**
 * The whole-request deadline for one clip of `bytes`, in milliseconds.
 *
 * Exported for the unit test, and for anyone who wants to know what the ceiling actually is: at the
 * 8 MiB maximum (MAX_STT_AUDIO_BYTES) it is a little under six minutes.
 */
export function sttTimeoutFor(bytes: number): number {
  const upload = Math.ceil((Math.max(0, bytes) * 8 * 1000) / STT_UPLINK_BITS_PER_SECOND);
  return upload + STT_PROVIDER_BUDGET_MS + STT_OVERHEAD_MS;
}

/**
 * Compose the caller's abort signal (a loader's `request.signal`, used to supersede a stale poll)
 * with a fresh timeout signal, so a fetch aborts on EITHER cause. Returns the timeout signal alone
 * when there's no caller signal. Runtime-guarded: on an older WebView missing `AbortSignal.timeout`
 * or `AbortSignal.any` we return the caller's signal unchanged rather than crash — degrading to the
 * old no-timeout behaviour instead of taking the app down.
 *
 * Exported for unit tests (the timeout wiring is otherwise unobservable).
 */
export function withTimeout(
  signal: AbortSignal | null | undefined,
  ms: number,
): AbortSignal | undefined {
  const timeoutSignal = abortSignalAfter(ms);
  if (timeoutSignal === null) return signal ?? undefined;
  if (!signal) return timeoutSignal;
  return abortSignalAny([signal, timeoutSignal]) ?? signal;
}

// Append the addressing scope to an API path, composing with any query already present (fetchPane
// carries `?lines=`). The browser URL uses the short `?h=` / `?s=`; on the wire they take their long
// names, `host=` and `session=`, in that same fixed order.
//
// Blank / absent host → the lead (the collie this phone is connected to); blank / absent session →
// that host's primary session. Both absent returns the path UNTOUCHED, so a solo install puts no
// query on the wire at all — byte-identical requests to what shipped.
function withScope(path: string, scope?: Scope): string {
  const { host, session } = normalizeScope(scope);
  let out = path;
  if (host) out += `${out.includes("?") ? "&" : "?"}host=${encodeURIComponent(host)}`;
  if (session) out += `${out.includes("?") ? "&" : "?"}session=${encodeURIComponent(session)}`;
  return out;
}

/**
 * A journal image reference as a URL this phone may load, or `null` when it is not one.
 *
 * ── TWO SHAPES, AND NOTHING ELSE ─────────────────────────────────────────────
 * A blob path served by the owning collie (`/api/blobs/<64 hex>`) and an inline `data:image/*`
 * payload. The bridge already refuses everything else (`bridge/journal/pi.ts` § resolveImageUrl),
 * and this is the second, independent check on the side that would do the fetching: a journal is an
 * AGENT's output, so a remote URL in it would have the phone call an arbitrary host on the agent's
 * word. Anything unrecognised answers null and renders as no image.
 *
 * ── AND THE BLOB CARRIES ITS HOST ────────────────────────────────────────────
 * The bytes sit on the machine whose journal named them, so the path takes the scope every other
 * per-pane request takes and the lead forwards it (CREW_PROTOCOL.md §9.1). A `data:` URL is already
 * the bytes and is scoped to nothing.
 */
const BLOB_REF = /^\/api\/blobs\/[0-9a-f]{64}$/i;

export function imageSrc(ref: string, scope?: Scope): string | null {
  if (BLOB_REF.test(ref)) return withScope(ref, scope);
  return ref.startsWith("data:image/") ? ref : null;
}

// ── READS NEED THE PAIRING TOKEN (M46 specs 03 and 06, ADR 0086) ───────────────────────────────
//
// Every `/api` route but health and pair answers 403 `device not paired` (or `device expired`) to a
// browser without a valid token. Two things follow here, and both are this module's to say.

/** Whether a status and body are the bridge's own pairing refusal, exactly as `guard` sends it. */
function isPairingRefusalBody(status: number, detail: string): boolean {
  const body = detail.trim();
  return status === 403 && (body === NOT_PAIRED_BODY || body === EXPIRED_BODY);
}

/**
 * A pairing refusal is the bridge ANSWERING. It is not an outage, so it stamps the connection-health
 * anchor like a 304 does: otherwise an unpaired phone would watch the connection strip escalate to
 * "not connected" over a bridge that is up and asking to be paired.
 */
function notePairingAnswer(status: number, detail: string): void {
  if (isPairingRefusalBody(status, detail)) markLive();
}

/**
 * Whether a failed request was refused for want of pairing. The loaders use it to keep this refusal
 * apart from a fronting proxy's 401/403 (`isAuthError`): the remedy here is the pair screen, not the
 * proxy's sign-in page.
 */
export function isPairingRefusal<TThrown>(error: TThrown): boolean {
  if (!(error instanceof ApiError)) return false;
  const marker = ` → ${String(error.status)} `;
  const at = error.message.indexOf(marker);
  return at !== -1 && isPairingRefusalBody(error.status, error.message.slice(at + marker.length));
}

/**
 * A subresource the bridge serves under `/api` (a journal blob, the multiplexer's mark, an operator
 * font) as bytes fetched WITH the token. An `<img src>` or a CSS `url()` cannot carry an
 * `Authorization` header, so since reads need the token those URLs are fetched here and handed to the
 * page as object URLs or bytes (lib/authed-url.ts, lib/operator-fonts.ts). `path` is root-absolute,
 * as every other call here spells it; the mount is applied by `apiFetch`.
 */
export async function fetchAuthedBytes(path: string, signal?: AbortSignal): Promise<Blob> {
  return (await fetchAuthedAnswer(path, signal)).blob;
}

/** {@link fetchAuthedBytes} with the answer's headers, for a caller that reads a version off them. */
async function fetchAuthedAnswer(path: string, signal?: AbortSignal): Promise<{ blob: Blob; headers: Headers }> {
  const res = await apiFetch(path, {
    signal: withTimeout(signal, GET_TIMEOUT_MS),
    headers: { [XHR_HEADER]: XHR_HEADER_VALUE, ...authHeader() },
  });
  captureBuild(res);
  if (!res.ok) {
    const detail = await errorDetail(res);
    notePairing("GET", res.status, detail);
    notePairingAnswer(res.status, detail);
    throw new ApiError(`${path} → ${res.status} ${detail}`, res.status, parseApiErrorFields(detail));
  }
  return { blob: await res.blob(), headers: res.headers };
}

// Best-effort human-readable failure detail: the response body if present, else the status text.
async function errorDetail(res: Response): Promise<string> {
  try {
    return (await res.text()) || res.statusText;
  } catch {
    return res.statusText;
  }
}

// `redirect: "manual"` is intentionally local to the API client rather than a global fetch patch.
// Browsers expose a manual redirect as `opaqueredirect` (status 0); test/runtime implementations may
// expose the actual 3xx. Collie's own API has no redirect contract, and 304 is a normal pane ETag hit,
// so only these redirect statuses are authentication-front-door territory.
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function normaliseProxyRedirect(res: Response): Response {
  if (res.type !== "opaqueredirect" && !REDIRECT_STATUSES.has(res.status)) return res;
  return new Response("fronting identity proxy requires sign-in", {
    status: 401,
    statusText: "Unauthorized",
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  // Every caller spells a root-absolute `/api/…`; the mount is applied here, once (ADR 0052).
  try {
    return normaliseProxyRedirect(await fetch(mounted(path), { ...init, redirect: "manual" }));
  } catch (error) {
    throw deadlineError(error, init?.signal);
  }
}

/**
 * A read that ran out of its deadline, named for what it is on every engine.
 *
 * WebKit rejects a fetch whose signal aborted with a generic `AbortError` ("Fetch is aborted") even
 * when the signal is `AbortSignal.timeout`, whose own reason is a `TimeoutError`; Chromium and Gecko
 * reject with the reason. The two are not the same event for the app: an `AbortError` is a superseded
 * poll, which the loaders rethrow for React Router to drop, and a `TimeoutError` is a read that got
 * no answer ({@link readFailureKind}). On Safari the deadline looked like a supersede, so a hung poll
 * went to the error boundary and never counted as a lost connection. The signal still holds the
 * truth, so the error is swapped for the signal's own `TimeoutError` reason when that is what aborted
 * it. Anything else, a caller's own abort included, passes through unchanged.
 */
function deadlineError<TThrown>(error: TThrown, signal: AbortSignal | null | undefined): TThrown | Error {
  if (!(error instanceof Error) || error.name !== "AbortError") return error;
  const reason: unknown = signal?.aborted ? signal.reason : undefined;
  return reason instanceof Error && reason.name === "TimeoutError" ? reason : error;
}

/**
 * The recover handler for the two endpoints that accept `expected_prompt`: reply and keys. A
 * rejected binding is their normal answer, not a transport failure. The bridge refuses the write
 * because the prompt moved, and the caller renders "the dialog changed". Both must share it, or one
 * of them starts throwing where the other returns a value.
 */
const recoverPromptChanged = (status: number, detail: string): ActionResponse | null =>
  status === 409 ? promptChangedResponse(detail) : null;

function promptChangedResponse(detail: string): ActionResponse | null {
  // A non-JSON error body parses to `undefined` and follows the existing ApiError path below.
  const body = parseJsonObject(detail);
  if (!body) return null;
  if (body.ok !== false || body.code !== "prompt_changed") return null;
  const error = asJsonString(body.error);
  if (error === undefined) return null;
  const response: ActionResponse = { ok: false, error, code: "prompt_changed" };
  // The bridge's reason code, kept only when it is a plain code: it is shown to a person with the
  // console open and never as UI text, and a body that is not one is not forwarded.
  const reason = asJsonString(body.reason);
  if (reason !== undefined && /^[a-z_]{1,32}$/.test(reason)) response.reason = reason;
  return response;
}

/**
 * Read the pairing gate's verdict off a finished request, at the one place every request passes.
 *
 * The refusal latch is set here, from the bridge's own 403 body, and cleared by the opposite proof: a
 * mutation that actually went through. A refusal counts on any method, because every read is gated
 * too (ADR 0086) and refuses with the same two bodies. A GET that succeeds clears nothing: after a
 * refusal the token is gone, so the next proof is a fresh pairing, which clears the latch itself.
 *
 * The body must match EXACTLY. A refusal while this phone held a token ends its pairing, and
 * `pairingRefused` then runs the one wipe (M46 spec 02): `device not paired` means the token was
 * revoked, `device expired` that its lifetime ran out (spec 01). The proxy allowlist's
 * `device not authorised`, a crew member's longer body and every other 403 wipe nothing.
 */
function notePairing(method: string, status: number, detail?: string): void {
  if (status === 403 && detail?.trim() === NOT_PAIRED_BODY) {
    pairingRefused("not-paired");
    return;
  }
  if (status === 403 && detail?.trim() === EXPIRED_BODY) {
    pairingRefused("expired");
    return;
  }
  if (method === "GET") return;
  if (status >= 200 && status < 300) clearNotPaired();
}

// Capture the bridge's build id off any response that carries it. Every poll (snapshot/pane) — and
// config + mutations — funnels through the two fetch sites below, so the store stays current for
// free, powering the no-service-worker self-updater (lib/self-update.ts). Absent header (older
// bridge) → no-op, so nothing activates.
function captureBuild(res: Response): void {
  observeServerBuild(res.headers.get(SERVER_BUILD_HEADER));
}

/**
 * Lets ONE caller claim a non-ok response instead of having it thrown. The transport stays generic:
 * it knows a caller may recognise a refusal and turn it into a normal value, but nothing about which
 * status or which body shape. Return null to fall through to the usual {@link ApiError}.
 */
type Recover<T> = (status: number, detail: string) => T | null;

/** A request's init, plus the one deadline override a poll read asks for ({@link POLL_TIMEOUT_MS}). */
type ReqInit = RequestInit & { timeoutMs?: number };

async function doReq<T>(path: string, reqInit?: ReqInit, recover?: Recover<T>): Promise<T> {
  const { timeoutMs: asked, ...init } = reqInit ?? {};
  // GET reads get the short leash; anything mutating gets the longer mutation budget.
  const method = init.method?.toUpperCase() ?? "GET";
  const timeoutMs = asked ?? (method === "GET" ? GET_TIMEOUT_MS : MUTATION_TIMEOUT_MS);
  const res = await apiFetch(path, {
    ...init,
    signal: withTimeout(init.signal, timeoutMs),
    headers: {
      "content-type": "application/json",
      [XHR_HEADER]: XHR_HEADER_VALUE,
      // The device credential, injected once for every JSON request rather than plumbed per call.
      // Absent header when this device holds no token — which is exactly right for a bridge with
      // nothing paired, and for the bootstrap POST /api/pair that mints the first one.
      ...authHeader(),
      ...init.headers,
    },
  });
  captureBuild(res);
  if (!res.ok) {
    const detail = await errorDetail(res);
    notePairing(method, res.status, detail);
    notePairingAnswer(res.status, detail);
    const recovered = recover?.(res.status, detail);
    if (recovered !== null && recovered !== undefined) return recovered;
    throw new ApiError(`${path} → ${res.status} ${detail}`, res.status, parseApiErrorFields(detail));
  }
  notePairing(method, res.status);
  if (res.status === 204) {
    // SAFETY: `T` is the response contract each exported wrapper below declares for its own
    // endpoint; `doReq` is the generic transport and has no shape of its own to check against. A
    // 204 carries no body by definition, so the only honest value is `undefined`, and every caller
    // that passes a 204-returning path types `T` to include it.
    return undefined as T;
  }
  // SAFETY: as above — the bridge's JSON body is `T` by the endpoint's contract. The shapes that
  // are NOT under the bridge's control (a proxy's error page, a refusal body) never reach here:
  // they are non-ok and were parsed field-by-field by the `recover` handlers above.
  return (await res.json()) as T;
}

// Every mutating request (non-GET) feeds the app-wide busy signal so the top progress bar shows
// while it's in flight; GET reads (snapshot/config polling) don't, or the bar would never rest.
// trackBusy increments synchronously, so a caller sees `isBusy()` true the instant it fires.
function req<T>(path: string, init?: ReqInit, recover?: Recover<T>): Promise<T> {
  const op = doReq<T>(path, init, recover);
  const method = init?.method?.toUpperCase() ?? "GET";
  return method === "GET" ? op : trackBusy(op);
}

/**
 * The herd snapshot.
 *
 * `all` WIDENS the pane lists to every Herdr session on the addressed machine (`?sessions=all`).
 * It is a separate argument rather than a field on the scope because it is not part of a pane's
 * address — lib/scope.ts states that argument at {@link ALL_PARAM}. Note the browser URL spells it
 * `?all=1` and the wire spells it `?sessions=all`: the wire word is the one the bridge already uses
 * for the dimension, and the URL word is the one an operator might read.
 */
export async function fetchSnapshot(
  scope?: Scope,
  signal?: AbortSignal,
  all = false,
): Promise<SnapshotResponse> {
  const path = withScope("/api/snapshot", scope);
  let snap: SnapshotResponse;
  // When this read began, and whether the page was hidden: a read with no answer right after a wake
  // is one strike, not the outage (lib/connection-health.ts `noteNetworkFailure`).
  noteReadStart();
  try {
    snap = await req<SnapshotResponse>(all ? `${path}${path.includes("?") ? "&" : "?"}sessions=all` : path, {
      signal,
      timeoutMs: POLL_TIMEOUT_MS,
    });
  } catch (error) {
    // THE HERD READ IS THE ONE THAT DECIDES "THE BRIDGE IS GONE" (lib/connection-health.ts
    // `noteNetworkFailure`, `noteServerFailure`). Every poll makes it, it always goes to the lead, and
    // it is small, so a failure here is about the connection and not about one slow pane on a member.
    // A read the app aborted itself (a superseded poll, a navigation) says nothing and counts nothing.
    if (signal?.aborted !== true) {
      const kind = readFailureKind(error);
      if (kind === "network") noteNetworkFailure();
      else if (kind === "server") noteServerFailure();
    }
    throw error;
  }
  // A snapshot whose herd link is UP is a provably-live moment — stamp the shared connection-health
  // anchor so escalation is measured from here. A snapshot that 200s but reports `bridge:
  // "disconnected"` is NOT live (the pill/banner still escalate on it), so it must NOT reset the
  // clock, or the "Herdr is down" escalation could never surface.
  if (snap.bridge !== "disconnected") markLive();
  return snap;
}

// Per-pane cache of the last ETag AND the body it belongs to, kept together on purpose. We send
// If-None-Match on the next poll to skip re-transferring unchanged scrollback; on a 304 we return
// the cached body (with its text) so the mirror stays populated. Two invariants make this safe:
//   1. The ETag is recorded ONLY together with its response — never on its own.
//   2. It is recorded only AFTER the body parses successfully, so a transient parse/abort (e.g. a
//      bridge restart truncating an in-flight read) can't leave an ETag with no text behind — which
//      would otherwise make every later poll 304 into an empty mirror (a permanent blank pane).
// Entirely client-managed — we never rely on the browser HTTP cache (the server sends
// cache-control: no-store for privacy). Module-scoped, so it lives for the page's lifetime.
interface PaneCacheEntry {
  etag: string;
  response: PaneReadResponse;
}
const paneCache = new Map<string, PaneCacheEntry>();
// Bound the cache so it can't grow forever across a long session of opening many panes. Evict the
// oldest (insertion-order) entry beyond the cap — a plain FIFO is fine here (each entry is one
// pane's last body). 20 comfortably covers any panes in flight on a phone.
const PANE_CACHE_MAX = 20;

// What the client had last SEEN of each pane, and what it had seen at the moment of its most recent
// key send. The second is the baseline `settleAfterSend` (lib/harness/guard.ts) waits to leave: a
// tap that moves a highlight is only "on screen" once a read differs from the one the tap was made
// against. Kept here, beside the one function that reads and the one that sends, so a multi-step
// choreography needs no plumbing: the last key it sends snapshots whatever its last verified read
// showed. Both are FIFO-bounded like `paneCache`, and keyed the same way.
const lastSeenText = new Map<string, string>();
const textBeforeSend = new Map<string, string>();

function remember(map: Map<string, string>, key: string, text: string): void {
  map.delete(key); // re-insert, so the FIFO bound evicts the pane least recently touched
  map.set(key, text);
  if (map.size > PANE_CACHE_MAX) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

/** The pane text the client had seen when its latest key was sent (`undefined` = never read, or no
 *  key sent yet). The baseline for `settleAfterSend`. */
export function textBeforeLastSend(paneId: string, scope?: Scope): string | undefined {
  return textBeforeSend.get(paneScopeKey(scope, paneId));
}

/**
 * Read one pane's mirror. `seen: false` leaves the pane's unseen mark alone: the read a finger
 * starts on `pointerdown` (lib/pane-prefetch.ts) may be the start of a scroll, not an open.
 */
export async function fetchPane(
  paneId: string,
  lines?: number,
  scope?: Scope,
  signal?: AbortSignal,
  { seen = true }: { seen?: boolean } = {},
): Promise<PaneReadResponse> {
  const q = lines ? `?lines=${lines}` : "";
  const url = withScope(`/api/pane/${encodeURIComponent(paneId)}${q}`, scope);
  // Pane ids are unique only within one session on one machine (each session is its own Herdr
  // server; each crew member is its own machine again), so the ETag/body cache is keyed by the full
  // (host, session, paneId) triple — otherwise a "w1:p1" in one session, or on one host, would 304
  // into another's mirror. Shared with the loaders' caches via lib/scope, so the two can't drift.
  const cacheKey = paneScopeKey(scope, paneId);

  const cached = paneCache.get(cacheKey);
  // SEEN_HEADER is what tells the bridge this read came from our own page and may mark the pane
  // seen. A cross-site no-cors GET can't set a custom header, so it can't clear your alerts by
  // guessing pane ids (bridge/server.ts → marksPaneSeen).
  const headers = new Headers({
    [XHR_HEADER]: XHR_HEADER_VALUE,
    // A read needs no token, but the bridge stamps `lastSeenAt` off whatever it resolves — so a
    // paired device's polls are what keep its "last seen" honest. Same injection point as `doReq`.
    ...authHeader(),
  });
  if (seen) headers.set("x-collie-seen", "1");
  if (cached) headers.set("if-none-match", cached.etag);

  let res: Response;
  try {
    res = await apiFetch(url, { signal: withTimeout(signal, POLL_TIMEOUT_MS), headers });
  } catch (error) {
    // A read that never answered (network down, timed out) is a failed read. One the caller aborted
    // (a superseded revalidation, a navigation away) says nothing about the bridge.
    if (signal?.aborted !== true) markPaneDead(paneId, scope);
    throw error;
  }
  captureBuild(res); // pane polls carry the build header too (incl. 304s) — keep the store fresh
  if (res.ok || res.status === 304) markPaneLive(paneId, Date.now(), scope); // M46 spec 11: controls on this pane may act (lib/liveness.ts)
  else markPaneDead(paneId, scope); // a refused or failed read takes them down, after a short debounce

  if (res.status === 304 && cached) {
    // Unchanged — hand back the cached body (text included) so the mirror keeps its content. An
    // unchanged poll is still a live poll: stamp the connection-health anchor (a 304 counts as live).
    markLive();
    remember(lastSeenText, cacheKey, cached.response.text);
    return { ...cached.response, notModified: true };
  }

  if (!res.ok) {
    const detail = await errorDetail(res);
    // A pane read is gated like every read (ADR 0086), and it does not pass through `doReq`, so it
    // reads the pairing verdict itself: the pane screen shows the pair strip, not an outage.
    notePairing("GET", res.status, detail);
    notePairingAnswer(res.status, detail);
    throw new ApiError(`${url} → ${res.status} ${detail}`, res.status, parseApiErrorFields(detail));
  }

  // Parse the body BEFORE recording the ETag, so the cache only ever holds an (etag, text) pair
  // that actually arrived intact.
  // SAFETY: a 200 on `/api/pane/:id` is the bridge's own `PaneReadResponse` by contract — the same
  // endpoint contract every other call in this module rests on. Non-ok answers threw above.
  const data = (await res.json()) as PaneReadResponse;
  const etag = res.headers.get("etag");
  if (etag) {
    paneCache.set(cacheKey, { etag, response: data });
    if (paneCache.size > PANE_CACHE_MAX) {
      const oldest = paneCache.keys().next().value;
      if (oldest !== undefined) paneCache.delete(oldest);
    }
  }

  // A pane body served from Herdr is provably-live data — stamp the connection-health anchor.
  markLive();
  remember(lastSeenText, cacheKey, data.text);
  return data;
}

/**
 * Fetch a page of the pane's conversation history — the scrollback its terminal can't hold (a Claude
 * pane runs on the alternate screen, which has no scrollback ring). Newest-anchored: no cursor gives
 * the most recent turns; `before` walks backwards from a turn already on screen.
 *
 * Deliberately NOT ETag-cached like fetchPane: history is fetched on navigation and on an explicit
 * "load older" tap, never on the poll loop, so there's no repeat-fetch to save.
 */
export function fetchHistory(
  paneId: string,
  opts: { limit?: number; before?: string } = {},
  scope?: Scope,
  signal?: AbortSignal,
): Promise<PaneHistoryResponse> {
  const q = new URLSearchParams();
  if (opts.limit) q.set("limit", String(opts.limit));
  if (opts.before) q.set("before", opts.before);
  const qs = q.toString();
  const path = `/api/pane/${encodeURIComponent(paneId)}/history${qs ? `?${qs}` : ""}`;
  // Reading the transcript is looking at the pane — and history is a READ, so like fetchPane it
  // carries the header that lets the bridge count it (bridge/server.ts → marksPaneSeen).
  return req<PaneHistoryResponse>(withScope(path, scope), {
    signal,
    headers: { "x-collie-seen": "1" },
  });
}

/**
 * One page request for {@link fetchChat} — `limit`, and AT MOST ONE of the two cursors.
 *
 * The bridge honours `before` and does not even read `after` when both arrive
 * (bridge/journal/live.ts § `chatParams`), so a caller that sent both would be handed a page it did
 * not ask for and have nothing on screen to explain it. The `never` pair makes that a compile error
 * here instead of a puzzle there. The runtime order below matches the bridge exactly anyway, for
 * the one caller a type cannot reach.
 */
export type ChatRequest =
  | { limit?: number; after?: ChatAfter; before?: never }
  | { limit?: number; after?: never; before: ChatBefore };

// The last ETag per (host, session, pane), for the LIVE page only. Same key as the pane cache, and
// for the same reason: a pane id is unique only inside one session on one machine.
//
// Only the live page is validated, because only the live page repeats — the poll asks it on the
// cadence `hooks/use-polling.ts` already owns, and an unchanged session answers 304 (ADR 0073 point
// 6). A `?before=` page is a one-shot tap like fetchHistory's, so there is no repeat fetch for a
// validator to save. The body alone is NOT cached beside the tag: a 304 here means "you already
// hold this", and what the client holds is the merged window (lib/chat-window.ts), not this answer.
//
// THE TAG IS SENT ONLY WITH A CURSOR. A read with no `after` is the client saying it holds nothing: a
// view that mounted again (back from the Files screen), or a pane switched to. The tag outlives the
// view, so on such a read it could still match: the answer to a first read, when nothing moved since,
// hashes to the very bytes the tag was made from, and the 304 then told an EMPTY window "you already
// hold this". The Chat body stood blank until the session next changed. Only a read that names the
// window it holds can be told "unchanged".
const chatEtags = new Map<string, string>();
// One Chat screen is open at a time and a second device makes two; eight covers any plausible
// come-and-go across a session, and matches MAX_WINDOWS on the bridge side.
const CHAT_ETAG_MAX = 8;

/**
 * Ask a pane's session what moved (ADR 0073). The answer is merged by `lib/chat-window.ts`.
 *
 * Three outcomes, and the caller must tell them apart:
 *
 *  - `body` — a 200. Either a live window or a `?before=` page; `available: false` lives in here too,
 *    because "this pane has no session" is an ordinary answer and not a failure.
 *  - `unchanged` — a 304. Nothing moved. Neither an error nor a change.
 *  - `stale` — a 404. **This machine's Collie predates the route**, which is a version fact and never
 *    "this pane has nothing to show". The route is additive-optional over a crew link, so it is the
 *    ordinary skew a crew is in while it levels. The remedy is `chat.stale.member`, which the VIEW
 *    resolves; this module names no sentence.
 *
 * Anything else still throws, exactly as every other call here does.
 */
export async function fetchChat(
  paneId: string,
  opts: ChatRequest = {},
  scope?: Scope,
  signal?: AbortSignal,
): Promise<ChatAnswer> {
  const q = new URLSearchParams();
  if (opts.limit) q.set("limit", String(opts.limit));
  // The bridge's own precedence, restated rather than assumed: `before` wins and `after` is not read.
  if (opts.before) q.set("before", `${opts.before.seq}:${opts.before.uuid}`);
  else if (opts.after) q.set("after", `${opts.after.gen}:${opts.after.rev}`);
  const qs = q.toString();
  const url = withScope(
    `/api/pane/${encodeURIComponent(paneId)}/chat${qs ? `?${qs}` : ""}`,
    scope,
  );
  const cacheKey = opts.before ? null : paneScopeKey(scope, paneId);
  const cached = cacheKey === null || !opts.after ? undefined : chatEtags.get(cacheKey);

  const headers = new Headers({
    [XHR_HEADER]: XHR_HEADER_VALUE,
    // Watching a session IS looking at the pane, the same reading history takes (bridge/server.ts →
    // marksPaneSeen), so a Chat screen left open keeps the pane's unseen mark clear.
    "x-collie-seen": "1",
    ...authHeader(),
  });
  if (cached !== undefined) headers.set("if-none-match", cached);

  // The live window is a poll read and gets the poll deadline. A `?before=` page is a tap the operator
  // waits on, and it can reach back to disk, so it keeps the long one.
  const deadline = opts.before ? GET_TIMEOUT_MS : POLL_TIMEOUT_MS;
  const res = await apiFetch(url, { signal: withTimeout(signal, deadline), headers });
  captureBuild(res);

  if (res.status === 304) {
    // An unchanged poll is still a live poll — stamp the connection-health anchor, as fetchPane does.
    markLive();
    return CHAT_UNCHANGED;
  }
  if (res.status === 404) {
    // An older bridge's route table has no `chat` segment at all, so the request falls through to
    // its 404. The pane route answers `available:false` for every reason a pane itself has nothing,
    // which is why this status can only mean the version skew.
    //
    // It carries no sentence. This module is transport: an api error here carries a CODE and
    // `lib/api-error-message.ts` is what turns one into words. Resolving a sentence in the fetch
    // would put wording in the layer that has no business choosing it, and would freeze the
    // language at the moment of the answer. The view calls `t("chat.stale.member")`.
    return { outcome: "stale" };
  }
  if (!res.ok) {
    const detail = await errorDetail(res);
    // Gated like every read (ADR 0086), and outside `doReq`, as `fetchPane` is.
    notePairing("GET", res.status, detail);
    notePairingAnswer(res.status, detail);
    throw new ApiError(`${url} → ${res.status} ${detail}`, res.status, parseApiErrorFields(detail));
  }

  // SAFETY: a 200 on `/api/pane/:id/chat` is the bridge's own `PaneChatResponse` by contract — the
  // same endpoint contract every other call in this module rests on. Non-ok answers returned above.
  const body = (await res.json()) as PaneChatResponse;
  // Recorded only AFTER the body parsed, so a truncated read can never leave a tag behind that
  // 304s the next poll into a window nothing ever filled.
  const etag = res.headers.get("etag");
  if (cacheKey !== null && etag) {
    chatEtags.set(cacheKey, etag);
    if (chatEtags.size > CHAT_ETAG_MAX) {
      const oldest = chatEtags.keys().next().value;
      if (oldest !== undefined) chatEtags.delete(oldest);
    }
  }
  markLive();
  return { outcome: "body", body };
}

/** How far the Changes view looks for repos below the workspace folder (Settings → Changes). */
export interface ChangesLookup {
  depth: number;
  nested: boolean;
}

function changesQuery(lookup: ChangesLookup, file?: { repo: string; path: string }): string {
  const q = new URLSearchParams({ depth: String(lookup.depth), nested: lookup.nested ? "1" : "0" });
  if (file) {
    q.set("repo", file.repo);
    q.set("path", file.path);
  }
  return q.toString();
}

/**
 * Whose Changes list: a pane's (the bridge resolves the pane's workspace) or a workspace asked
 * directly. Both answer the same shape (ADR 0065).
 */
export type ChangesTarget = { kind: "pane"; paneId: string } | { kind: "space"; spaceId: string };

function changesBase(target: ChangesTarget): string {
  return target.kind === "pane"
    ? `/api/pane/${encodeURIComponent(target.paneId)}/changes`
    : `/api/workspace/${encodeURIComponent(target.spaceId)}/changes`;
}

/**
 * The uncommitted changes under a workspace's folder, read-only (ADR 0065). Fetched on open and on
 * the view's refresh button, never on the poll loop. No seen header: a git view of the folder is
 * not the pane's conversation, so it does not mark the pane seen.
 */
export function fetchChanges(
  target: ChangesTarget,
  lookup: ChangesLookup,
  scope?: Scope,
  signal?: AbortSignal,
): Promise<ChangesResponse> {
  const path = `${changesBase(target)}?${changesQuery(lookup)}`;
  return req<ChangesResponse>(withScope(path, scope), { signal });
}

/** One changed file's diff. The bridge serves only a repo and path its own list names. */
export function fetchChangeDiff(
  target: ChangesTarget,
  lookup: ChangesLookup,
  file: { repo: string; path: string },
  scope?: Scope,
  signal?: AbortSignal,
): Promise<ChangeDiffResponse> {
  const path = `${changesBase(target)}?${changesQuery(lookup, file)}`;
  return req<ChangeDiffResponse>(withScope(path, scope), { signal });
}

/** The last commit of one repo in the workspace (ADR 0065, the commit view). HEAD only. */
export function fetchChangeCommit(
  target: ChangesTarget,
  lookup: ChangesLookup,
  repo: string,
  scope?: Scope,
  signal?: AbortSignal,
): Promise<ChangeCommitResponse> {
  const q = new URLSearchParams(changesQuery(lookup));
  q.set("view", "commit");
  q.set("repo", repo);
  return req<ChangeCommitResponse>(withScope(`${changesBase(target)}?${q.toString()}`, scope), { signal });
}

/** One file of that commit. The bridge serves only a path the same read of HEAD listed. */
export function fetchChangeCommitDiff(
  target: ChangesTarget,
  lookup: ChangesLookup,
  file: { repo: string; path: string },
  scope?: Scope,
  signal?: AbortSignal,
): Promise<ChangeCommitDiffResponse> {
  const q = new URLSearchParams(changesQuery(lookup, file));
  q.set("view", "commit");
  return req<ChangeCommitDiffResponse>(withScope(`${changesBase(target)}?${q.toString()}`, scope), { signal });
}

// ── The Files view (ADR 0083) ─────────────────────────────────────────────────────────────────────
// Two reads on one route: a folder (`?dir=`, or nothing for the root) and one file (`?path=`). Both
// answer JSON only; file bytes are never served as a document. The two 404s mean different things and
// the view must tell them apart, so this module turns each into a value instead of a throw.

/**
 * What a Files read came to. `body` is a 200. `unknown-path` is the bridge's one answer for a path
 * that is absent, outside the root, denied, or the wrong kind. `stale` is any other 404: the route is
 * additive-optional over a crew link, so a member one release behind has no `files` segment and
 * answers `{ "error": "not found" }`, and the honest reading is "update this machine". The two 404s
 * differ by the `error` value alone. `not-paired` and `not-authorised` are the two 403s: Files takes
 * the paired-device gate that writes take, so a read can be refused too, with a plain-text body that
 * names which gate said no (ADR 0083). No sentence here, as in {@link fetchChat}: the view resolves
 * the words.
 */
export type FilesAnswer<T> =
  | { outcome: "body"; body: T }
  | { outcome: "unknown-path" }
  | { outcome: "stale" }
  | { outcome: "not-paired" }
  | { outcome: "not-authorised" };

const FILES_UNKNOWN_PATH = { outcome: "unknown-path" } as const;
const FILES_STALE = { outcome: "stale" } as const;
const NOT_AUTHORISED_BODY = "device not authorised";
const FILES_NOT_PAIRED = { outcome: "not-paired" } as const;
const FILES_NOT_AUTHORISED = { outcome: "not-authorised" } as const;

type FilesRefusal =
  | typeof FILES_UNKNOWN_PATH
  | typeof FILES_STALE
  | typeof FILES_NOT_PAIRED
  | typeof FILES_NOT_AUTHORISED;

/**
 * A refusal on the files route, told apart by status and body: a 404 by its JSON `error` value, a
 * 403 by its plain-text body (the same two bodies a refused write carries, lib/pairing.ts).
 */
function filesRefusal(status: number, detail: string): FilesRefusal | null {
  if (status === 404) return parseJsonObject(detail)?.error === "unknown-path" ? FILES_UNKNOWN_PATH : FILES_STALE;
  if (status !== 403) return null;
  // Prefixes, not equality: a crew member answers "device not authorised on this host" and its kin,
  // the lead's plain bodies with a clause after them (the relay keeps the member's own words).
  const body = detail.trim();
  if (body.startsWith(NOT_PAIRED_BODY)) {
    // Reads were ungated until Files, so nothing on a read could ever discover an unpaired device.
    // Latch it as a refused write does: the app's read-only strip then names the remedy, once. Only
    // the lead's own exact body wipes (M46 spec 02); a member's longer one latches and no more.
    if (body === NOT_PAIRED_BODY) pairingRefused("not-paired");
    else markNotPaired();
    return FILES_NOT_PAIRED;
  }
  if (body.startsWith(EXPIRED_BODY)) {
    // The same refusal for the view's purpose; the latch carries the pair-again reason.
    if (body === EXPIRED_BODY) pairingRefused("expired");
    else markExpired();
    return FILES_NOT_PAIRED;
  }
  return body.startsWith(NOT_AUTHORISED_BODY) ? FILES_NOT_AUTHORISED : null;
}

const FILES_REFUSALS: ReadonlySet<unknown> = new Set([
  FILES_UNKNOWN_PATH,
  FILES_STALE,
  FILES_NOT_PAIRED,
  FILES_NOT_AUTHORISED,
]);

/** The refusal objects above are shared constants, so identity is the whole test: a parsed body is never one. */
function isFilesRefusal<T>(got: T | FilesRefusal): got is FilesRefusal {
  return FILES_REFUSALS.has(got);
}

async function filesRead<T>(path: string, scope: Scope | undefined, signal: AbortSignal | undefined): Promise<FilesAnswer<T>> {
  const got = await req<T | FilesRefusal>(withScope(path, scope), { signal }, filesRefusal);
  if (isFilesRefusal(got)) return got;
  return { outcome: "body", body: got };
}

function filesBase(target: ChangesTarget): string {
  return target.kind === "pane"
    ? `/api/pane/${encodeURIComponent(target.paneId)}/files`
    : `/api/workspace/${encodeURIComponent(target.spaceId)}/files`;
}

/** One folder of the root (`dir` is relative, `""` the root). Fetched on open and on refresh only. */
export function fetchFilesDir(
  target: ChangesTarget,
  dir: string,
  scope?: Scope,
  signal?: AbortSignal,
): Promise<FilesAnswer<FilesListResponse>> {
  const q = dir === "" ? "" : `?${new URLSearchParams({ dir }).toString()}`;
  return filesRead<FilesListResponse>(`${filesBase(target)}${q}`, scope, signal);
}

/** One file under the root, as text: cut at the bridge's cap, `binary` with no text. */
export function fetchFileText(
  target: ChangesTarget,
  path: string,
  scope?: Scope,
  signal?: AbortSignal,
): Promise<FilesAnswer<FileReadResponse>> {
  return filesRead<FileReadResponse>(`${filesBase(target)}?${new URLSearchParams({ path }).toString()}`, scope, signal);
}

/**
 * The address of one picture under the Files root, as bytes (ADR 0090): `files/image` beside the
 * Files read, in the same pane or workspace form and with the same scope.
 */
export function filesImagePath(target: ChangesTarget, path: string, scope?: Scope): string {
  return withScope(`${filesBase(target)}/image?${new URLSearchParams({ path }).toString()}`, scope);
}

/**
 * What an image read came to. `image` is the bytes, typed by the bridge's sniff. `too-large` is the
 * bridge's 413 (over 16 MiB), `not-image` its 415 (the bytes are none of the types it serves), and
 * `failed` everything else: a refusal, an older member's 404, the network. The screen then shows the
 * file's size as it did before, with the reason. `version` is the size and mtime the bridge sent with
 * the bytes, when it sent them (an older bridge sends none; a crew lead relays a member's as they came).
 */
export type FileImageAnswer =
  | { outcome: "image"; blob: Blob; version?: string }
  | { outcome: "too-large" }
  | { outcome: "not-image" }
  | { outcome: "failed" };

/**
 * One picture under the Files root, fetched WITH the pairing token (an `<img src>` cannot carry it)
 * and handed back as a Blob the caller turns into an object URL and revokes. Never through
 * `lib/authed-url.ts`'s table: that one keeps one URL per path for the life of the page, which is
 * right for content-addressed blobs and wrong for a file whose bytes change under one name. An abort
 * rethrows, so a caller that moved on hears nothing.
 */
export async function fetchFileImage(
  target: ChangesTarget,
  path: string,
  scope?: Scope,
  signal?: AbortSignal,
): Promise<FileImageAnswer> {
  try {
    const { blob, headers } = await fetchAuthedAnswer(filesImagePath(target, path, scope), signal);
    const version = fileVersionOf(headers.get("x-collie-file-size"), headers.get("x-collie-file-mtime"));
    return version === null ? { outcome: "image", blob } : { outcome: "image", blob, version };
  } catch (err) {
    if (signal?.aborted) throw err;
    if (err instanceof ApiError && err.status === 413) return { outcome: "too-large" };
    if (err instanceof ApiError && err.status === 415) return { outcome: "not-image" };
    return { outcome: "failed" };
  }
}

/** The most paths one existence check may name: the bridge's `MAX_EXIST_PATHS` (ADR 0088). */
export const FILES_EXIST_MAX = 64;

/**
 * Which of up to {@link FILES_EXIST_MAX} root-relative paths are a file or a folder under the pane's
 * Files root (ADR 0088), so the pane view links only a path that opens. A POST because the paths ride
 * in the body, but a read: it changes nothing, so it takes the read's deadline and stays off the busy
 * bar. Only paths that were asked come back. A refusal or a failure throws, and the caller draws text.
 */
export async function fetchFilesExist(
  paneId: string,
  paths: readonly string[],
  scope?: Scope,
  signal?: AbortSignal,
): Promise<string[]> {
  const got = await doReq<JsonObject>(withScope(`/api/pane/${encodeURIComponent(paneId)}/files/exist`, scope), {
    method: "POST",
    body: JSON.stringify({ paths }),
    signal,
    timeoutMs: GET_TIMEOUT_MS,
  });
  const asked = new Set(paths);
  const exists = Array.isArray(got.exists) ? got.exists : [];
  return exists.map(asJsonString).filter((p): p is string => p !== undefined && asked.has(p));
}

/**
 * Run a write to a pane's input under the poll burst. The burst starts when the request is ISSUED,
 * because the operator is watching the mirror from the tap on, and again when it comes back ok, so
 * the minimum polls it buys start counting at the moment the pane can actually have changed. A write
 * that fails leaves no burst behind that could run forever: a burst ends itself after its minimum
 * and two quiet polls (lib/poll-intent.ts), so the stamp on issue is the whole cost of a failure.
 *
 * This is the one chokepoint: every dialog tap, the key bar and the composer's typed text end in
 * `sendKeys` or `sendReply`, so no call site has to remember to stamp.
 */
async function withSendBurst(paneId: string, write: Promise<ActionResponse>): Promise<ActionResponse> {
  const res = await write;
  if (res.ok) stampSend(paneId);
  return res;
}

export function sendReply(
  paneId: string,
  text: string,
  submit = true,
  scope?: Scope,
  expectedPrompt?: string,
): Promise<ActionResponse> {
  stampSend(paneId);
  return withSendBurst(
    paneId,
    req<ActionResponse>(
      withScope(`/api/pane/${encodeURIComponent(paneId)}/reply`, scope),
      {
        method: "POST",
        // `JSON.stringify` omits an `undefined` property entirely, so an absent binding puts no
        // `expected_prompt` on the wire — byte-identical to not naming the field at all.
        body: JSON.stringify({ text, submit, expected_prompt: expectedPrompt }),
      },
      recoverPromptChanged,
    ),
  );
}

export function sendKeys(
  paneId: string,
  keys: string[],
  scope?: Scope,
  expectedPrompt?: string,
  expectedStyled?: string,
): Promise<ActionResponse> {
  stampSend(paneId);
  // Snapshot what the client has seen NOW, before the key can change anything: `settleAfterSend`
  // waits for a read that differs from it.
  const key = paneScopeKey(scope, paneId);
  const seen = lastSeenText.get(key);
  if (seen === undefined) textBeforeSend.delete(key);
  else remember(textBeforeSend, key, seen);
  return withSendBurst(
    paneId,
    req<ActionResponse>(
      withScope(`/api/pane/${encodeURIComponent(paneId)}/keys`, scope),
      {
        method: "POST",
        // As in `sendReply`: an `undefined` property is omitted by `JSON.stringify`. The bridge honours
        // `expected_styled` only beside `expected_prompt` (ADR 0080 point 7); an older bridge ignores it.
        body: JSON.stringify({ keys, expected_prompt: expectedPrompt, expected_styled: expectedStyled }),
      },
      recoverPromptChanged,
    ),
  );
}

/**
 * "Look now" — ask the bridge to take a fresh reading of its multiplexer before the next poll.
 *
 * A read that mutates nothing (the bridge gates it as one), so it is safe from a read-only device
 * and safe to fire on a page becoming visible. It changes no state on THIS side: what it does is
 * make the very next `revalidate()` see a herd the bridge has just re-read, which under a
 * multiplexer that censuses for topology is the difference between now and up to twelve seconds ago
 * (ADR 0031).
 *
 * Never rejects into a caller's face — a refresh that could not happen leaves the herd exactly as
 * stale as it already was, and every call site's next act is a revalidation that reports the truth
 * anyway. Swallowing it here is what lets a caller write `await refreshNow(); revalidate();` with no
 * ceremony around the first half.
 *
 * **A scope naming a PEER is a no-op, and that is the honest answer rather than a shortcut.** The
 * route is not on the crew link's forwarding table (`bridge/crew/forward.ts`), because what is stale
 * about a peer on the lead's screen is the LEAD's swept copy of it, which the lead refreshes on its
 * own sweep — not the peer's census, which the peer tightens itself the moment the lead forwards a
 * pane read to it. Sending it anyway would spend one legible 501 per foreground to change nothing.
 */
export async function refreshNow(scope?: Scope): Promise<void> {
  if (!isLead(scope)) return;
  try {
    await req<ActionResponse>(withScope("/api/refresh", scope), { method: "POST" });
  } catch {
    // Deliberately silent: see above. The revalidation that follows is the one that reports.
  }
}

/** Close a pane ("kill the agent"). */
export function closePane(paneId: string, scope?: Scope): Promise<ActionResponse> {
  return req<ActionResponse>(withScope(`/api/pane/${encodeURIComponent(paneId)}/close`, scope), {
    method: "POST",
  });
}

/**
 * Show this pane on the OPERATOR's own terminal — the one call in this file that moves a screen
 * nobody is holding.
 *
 * It carries no body: the pane is the whole request. Only ever called from a named tap ("Show in
 * terminal"), never from navigation — see components/pane-actions-sheet.tsx.
 */
export function focusPane(paneId: string, scope?: Scope): Promise<ActionResponse> {
  return req<ActionResponse>(withScope(`/api/pane/${encodeURIComponent(paneId)}/focus`, scope), {
    method: "POST",
  });
}

/** Set (or clear) a pane's label. An empty/blank `label` clears it (the bridge sends `null` on). */
export function renamePane(
  paneId: string,
  label: string,
  scope?: Scope,
): Promise<ActionResponse> {
  return req<ActionResponse>(withScope(`/api/pane/${encodeURIComponent(paneId)}/rename`, scope), {
    method: "POST",
    body: JSON.stringify({ label }),
  });
}

/** Set a tab's label. Non-empty required — a tab has no "clear" (the bridge 400s a blank label). */
export function renameTab(
  tabId: string,
  label: string,
  scope?: Scope,
): Promise<ActionResponse> {
  return req<ActionResponse>(withScope(`/api/tab/${encodeURIComponent(tabId)}/rename`, scope), {
    method: "POST",
    body: JSON.stringify({ label }),
  });
}

/** Close a tab, killing every pane inside it. */
export function closeTab(tabId: string, scope?: Scope): Promise<ActionResponse> {
  return req<ActionResponse>(withScope(`/api/tab/${encodeURIComponent(tabId)}/close`, scope), {
    method: "POST",
  });
}

/** Create a new tab in a space, opening a fresh shell pane. `cwd` omitted = inherits the space dir. */
export function createTab(
  workspaceId: string,
  opts: { label?: string; cwd?: string } = {},
  scope?: Scope,
): Promise<CreateResponse> {
  return req<CreateResponse>(withScope("/api/tab", scope), {
    method: "POST",
    body: JSON.stringify({ workspaceId, ...opts }),
  });
}

/** Create a new space (workspace) with a fresh shell pane. `cwd` omitted = the host's home dir. */
export function createWorkspace(
  opts: { label?: string; cwd?: string } = {},
  scope?: Scope,
): Promise<CreateResponse> {
  return req<CreateResponse>(withScope("/api/workspace", scope), {
    method: "POST",
    body: JSON.stringify(opts),
  });
}

// POST /api/launch — the command string here is an allowlist KEY the bridge must recognise, not an
// arbitrary line the client gets to run. Anything not in `launchers.toml` is a 400 before the
// multiplexer is ever touched, and that lookup is the whole security story of the route. Scoped
// like /api/tab and /api/workspace: the new pane is created where you are looking. The client never
// sends a path — only, optionally, `besidePaneId`, the pane this launch should open a TAB beside
// (the switcher). Omitted, the bridge creates a throwaway Space instead (the dashboard).
/** POST /api/launch's body — a named contract so `launch` below infers against it, not a widened literal. */
interface LaunchRequestBody {
  command: string;
  paneId?: string;
}

export function launch(command: string, besidePaneId?: string, scope?: Scope): Promise<CreateResponse> {
  const body: LaunchRequestBody = { command };
  if (besidePaneId !== undefined) body.paneId = besidePaneId;
  return req<CreateResponse>(withScope("/api/launch", scope), {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * GET /api/launchers — THIS scope's own host's launcher rows, read live off its `launchers.toml`.
 * Never cached alongside `/api/config`: rows must come from the host that runs them, and the
 * operator file is read live on the bridge, so this is fetched on mount and again whenever the
 * scope changes (lib/operator-config.ts's `useLaunchers`).
 */
export function fetchLaunchers(scope?: Scope): Promise<LaunchersResponse> {
  return req<LaunchersResponse>(withScope("/api/launchers", scope));
}

/**
 * What the phone can know about one machine's GitHub work: that machine's answer, or `absent` — it
 * answered 404, so its Collie predates the route (a forwarded older crew member, CREW_PROTOCOL.md
 * §7.1, or an older bridge). Not an outage, and the screen says so: "not available on that machine".
 */
export type GithubWorkAnswer = GithubWorkResponse | { state: "absent" };

/**
 * GET /api/github — the scope's host user's open PRs, review requests and assigned issues, read
 * through that machine's `gh` (ADR 0091). `peek` never makes the bridge run `gh`: it answers `off`,
 * `cold` or what is cached, which is all the dashboard's footer line may ask. `fresh` asks past the
 * bridge's 60 s TTL (the bridge floors it at 10 s and keeps it single-flight). Host-aware through
 * `?host=`, like every scoped read.
 */
export function getGithubWork(
  scope: Scope | undefined,
  opts: { peek?: boolean; fresh?: boolean; signal?: AbortSignal } = {},
): Promise<GithubWorkAnswer> {
  const query = opts.peek ? "?peek=1" : opts.fresh ? "?fresh=1" : "";
  return req<GithubWorkAnswer>(
    withScope(`/api/github${query}`, scope),
    { signal: opts.signal, timeoutMs: GITHUB_TIMEOUT_MS },
    (status) => (status === 404 ? { state: "absent" } : null),
  );
}

/**
 * GET /api/folders — THIS scope's own host's folder list for the new-space sheet (#289), off that
 * machine's `folders.json`. Session-scoped only so `?host=` reaches the machine whose folders they
 * are; the list itself is one per machine. Read when the sheet opens and when its chosen machine
 * changes (lib/folders.ts), never polled and never part of the snapshot.
 */
export function fetchFolders(scope?: Scope): Promise<FoldersResponse> {
  return req<FoldersResponse>(withScope("/api/folders", scope));
}

/** POST /api/folders/star body — a named contract so `starFolder` infers against it. */
interface StarFolderBody {
  folder: string;
  starred: boolean;
}

/**
 * POST /api/folders/star — star (`true`) or unstar (`false`) one folder on THIS scope's host. The
 * bridge refuses a folder that is not already in its lists, so the sheet only ever sends one it read.
 * Answers the whole new list, so the sheet redraws from the bridge's word rather than guessing.
 */
export function starFolder(folder: string, starred: boolean, scope?: Scope): Promise<FoldersResponse> {
  const body: StarFolderBody = { folder, starred };
  return req<FoldersResponse>(withScope("/api/folders/star", scope), {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * GET /api/cache-rules — the catalog behind every cache chip on THIS host, plus its applied overrides.
 *
 * Fetched once per boot, lazily, the first time a cache sheet is opened: the catalog only moves on a
 * release or a `cache-rules.toml` edit, and the route is ETagged, so a re-ask costs a 304. NOT scoped
 * and deliberately not forwarded across the crew link — a peer may hold its own override, so quoting
 * this catalog for a peer's number would cite a page that peer never read. The sheet on a peer's pane
 * says where the number was read instead.
 */
export function fetchCacheRules(): Promise<CacheRulesResponse> {
  return req<CacheRulesResponse>("/api/cache-rules");
}

/** The worktrees of the repo a space sits in. Empty-handed when the space is not in one. */
export function listWorktrees(workspaceId: string, scope?: Scope): Promise<WorktreeListResponse> {
  return req<WorktreeListResponse>(
    withScope(`/api/workspace/${encodeURIComponent(workspaceId)}/worktrees`, scope),
  );
}

/**
 * What a worktree create may carry beyond the branch (ADR 0089). Both are optional, and the
 * dashboard's sheet sends neither, which is the body the route has always taken.
 */
export interface WorktreeCreateExtras {
  /** One id per intent, minted by the phone. A retry with the same id replays, never re-creates. */
  requestId?: string;
  /** A launcher row's `command`, typed into the new shell. Absent is a plain shell. */
  launcher?: string;
}

/** The create's wire body: the branch, plus the two extras when the caller has them. */
interface WorktreeCreateBody {
  branch: string;
  requestId?: string;
  launcher?: string;
}

/** Create a worktree on a new branch and open it as its own space, optionally starting an agent in it. */
export function createWorktree(
  workspaceId: string,
  branch: string,
  scope?: Scope,
  extras: WorktreeCreateExtras = {},
): Promise<WorktreeCreateResponse> {
  const body: WorktreeCreateBody = { branch };
  if (extras.requestId !== undefined) body.requestId = extras.requestId;
  if (extras.launcher !== undefined) body.launcher = extras.launcher;
  return req<WorktreeCreateResponse>(
    withScope(`/api/workspace/${encodeURIComponent(workspaceId)}/worktree`, scope),
    { method: "POST", body: JSON.stringify(body), timeoutMs: WORKTREE_TIMEOUT_MS },
  );
}

/** Show a worktree that already exists. Answers `alreadyOpen` rather than refusing. */
export function openWorktree(
  workspaceId: string,
  path: string,
  scope?: Scope,
): Promise<WorktreeOpenResponse> {
  return req<WorktreeOpenResponse>(
    withScope(`/api/workspace/${encodeURIComponent(workspaceId)}/worktree/open`, scope),
    { method: "POST", body: JSON.stringify({ path }), timeoutMs: WORKTREE_TIMEOUT_MS },
  );
}


/**
 * The bridge's startup config: push setup, the build id, the operator's own rows, and the
 * multiplexer's declared capabilities (M10/06 — read them through lib/mux-capability.ts, never by
 * reaching into `mux.name`).
 *
 * Read once per page load by lib/operator-config.ts, which is the only caller that should exist:
 * every field here is startup-resolved on the bridge, so a second channel would be a second answer
 * to the same question.
 *
 * `scope` names ONE MEMBER of the crew, and then the only field that differs is `mux`: the lead
 * answers that member's own capability declaration, from what its last `hello` taught it, and every
 * other field stays the lead's own (M22/03). It is NOT forwarded to the member, so this read cannot
 * make the lead dial a machine. Absent, which is every solo install and every lead-scoped read, puts
 * nothing on the wire and gets the byte-identical body it always did.
 */
export function fetchConfig(scope?: Scope): Promise<BridgeConfig> {
  // A poll read: the connection strip's probe asks it while the strip is red.
  return req<BridgeConfig>(withScope("/api/config", scope), { timeoutMs: POLL_TIMEOUT_MS });
}

/** Register push through the same timeout, authentication and error handling as the other APIs. */
export function registerPushSubscription(body: SubscribeBody): Promise<void> {
  return req<void>("/api/subscribe", { method: "POST", body: JSON.stringify(body) });
}

/**
 * Set (or clear) the global notification snooze. `snoozedUntil` is an epoch-ms deadline; `null`
 * resumes immediately. Affects every device — it's a quiet-hours switch, not a per-device toggle.
 */
export function setSnooze(snoozedUntil: number | null): Promise<{ snoozedUntil: number | null }> {
  return req<{ snoozedUntil: number | null }>("/api/notifications/snooze", {
    method: "POST",
    body: JSON.stringify({ snoozedUntil }),
  });
}

/** Fetch the bridge-wide notification-type preferences (which agent statuses push). */
export function getNotifyPrefs(): Promise<NotifyPrefs> {
  return req<NotifyPrefs>("/api/notifications/prefs");
}

/**
 * Update the notification-type preferences with a partial patch (only the keys you send change).
 * Bridge-wide — it affects every device, like the snooze. Returns the merged prefs.
 */
export function setNotifyPrefs(patch: Partial<NotifyPrefs>): Promise<NotifyPrefs> {
  return req<NotifyPrefs>("/api/notifications/prefs", {
    method: "POST",
    body: JSON.stringify(patch),
  });
}

/**
 * One pane's place in the prompt-cache watch list (ADR 0042).
 *
 * The scope names the machine the PANE lives on; the preference itself always lands on the collie this
 * phone is talking to, because that is the only machine holding a push subscription. So this call is
 * never forwarded, and `?host=` here is an argument rather than an address.
 */
export function getCacheWatch(paneId: string, scope?: Scope): Promise<CacheWatchState> {
  return req<CacheWatchState>(withScope(`/api/notifications/cache-watch?pane=${encodeURIComponent(paneId)}`, scope));
}

/** Switch this pane's warning on or off. Returns the same body the read returns, after the write. */
export function setCacheWatch(paneId: string, on: boolean, scope?: Scope): Promise<CacheWatchState> {
  return req<CacheWatchState>(
    withScope(`/api/notifications/cache-watch?pane=${encodeURIComponent(paneId)}`, scope),
    { method: "POST", body: JSON.stringify({ on }) },
  );
}

/** The whole bridge's watch list, for the Settings card. Not one pane's, and not scoped. */
export function getCacheWatchList(): Promise<CacheWatchListResponse> {
  return req<CacheWatchListResponse>("/api/notifications/cache-watch/list");
}

/**
 * Drop one entry by its opaque id, and get the list back.
 *
 * The id is the only address removal has: an entry whose pane is gone cannot be un-watched by the
 * per-pane call, which needs a live `(host, session, paneId)`.
 */
export function forgetCacheWatch(id: string): Promise<CacheWatchListResponse> {
  return req<CacheWatchListResponse>("/api/notifications/cache-watch/forget", {
    method: "POST",
    body: JSON.stringify({ id }),
  });
}

/**
 * Force an immediate upstream update check and return the fresh UpdateInfo. Read-level gated (same
 * auth basis as the prefs/snooze POSTs) and takes no body. The bridge otherwise only checks every
 * few hours, so this can take a beat — it rides the mutation timeout budget like the other POSTs.
 */
export function checkForUpdates(): Promise<UpdateInfo> {
  return req<UpdateInfo>("/api/update/check", { method: "POST" });
}

/**
 * The update card's read: the same status the snapshot carries, plus the PREFLIGHT that decides
 * whether the update button is live and what it says when it is not (M15/05).
 *
 * A GET, and read-gated: it starts nothing and takes no upstream look, so it is safe to poll. The
 * preflight behind it is cached on the bridge, so polling it costs one `collie update --check` a
 * minute at most.
 */
export function fetchUpdateState(signal?: AbortSignal): Promise<UpdateCheckResponse> {
  return req<UpdateCheckResponse>("/api/update/check", signal ? { signal } : undefined);
}

/**
 * Start an update — one tap plus one confirm, and this is what the confirm sends.
 *
 * `target` is the version the operator READ about on the card. The bridge refuses if that is no
 * longer what it would install, so a card left open overnight cannot consent to a version nobody
 * read about. `major` is the second consent, and only a major crossing takes one (ADR 0020).
 *
 * WRITE-gated, exactly like typing into a pane. A refusal is a throw carrying the bridge's own code
 * (`update.in_progress`, `update.preflight_red`, `update.major_confirm_required`, …) — the caller
 * renders it through `lib/api-error-message.ts` like every other refusal.
 */
/** The body `POST /api/update` takes. Named, so `peersOnly` has an owner rather than being widened
 *  in at the call site — and so a bridge that predates the field is simply never sent it. */
interface UpdateStartBody {
  confirm: true;
  target: string;
  major: boolean;
  peersOnly?: true;
}

export function startUpdate(a: {
  target: string;
  major: boolean;
  /**
   * "Retry crew update": a new run whose only legs are the peers (M16/04). Sent only when true, so
   * the ordinary confirm's body is byte-identical to the one that shipped and a bridge that does
   * not know the field yet is never handed it.
   */
  peersOnly?: boolean;
}): Promise<UpdateStartResponse> {
  const body: UpdateStartBody = { confirm: true, target: a.target, major: a.major };
  if (a.peersOnly === true) body.peersOnly = true;
  return req<UpdateStartResponse>("/api/update", { method: "POST", body: JSON.stringify(body) });
}

/** "Remind me next digest" — the card's dismiss. Not a mute: the banner keeps showing. */
export function snoozeUpdate(): Promise<UpdateInfo> {
  return req<UpdateInfo>("/api/update/snooze", { method: "POST" });
}

/**
 * The update band was closed, for the version it named — the band's own dismiss (M17/08).
 *
 * The version goes to the BRIDGE rather than to this browser's storage, so the decision holds
 * wherever the band is read next. `scope` says WHICH band: `offer` is a release available on this
 * machine, and closing it snoozes the digest for that version too; `crew` is the quiet notice about
 * a machine a package manager owns, and closing it touches no push. Not a mute either way — a newer
 * version is a different fact and raises the band again.
 */
export function dismissUpdate(version: string, scope: DismissScope = "offer"): Promise<UpdateInfo> {
  return req<UpdateInfo>("/api/update/dismiss", {
    method: "POST",
    body: JSON.stringify({ version, scope }),
  });
}

/**
 * The run record from the STANDBY door (`GET /standby/update`), for the window in which the front
 * door is not answering because the update is restarting it.
 *
 * Same-origin, because that is the deployment this can help in: a failover proxy publishes
 * `/standby/*` beside the app (CREW_PROTOCOL.md §18.15, and `lib/sw-routes.ts` keeps the service
 * worker's hands off it). Everywhere else it simply fails, which is exactly what the caller already
 * handles — the card treats a failed poll during `restarting` as expected either way.
 */
export function fetchStandbyRun(signal?: AbortSignal): Promise<UpdateRun> {
  return req<UpdateRun>("/standby/update", signal ? { signal } : undefined);
}

// ── Device pairing ───────────────────────────────────────────────────────────────────────────────

/** A successful claim (the token, returned exactly once) or the bridge's named reason for refusing. */
export type PairResult =
  | { ok: true; token: string; label: string }
  | { ok: false; reason: PairFailure };

/**
 * A refused claim is a NORMAL answer, not a transport failure — the operator mistyped a code, or
 * never minted one — so it is recovered into a value the pairing card can render a sentence for,
 * exactly like the reply/keys 409. Anything other than a well-formed 400 still throws.
 */
const PAIR_FAILURES: readonly PairFailure[] = [
  "no-pending",
  "expired",
  "exhausted",
  "bad-code",
  "duplicate-label",
  "bad-request",
];

const recoverPairFailure: Recover<{ ok: false; reason: PairFailure }> = (status, detail) => {
  if (status !== 400) return null;
  // A non-JSON 400 body, or one with no `error` string, falls through to the usual ApiError.
  const body = parseJsonObject(detail);
  if (!body) return null;
  const named = asJsonString(body.error);
  if (named === undefined) return null;
  // A refusal this build doesn't know the name of is still a refusal, not a transport failure: it
  // reads as the bridge's own catch-all so the card says something actionable. (Left as the raw
  // string, `failureText`'s exhaustive switch returned `undefined` and the card said nothing.)
  return { ok: false, reason: PAIR_FAILURES.find((f) => f === named) ?? "bad-request" };
};

/**
 * Claim the code `bin/collie pair` printed on the host and enrol this device under `label`.
 *
 * The bootstrap: same-origin gated like every other POST, but deliberately gated by NEITHER the
 * pairing nor the device-header check — it is the one door an unpaired phone can walk through. The
 * token in the reply exists exactly once; store it (lib/pairing.ts) or lose it.
 */
export async function pairDevice(code: string, label: string): Promise<PairResult> {
  const res = await req<{ token: string; label: string } | { ok: false; reason: PairFailure }>(
    "/api/pair",
    { method: "POST", body: JSON.stringify({ code, label }) },
    recoverPairFailure,
  );
  return "token" in res ? { ok: true, token: res.token, label: res.label } : res;
}

/**
 * The paired-device registry. Read-level, and like every read it needs the token (ADR 0086): an
 * unpaired device learns that it is unpaired from the 403 itself (`isPairingRefusal`).
 */
export function fetchDevices(signal?: AbortSignal): Promise<DevicesResponse> {
  return req<DevicesResponse>("/api/devices", { signal });
}

/**
 * The crew census (`GET /api/crew`). Read-level, like the snapshot — looking at who is in the crew
 * needs no token; changing it is a CLI verb and has no endpoint here at all.
 *
 * Carries NO scope: the question is "what does this collie lead", and only a lead can answer it. A
 * solo collie and a peer both refuse with 404, which the loader reads as "no crew" rather than as a
 * failure — so this throws for that case exactly as it does for any other refusal, and the branch
 * lives at the one call site that knows what a 404 means here (lib/loaders.ts `crewLoader`).
 */
export function fetchCrew(signal?: AbortSignal): Promise<CrewStatusResponse> {
  return req<CrewStatusResponse>("/api/crew", { signal });
}

/**
 * The machines census (`GET /api/machines`): every machine's load now, its alert rules and which
 * rules are firing. Read-level, never forwarded, and carries no scope: a lead (or a solo collie)
 * answers for the whole crew, and a peer refuses with 404, which `machinesLoader` reads as "nothing
 * to show here" rather than as a failure.
 */
export function fetchMachines(signal?: AbortSignal, opts: { spark?: number } = {}): Promise<MachinesResponse> {
  // `?spark=N` adds each row's last N complete minutes for the small charts; without it the answer is
  // the plain census.
  const query = opts.spark === undefined ? "" : `?spark=${opts.spark}`;
  return req<MachinesResponse>(`/api/machines${query}`, { signal });
}

/**
 * One machine's last 24 hours at one point per minute (`GET /api/machines/:id/history`). With
 * `since`, only the minutes starting at or after it: the page reads the day once, then only what it
 * has not seen.
 */
export function fetchMachineHistory(id: string, signal?: AbortSignal, since?: number): Promise<MachineHistoryResponse> {
  const query = since === undefined ? "" : `?since=${Math.max(0, Math.floor(since))}`;
  return req<MachineHistoryResponse>(`/api/machines/${encodeURIComponent(id)}/history${query}`, { signal });
}

/**
 * Replace one machine's alert rules. The body is the WHOLE `MachineAlerts` object: a missing key
 * removes that rule. Returns the rules as the bridge stored them.
 */
export function setMachineAlerts(id: string, alerts: MachineAlerts): Promise<{ alerts: MachineAlerts }> {
  return req<{ alerts: MachineAlerts }>(`/api/machines/${encodeURIComponent(id)}/alerts`, {
    method: "POST",
    body: JSON.stringify(alerts),
  });
}

/**
 * Revoke a paired device by label, returning the registry as it now stands. WRITE-level, so it needs
 * this device's own token — including when the label being revoked IS this device, which is allowed
 * and self-unpairs (the caller drops the local token afterwards).
 */
export function revokeDevice(label: string): Promise<DevicesResponse> {
  return req<DevicesResponse>("/api/devices/revoke", {
    method: "POST",
    body: JSON.stringify({ label }),
  });
}

/**
 * Upload an attachment — an image or a text file; the bridge saves it to a host file and returns the
 * path to reference in a message. Uses multipart/form-data (NOT the JSON `req` helper — the browser
 * sets the boundary). What the host will actually take is `/api/config`'s `upload` block, and
 * lib/attachments.ts is where the phone reads it.
 */
export function uploadFile(paneId: string, file: File, scope?: Scope): Promise<UploadResponse> {
  // Multipart, so it bypasses `req` (the browser sets the boundary) — track it explicitly instead.
  return trackBusy(
    (async () => {
      const fd = new FormData();
      fd.append("file", file);
      const res = await apiFetch(withScope(`/api/pane/${encodeURIComponent(paneId)}/upload`, scope), {
        method: "POST",
        body: fd,
        // No content-type: the browser sets the multipart boundary. The XHR marker still applies —
        // an upload refused by a lapsed proxy session must surface as a status, not a redirect.
        headers: { [XHR_HEADER]: XHR_HEADER_VALUE, ...authHeader() },
        signal: withTimeout(undefined, UPLOAD_TIMEOUT_MS),
      });
      if (!res.ok) {
        const detail = await errorDetail(res);
        notePairing("POST", res.status, detail);
        throw new ApiError(`upload → ${res.status} ${detail}`, res.status, parseApiErrorFields(detail));
      }
      notePairing("POST", res.status);
      // SAFETY: a 200 on `/api/pane/:id/upload` is the bridge's own `UploadResponse` by contract;
      // every non-ok answer threw above.
      return (await res.json()) as UploadResponse;
    })(),
  );
}

/**
 * One transcription attempt. A refusal is a VALUE here, not a throw — see {@link transcribeAudio}.
 *
 * The refusal carries the bridge's `code`/`detail` beside its status: the status alone cannot tell
 * "the recording is empty" from "the recording could not be read" (both 400), which is the reason
 * `bridge/stt/http.ts` codes them separately. `status` stays, because it is still what an OLDER
 * bridge — one that sends no code — is judged by.
 */
export type SttResult =
  | { ok: true; text: string }
  | {
      ok: false;
      status: number;
      error: string | null;
      code?: string;
      detail?: ApiErrorDetail;
    };

/**
 * Send one recorded clip to `POST /api/stt` and get its transcript (ADR 0029).
 *
 * The body is RAW AUDIO BYTES and the `Content-Type` names the container — no multipart envelope,
 * because there is exactly one thing to send (bridge/stt/http.ts says the same from its side). It
 * is pane-agnostic: audio is not terminal state, so no scope goes on the wire.
 *
 * Unlike every other call here it RESOLVES on a refusal instead of throwing. Each failure status
 * earns its own operator-facing sentence (lib/stt.ts `sttErrorMessage`), and a thrown ApiError
 * carries its status only inside a formatted message — so the status is returned as a value, and
 * only a transport failure (offline, timeout) still throws.
 */
export function transcribeAudio(audio: Blob, signal?: AbortSignal): Promise<SttResult> {
  // Announced to the connection-health store for the whole call, and released in the `finally`
  // below on every path — success, refusal, abort. While it is in flight the app stops polling and
  // stops escalating: the link is not failing, it is carrying this (see lib/connection-health).
  beginLongUpload();
  return trackBusy(
    (async () => {
      const res = await apiFetch("/api/stt", {
        method: "POST",
        body: audio,
        headers: {
          // The recorder's own container, which is the one thing the bridge needs in order to name
          // a demuxer. Its codec parameter rides along; the bridge splits it off.
          "content-type": audio.type || "audio/webm",
          [XHR_HEADER]: XHR_HEADER_VALUE,
          ...authHeader(),
        },
        signal: withTimeout(signal, sttTimeoutFor(audio.size)),
      });
      const detail = await errorDetail(res);
      notePairing("POST", res.status, res.ok ? undefined : detail);
      const body = parseJsonObject(detail);
      const text = body === undefined ? undefined : asJsonString(body.text);
      if (res.ok && text !== undefined) return { ok: true as const, text };
      const error = body === undefined ? null : (asJsonString(body.error) ?? null);
      // The same fields every other refusal now carries, read off the same body — so the composer's
      // one line can be the translated sentence rather than the bridge's English one.
      const fields = parseApiErrorFields(detail);
      // A 200 whose body is not the documented shape is still a failure, and one the operator can do
      // nothing about — report it as the bridge's own status rather than inventing a transcript.
      return {
        ok: false as const,
        status: res.ok ? 502 : res.status,
        error,
        code: fields?.code,
        detail: fields?.detail,
      };
    })().finally(endLongUpload),
  );
}
