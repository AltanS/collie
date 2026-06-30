import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, normalize } from "node:path";
import type { Config } from "./config.ts";
import type { HerdrClient } from "./herdr-client.ts";
import { computeEtag, gzipJsonResponse, notModified } from "./http-cache.ts";
import { NotificationCoordinator, makeNotifySink, type NotifyClock } from "./notifications.ts";
import type { Push, PushSubscription } from "./push.ts";
import type { Snooze } from "./snooze.ts";
import type { StateEngine } from "./state-engine.ts";
import type {
  ActionResponse,
  BridgeConfig,
  CreateResponse,
  DeviceAuth,
  PaneReadResponse,
  SnapshotResponse,
  UploadResponse,
} from "./types.ts";

// Image upload limits. Herdr's socket only carries text/keys, so we can't paste an image into the
// terminal — instead we save it to a host file and the client references its path in the message
// (the agent reads images by path). See uploadPane().
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
const IMAGE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

// The built PWA lives in web/dist (Vite output). If it's missing, the bridge still runs the API
// — only the static UI 503s with a hint to build.
const WEB_DIR = join(import.meta.dir, "..", "web", "dist");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// Strict CSP. Scripts are external, hashed bundles (script-src 'self'); pane text is rendered by
// React as text nodes, never markup, so terminal output can't inject. 'unsafe-inline' is allowed
// for styles only (the toast library injects a <style> tag) — it can't execute code.
const CSP =
  "default-src 'self'; connect-src 'self'; img-src 'self' data:; " +
  "style-src 'self' 'unsafe-inline'; script-src 'self'; worker-src 'self'; " +
  "manifest-src 'self'; base-uri 'none'; frame-ancestors 'none'";

const PANE_ROUTE = /^\/api\/pane\/([^/]+)(?:\/(reply|keys|upload|close))?$/;

// The whole herd shares one notification slot, so multiple agents coalesce into a single summary
// and a retraction (or a snooze) targets exactly it.
const HERD_TAG = "collie:herd";

