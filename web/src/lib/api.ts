// Thin REST client for the bridge. Everything is same-origin, so credentials/headers are
// minimal. Each call throws on a non-2xx so callers (route loaders / action handlers) surface errors.

import { trackBusy } from "./busy";
import { markLive } from "./connection-health";
import { observeServerBuild, SERVER_BUILD_HEADER } from "./server-build";
import type {
  ActionResponse,
  BridgeConfig,
  CreateResponse,
  NotifyPrefs,
  PaneReadResponse,
  SnapshotResponse,
  UpdateInfo,
  UploadResponse,
} from "./types";

export type { NotifyPrefs, UpdateInfo };

class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
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
  if (typeof AbortSignal.timeout !== "function") return signal ?? undefined;
  const timeoutSignal = AbortSignal.timeout(ms);
  if (!signal) return timeoutSignal;
  if (typeof AbortSignal.any !== "function") return signal;
  return AbortSignal.any([signal, timeoutSignal]);
}

// Append the `session=<name>` query param to an API path, composing with any query already present
// (fetchPane carries `?lines=`). The browser URL uses the short `?s=`; on the wire it's `session=`.
// Blank / absent session → the primary session, so the path is returned untouched (no param).
function withSession(path: string, session?: string): string {
  const s = session?.trim();
  if (!s) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}session=${encodeURIComponent(s)}`;
}

// Best-effort human-readable failure detail: the response body if present, else the status text.
async function errorDetail(res: Response): Promise<string> {
  try {
    return (await res.text()) || res.statusText;
  } catch {
    return res.statusText;
  }
}

// Capture the bridge's build id off any response that carries it. Every poll (snapshot/pane) — and
// config + mutations — funnels through the two fetch sites below, so the store stays current for
// free, powering the no-service-worker self-updater (lib/self-update.ts). Absent header (older
// bridge) → no-op, so nothing activates.
function captureBuild(res: Response): void {
  observeServerBuild(res.headers.get(SERVER_BUILD_HEADER));
}

async function doReq<T>(path: string, init?: RequestInit): Promise<T> {
  // GET reads get the short leash; anything mutating gets the longer mutation budget.
  const method = init?.method?.toUpperCase() ?? "GET";
  const timeoutMs = method === "GET" ? GET_TIMEOUT_MS : MUTATION_TIMEOUT_MS;
  const res = await fetch(path, {
    ...init,
    signal: withTimeout(init?.signal, timeoutMs),
    headers: { "content-type": "application/json", ...init?.headers },
  });
  captureBuild(res);
  if (!res.ok) {
    throw new ApiError(`${path} → ${res.status} ${await errorDetail(res)}`, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// Every mutating request (non-GET) feeds the app-wide busy signal so the top progress bar shows
// while it's in flight; GET reads (snapshot/config polling) don't, or the bar would never rest.
// trackBusy increments synchronously, so a caller sees `isBusy()` true the instant it fires.
function req<T>(path: string, init?: RequestInit): Promise<T> {
  const op = doReq<T>(path, init);
  const method = init?.method?.toUpperCase() ?? "GET";
  return method === "GET" ? op : trackBusy(op);
}

export async function fetchSnapshot(
  session?: string,
  signal?: AbortSignal,
): Promise<SnapshotResponse> {
  const snap = await req<SnapshotResponse>(withSession("/api/snapshot", session), { signal });
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
  session?: string,
  signal?: AbortSignal,
): Promise<PaneReadResponse> {
  const q = lines ? `?lines=${lines}` : "";
  const url = withSession(`/api/pane/${encodeURIComponent(paneId)}${q}`, session);
  // Pane ids are per-session (each session is a separate Herdr server), so the ETag/body cache must
  // be keyed by session too — otherwise a "w1:p1" in one session would 304 into another's mirror.
  const cacheKey = `${session ?? ""}\u0000${paneId}`;

  const cached = paneCache.get(cacheKey);
  const headers: Record<string, string> = {};
  if (cached) headers["if-none-match"] = cached.etag;

  const res = await fetch(url, { signal: withTimeout(signal, GET_TIMEOUT_MS), headers });
  captureBuild(res); // pane polls carry the build header too (incl. 304s) — keep the store fresh

  if (res.status === 304 && cached) {
    // Unchanged — hand back the cached body (text included) so the mirror keeps its content. An
    // unchanged poll is still a live poll: stamp the connection-health anchor (a 304 counts as live).
    markLive();
    return { ...cached.response, notModified: true };
  }

  if (!res.ok) {
    throw new ApiError(`${url} → ${res.status} ${await errorDetail(res)}`, res.status);
  }

  // Parse the body BEFORE recording the ETag, so the cache only ever holds an (etag, text) pair
  // that actually arrived intact.
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

export function sendReply(
  paneId: string,
  text: string,
  submit = true,
  session?: string,
): Promise<ActionResponse> {
  return req<ActionResponse>(withSession(`/api/pane/${encodeURIComponent(paneId)}/reply`, session), {
    method: "POST",
    body: JSON.stringify({ text, submit }),
  });
}

export function sendKeys(paneId: string, keys: string[], session?: string): Promise<ActionResponse> {
  return req<ActionResponse>(withSession(`/api/pane/${encodeURIComponent(paneId)}/keys`, session), {
    method: "POST",
    body: JSON.stringify({ keys }),
  });
}

/** Close a pane ("kill the agent"). */
export function closePane(paneId: string, session?: string): Promise<ActionResponse> {
  return req<ActionResponse>(withSession(`/api/pane/${encodeURIComponent(paneId)}/close`, session), {
    method: "POST",
  });
}

/** Create a new tab in a space, opening a fresh shell pane. `cwd` omitted = inherits the space dir. */
export function createTab(
  workspaceId: string,
  opts: { label?: string; cwd?: string } = {},
  session?: string,
): Promise<CreateResponse> {
  return req<CreateResponse>(withSession("/api/tab", session), {
    method: "POST",
    body: JSON.stringify({ workspaceId, ...opts }),
  });
}

/** Create a new space (workspace) with a fresh shell pane. `cwd` omitted = the host's home dir. */
export function createWorkspace(
  opts: { label?: string; cwd?: string } = {},
  session?: string,
): Promise<CreateResponse> {
  return req<CreateResponse>(withSession("/api/workspace", session), {
    method: "POST",
    body: JSON.stringify(opts),
  });
}

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

/**
 * Upload an image; the bridge saves it to a host file and returns the path to reference in a
 * message. Uses multipart/form-data (NOT the JSON `req` helper — the browser sets the boundary).
 */
export function uploadImage(paneId: string, file: File, session?: string): Promise<UploadResponse> {
  // Multipart, so it bypasses `req` (the browser sets the boundary) — track it explicitly instead.
  return trackBusy(
    (async () => {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(withSession(`/api/pane/${encodeURIComponent(paneId)}/upload`, session), {
        method: "POST",
        body: fd,
        signal: withTimeout(undefined, UPLOAD_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new ApiError(`upload → ${res.status} ${await errorDetail(res)}`, res.status);
      }
      return (await res.json()) as UploadResponse;
    })(),
  );
}
