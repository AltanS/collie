import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, normalize, sep } from "node:path";
import type { AuditLog } from "./audit.ts";
import type { Config } from "./config.ts";
import type { HerdrClient, PaneRead } from "./herdr-client.ts";
import { computeEtag, gzipJsonResponse, notModified } from "./http-cache.ts";
import type { NotifyPrefs, NotifyPrefsStore } from "./notify-prefs.ts";
import type { Push, PushSubscription } from "./push.ts";
import { herdTagFor, type SessionRegistry } from "./sessions.ts";
import type { Snooze } from "./snooze.ts";
import type { UpdateMonitor } from "./update.ts";
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
// Multipart wraps the file in a boundary + part headers, so a legitimately-sized image arrives a
// little over MAX_UPLOAD_BYTES on the wire. Allow a small slack for the Content-Length pre-check.
const MAX_UPLOAD_OVERHEAD = 64 * 1024; // 64 KB
// Hard cap the runtime enforces on ANY request body (Bun.serve maxRequestBodySize). Bigger than the
// upload cap + overhead so the handler's own 413 fires first for honest clients; this cuts off a
// chunked or lying client that never sends an accurate Content-Length.
const MAX_REQUEST_BODY_BYTES = 12 * 1024 * 1024; // 12 MB
// Upper bound on the pane-read `lines` param — don't trust the client (or Herdr) to cap it.
const MAX_READ_LINES = 10_000;
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

// Hardening headers set on EVERY response (static + API), applied centrally in the fetch wrapper.
// nosniff stops content-type confusion; no-referrer keeps the tailnet URL out of any Referer.
const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

// Loopback Host/Origin forms (with an optional port). Loopback is always trusted — only tailscaled
// (or a co-located proxy) can reach the bridge's port, so a loopback caller is the on-host operator.
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

const PANE_ROUTE = /^\/api\/pane\/([^/]+)(?:\/(reply|keys|upload|close|rename))?$/;

