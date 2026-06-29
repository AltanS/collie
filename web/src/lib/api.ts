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

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = (await res.text()) || detail;
    } catch {
      /* ignore */
    }
    throw new ApiError(`${path} → ${res.status} ${detail}`, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function fetchSnapshot(signal?: AbortSignal): Promise<SnapshotResponse> {
  return req<SnapshotResponse>("/api/snapshot", { signal });
}

export function fetchPane(
  paneId: string,
  lines?: number,
  signal?: AbortSignal,
): Promise<PaneReadResponse> {
  const q = lines ? `?lines=${lines}` : "";
  return req<PaneReadResponse>(`/api/pane/${encodeURIComponent(paneId)}${q}`, { signal });
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
    let detail = res.statusText;
    try {
      detail = (await res.text()) || detail;
    } catch {
      /* ignore */
    }
    throw new ApiError(`upload → ${res.status} ${detail}`, res.status);
  }
  return (await res.json()) as UploadResponse;
}

export { ApiError };