export function startServer(opts: {
  cfg: Config;
  herdr: HerdrClient;
  engine: StateEngine;
  push: Push;
  snooze: Snooze;
}): void {
  const { cfg, herdr, engine, push, snooze } = opts;
  const server = Bun.serve({
    hostname: cfg.host,
    port: cfg.port,

    async fetch(req) {
      const url = new URL(req.url);
      const { pathname } = url;

      // ── Live state (polled by the client) ────────────────────────────────
      if (pathname === "/api/snapshot") {
        const gate = checkAccess(req, cfg);
        if (!gate.ok) return text(gate.reason, 403);
        const { agents, shellPanes, workspaces, tabs, bridge } = engine.current();
        const device = deviceAuth(req, cfg);
        return json({
          bridge,
          // Only report device state when the feature is on, so an off deployment sends nothing new.
          ...(device.enforced ? { device } : {}),
          agents,
          shellPanes,
          workspaces,
          tabs,
          notifications: { snoozedUntil: snooze.until() },
          ts: Date.now(),
        } satisfies SnapshotResponse, req.headers.get("accept-encoding"));
      }

      // ── Structural creates: new tab / new space (each opens a fresh shell pane) ──
      if (pathname === "/api/tab" && req.method === "POST") {
        const denied = guard(req, cfg, "write");
        if (denied) return denied;
        return createTab(herdr, engine, req);
      }
      if (pathname === "/api/workspace" && req.method === "POST") {
        const denied = guard(req, cfg, "write");
        if (denied) return denied;
        return createWorkspace(herdr, req);
      }

      // ── Per-pane read / send ─────────────────────────────────────────────
      const paneMatch = pathname.match(PANE_ROUTE);
      if (paneMatch) {
        const paneId = decodeURIComponent(paneMatch[1]!);
        const action = paneMatch[2];
        // Reading a pane is allowed for any access-gated client; every action (reply/keys/upload/
        // close) types into or restructures a terminal, so it additionally needs an authorised device.
        const denied = guard(req, cfg, action ? "write" : "read");
        if (denied) return denied;

        if (!action && req.method === "GET") return readPane(herdr, cfg, paneId, url, req);
        if (action === "reply" && req.method === "POST") return replyPane(herdr, cfg, paneId, req);
        if (action === "keys" && req.method === "POST") return keysPane(herdr, paneId, req);
        if (action === "upload" && req.method === "POST") return uploadPane(cfg, paneId, req);
        if (action === "close" && req.method === "POST") return closePane(herdr, paneId, req);
        return text("method not allowed", 405);
      }

      // ── Misc API ─────────────────────────────────────────────────────────
      if (pathname === "/api/config") {
        return json({
          push: push.enabled,
          vapidPublicKey: push.publicKey,
          build: await buildId(),
        } satisfies BridgeConfig, req.headers.get("accept-encoding"));
      }
      if (pathname === "/api/subscribe" && req.method === "POST") {
        // Read-level: registering for push isn't terminal-driving, so a read-only device may still
        // subscribe to notifications.
        const denied = guard(req, cfg, "read");
        if (denied) return denied;
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return text("bad subscription", 400);
        }
        if (!isPushSubscription(body)) return text("bad subscription", 400);
        await push.addSubscription(body);
        return new Response(null, { status: 204 });
      }
      if (pathname === "/api/notifications/snooze" && req.method === "POST") {
        // Managing your own notification quiet-hours isn't terminal-driving — read-level, like subscribe.
        const denied = guard(req, cfg, "read");
        if (denied) return denied;
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return text("bad request", 400);
        }
        const until = (body as { snoozedUntil?: unknown }).snoozedUntil;
        if (until !== null && typeof until !== "number") return text("bad snoozedUntil", 400);
        await snooze.set(until);
        // Snoozing should also clear whatever's already on the lock screen.
        if (snooze.isMuted()) void push.send({ type: "clear", tag: HERD_TAG });
        return json({ snoozedUntil: snooze.until() });
      }

      // ── Static PWA (with SPA fallback) ───────────────────────────────────
      return serveStatic(pathname);
    },
  });

  // Background notifications on lifecycle transitions (foreground toasts are computed client-side
  // by diffing snapshots). Push is independent of how the client polls. The coordinator debounces
  // each blocked/done alert and retracts it once the agent resolves — so an agent you cleared at
  // your desk never (or no longer) buzzes your phone. See notifications.ts.
  const clock: NotifyClock<ReturnType<typeof setTimeout>> = {
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: (h) => clearTimeout(h),
  };
  const sink = makeNotifySink(push, snooze, HERD_TAG);
  const notifications = new NotificationCoordinator(clock, sink, cfg.notifyDelayMs);
  engine.onTransition((agent, from, to) => notifications.onTransition(agent, from, to));
  engine.onRemove((paneId) => notifications.onRemove(paneId));

  console.log(`[bridge] listening on http://${cfg.host}:${cfg.port}  (poll ${cfg.pollMs}ms)`);
  if (cfg.host !== "127.0.0.1" && cfg.host !== "localhost") {
    console.warn(`[bridge] WARNING: bound to ${cfg.host}, not loopback — identity checks may be bypassable`);
  }
  if (cfg.deviceHeader) {
    console.log(
      `[bridge] per-device auth ON: trusting '${cfg.deviceHeader}', ${cfg.deviceAllowlist.length} device(s) allowlisted`,
    );
    if (cfg.deviceAllowlist.length === 0) {
      console.warn(
        `[bridge] WARNING: COLLIE_DEVICE_HEADER set but COLLIE_DEVICE_ALLOWLIST is empty — every device is read-only`,
      );
    }
  }
}