export function startServer(opts: {
  cfg: Config;
  registry: SessionRegistry;
  push: Push;
  snooze: Snooze;
  notifyPrefs: NotifyPrefsStore;
  updateMonitor: UpdateMonitor;
  audit: AuditLog;
}) {
  const { cfg, registry, push, snooze, notifyPrefs, updateMonitor, audit } = opts;
  // Per-session background notifications live in each session's runtime (built by the factory in
  // index.ts, wired to its StateEngine transitions). The routes here only fan preference changes and
  // snooze-clears across every live session's coordinator.

  const server = Bun.serve({
    hostname: cfg.host,
    port: cfg.port,
    // Runtime cap on any request body — a chunked/lying client is cut off here even if its
    // Content-Length is absent or false. The upload handler still does its own precise check.
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,

    async fetch(req) {
      const url = new URL(req.url);
      const { pathname } = url;

      // Session-scoped routes accept an optional `?session=<name>`; absent → the primary session
      // (identical to pre-multi-session behaviour). The name is only ever a registry Map lookup — it
      // never builds a path. An unknown name is a 404. Global routes below ignore the param entirely.
      const sessionName = url.searchParams.get("session") ?? undefined;
      const unknownSession = () =>
        jsonError(`unknown session: ${sessionName ?? ""}`, 404, req.headers.get("accept-encoding"));

      // ── Live state (polled by the client) ────────────────────────────────
      if (pathname === "/api/snapshot") {
        const gate = checkAccess(req, cfg);
        if (!gate.ok) return text(gate.reason, 403);
        const rt = registry.get(sessionName);
        if (!rt) return unknownSession();
        const { agents, shellPanes, workspaces, tabs, bridge } = rt.engine.current();
        const device = deviceAuth(req, cfg);
        return json({
          bridge,
          // Only report device state when the feature is on, so an off deployment sends nothing new.
          ...(device.enforced ? { device } : {}),
          agents,
          shellPanes,
          workspaces,
          tabs,
          sessions: registry.list(),
          notifications: { snoozedUntil: snooze.until() },
          update: updateMonitor.status(),
          ts: Date.now(),
        } satisfies SnapshotResponse, req.headers.get("accept-encoding"));
      }

      // ── Structural creates: new tab / new space (each opens a fresh shell pane) ──
      if (pathname === "/api/tab" && req.method === "POST") {
        const denied = guard(req, cfg, "write");
        if (denied) return denied;
        const rt = registry.get(sessionName);
        if (!rt) return unknownSession();
        return createTab(rt.herdr, rt.engine, req, audit, deviceAuth(req, cfg).device, rt.name);
      }
      if (pathname === "/api/workspace" && req.method === "POST") {
        const denied = guard(req, cfg, "write");
        if (denied) return denied;
        const rt = registry.get(sessionName);
        if (!rt) return unknownSession();
        return createWorkspace(rt.herdr, req, audit, deviceAuth(req, cfg).device, rt.name);
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
        const rt = registry.get(sessionName);
        if (!rt) return unknownSession();
        const { herdr, name: session } = rt;
        // Every action is a write; attribute it to the authorised device for the audit trail.
        const device = action ? deviceAuth(req, cfg).device : null;

        if (!action && req.method === "GET") return readPane(herdr, cfg, paneId, url, req);
        if (action === "reply" && req.method === "POST") return replyPane(herdr, cfg, paneId, req, audit, device, session);
        if (action === "keys" && req.method === "POST") return keysPane(herdr, paneId, req, audit, device, session);
        if (action === "upload" && req.method === "POST") return uploadPane(cfg, paneId, req, audit, device, session);
        if (action === "close" && req.method === "POST") return closePane(herdr, paneId, req, audit, device, session);
        if (action === "rename" && req.method === "POST") return renamePane(herdr, paneId, req, audit, device, session);
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
        return secure(new Response(null, { status: 204 }));
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
        // Snoozing should also clear whatever's already on the lock screen — across every session,
        // since snooze is bridge-wide. Each session owns its own notification slot (tag).
        if (snooze.isMuted()) {
          for (const rt of registry.all()) {
            void push.send({ type: "clear", tag: herdTagFor(rt.isPrimary, rt.name) });
          }
        }
        return json({ snoozedUntil: snooze.until() }, req.headers.get("accept-encoding"));
      }
      if (pathname === "/api/notifications/prefs") {
        // Which agent statuses push (bridge-wide). Read-level like snooze — managing your own
        // notification preferences isn't terminal-driving.
        if (req.method === "GET") {
          const denied = guard(req, cfg, "read");
          if (denied) return denied;
          return json(notifyPrefs.current(), req.headers.get("accept-encoding"));
        }
        if (req.method === "POST") {
          const denied = guard(req, cfg, "read");
          if (denied) return denied;
          let body: unknown;
          try {
            body = await req.json();
          } catch {
            return text("bad request", 400);
          }
          const patch = parseNotifyPrefsPatch(body);
          if (!patch) return text("bad prefs", 400);
          const updated = await notifyPrefs.set(patch);
          // Prefs may have just disabled a kind — retract any pending/outstanding alerts of it, in
          // every live session (prefs are bridge-wide; each session has its own coordinator).
          for (const rt of registry.all()) rt.notifications.applyPrefs();
          return json(updated, req.headers.get("accept-encoding"));
        }
        return text("method not allowed", 405);
      }
      if (pathname === "/api/update/check" && req.method === "POST") {
        // Force an immediate upstream check (the "check for updates" button), instead of waiting for
        // the periodic timer. Read-level — checking a version isn't terminal-driving — and idempotent
        // (the monitor de-dupes concurrent checks). Returns the fresh status the client revalidates on.
        const denied = guard(req, cfg, "read");
        if (denied) return denied;
        await updateMonitor.checkRelease();
        return json(updateMonitor.status(), req.headers.get("accept-encoding"));
      }

      // ── Static PWA (with SPA fallback) ───────────────────────────────────
      return serveStatic(pathname);
    },
  });

  console.log(`[bridge] listening on http://${cfg.host}:${cfg.port}  (poll ${cfg.pollMs}ms)`);
  if (cfg.deviceHeader) {
    console.log(
      `[bridge] per-device auth ON: trusting '${cfg.deviceHeader}', ${cfg.deviceAllowlist.length} device(s) allowlisted`,
    );
  }
  for (const w of startupWarnings(cfg)) console.warn(w);

  return server;
}

/**
 * The security-posture warnings emitted once at startup, as plain strings (each already prefixed
 * `[bridge] WARNING:`). Pure + exported so the exact set that fires for a given {@link Config} is
 * unit-testable without standing up Bun.serve; the bootstrap in {@link startServer} just logs each
 * via `console.warn`. The identity-gate advice forks on {@link Config.skipServe}: behind a reverse
 * proxy the `Tailscale-User-Login` header is never injected, so trustedUser is inert (nag toward
 * COLLIE_DEVICE_HEADER instead), whereas under `tailscale serve` an empty trustedUser is the open
 * door Variant A closes.
 */
