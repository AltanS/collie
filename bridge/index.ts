import { existsSync, readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { AuditLog, fileAuditAppender } from "./audit.ts";
import { loadConfig } from "./config.ts";
import { EventPoker } from "./event-poker.ts";
import { HerdrClient } from "./herdr-client.ts";
import { NotificationCoordinator, makeNotifySink, type NotifyClock } from "./notifications.ts";
import { NotifyPrefsStore } from "./notify-prefs.ts";
import { Push } from "./push.ts";
import { startServer } from "./server.ts";
import {
  deriveConfigRoot,
  herdTagFor,
  SessionRegistry,
  type SessionFactory,
} from "./sessions.ts";
import { Snooze } from "./snooze.ts";
import { StateEngine } from "./state-engine.ts";
import { SWEEP_INTERVAL_MS, sweepUploads } from "./uploads.ts";

// How often the registry rescans the filesystem for sessions that appeared/disappeared after boot.
const SESSION_REFRESH_MS = 15_000;

// Entry point: resolve config, wire the pieces, start polling and serving.
const cfg = loadConfig();

// Ensure the state dir exists with private (0700) perms before push/snooze/uploads write into it —
// it holds push subscription endpoints and uploaded images, so keep it owner-only.
await mkdir(cfg.stateDir, { recursive: true, mode: 0o700 });

// ── Process-global services, shared across every session ─────────────────────
const push = new Push(cfg);
await push.init();

const snooze = new Snooze(cfg);
await snooze.load();

const notifyPrefs = new NotifyPrefsStore(cfg);
await notifyPrefs.load();

// Append-only audit trail of write-level actions (see audit.ts). A write failure here is swallowed
// inside record() so it can never break the user action it's auditing.
const audit = new AuditLog(fileAuditAppender(join(cfg.stateDir, "audit.log")));

// ── Per-session runtime factory ──────────────────────────────────────────────
// One HerdrClient + StateEngine + EventPoker + NotificationCoordinator per herdr session. The
// registry calls this for the primary at construction and for each session discovered later. Push,
// snooze, notify-prefs, the audit log and the uploads dir stay process-global (shared here).
const makeSession: SessionFactory = (name, socketPath, isPrimary) => {
  const herdr = new HerdrClient(socketPath);
  const engine = new StateEngine(herdr, cfg.pollMs);

  // Event-poked polling: a long-lived events.subscribe stream pokes an immediate re-poll on any herd
  // change, and while it's healthy the interval relaxes to the safety-net cadence. Events are ONLY a
  // poke — the snapshot poll stays the source of truth — so a missed event costs one interval, not
  // correctness. The fresh snapshot after any pane lifecycle change re-scopes the subscriptions.
  const poker = new EventPoker(herdr);
  poker.onPoke(() => engine.pokeNow());
  poker.onHealth((h) => engine.setCadence(h ? cfg.pollIdleMs : cfg.pollMs));
  engine.onUpdate((s) => poker.setAgentPanes(s.agents.map((a) => a.paneId)));

  // Background notifications on lifecycle transitions (foreground toasts are computed client-side by
  // diffing snapshots). Each session gets its own coordinator + notification slot: the primary keeps
  // the bare `collie:herd` tag (so pre-feature notifications don't orphan) and omits the session name
  // from the payload; every other session tags `collie:herd:<name>` and carries the name for deep-links.
  const clock: NotifyClock<ReturnType<typeof setTimeout>> = {
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: (h) => clearTimeout(h),
  };
  const sink = makeNotifySink(push, snooze, herdTagFor(isPrimary, name), isPrimary ? undefined : name);
  const notifications = new NotificationCoordinator(clock, sink, cfg.notifyDelayMs, (status) =>
    notifyPrefs.isNotifiable(status),
  );
  engine.onTransition((agent, from, to) => notifications.onTransition(agent, from, to));
  engine.onRemove((paneId) => notifications.onRemove(paneId));

  engine.start();
  poker.start();
  return { herdr, engine, poker, notifications };
};

// List the session directory names under `<configRoot>/sessions` (empty if the dir doesn't exist).
const listSessionDirs = (dir: string): string[] => {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
};

const registry = new SessionRegistry({
  configRoot: deriveConfigRoot(cfg.socketPath),
  primarySocketPath: cfg.socketPath,
  factory: makeSession,
  multiSession: cfg.multiSession,
  listSessionDirs,
  exists: (p) => existsSync(p),
});

// Fail soft with a clear message if the PRIMARY Herdr isn't reachable at startup. Other sessions come
// up lazily via refresh(); an unreachable one just reads `reachable:false` in the sessions list.
const primary = registry.get();
if (primary && !(await primary.herdr.ping())) {
  console.warn(
    `[bridge] cannot reach Herdr socket at ${cfg.socketPath} yet — ` +
      `will keep retrying on the poll loop. Is the Herdr server running?`,
  );
}

// Discover any already-running named sessions now, then rescan on an interval so a session
// started/stopped after boot is picked up (or disposed) within SESSION_REFRESH_MS. A no-op when
// multi-session is off. unref() so the timer never keeps the process alive; cleared on shutdown.
await registry.refresh();
const refreshTimer = setInterval(() => void registry.refresh(), SESSION_REFRESH_MS);
refreshTimer.unref();

// Prune uploaded images past their TTL: once at startup, then on an interval. Uploads are single-use
// (Herdr reads them by path when the message is sent), so nothing else reclaims them. unref() so the
// timer never keeps the process alive; it's also cleared on shutdown.
const uploadsDir = join(cfg.stateDir, "uploads");
void sweepUploads(uploadsDir).then((removed) => {
  if (removed.length) console.log(`[uploads] swept ${removed.length} expired image(s) at startup`);
});
const sweepTimer = setInterval(() => {
  void sweepUploads(uploadsDir).then((removed) => {
    if (removed.length) console.log(`[uploads] swept ${removed.length} expired image(s)`);
  });
}, SWEEP_INTERVAL_MS);
sweepTimer.unref();

const server = startServer({ cfg, registry, push, snooze, notifyPrefs, audit });

const shutdown = async () => {
  console.log("\n[bridge] shutting down");
  // Stop accepting new connections and let in-flight requests drain briefly (non-forced stop)
  // before we tear down the poll loops and exit.
  await server.stop();
  clearInterval(refreshTimer);
  registry.disposeAll();
  clearInterval(sweepTimer);
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