async function readPane(
  herdr: HerdrClient,
  cfg: Config,
  paneId: string,
  url: URL,
  req: Request,
): Promise<Response> {
  const linesParam = Number.parseInt(url.searchParams.get("lines") ?? "", 10);
  const lines = Number.isFinite(linesParam) && linesParam > 0 ? linesParam : cfg.readLines;
  try {
    // "ansi" so the client can render a faithful, colored terminal mirror.
    const read = await herdr.readPane(paneId, "recent", lines, "ansi");
    const data: PaneReadResponse = { paneId, text: read.text, truncated: read.truncated };
    // ETag is derived from the serialised body — if content hasn't changed the client gets a 304
    // and skips the whole transfer (the big win on a cellular link).
    const bodyStr = JSON.stringify(data);
    const etag = computeEtag(bodyStr);
    if (notModified(req.headers.get("if-none-match"), etag)) {
      // RFC 7232 §4.1: 304 MUST echo the ETag; body MUST be empty.
      return new Response(null, {
        status: 304,
        headers: { etag, "cache-control": "no-store" },
      });
    }
    return gzipJsonResponse(data, req.headers.get("accept-encoding"), { etag });
  } catch (err) {
    return text(`herdr read failed: ${(err as Error).message}`, 502);
  }
}

async function replyPane(
  herdr: HerdrClient,
  cfg: Config,
  paneId: string,
  req: Request,
): Promise<Response> {
  let body: { text?: string; submit?: boolean };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return text("bad body", 400);
  }
  const txt = body.text ?? "";
  const submit = body.submit ?? true;
  const ae = req.headers.get("accept-encoding");
  try {
    if (txt) await herdr.sendPaneText(paneId, txt);
    if (submit) await herdr.sendPaneKeys(paneId, cfg.submitKeys);
    return json({ ok: true } satisfies ActionResponse, ae);
  } catch (err) {
    return json({ ok: false, error: (err as Error).message } satisfies ActionResponse, ae);
  }
}

async function keysPane(herdr: HerdrClient, paneId: string, req: Request): Promise<Response> {
  let body: { keys?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return text("bad body", 400);
  }
  const keys = Array.isArray(body.keys) ? body.keys.filter((k): k is string => typeof k === "string") : [];
  if (keys.length === 0) return text("no keys", 400);
  const ae = req.headers.get("accept-encoding");
  try {
    await herdr.sendPaneKeys(paneId, keys);
    return json({ ok: true } satisfies ActionResponse, ae);
  } catch (err) {
    return json({ ok: false, error: (err as Error).message } satisfies ActionResponse, ae);
  }
}

// Close a pane ("kill the agent"). Structural op — strictly less powerful than the text/keys
// injection the bridge already allows, so it stays within the existing remote-shell threat model.
async function closePane(herdr: HerdrClient, paneId: string, req: Request): Promise<Response> {
  const ae = req.headers.get("accept-encoding");
  try {
    await herdr.closePane(paneId);
    return json({ ok: true } satisfies ActionResponse, ae);
  } catch (err) {
    return json({ ok: false, error: (err as Error).message } satisfies ActionResponse, ae);
  }
}

// Create a new tab in a workspace, opening a fresh shell pane (you then launch your own agent in
// it). Structural — no more privilege than typing into an existing pane (you can already spawn a
// shell that way). `cwd` omitted => inherits the workspace dir. session.* stays unexposed.
async function createTab(herdr: HerdrClient, engine: StateEngine, req: Request): Promise<Response> {
  let body: { workspaceId?: string; label?: string; cwd?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return text("bad body", 400);
  }
  const workspaceId = body.workspaceId?.trim();
  const ae = req.headers.get("accept-encoding");
  if (!workspaceId) return json({ ok: false, error: "workspaceId required" } satisfies CreateResponse, ae);
  try {
    const created = await herdr.createTab(workspaceId, { label: body.label, cwd: body.cwd });
    const label =
      engine.current().workspaces.find((w) => w.workspaceId === created.workspaceId)?.label ??
      created.workspaceId;
    return json({
      ok: true,
      pane: { ...created, workspaceLabel: label },
    } satisfies CreateResponse, ae);
  } catch (err) {
    return json({ ok: false, error: (err as Error).message } satisfies CreateResponse, ae);
  }
}