export function startupWarnings(cfg: Config): string[] {
  const warnings: string[] = [];
  if (cfg.host !== "127.0.0.1" && cfg.host !== "localhost") {
    warnings.push(
      `[bridge] WARNING: bound to ${cfg.host}, not loopback — identity checks may be bypassable`,
    );
  }
  if (cfg.deviceHeader && cfg.deviceAllowlist.length === 0) {
    warnings.push(
      `[bridge] WARNING: COLLIE_DEVICE_HEADER set but COLLIE_DEVICE_ALLOWLIST is empty — every device is read-only`,
    );
  }
  if (cfg.skipServe) {
    // Reverse-proxy mode: no tailscale serve injects Tailscale-User-Login, so checkAccess never has
    // an identity to enforce — trustedUser is dead config. Only nag when it's set (a likely mistake).
    if (cfg.trustedUser) {
      warnings.push(
        `[bridge] WARNING: COLLIE_TRUSTED_USER has no effect under COLLIE_SKIP_SERVE=1 — without tailscale serve in front, the Tailscale-User-Login header is never injected. Use COLLIE_DEVICE_HEADER for per-device auth (see README → Variant C).`,
      );
    }
  } else if (!cfg.trustedUser) {
    warnings.push(
      `[bridge] WARNING: COLLIE_TRUSTED_USER is empty — any tailnet device/user that reaches the bridge gets full write access. Set it to your tailnet login (see README → Variant A).`,
    );
  }
  if (cfg.publicHosts.length === 0) {
    warnings.push(
      `[bridge] WARNING: COLLIE_PUBLIC_HOSTS is empty — Host-header validation is OFF (DNS rebinding not blocked). Set it to your MagicDNS name, especially under plain-HTTP serve mode or behind a reverse proxy.`,
    );
  }
  return warnings;
}

async function readPane(
  herdr: HerdrClient,
  cfg: Config,
  paneId: string,
  url: URL,
  req: Request,
): Promise<Response> {
  const linesParam = Number.parseInt(url.searchParams.get("lines") ?? "", 10);
  // Clamp to a sane ceiling — don't trust the client (or Herdr) to bound an enormous read.
  const lines =
    Number.isFinite(linesParam) && linesParam > 0
      ? Math.min(linesParam, MAX_READ_LINES)
      : cfg.readLines;
  try {
    // "ansi" so the client can render a faithful, colored terminal mirror.
    const read = await herdr.readPane(paneId, "recent", lines, "ansi");
    const data = paneReadResponse(paneId, read);
    // ETag is derived from the serialised body — if content hasn't changed the client gets a 304
    // and skips the whole transfer (the big win on a cellular link).
    const bodyStr = JSON.stringify(data);
    const etag = computeEtag(bodyStr);
    if (notModified(req.headers.get("if-none-match"), etag)) {
      // RFC 7232 §4.1: 304 MUST echo the ETag; body MUST be empty.
      return secure(
        new Response(null, {
          status: 304,
          headers: { etag, "cache-control": "no-store" },
        }),
      );
    }
    return secure(gzipJsonResponse(data, req.headers.get("accept-encoding"), { etag }));
  } catch (err) {
    return text(`herdr read failed: ${(err as Error).message}`, 502);
  }
}

/**
 * Map a Herdr pane read to the REST response body. Pure + exported so the `revision` passthrough
 * (the client's prompt-select race guard depends on it) is covered by the bridge unit tests without
 * standing up Bun.serve / the socket client.
 */
export function paneReadResponse(paneId: string, read: PaneRead): PaneReadResponse {
  return { paneId, text: read.text, truncated: read.truncated, revision: read.revision };
}

/** Just the two one-shot RPCs a reply needs — real HerdrClient in the bridge, fake in tests. */
export interface ReplySender {
  sendPaneText(paneId: string, text: string): Promise<void>;
  sendPaneKeys(paneId: string, keys: string[]): Promise<void>;
}

/** Outcome of the two-step send. `textDelivered` is only meaningful on the failure branch. */
export type ReplyOutcome =
  | { ok: true; textDelivered: boolean }
  | { ok: false; error: string; textDelivered: boolean };

