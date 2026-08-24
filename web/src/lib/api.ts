// Thin REST client for the bridge. Everything is same-origin, so credentials/headers are
// minimal. Each call throws on a non-2xx so callers (route loaders / action handlers) surface errors.

import { parseApiErrorFields, type ApiErrorDetail, type ApiErrorFields } from "./api-error-codes";
import { trackBusy } from "./busy";
import { markLive } from "./connection-health";
import { abortSignalAfter, abortSignalAny } from "./env";
import { asJsonString, parseJsonObject } from "./json";
import { authHeader, clearNotPaired, markNotPaired, NOT_PAIRED_BODY } from "./pairing";
import { isLead, normalizeScope, paneScopeKey, type Scope } from "./scope";
import { observeServerBuild, SERVER_BUILD_HEADER } from "./server-build";
import type {
  ActionResponse,
  BridgeConfig,
  CreateResponse,
  DevicesResponse,
  NotifyPrefs,
  PaneHistoryResponse,
  PaneReadResponse,
  PairFailure,
  SnapshotResponse,
  UpdateInfo,
  UploadResponse,
} from "./types";

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
//   - Mutations drive a real terminal on the host, which can legitimately take a beat — more slack.
const MUTATION_TIMEOUT_MS = 20_000;
//   - Uploads carry a whole file over the phone's uplink — the most generous budget.
const UPLOAD_TIMEOUT_MS = 60_000;

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

// Best-effort human-readable failure detail: the response body if present, else the status text.
async function errorDetail(res: Response): Promise<string> {
  try {
    return (await res.text()) || res.statusText;
  } catch {
    return res.statusText;
  }
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
  return { ok: false, error, code: "prompt_changed" };
}

/**
 * Read the pairing gate's verdict off a finished request, at the one place every request passes.
 *
 * Only a WRITE can discover that this device is unpaired — reads are ungated — so the refusal latch
 * is set here, from the bridge's own 403 body, and cleared by the opposite proof: a mutation that
 * actually went through. GETs say nothing either way and are ignored on both counts.
 */
