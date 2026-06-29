import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, normalize } from "node:path";
import type { Config } from "./config.ts";
import type { HerdrClient } from "./herdr-client.ts";
import type { StateEngine } from "./state-engine.ts";
import type { Push } from "./push.ts";
import type {
  ActionResponse,
  CreateResponse,
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

export function startServer(
  cfg: Config,
  herdr: HerdrClient,
  engine: StateEngine,
  push: Push,
): void {
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
        return json({
          bridge,
          agents,
          shellPanes,
          workspaces,
          tabs,
          ts: Date.now(),
        } satisfies SnapshotResponse);
      }

      // ── Structural creates: new tab / new space (each opens a fresh shell pane) ──
      if (pathname === "/api/tab" && req.method === "POST") {
        const gate = checkAccess(req, cfg);
        if (!gate.ok) return text(gate.reason, 403);
        return createTab(herdr, engine, req);
      }
      if (pathname === "/api/workspace" && req.method === "POST") {
        const gate = checkAccess(req, cfg);
        if (!gate.ok) return text(gate.reason, 403);
        return createWorkspace(herdr, req);
      }

      // ── Per-pane read / send ─────────────────────────────────────────────
      const paneMatch = pathname.match(PANE_ROUTE);
      if (paneMatch) {
        const gate = checkAccess(req, cfg);
        if (!gate.ok) return text(gate.reason, 403);
        const paneId = decodeURIComponent(paneMatch[1]!);
        const action = paneMatch[2];

        if (!action && req.method === "GET") return readPane(herdr, cfg, paneId, url);
        if (action === "reply" && req.method === "POST") return replyPane(herdr, cfg, paneId, req);
        if (action === "keys" && req.method === "POST") return keysPane(herdr, paneId, req);
        if (action === "upload" && req.method === "POST") return uploadPane(cfg, paneId, req);
        if (action === "close" && req.method === "POST") return closePane(herdr, paneId);
        return text("method not allowed", 405);
      }

      // ── Misc API ─────────────────────────────────────────────────────────
      if (pathname === "/api/config") {
        return json({ push: push.enabled, vapidPublicKey: push.publicKey });
      }
      if (pathname === "/api/subscribe" && req.method === "POST") {
        const gate = checkAccess(req, cfg);
        if (!gate.ok) return text(gate.reason, 403);
        try {
          const body = (await req.json()) as {
            endpoint: string;
            keys: { p256dh: string; auth: string };
          };
          await push.addSubscription(body);
          return new Response(null, { status: 204 });
        } catch {
          return text("bad subscription", 400);
        }
      }

      // ── Static PWA (with SPA fallback) ───────────────────────────────────
      return serveStatic(pathname);
    },
  });

  // Background notifications on lifecycle transitions (foreground toasts are computed client-side
  // by diffing snapshots). Push is independent of how the client polls.
  engine.onTransition((agent, _from, to) => {
    if (to === "blocked" || to === "done") {
      const verb = to === "blocked" ? "needs you" : "is done";
      void push.notify(`${agent.agent} ${verb}`, `${agent.workspaceLabel} · ${agent.cwd}`, {
        paneId: agent.paneId,
      });
    }
  });

  console.log(`[bridge] listening on http://${cfg.host}:${cfg.port}  (poll ${cfg.pollMs}ms)`);
  if (cfg.host !== "127.0.0.1" && cfg.host !== "localhost") {
    console.warn(`[bridge] WARNING: bound to ${cfg.host}, not loopback — identity checks may be bypassable`);
  }
}

async function readPane(
  herdr: HerdrClient,
  cfg: Config,
  paneId: string,
  url: URL,
): Promise<Response> {
  const linesParam = Number.parseInt(url.searchParams.get("lines") ?? "", 10);
  const lines = Number.isFinite(linesParam) && linesParam > 0 ? linesParam : cfg.readLines;
  try {
    // "ansi" so the client can render a faithful, colored terminal mirror.
    const read = await herdr.readPane(paneId, "recent", lines, "ansi");
    return json({
      paneId,
      text: read.text,
      truncated: read.truncated,
    } satisfies PaneReadResponse);
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
  try {
    if (txt) await herdr.sendPaneText(paneId, txt);
    if (submit) await herdr.sendPaneKeys(paneId, cfg.submitKeys);
    return json({ ok: true } satisfies ActionResponse);
  } catch (err) {
    return json({ ok: false, error: (err as Error).message } satisfies ActionResponse);
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
  try {
    await herdr.sendPaneKeys(paneId, keys);
    return json({ ok: true } satisfies ActionResponse);
  } catch (err) {
    return json({ ok: false, error: (err as Error).message } satisfies ActionResponse);
  }
}

// Close a pane ("kill the agent"). Structural op — strictly less powerful than the text/keys
// injection the bridge already allows, so it stays within the existing remote-shell threat model.
async function closePane(herdr: HerdrClient, paneId: string): Promise<Response> {
  try {
    await herdr.closePane(paneId);
    return json({ ok: true } satisfies ActionResponse);
  } catch (err) {
    return json({ ok: false, error: (err as Error).message } satisfies ActionResponse);
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
  if (!workspaceId) return json({ ok: false, error: "workspaceId required" } satisfies CreateResponse);
  try {
    const created = await herdr.createTab(workspaceId, { label: body.label, cwd: body.cwd });
    const label =
      engine.current().workspaces.find((w) => w.workspaceId === created.workspaceId)?.label ??
      created.workspaceId;
    return json({
      ok: true,
      pane: { ...created, workspaceLabel: label },
    } satisfies CreateResponse);
  } catch (err) {
    return json({ ok: false, error: (err as Error).message } satisfies CreateResponse);
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
    } satisfies CreateResponse);
  } catch (err) {
    return json({ ok: false, error: (err as Error).message } satisfies CreateResponse);
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
  if (!(file instanceof File)) {
    return json({ ok: false, error: "no file" } satisfies UploadResponse);
  }
  const ext = IMAGE_EXT[file.type];
  if (!ext) {
    return json({ ok: false, error: `unsupported type: ${file.type || "unknown"}` } satisfies UploadResponse);
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return json({ ok: false, error: "image too large (max 10 MB)" } satisfies UploadResponse);
  }
  try {
    const dir = join(cfg.stateDir, "uploads");
    await mkdir(dir, { recursive: true });
    const safePane = paneId.replace(/[^A-Za-z0-9_-]/g, "_");
    const filename = `${safePane}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
    const fullPath = join(dir, filename);
    await Bun.write(fullPath, file);
    return json({ ok: true, path: fullPath } satisfies UploadResponse);
  } catch (err) {
    return json({ ok: false, error: (err as Error).message } satisfies UploadResponse);
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
function checkAccess(req: Request, cfg: Config): { ok: true } | { ok: false; reason: string } {
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

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function text(body: string, status: number): Response {
  return new Response(body, { status });
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