/**
 * The reply's two one-shot RPCs — type the text, then send the submit key(s) — as a pure function so
 * the partial-failure branch is unit-testable with a fake client. The important case: if the text
 * lands but the submit keypress fails, we surface a distinct, actionable error and `textDelivered:
 * true` so the client knows NOT to resend (which would duplicate the already-typed text). Pure +
 * exported.
 */
export type SleepFn = (ms: number) => Promise<void>;
const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Pause between typing and Enter so the TUI accepts the submit key (preview-action polls ~350ms). */
const REPLY_SETTLE_MS = 350;

export async function sendReplySteps(
  client: ReplySender,
  paneId: string,
  txt: string,
  submit: boolean,
  submitKeys: string[],
  sleep: SleepFn = defaultSleep,
): Promise<ReplyOutcome> {
  let textDelivered = false;
  try {
    if (txt) {
      await client.sendPaneText(paneId, txt);
      textDelivered = true;
    }
    if (submit) {
      if (txt) await sleep(REPLY_SETTLE_MS);
      await client.sendPaneKeys(paneId, submitKeys);
    }
    return { ok: true, textDelivered };
  } catch (err) {
    if (textDelivered && submit) {
      // Text is already in the pane — only the submit failed. Tell the operator to check/submit it
      // by hand rather than resend, and flag textDelivered so a resend-on-error UI can hold off.
      return {
        ok: false,
        textDelivered: true,
        error: "typed into the pane but not submitted — check the pane before resending",
      };
    }
    return { ok: false, textDelivered, error: (err as Error).message };
  }
}

async function replyPane(
  herdr: HerdrClient,
  cfg: Config,
  paneId: string,
  req: Request,
  audit: AuditLog,
  device: string | null,
  session: string,
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
  const outcome = await sendReplySteps(herdr, paneId, txt, submit, cfg.submitKeys);
  // Audit the attempt regardless of outcome — text may have landed even when the submit failed.
  audit.record({
    action: "reply",
    paneId,
    session,
    device,
    detail: { text: txt, submit, submitted: outcome.ok, textDelivered: outcome.textDelivered },
  });
  if (outcome.ok) return json({ ok: true } satisfies ActionResponse, ae);
  return json(
    { ok: false, error: outcome.error, textDelivered: outcome.textDelivered } satisfies ActionResponse,
    ae,
  );
}

async function keysPane(
  herdr: HerdrClient,
  paneId: string,
  req: Request,
  audit: AuditLog,
  device: string | null,
  session: string,
): Promise<Response> {
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
    audit.record({ action: "keys", paneId, session, device, detail: { keys } });
    return json({ ok: true } satisfies ActionResponse, ae);
  } catch (err) {
    return json({ ok: false, error: (err as Error).message } satisfies ActionResponse, ae);
  }
}

// Close a pane ("kill the agent"). Structural op — strictly less powerful than the text/keys
// injection the bridge already allows, so it stays within the existing remote-shell threat model.
async function closePane(
  herdr: HerdrClient,
  paneId: string,
  req: Request,
  audit: AuditLog,
  device: string | null,
  session: string,
): Promise<Response> {
  const ae = req.headers.get("accept-encoding");
  try {
    await herdr.closePane(paneId);
    audit.record({ action: "pane.close", paneId, session, device, detail: {} });
    return json({ ok: true } satisfies ActionResponse, ae);
  } catch (err) {
    return json({ ok: false, error: (err as Error).message } satisfies ActionResponse, ae);
  }
}

// Set or clear a pane's label. Structural metadata op — strictly less powerful than the text/keys
// injection the bridge already allows, so it stays within the existing remote-shell threat model.
// The body's `label` must be a string or null; a blank string clears (so a user can wipe a label by
// saving an empty field), which we send to Herdr as `label: null`.
async function renamePane(
  herdr: HerdrClient,
  paneId: string,
  req: Request,
  audit: AuditLog,
  device: string | null,
  session: string,
): Promise<Response> {
  const ae = req.headers.get("accept-encoding");
  let body: { label?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return text("bad body", 400);
  }
  if (body.label !== null && typeof body.label !== "string") return text("bad label", 400);
  const trimmed = typeof body.label === "string" ? body.label.trim() : "";
  const label = trimmed.length > 0 ? trimmed : null;
  try {
    await herdr.renamePane(paneId, label);
    audit.record({ action: "pane.rename", paneId, session, device, detail: { label } });
    return json({ ok: true } satisfies ActionResponse, ae);
  } catch (err) {
    return json({ ok: false, error: (err as Error).message } satisfies ActionResponse, ae);
  }
}