function notePairing(method: string, status: number, detail?: string): void {
  if (method === "GET") return;
  if (status === 403 && detail?.trim() === NOT_PAIRED_BODY) {
    markNotPaired();
    return;
  }
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

async function doReq<T>(path: string, init?: RequestInit, recover?: Recover<T>): Promise<T> {
  // GET reads get the short leash; anything mutating gets the longer mutation budget.
  const method = init?.method?.toUpperCase() ?? "GET";
  const timeoutMs = method === "GET" ? GET_TIMEOUT_MS : MUTATION_TIMEOUT_MS;
  const res = await fetch(path, {
    ...init,
    signal: withTimeout(init?.signal, timeoutMs),
    headers: {
      "content-type": "application/json",
      [XHR_HEADER]: XHR_HEADER_VALUE,
      // The device credential, injected once for every JSON request rather than plumbed per call.
      // Absent header when this device holds no token — which is exactly right for a bridge with
      // nothing paired, and for the bootstrap POST /api/pair that mints the first one.
      ...authHeader(),
      ...init?.headers,
    },
  });
  captureBuild(res);
  if (!res.ok) {
    const detail = await errorDetail(res);
    notePairing(method, res.status, detail);
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
function req<T>(path: string, init?: RequestInit, recover?: Recover<T>): Promise<T> {
  const op = doReq<T>(path, init, recover);
  const method = init?.method?.toUpperCase() ?? "GET";
  return method === "GET" ? op : trackBusy(op);
}

export async function fetchSnapshot(
  scope?: Scope,
  signal?: AbortSignal,
): Promise<SnapshotResponse> {
  const snap = await req<SnapshotResponse>(withScope("/api/snapshot", scope), { signal });
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

export async function fetchPane(
  paneId: string,
  lines?: number,
  scope?: Scope,
  signal?: AbortSignal,
): Promise<PaneReadResponse> {
  const q = lines ? `?lines=${lines}` : "";
  const url = withScope(`/api/pane/${encodeURIComponent(paneId)}${q}`, scope);
  // Pane ids are unique only within one session on one machine (each session is its own Herdr
  // server; each pack member is its own machine again), so the ETag/body cache is keyed by the full
  // (host, session, paneId) triple — otherwise a "w1:p1" in one session, or on one host, would 304
  // into another's mirror. Shared with the loaders' caches via lib/scope, so the two can't drift.
  const cacheKey = paneScopeKey(scope, paneId);

  const cached = paneCache.get(cacheKey);
  // SEEN_HEADER is what tells the bridge this read came from our own page and may mark the pane
  // seen. A cross-site no-cors GET can't set a custom header, so it can't clear your alerts by
  // guessing pane ids (bridge/server.ts → marksPaneSeen).
  const headers = new Headers({
    "x-collie-seen": "1",
    [XHR_HEADER]: XHR_HEADER_VALUE,
    // A read needs no token, but the bridge stamps `lastSeenAt` off whatever it resolves — so a
    // paired device's polls are what keep its "last seen" honest. Same injection point as `doReq`.
    ...authHeader(),
  });
  if (cached) headers.set("if-none-match", cached.etag);

  const res = await fetch(url, { signal: withTimeout(signal, GET_TIMEOUT_MS), headers });
  captureBuild(res); // pane polls carry the build header too (incl. 304s) — keep the store fresh

  if (res.status === 304 && cached) {
    // Unchanged — hand back the cached body (text included) so the mirror keeps its content. An
    // unchanged poll is still a live poll: stamp the connection-health anchor (a 304 counts as live).
    markLive();
    return { ...cached.response, notModified: true };
  }

  if (!res.ok) {
    const detail = await errorDetail(res);
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

export function sendReply(
  paneId: string,
  text: string,
  submit = true,
  scope?: Scope,
  expectedPrompt?: string,
): Promise<ActionResponse> {
  return req<ActionResponse>(
    withScope(`/api/pane/${encodeURIComponent(paneId)}/reply`, scope),
    {
      method: "POST",
      // `JSON.stringify` omits an `undefined` property entirely, so an absent binding puts no
      // `expected_prompt` on the wire — byte-identical to not naming the field at all.
      body: JSON.stringify({ text, submit, expected_prompt: expectedPrompt }),
    },
    recoverPromptChanged,
  );
}

export function sendKeys(
  paneId: string,
  keys: string[],
  scope?: Scope,
  expectedPrompt?: string,
): Promise<ActionResponse> {
  return req<ActionResponse>(
    withScope(`/api/pane/${encodeURIComponent(paneId)}/keys`, scope),
    {
      method: "POST",
      // As in `sendReply`: an `undefined` property is omitted by `JSON.stringify`.
      body: JSON.stringify({ keys, expected_prompt: expectedPrompt }),
    },
    recoverPromptChanged,
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
 * route is not on the pack link's forwarding table (`bridge/pack/forward.ts`), because what is stale
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

/**
 * The bridge's startup config: push setup, the build id, the operator's own rows, and the
 * multiplexer's declared capabilities (M10/06 — read them through lib/mux-capability.ts, never by
 * reaching into `mux.name`).
 *
 * Read once per page load by lib/operator-config.ts, which is the only caller that should exist:
 * every field here is startup-resolved on the bridge, so a second channel would be a second answer
 * to the same question.
 */
export function fetchConfig(): Promise<BridgeConfig> {
  return req<BridgeConfig>("/api/config");
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
 * Force an immediate upstream update check and return the fresh UpdateInfo. Read-level gated (same
 * auth basis as the prefs/snooze POSTs) and takes no body. The bridge otherwise only checks every
 * few hours, so this can take a beat — it rides the mutation timeout budget like the other POSTs.
 */
export function checkForUpdates(): Promise<UpdateInfo> {
  return req<UpdateInfo>("/api/update/check", { method: "POST" });
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

/** The paired-device registry. Read-level, so an unpaired device may ask (and learn it is unpaired). */
export function fetchDevices(signal?: AbortSignal): Promise<DevicesResponse> {
  return req<DevicesResponse>("/api/devices", { signal });
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
 * Upload an image; the bridge saves it to a host file and returns the path to reference in a
 * message. Uses multipart/form-data (NOT the JSON `req` helper — the browser sets the boundary).
 */
export function uploadImage(paneId: string, file: File, scope?: Scope): Promise<UploadResponse> {
  // Multipart, so it bypasses `req` (the browser sets the boundary) — track it explicitly instead.
  return trackBusy(
    (async () => {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(withScope(`/api/pane/${encodeURIComponent(paneId)}/upload`, scope), {
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
  return trackBusy(
    (async () => {
      const res = await fetch("/api/stt", {
        method: "POST",
        body: audio,
        headers: {
          // The recorder's own container, which is the one thing the bridge needs in order to name
          // a demuxer. Its codec parameter rides along; the bridge splits it off.
          "content-type": audio.type || "audio/webm",
          [XHR_HEADER]: XHR_HEADER_VALUE,
          ...authHeader(),
        },
        signal: withTimeout(signal, UPLOAD_TIMEOUT_MS),
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
    })(),
  );
}
