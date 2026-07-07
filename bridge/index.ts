import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { AuditLog, fileAuditAppender } from "./audit.ts";
import { loadConfig } from "./config.ts";
import { EventPoker } from "./event-poker.ts";
import { HerdrClient } from "./herdr-client.ts";
import { NotifyPrefsStore } from "./notify-prefs.ts";
import { Push } from "./push.ts";
import { startServer } from "./server.ts";
import { Snooze } from "./snooze.ts";
import { StateEngine } from "./state-engine.ts";
import { SWEEP_INTERVAL_MS, sweepUploads } from "./uploads.ts";

// Entry point: resolve config, wire the pieces, start polling and serving.
const cfg = loadConfig();

// Ensure the state dir exists with private (0700) perms before push/snooze/uploads write into it —
// it holds push subscription endpoints and uploaded images, so keep it owner-only.
await mkdir(cfg.stateDir, { recursive: true, mode: 0o700 });

const herdr = new HerdrClient(cfg.socketPath);

// Fail fast with a clear message if Herdr isn't reachable at startup.
if (!(await herdr.ping())) {
  console.warn(
    `[bridge] cannot reach Herdr socket at ${cfg.socketPath} yet — ` +
      `will keep retrying on the poll loop. Is the Herdr server running?`,
  );
}

const push = new Push(cfg);
await push.init();

const snooze = new Snooze(cfg);
await snooze.load();

const notifyPrefs = new NotifyPrefsStore(cfg);
await notifyPrefs.load();

const engine = new StateEngine(herdr, cfg.pollMs);
engine.start();

// Event-poked polling: a long-lived events.subscribe stream pokes an immediate re-poll on any herd
// change, and while it's healthy the interval relaxes to the safety-net cadence. Events are ONLY a
// poke — the snapshot poll stays the source of truth — so a missed event costs one interval, not
// correctness. The fresh snapshot after any pane lifecycle change re-scopes the subscriptions.
const poker = new EventPoker(herdr);
poker.onPoke(() => engine.pokeNow());
poker.onHealth((h) => engine.setCadence(h ? cfg.pollIdleMs : cfg.pollMs));
engine.onUpdate((s) => poker.setAgentPanes(s.agents.map((a) => a.paneId)));
poker.start();

// Append-only audit trail of write-level actions (see audit.ts). A write failure here is swallowed
// inside record() so it can never break the user action it's auditing.
const audit = new AuditLog(fileAuditAppender(join(cfg.stateDir, "audit.log")));

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

const server = startServer({ cfg, herdr, engine, push, snooze, notifyPrefs, audit });

const shutdown = async () => {
  console.log("\n[bridge] shutting down");
  // Stop accepting new connections and let in-flight requests drain briefly (non-forced stop)
  // before we tear down the poll loop and exit.
  await server.stop();
  poker.stop();
  engine.stop();
  clearInterval(sweepTimer);
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