// Create a new tab in a workspace, opening a fresh shell pane (you then launch your own agent in
// it). Structural — no more privilege than typing into an existing pane (you can already spawn a
// shell that way). `cwd` omitted => inherits the workspace dir. session.* stays unexposed.
async function createTab(
  herdr: HerdrClient,
  engine: StateEngine,
  req: Request,
  audit: AuditLog,
  device: string | null,
  session: string,
): Promise<Response> {
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
    audit.record({
      action: "tab.create",
      paneId: created.paneId,
      session,
      device,
      detail: { workspaceId, label: body.label, cwd: body.cwd },
    });
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
async function createWorkspace(
  herdr: HerdrClient,
  req: Request,
  audit: AuditLog,
  device: string | null,
  session: string,
): Promise<Response> {
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
    audit.record({
      action: "workspace.create",
      paneId: created.paneId,
      session,
      device,
      detail: { label: body.label, cwd },
    });
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
async function uploadPane(
  cfg: Config,
  paneId: string,
  req: Request,
  audit: AuditLog,
  device: string | null,
  session: string,
): Promise<Response> {
  const ae = req.headers.get("accept-encoding");
  // Reject an oversize upload by its declared Content-Length BEFORE buffering — req.formData()
  // reads the whole body into memory first, so a 100 MB "image" would be materialised just to fail
  // the size check below. Multipart adds a boundary + part headers, so allow a small slack.
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES + MAX_UPLOAD_OVERHEAD) {
    return secure(
      new Response(
        JSON.stringify({
          ok: false,
          error: "image too large (max 10 MB)",
        } satisfies UploadResponse),
        { status: 413, headers: { "content-type": "application/json; charset=utf-8" } },
      ),
    );
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return text("expected multipart form data", 400);
  }
  const file = form.get("file");
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
    // 0700 — uploads (and the state dir they live under) may hold sensitive images; keep them
    // owner-only. recursive:true applies the mode to any intermediate dirs it creates too.
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const safePane = paneId.replace(/[^A-Za-z0-9_-]/g, "_");
    const filename = `${safePane}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
    const fullPath = join(dir, filename);
    await Bun.write(fullPath, file);
    audit.record({
      action: "upload",
      paneId,
      session,
      device,
      detail: { filename: file.name, size: file.size, saved: filename },
    });
    return json({ ok: true, path: fullPath } satisfies UploadResponse, ae);
  } catch (err) {
    return json({ ok: false, error: (err as Error).message } satisfies UploadResponse, ae);
  }
}

/**
 * Access gate for the API:
 *  - Host allowlist (opt-in): when COLLIE_PUBLIC_HOSTS is set, the request's Host header must be a
 *    loopback form, one of those hosts, or the host of an allowed origin — otherwise rejected,
 *    BEFORE any Origin logic (fail-closed). This defeats DNS rebinding, where a browser is tricked
 *    into sending Host==Origin==evil.example so a bare same-origin check trivially passes — acute
 *    under COLLIE_SERVE_MODE=http (no TLS). Empty COLLIE_PUBLIC_HOSTS keeps the legacy behaviour so
 *    existing deployments don't break (see the startup warning).
 *  - Same-origin only (Origin host must equal Host) — defeats cross-site requests/CSRF. Browsers
 *    omit Origin on same-origin GETs (so the snapshot poll passes); they send it on POSTs.
 *    localhost and explicitly-configured origins are also allowed.
 *  - Origin required for writes: a state-changing (`level === "write"`) request with no Origin is
 *    trusted only from loopback (curl on the host). Browsers always send Origin on fetch/SW POSTs,
 *    so a missing Origin on a remote write is a non-browser or Origin-stripped request — reject it.
 *  - Optional Tailscale identity: if a trusted user is configured and `tailscale serve` injects a
 *    `Tailscale-User-Login`, it must match.
 */
export function checkAccess(
  req: Request,
  cfg: Config,
  level: "read" | "write" = "read",
): { ok: true } | { ok: false; reason: string } {
  const host = req.headers.get("host") ?? "";

  // Host-header allowlist — only when the operator opted in (COLLIE_PUBLIC_HOSTS non-empty). Fail
  // closed, before the Origin logic, so a rebinding request (Host==Origin==evil) never reaches it.
  if (cfg.publicHosts.length > 0 && !isHostAllowed(host, cfg)) {
    return { ok: false, reason: "host not allowed" };
  }

  const origin = req.headers.get("origin");
  if (origin) {
    let originHost = "";
    try {
      originHost = new URL(origin).host;
    } catch {
      return { ok: false, reason: "bad origin" };
    }
    const allowed =
      originHost === host ||
      LOOPBACK_HOST.test(originHost) ||
      cfg.allowedOrigins.includes(origin);
    if (!allowed) return { ok: false, reason: "cross-origin rejected" };
  } else if (level === "write" && !LOOPBACK_HOST.test(host)) {
    // A write with no Origin header from a non-loopback Host isn't a real browser request — refuse.
    return { ok: false, reason: "origin required" };
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
 * Whether a Host header is one the bridge will answer to under the opt-in host allowlist: a loopback
 * form, an explicit COLLIE_PUBLIC_HOSTS entry, or the host of a configured allowed origin. Pure +
 * exported for tests.
 */
export function isHostAllowed(host: string, cfg: Config): boolean {
  if (!host) return false;
  if (LOOPBACK_HOST.test(host)) return true;
  if (cfg.publicHosts.includes(host)) return true;
  return cfg.allowedOrigins.some((o) => {
    try {
      return new URL(o).host === host;
    } catch {
      return false;
    }
  });
}

/**
 * Combined API gate used by every handler. A request must always pass {@link checkAccess}
 * (same-origin / CSRF + optional Tailscale identity). A `"write"` request — one that types into a
 * terminal or creates panes — must additionally come from an authorised device (see
 * {@link deviceAuth}). Returns a 403 Response to short-circuit on denial, or null to proceed.
 */
function guard(req: Request, cfg: Config, level: "read" | "write"): Response | null {
  const gate = checkAccess(req, cfg, level);
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

// Apply the shared hardening headers (nosniff / no-referrer) to any response. Every response the
// bridge emits funnels through json(), text(), serveStatic(), or a handful of inline responses —
// all of which pass through here — so the headers are set exactly once, consistently.
function secure(res: Response): Response {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
  return res;
}

function json(data: unknown, acceptEncoding: string | null): Response {
  return secure(gzipJsonResponse(data, acceptEncoding));
}

/**
 * A JSON error body with a non-200 status (e.g. an unknown-session 404). The body is tiny (below the
 * gzip threshold), so a plain uncompressed JSON response is the whole story — no need for the gzip
 * path. `acceptEncoding` is accepted for call-site symmetry with {@link json} but not needed here.
 */
function jsonError(message: string, status: number, _acceptEncoding: string | null): Response {
  return secure(
    new Response(JSON.stringify({ error: message }), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    }),
  );
}

function text(body: string, status: number): Response {
  return secure(new Response(body, { status }));
}

/**
 * Validate an untrusted /api/notifications/prefs body into a partial patch. Only the known keys are
 * considered and each, if present, must be a boolean — a non-boolean value is rejected (null return
 * → 400). Unknown keys are ignored. An empty patch is valid (a no-op that echoes current prefs).
 * Pure + exported so the validation is unit-testable without Bun.serve.
 */
export function parseNotifyPrefsPatch(v: unknown): Partial<NotifyPrefs> | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const patch: Partial<NotifyPrefs> = {};
  for (const key of ["blocked", "done", "updates"] as const) {
    if (!(key in o)) continue;
    if (typeof o[key] !== "boolean") return null;
    patch[key] = o[key] as boolean;
  }
  return patch;
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

/**
 * Resolve a request pathname to an absolute path under `webDir`, or null if it escapes. Pure +
 * exported for tests. The `full === webDir || full.startsWith(webDir + sep)` check rejects both
 * `..` traversal AND a sibling dir that merely shares the prefix (e.g. `web/dist-x` vs `web/dist`) —
 * a bare `startsWith(webDir)` would let the latter through.
 */
export function resolveStaticPath(
  pathname: string,
  webDir: string = WEB_DIR,
): { rel: string; full: string } | null {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const full = normalize(join(webDir, rel));
  if (full !== webDir && !full.startsWith(webDir + sep)) return null;
  return { rel, full };
}

async function serveStatic(pathname: string): Promise<Response> {
  const resolved = resolveStaticPath(pathname);
  if (!resolved) return text("forbidden", 403);
  let { rel, full } = resolved;

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
  return secure(new Response(file, { headers }));
}