// Create a new workspace ("space") with a fresh shell pane. `cwd` defaults to the user's home dir
// when the client doesn't specify one (typing a path on a phone is painful) — it's a shell, so you
// can cd from there. Same structural-only threat model as createTab.
async function createWorkspace(herdr: HerdrClient, req: Request): Promise<Response> {
  let body: { cwd?: string; label?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return text("bad body", 400);
  }
  const cwd = body.cwd?.trim() || homedir();
  const ae = req.headers.get("accept-encoding");
  try {
    const created = await herdr.createWorkspace({ cwd, label: body.label });
    return json({
      ok: true,
      pane: {
        paneId: created.paneId,
        workspaceId: created.workspaceId,
        workspaceLabel: created.workspaceLabel ?? created.workspaceId,
        tabId: created.tabId,
        cwd: created.cwd,
      },
    } satisfies CreateResponse, ae);
  } catch (err) {
    return json({ ok: false, error: (err as Error).message } satisfies CreateResponse, ae);
  }
}

// Save an uploaded image to a host file and return its absolute path. The client then references
// that path in a message; Claude Code / Codex read images by path (the terminal can't take a
// pasted image over the socket). Validated by MIME and size; the filename is server-generated.
async function uploadPane(cfg: Config, paneId: string, req: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return text("expected multipart form data", 400);
  }
  const file = form.get("file");
  const ae = req.headers.get("accept-encoding");
  if (!(file instanceof File)) {
    return json({ ok: false, error: "no file" } satisfies UploadResponse, ae);
  }
  const ext = IMAGE_EXT[file.type];
  if (!ext) {
    return json({ ok: false, error: `unsupported type: ${file.type || "unknown"}` } satisfies UploadResponse, ae);
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return json({ ok: false, error: "image too large (max 10 MB)" } satisfies UploadResponse, ae);
  }
  try {
    const dir = join(cfg.stateDir, "uploads");
    await mkdir(dir, { recursive: true });
    const safePane = paneId.replace(/[^A-Za-z0-9_-]/g, "_");
    const filename = `${safePane}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
    const fullPath = join(dir, filename);
    await Bun.write(fullPath, file);
    return json({ ok: true, path: fullPath } satisfies UploadResponse, ae);
  } catch (err) {
    return json({ ok: false, error: (err as Error).message } satisfies UploadResponse, ae);
  }
}

/**
 * Access gate for the API:
 *  - Same-origin only (Origin host must equal Host) — defeats cross-site requests/CSRF. Browsers
 *    omit Origin on same-origin GETs (so the snapshot poll passes); they send it on POSTs.
 *    localhost and explicitly-configured origins are also allowed.
 *  - Optional Tailscale identity: if a trusted user is configured and `tailscale serve` injects a
 *    `Tailscale-User-Login`, it must match.
 */
export function checkAccess(
  req: Request,
  cfg: Config,
): { ok: true } | { ok: false; reason: string } {
  const origin = req.headers.get("origin");
  if (origin) {
    let originHost = "";
    try {
      originHost = new URL(origin).host;
    } catch {
      return { ok: false, reason: "bad origin" };
    }
    const host = req.headers.get("host") ?? "";
    const allowed =
      originHost === host ||
      /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(originHost) ||
      cfg.allowedOrigins.includes(origin);
    if (!allowed) return { ok: false, reason: "cross-origin rejected" };
  }

  if (cfg.trustedUser) {
    const login = req.headers.get("tailscale-user-login");
    if (login && login !== cfg.trustedUser) {
      return { ok: false, reason: "identity not trusted" };
    }
  }
  return { ok: true };
}

/**
 * Combined API gate used by every handler. A request must always pass {@link checkAccess}
 * (same-origin / CSRF + optional Tailscale identity). A `"write"` request — one that types into a
 * terminal or creates panes — must additionally come from an authorised device (see
 * {@link deviceAuth}). Returns a 403 Response to short-circuit on denial, or null to proceed.
 */
function guard(req: Request, cfg: Config, level: "read" | "write"): Response | null {
  const gate = checkAccess(req, cfg);
  if (!gate.ok) return text(gate.reason, 403);
  if (level === "write" && !deviceAuth(req, cfg).authorized) {
    return text("device not authorised", 403);
  }
  return null;
}

/**
 * Optional per-device authorisation, layered on top of {@link checkAccess}. Off by default; enabled
 * by setting COLLIE_DEVICE_HEADER to the header a trusted upstream proxy injects, carrying an opaque
 * device identifier. The header is trusted only because the bridge binds loopback behind the proxy,
 * so a direct client can't forge it (the same trust basis as the Tailscale identity header). Matrix:
 *
 *   - feature off (no header configured) → not enforced, fully authorised (today's behaviour).
 *   - header absent                      → authorised, unchanged. The proxy injects the header for
 *                                          real device traffic; an absent header is the on-host
 *                                          loopback operator (same tolerance as a missing identity).
 *   - header present, value allowlisted  → authorised; the session is attributed to that device.
 *   - header present, value not listed   → read-only. The "unknown" sentinel is never authorised,
 *                                          and an empty allowlist makes every device read-only — a
 *                                          fail-closed default for a security toggle you turned on.
 */
export function deviceAuth(req: Request, cfg: Config): DeviceAuth {
  if (!cfg.deviceHeader) return { enforced: false, device: null, authorized: true };
  const raw = req.headers.get(cfg.deviceHeader);
  const device = raw?.trim() ? raw.trim() : null;
  if (!device) return { enforced: true, device: null, authorized: true };
  const authorized = device !== "unknown" && cfg.deviceAllowlist.includes(device);
  return { enforced: true, device, authorized };
}

function json(data: unknown, acceptEncoding: string | null): Response {
  return gzipJsonResponse(data, acceptEncoding);
}

function text(body: string, status: number): Response {
  return new Response(body, { status });
}

// Shape-check an untrusted /api/subscribe body before persisting it (a malformed sub would be
// stored keyed on `undefined` and silently never fire).
function isPushSubscription(v: unknown): v is PushSubscription {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  const keys = o.keys as Record<string, unknown> | undefined;
  return (
    typeof o.endpoint === "string" &&
    typeof keys === "object" &&
    keys !== null &&
    typeof keys.p256dh === "string" &&
    typeof keys.auth === "string"
  );
}

// Build id of the bundle currently on disk (written by the Vite build to dist/build-info.json).
// Surfaced via the X-Collie-Build header and /api/config so a stale, service-worker-cached client
// can tell it's behind. Cached by file mtime so a frontend rebuild (live, no restart) is picked up.
let buildCache: { id: string; mtime: number } | null = null;
async function buildId(): Promise<string> {
  try {
    const f = Bun.file(join(WEB_DIR, "build-info.json"));
    const mtime = f.lastModified;
    if (!buildCache || buildCache.mtime !== mtime) {
      const data = (await f.json()) as { id?: string };
      buildCache = { id: data.id ?? "unknown", mtime };
    }
    return buildCache.id;
  } catch {
    return "unknown";
  }
}

async function serveStatic(pathname: string): Promise<Response> {
  let rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  let full = normalize(join(WEB_DIR, rel));
  if (!full.startsWith(WEB_DIR)) return text("forbidden", 403);

  let file = Bun.file(full);
  if (!(await file.exists())) {
    // SPA fallback: extension-less paths fall back to index.html; missing assets 404.
    if (extname(rel) === "") {
      rel = "index.html";
      full = join(WEB_DIR, "index.html");
      file = Bun.file(full);
      if (!(await file.exists())) {
        return text("frontend not built — run `bun run build` in web/", 503);
      }
    } else {
      return text("not found", 404);
    }
  }

  const ext = extname(full);
  const headers: Record<string, string> = {
    "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream",
    "x-collie-build": await buildId(), // which bundle the server is serving (vs the client's stamp)
  };
  if (ext === ".html") {
    headers["content-security-policy"] = CSP;
    headers["cache-control"] = "no-cache";
  } else if (rel.startsWith("assets/")) {
    headers["cache-control"] = "public, max-age=31536000, immutable"; // hashed → cache hard
  }
  if (rel === "sw.js") headers["service-worker-allowed"] = "/";
  return new Response(file, { headers });
}
