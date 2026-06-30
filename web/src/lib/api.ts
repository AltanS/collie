// Thin REST client for the bridge. Everything is same-origin, so credentials/headers are
// minimal. Each call throws on a non-2xx so callers (route loaders / action handlers) surface errors.

import type {
  ActionResponse,
  BridgeConfig,
  CreateResponse,
  PaneReadResponse,
  SnapshotResponse,
  UploadResponse,
} from "./types";

class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

// Best-effort human-readable failure detail: the response body if present, else the status text.
async function errorDetail(res: Response): Promise<string> {
  try {
    return (await res.text()) || res.statusText;
  } catch {
    return res.statusText;
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    throw new ApiError(`${path} → ${res.status} ${await errorDetail(res)}`, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function fetchSnapshot(signal?: AbortSignal): Promise<SnapshotResponse> {
  return req<SnapshotResponse>("/api/snapshot", { signal });
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

export async function fetchPane(
  paneId: string,
  lines?: number,
  signal?: AbortSignal,
): Promise<PaneReadResponse> {
  const q = lines ? `?lines=${lines}` : "";
  const url = `/api/pane/${encodeURIComponent(paneId)}${q}`;

  const cached = paneCache.get(paneId);
  const headers: Record<string, string> = {};
  if (cached) headers["if-none-match"] = cached.etag;

  const res = await fetch(url, { signal, headers });

  if (res.status === 304 && cached) {
    // Unchanged — hand back the cached body (text included) so the mirror keeps its content.
    return { ...cached.response, notModified: true };
  }

  if (!res.ok) {
    throw new ApiError(`${url} → ${res.status} ${await errorDetail(res)}`, res.status);
  }

  // Parse the body BEFORE recording the ETag, so the cache only ever holds an (etag, text) pair
  // that actually arrived intact.
  const data = (await res.json()) as PaneReadResponse;
  const etag = res.headers.get("etag");
  if (etag) paneCache.set(paneId, { etag, response: data });

  return data;
}

export function sendReply(
  paneId: string,
  text: string,
  submit = true,
): Promise<ActionResponse> {
  return req<ActionResponse>(`/api/pane/${encodeURIComponent(paneId)}/reply`, {
    method: "POST",
    body: JSON.stringify({ text, submit }),
  });
}

export function sendKeys(paneId: string, keys: string[]): Promise<ActionResponse> {
  return req<ActionResponse>(`/api/pane/${encodeURIComponent(paneId)}/keys`, {
    method: "POST",
    body: JSON.stringify({ keys }),
  });
}

/** Close a pane ("kill the agent"). */
export function closePane(paneId: string): Promise<ActionResponse> {
  return req<ActionResponse>(`/api/pane/${encodeURIComponent(paneId)}/close`, {
    method: "POST",
  });
}

/** Create a new tab in a space, opening a fresh shell pane. `cwd` omitted = inherits the space dir. */
export function createTab(
  workspaceId: string,
  opts: { label?: string; cwd?: string } = {},
): Promise<CreateResponse> {
  return req<CreateResponse>("/api/tab", {
    method: "POST",
    body: JSON.stringify({ workspaceId, ...opts }),
  });
}

/** Create a new space (workspace) with a fresh shell pane. `cwd` omitted = the host's home dir. */
export function createWorkspace(opts: { label?: string; cwd?: string } = {}): Promise<CreateResponse> {
  return req<CreateResponse>("/api/workspace", {
    method: "POST",
    body: JSON.stringify(opts),
  });
}

export function fetchConfig(): Promise<BridgeConfig> {
  return req<BridgeConfig>("/api/config");
}

/**
 * Upload an image; the bridge saves it to a host file and returns the path to reference in a
 * message. Uses multipart/form-data (NOT the JSON `req` helper — the browser sets the boundary).
 */
export async function uploadImage(paneId: string, file: File): Promise<UploadResponse> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch(`/api/pane/${encodeURIComponent(paneId)}/upload`, {
    method: "POST",
    body: fd,
  });
  if (!res.ok) {
    throw new ApiError(`upload → ${res.status} ${await errorDetail(res)}`, res.status);
  }
  return (await res.json()) as UploadResponse;
}
