import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

import { ActivityLedger } from "./activity.ts";
import { AuditLog, fileAuditAppender } from "./audit.ts";
import { beaconReader, hooksInstalledProbe } from "./beacon-io.ts";
import { withAgentBeacons } from "./beacon/decorate.ts";
import { withAgentHints } from "./beacon/hint.ts";
import { loadConfig } from "./config.ts";
import { EventPoker } from "./event-poker.ts";
import { HERDR_DIAL_MODE_OPTION } from "./mux/herdr/adapter.ts";
import { DEFAULT_TIMEOUT_MS } from "./mux/herdr/client.ts";
import { buildMuxRegistry, createMux, DEFAULT_MUX, factoryFor, type MuxTarget } from "./mux/registry.ts";
import { TMUX_BINARY_OPTION } from "./mux/tmux/adapter.ts";
import type { MuxAdapter } from "./mux/types.ts";
import { ZELLIJ_BINARY_OPTION } from "./mux/zellij/adapter.ts";
import { NotificationCoordinator, makeNotifySink, type NotifyClock } from "./notifications.ts";
import { NotifyPrefsStore } from "./notify-prefs.ts";
import { filePairingIo, PairingStore } from "./pairing.ts";
import { runBootGate } from "./pack/boot-gate.ts";
import { PEER_BROWSER_ENV, resolvePackRuntime, warnsOnWildcardBind } from "./pack/config.ts";
import { deposedAnswer, deposedStateFrom, outcomeNow, selfHeal, type DeposedState } from "./pack/deposed.ts";
import { LeadContact } from "./pack/lead-contact.ts";
import { dialTls, peerListenerTls } from "./pack/transport.ts";
import { commitPackChange } from "./pack/enrollment.ts";
import { PackLead } from "./pack/lead.ts";
import { leadLabel } from "./pack/merge.ts";
import { herdPushGate, PeerNotifier } from "./pack/notify.ts";
import { packHelloBudget, packTimeoutBudget, packTimeoutClampWarning, PeerClient } from "./pack/peer-client.ts";
import { PackRegistry } from "./pack/registry.ts";
import { createPackRouter } from "./pack/router.ts";
import { formatMarker, markerFor, packRuntimePath, rosterDrift } from "./pack/staleness.ts";
import { enrollmentOf, TrustStore, type TrustStoreData, type Warrant } from "./pack/trust-store.ts";
import { currentWarrant, refreshWarrant } from "./pack/warrant.ts";
import { Push } from "./push.ts";
import { pluginRoot } from "./root.ts";
import { startServer } from "./server.ts";
import {
  deriveConfigRoot,
  herdTagFor,
  SessionRegistry,
  type SessionFactory,
} from "./sessions.ts";
import { Snooze } from "./snooze.ts";
import { StateEngine } from "./state-engine.ts";
import {
  bridgeStampSync,
  githubTagsFetcher,
  UpdateMonitor,
  UpdateStateStore,
} from "./update.ts";
import { SWEEP_INTERVAL_MS, sweepUploads } from "./uploads.ts";
import { collieVersionBare } from "./version.ts";

// How often the registry rescans the filesystem for sessions that appeared/disappeared after boot.
const SESSION_REFRESH_MS = 15_000;
// Upstream release check cadence. Releases are rare, so poll every few hours; the first check is
// delayed so we never probe the network mid-boot.
const UPDATE_FIRST_DELAY_MS = 90_000;
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Entry point: resolve config, wire the pieces, start polling and serving.
const cfg = loadConfig();

// The pack mode, resolved BEFORE anything is wired, because a peer wires fewer things than a lead
// (PACK_PROTOCOL.md §3) and a mode discovered halfway through startup would already have opened
// what it was supposed to keep shut.
//
// Enrollment comes from the trust store and from nothing else — no env var, no flag (§3). On a solo
// instance the store file does not exist, so this is one failed `open()`: nothing is created, no key
// is generated, no default is written back and no timer is armed. That is the zero-tax contract
// (§11) holding at its startup seam — and `trustStore.load()` returning `null` is the same `null` a
// solo instance will hand `resolvePackRuntime` forever after.
const trustStore = new TrustStore(cfg.stateDir);
const bootTrust = await trustStore.load();

// Ensure the state dir exists with private (0700) perms before push/snooze/uploads write into it —
// it holds push subscription endpoints and uploaded images, so keep it owner-only.
//
// Moved AHEAD of the mode resolution by §18.11's boot gate: that gate may rewrite the trust store
// before anything else is wired, and a store written into a directory that does not exist yet is a
// boot that fails for the wrong reason.
await mkdir(cfg.stateDir, { recursive: true, mode: 0o700 });

// Append-only audit trail of write-level actions (see audit.ts). A write failure here is swallowed
// inside record() so it can never break the user action it's auditing.
//
// Constructed here, before the mode is resolved, for the boot gate's sake: a deposition is an audited
// membership change (`pack.deposed`) and it happens before there is anything else to audit with.
const audit = new AuditLog(fileAuditAppender(join(cfg.stateDir, "audit.log")), {
  content: cfg.auditContent,
});

/**
 * Gap A (PACK_PROTOCOL.md §18.9): when this collie's lead last called it.
 *
 * Constructed unconditionally and armed by nothing — it holds two `null`s and this process's start
 * time until the router hands it a receipt, so a solo instance carries an object and no behaviour.
 * In memory on purpose (`bridge/pack/lead-contact.ts` says why at length).
 */
const leadContact = new LeadContact(Date.now());

/** This process's deposed state (§18.12), or `null`. Set at most once, at boot or from the wire. */
let deposed: DeposedState | null = null;

/**
 * One pack client, built the same way for the boot gate and for the lead's sweep — because two would
 * be two places for a pack request to forget its budget, its pin or its secret.
 */
function packPeerClient(data: TrustStoreData): PeerClient {
  return new PeerClient({
    self: data.self.memberId,
    // Read at call time so a rotation is picked up without a restart (§8.3, §8.4).
    secret: () => trustStore.current()?.pack?.secret ?? null,
    // Strictly below the lead's own poll interval, so a slow peer can never stall this snapshot
    // (§10.1). The clamp lives in packTimeoutBudget; nothing here is allowed to widen it.
    timeoutMs: packTimeoutBudget(cfg.pollMs),
    // …and the patient one, which the poll fraction deliberately does not clamp (§10.4). A cold
    // pinned-TLS handshake over a relay costs more than a whole poll budget, so the strict budget can
    // decide "this poll is stale" but must never be what decides "this peer is gone", nor what a cold
    // link's FIRST data request has to fit inside — see packHelloBudget and takeDataBudget for the
    // measurements that produced this pair. It is also the boot gate's whole budget (§18.11).
    patientTimeoutMs: packHelloBudget(cfg.pollMs),
    fetch: (url, init) => fetch(url, init),
    // Pinned mutual TLS, per member, read through the store on every dial for the same reason the
    // secret and the roster are: `pack remove`, a re-join and a rotation all change what this lead
    // may pin, and a captured copy would keep trusting a certificate the operator revoked. A member
    // we cannot build a pin for is dialled with no TLS material at all — which the peer's own
    // listener then refuses at the handshake, i.e. `unreachable`, never an unpinned connection.
    tls: (link) => {
      const member = trustStore.current()?.peers.find((p) => p.memberId === link.memberId);
      return member === undefined ? undefined : (dialTls(trustStore.current(), member) ?? undefined);
    },
  });
}

/**
 * Act on a deposition proof: self-heal to `peer` where the proof allows it, park where it does not,
 * and **say so either way** (§18.12; RFC §12, F11 makes the announcement part of the security
 * property rather than the UX — a re-entry the operator does not see is one they cannot decide about).
 */
async function applyDeposition(proof: Warrant | null, reason: string): Promise<DeposedState> {
  const data = trustStore.current();
  const heal = data === null ? ({ outcome: "parked", reason: "no-proof" } as const) : selfHeal(data, proof);
  const state =
    data === null
      ? { outcome: "parked-unverifiable" as const, leadMemberId: null, generation: 0, at: Date.now(), packName: null, reason: "no-proof" as const }
      : deposedStateFrom(data, proof, heal, Date.now());
  if (heal.outcome === "healed") {
    await commitPackChange(trustStore, audit, (current) => (current === null ? null : heal.change));
    console.warn(
      `[pack] DEPOSED — ${reason}. This machine has demoted itself to a peer of "${state.leadMemberId}" ` +
        `(warrant generation ${state.generation}) on materials both machines already held. Its front door ` +
        "is down and its health check now fails; run `collie unserve` here when convenient.",
    );
  } else {
    audit.record({
      action: "pack.deposed",
      detail: { lead: state.leadMemberId, generation: state.generation, outcome: "parked", reason: heal.reason },
    });
    console.warn(
      `[pack] DEPOSED — ${reason}. This machine could NOT rejoin by itself and has parked: ` +
        `${heal.reason}. Recover it with \`collie pack add\` from the new lead, or \`collie join\`.`,
    );
  }
  return state;
}

// ── The boot-time gate against a split brain (§18.11) ────────────────────────
// A collie booting into `lead` mode with a non-empty roster asks its members ONCE, concurrently, on
// the patient budget, BEFORE it publishes anything. Silence publishes; a conflicting answer deposes.
// Nothing is armed and nothing repeats — this is boot-only, and it is not an election (§15).
{
  const data = trustStore.current();
  if (data !== null && resolvePackRuntime(enrollmentOf(data)).mode === "lead") {
    const client = packPeerClient(data);
    const verdict = await runBootGate({
      links: data.peers
        .filter((p) => p.status === "enrolled")
        .map((p) => ({ memberId: p.memberId, address: p.address })),
      hello: (link) => client.hello(link),
      generation: currentWarrant(data)?.warrant.generation ?? 0,
    });
    if (verdict.kind === "deposed") {
      const state = await applyDeposition(verdict.proof, verdict.reason);
      // A boot-time HEAL needs no deposed page: the mode is resolved below from the healed store, so
      // this process comes up as an ordinary peer in the very same boot, having published nothing in
      // between. That is the common case and the whole reason the gate sits at boot (§18.11).
      deposed = state.outcome === "healed" ? null : state;
    }
  }
}

// The mode is resolved AFTER the gate, from whatever the gate left on disk — a machine that healed
// boots as a peer, wires a peer's listener and serves no front door, with no second process involved.
const enrollment = enrollmentOf(trustStore.current());
const pack = resolvePackRuntime(enrollment);
if (pack.conflict) console.warn(`[pack] ${pack.conflict}`);
if (pack.mode !== "solo") console.log(`[pack] mode: ${pack.mode}`);

// The roster THIS PROCESS wired, left on disk for `collie pack status` to compare the store against
// (bridge/pack/staleness.ts). A membership change can arrive over the wire — the first enrollment
// lands in a running lead, a promotion demotes a running lead — and no re-read follows, by design.
//
// Gated on a trust store EXISTING: a solo instance writes no file here, which is §11's zero-tax
// contract. Best effort throughout — a marker is a diagnostic, and one that failed to write must
// never be a reason a bridge does not come up.
//
// Built from the store AS THE GATE LEFT IT, not from the bytes read at line one: a machine that
// self-healed at boot (§18.11) really did wire a peer's roster, and a marker claiming otherwise
// would make `pack status` report drift against a store that is perfectly in step.
const bootMarker = markerFor(trustStore.current(), Date.now(), process.pid);
if (bootTrust !== null) {
  try {
    await writeFile(packRuntimePath(cfg.stateDir), formatMarker(bootMarker), { mode: 0o600 });
  } catch (err) {
    console.warn(`[pack] could not record the boot roster: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * A membership change landed on THIS running process, from the wire. Say so, once per change, with
 * the verb that fixes it — the store is already correct, and this process is not.
 */
function packStoreChanged(): void {
  const drift = rosterDrift(bootMarker, trustStore.current());
  if (drift === null) return;
  console.warn(
    "[pack] the trust store changed under this running process — it still holds the roster it read " +
      "at boot. Run `collie restart` on THIS machine to activate the change.",
  );
  if (drift.gained.length > 0) console.warn(`[pack]   enrolled but not yet active: ${drift.gained.join(", ")}`);
  if (drift.lost.length > 0) console.warn(`[pack]   no longer members: ${drift.lost.join(", ")}`);
  if (drift.modeChanged !== null) {
    console.warn(
      `[pack]   this machine is now a ${drift.modeChanged}, but the process is still running as a ` +
        `${bootMarker.mode} — its listener and its front door are the ${bootMarker.mode}'s until it restarts.`,
    );
  }
}

// ── Process-global services, shared across every session ─────────────────────
const push = new Push(cfg);
await push.init();

const snooze = new Snooze(cfg);
await snooze.load();

const notifyPrefs = new NotifyPrefsStore(cfg);
await notifyPrefs.load();

// Device pairing (bridge/pairing.ts). Constructed unconditionally and holding no state of its own:
// it re-reads `<stateDir>/paired-devices.json` per request (cached on mtime), so `collie pair` and
// `collie devices revoke` land on the RUNNING service without the restart every other backend change
// needs. An empty registry — the state every existing install starts in — enforces nothing.
const pairing = new PairingStore(filePairingIo(cfg.stateDir));

// When each pane last moved, and when you last looked at it — the two numbers the dashboard sorts
// and triages by (see activity.ts). Process-global and keyed by session name, because pane ids are
// session-scoped and collide across sessions.
const activity = new ActivityLedger(cfg);
await activity.load();

// ── Update-availability monitor ───────────────────────────────────────────────
// The running plugin version, captured NOW at module load — never re-read from disk later, or a
// post-pull package.json would mask the very update we detect (same class of bug as the buildId gap).
// The bridge-source stamp is snapshotted here too, so a rebuilt-but-not-restarted process reads stale.
const rootDir = pluginRoot();
const bridgeDir = join(rootDir, "bridge");
// SAFETY: this is the plugin's OWN package.json, shipped in the same checkout as this file, and
// `scripts/check-version.sh` gates every build on its `version` being present and agreeing with the
// manifest — so the field is guaranteed by the release process, not hoped for.
const currentVersion = (
  JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8")) as { version: string }
).version;

// What this process answers `GET /pack/v1/hello` with (PACK_PROTOCOL.md §5, §7.1). Resolved ONCE,
// here, by the same rule `collie version` uses (`bridge/version.ts`, shared with `cli/context.ts`)
// so one machine never reports two different versions — and never per request, since the answer
// cannot change without a restart. Bare: no `(manifest; web not built)` parenthetical on the wire,
// or a machine with an unbuilt bundle would read as skewed against every peer including itself.
const packVersion = collieVersionBare(rootDir);

const updateStore = new UpdateStateStore(cfg);
await updateStore.load();

// The repo the release check + release links point at. Defaults to Collie's own; overridable for a
// fork (or a synthetic test target) via COLLIE_UPDATE_REPO.
const updateRepo = process.env.COLLIE_UPDATE_REPO?.trim() || "AltanS/collie";
const updateMonitor = new UpdateMonitor({
  repo: updateRepo,
  current: currentVersion,
  startupStamp: bridgeStampSync(bridgeDir, rootDir),
  fetchTags: githubTagsFetcher(updateRepo),
  bridgeStamp: () => bridgeStampSync(bridgeDir, rootDir),
  store: updateStore,
  now: Date.now,
  // The `updates` notify pref is the off-switch — update pushes bypass snooze, so this is their gate.
  updatesEnabled: () => notifyPrefs.current().updates,
  notify: (latest) =>
    void push.send({
      type: "update",
      tag: "collie:update",
      // No command in the body — the tap opens Settings (target below), and the update banner / linked
      // release page carry the location-independent Herdr actions. Keeps this off the cwd-dependent path.
      title: "Collie update available",
      body: `Version ${latest} is available`,
      target: "settings",
    }),
});

// First check delayed (don't probe mid-boot); then every few hours. unref() so neither timer holds
// the process open; both cleared on shutdown.
const updateFirstCheck = setTimeout(() => void updateMonitor.checkRelease(), UPDATE_FIRST_DELAY_MS);
updateFirstCheck.unref();
const updateTimer = setInterval(() => void updateMonitor.checkRelease(), UPDATE_INTERVAL_MS);
updateTimer.unref();

// The multiplexers this build can drive. Built once — the map is derived from each factory's own
// name, so a key can never drift from the adapter it resolves to.
const muxRegistry = buildMuxRegistry();

// Are the agent's own hooks installed (M11/02)? Probed through `cli/hooks.ts`'s definition of
// "installed", cached for a few seconds, and shared by every session: it is a property of this HOST,
// not of one herd. It is what decides whether a blind adapter's beacon capabilities are lifted —
// never whether a beacon happens to be on disk, which would make the declaration flicker.
const hooksInstalled = hooksInstalledProbe({ home: homedir(), env: process.env });

/**
 * The adapter, with agent beacons around it when the multiplexer cannot see agents on its own.
 *
 * A multiplexer that reports the agent and its session from its own wire is left ALONE — it has the
 * stronger source of truth, and the decorator refuses to wrap it anyway (bridge/beacon/decorate.ts).
 * The two conditions are the same one, read from two sides: an adapter contributes a beacon matcher
 * exactly when it is blind, and the decorator refuses exactly when it is not.
 */
function withBeaconsIfBlind(adapter: MuxAdapter, target: MuxTarget): MuxAdapter {
  const matcher = factoryFor(muxRegistry, adapter.mux)?.beaconMatcher?.(target);
  const seeing = matcher === undefined ? adapter : withAgentBeacons(adapter, beaconReader(cfg.stateDir), { matcher, hooksInstalled });
  // The hint tier sits OUTSIDE the decorator, so it reads the DECORATED declaration and retires
  // itself the moment that declaration says agents are visible (M11/05). Applied to every adapter,
  // including one that was never decorated: it suppresses itself there for the same reason.
  return withAgentHints(seeing, { hooksInstalled });
}

// ── Per-session runtime factory ──────────────────────────────────────────────
// One mux adapter + StateEngine + EventPoker + NotificationCoordinator per herd session. The
// registry calls this for the primary at construction and for each session discovered later. Push,
// snooze, notify-prefs, the audit log and the uploads dir stay process-global (shared here).
//
// THE ADAPTER IS BUILT THROUGH THE MUX REGISTRY and this is the only place that happens. `COLLIE_MUX`
// picks it and defaults to Herdr, so a deployment that sets nothing behaves exactly as it always has.
// The endpoint fork is the one thing this site knows: Herdr's endpoint IS the discovered session
// socket, and every other adapter is told where it lives by its own `COLLIE_MUX_ENDPOINT_<NAME>`
// (config.ts). Both per-adapter knobs ride the target's OPAQUE options — which local dialer opens a
// filesystem-path endpoint is Herdr's question, where the tmux binary is, is tmux's, and the registry
// reads neither key.
const makeSession: SessionFactory = (name, socketPath, isPrimary) => {
  const target = {
    endpoint: cfg.mux === DEFAULT_MUX ? socketPath : cfg.muxEndpoint,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    options: {
      [HERDR_DIAL_MODE_OPTION]: cfg.dialMode ?? "auto",
      [TMUX_BINARY_OPTION]: cfg.tmuxBin,
      [ZELLIJ_BINARY_OPTION]: cfg.zellijBin,
    },
  };
  const herdr = withBeaconsIfBlind(createMux(muxRegistry, cfg.mux, target), target);
  const engine = new StateEngine(herdr, cfg.pollMs);

  // Event-poked polling: a long-lived watch on the multiplexer pokes an immediate re-poll on any
  // herd change, and while it's healthy the interval relaxes to the safety-net cadence. Events are
  // ONLY a poke — the snapshot poll stays the source of truth — so a missed one costs one interval,
  // not correctness. The fresh snapshot after any pane lifecycle change re-scopes the watch.
  const poker = new EventPoker(herdr);
  poker.onPoke(() => engine.pokeNow());
  poker.onHealth((h) => engine.setCadence(h ? cfg.pollIdleMs : cfg.pollMs));
  engine.onUpdate((s) => poker.setAgentPanes(s.agents.map((a) => a.paneId)));

  // Activity bookkeeping. A status change stamps `activeAt` (the only thing that can make a pane
  // read as unseen); every successful poll reconciles the ledger against the panes that exist, which
  // seeds first sightings as already-seen and reaps closed ones. Reconciling covers bare shells too,
  // which the engine's agent-derived removal event never reports.
  engine.onTransition((agent) => activity.noteActive(name, agent.paneId));
  engine.onUpdate((s) =>
    activity.reconcile(name, [...s.agents, ...s.shellPanes].map((p) => p.paneId)),
  );

  // Background notifications on lifecycle transitions (foreground toasts are computed client-side by
  // diffing snapshots). Each session gets its own coordinator + notification slot: the primary keeps
  // the bare `collie:herd` tag (so pre-feature notifications don't orphan) and omits the session name
  // from the payload; every other session tags `collie:herd:<name>` and carries the name for deep-links.
  const clock: NotifyClock<ReturnType<typeof setTimeout>> = {
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: (h) => clearTimeout(h),
  };
  // In peer mode this machine's own herd alerts are muted at the sink: the lead derives them from the
  // swept snapshot and owns the one phone registration (PACK_PROTOCOL.md §5). Nothing is deleted —
  // see herdPushGate. Solo and lead get `snooze` back by identity, so there is no pack tax here.
  const sink = makeNotifySink(push, herdPushGate(pack.mode, snooze), herdTagFor(isPrimary, name), {
    session: isPrimary ? undefined : name,
  });
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
  // Multi-session discovery walks HERDR's config root for herdr sockets — it is that adapter's own
  // shape, not the port's, so it is off for any other multiplexer rather than scanning for sockets
  // nothing there would answer. A tmux collie fronts one tmux server, which is what its endpoint names.
  multiSession: cfg.multiSession && cfg.mux === DEFAULT_MUX,
  listSessionDirs,
  exists: (p) => existsSync(p),
});

// Fail soft with a clear message if the PRIMARY multiplexer isn't reachable at startup. Other
// sessions come up lazily via refresh(); an unreachable one just reads `reachable:false` in the list.
const primary = registry.get();
if (primary && !(await primary.herdr.reachable())) {
  console.warn(
    `[bridge] cannot reach ${cfg.mux} at ${cfg.mux === DEFAULT_MUX ? cfg.socketPath : cfg.muxEndpoint || "its default server"} yet — ` +
      `will keep retrying on the poll loop. Is it running?`,
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
const sweepNow = async (when: string): Promise<void> => {
  const removed = await sweepUploads(uploadsDir);
  if (removed.length) console.log(`[uploads] swept ${removed.length} expired image(s)${when}`);
};
void sweepNow(" at startup");
const sweepTimer = setInterval(() => void sweepNow(""), SWEEP_INTERVAL_MS);
sweepTimer.unref();

// ── The lead runtime ─────────────────────────────────────────────────────────
// Built only in `lead` mode — which `deriveMode` defines as "≥1 enrolled peer and no lead of my
// own". So the condition under which `servers` goes on the wire is exactly "a pack with peers
// exists": an instance that has a trust store but has enrolled nobody keeps emitting a solo body,
// and a peer builds none at all (it has no peers to sweep, and a pack link never forwards a
// `host=` — PACK_PROTOCOL.md §4, §9.2, §11).
// The lead's notification coordinators for its peers — one phone registration, on the lead (§5).
// Built only in `lead` mode, so a solo instance holds no map and adds no tag (§11); it arms nothing
// on its own, being driven entirely by bodies the sweep hands it below. The lead's OWN snooze and
// notify-prefs are what it reads, which is what makes them pack-wide by construction.
const peerNotifier =
  pack.mode === "lead"
    ? new PeerNotifier<ReturnType<typeof setTimeout>>({
        clock: { schedule: (fn, ms) => setTimeout(fn, ms), cancel: (h) => clearTimeout(h) },
        push,
        mute: snooze,
        delayMs: cfg.notifyDelayMs,
        isNotifiable: (status) => notifyPrefs.isNotifiable(status),
      })
    : undefined;

// ── The transport half of §8.1's first factor ────────────────────────────────
// A PEER pins its lead's certificate on its own listener, so BoringSSL refuses an unpinned or absent
// client certificate at the handshake and the admission gate is told, as a fact it cannot be lied to
// about, that the transport already did its half (`bridge/pack/transport.ts`).
//
// A LEAD pins nothing here: its pack surface rides the front door, which terminates TLS. Peer→lead
// requests carry a §8.6 signature instead. A SOLO instance never reaches this — `listenerTls` is
// `null` and no `tls` key is passed to `Bun.serve` (§11: "Ports opened — exactly one, loopback, as
// today", unchanged in shape as well as in count).
//
// MIS-WIRING IS FAIL-CLOSED, NOT DEGRADED: a peer whose store cannot produce an anchor gets
// `transportPinned === false`, and admission then refuses every request rather than running on the
// pack secret alone.
const listenerTls = peerListenerTls(pack.mode, trustStore.current());
const transportPinned = listenerTls !== null;
if (pack.mode === "peer" && !transportPinned) {
  console.warn(
    "[pack] this peer could not build its pinned listener (no enrolled lead certificate in the trust " +
      "store) — the pack surface will refuse every request. Re-run `collie join` on this machine.",
  );
}
if (transportPinned && pack.peerServesBrowser) {
  console.warn(
    `[pack] ${PEER_BROWSER_ENV} is set, but this peer's port now requires the lead's client certificate ` +
      "at the TLS handshake — a browser cannot present one, so the browser surface is unreachable here. " +
      "Use the lead's front door, or leave the pack on this machine.",
  );
}
// The peer's pack listener binds COLLIE_HOST (one address, PACK_PROTOCOL.md §3) — the operator owns
// that bind, exactly as they own reachability everywhere else. A wildcard bind is not a hole: pinned
// mutual TLS + the pack secret still gate every request. But it widens WHICH networks can attempt the
// gate to all of them, so say so, loudly, once — and do NOT refuse to start (ADR 0013: a peer warns
// rather than fails; the same posture as the lead's front-door detection). A specific overlay/LAN
// address bounds it; loopback-only refuses the lead, which is why the operator set it wide.
if (warnsOnWildcardBind(pack.mode, cfg.host)) {
  const shown = cfg.host.trim() === "" ? "0.0.0.0/:: (COLLIE_HOST empty → all interfaces)" : cfg.host;
  console.warn(
    `[pack] this peer's pack listener binds ${shown} — reachable on ALL interfaces, not one. It is ` +
      "gated only by pinned mutual TLS + the pack secret; the bind bounds nothing further. Set " +
      "COLLIE_HOST to the specific overlay/LAN address the lead dials (PACK_PROTOCOL.md §3).",
  );
}

// The per-peer budget is clamped by the poll interval, and a clamp nobody is told about reads as a
// knob that does nothing. Said once, at boot, next to the other pack warnings.
{
  const clamped = packTimeoutClampWarning(cfg.pollMs);
  if (clamped !== null) console.warn(clamped);
}

const packLead = (() => {
  if (pack.mode !== "lead") return undefined;
  const data = trustStore.current();
  if (data === null) return undefined;
  const packRegistry = new PackRegistry({
    sessions: registry,
    self: data.self.memberId,
    // Read through the store on every call, never snapshotted: `join`, `leave` and a rotation all
    // change the roster under a running bridge, and a captured array would keep dialling a member
    // the operator has revoked.
    members: () => trustStore.current()?.peers ?? [],
  });
  const client = packPeerClient(data);
  return new PackLead({
    registry: packRegistry,
    snapshot: (link) => client.snapshot(link),
    // The re-ask a timed-out sweep earns (§10.4). Off the tick, on the patient budget — and the
    // connection it warms is the one the next strict-budget snapshot rides, which is what makes a
    // high-latency member converge on `reachable` instead of never bootstrapping at all.
    hello: (link) => client.hello(link),
    // The per-pane forward (§5, §9.1). `proxy`, not `raw`: the peer's own status codes — its 304
    // above all — are the answer, and flattening them would cost the conditional-GET win end to end.
    proxy: (link, route, params, init) => client.proxy(link, route, params, init),
    // servers[].name is an operator-facing MACHINE label (§9.2), same as every peer's `join` label —
    // never the pack's name, which is not a roster member and would collide visually with the peers'
    // per-machine labels. See leadLabel's doc for the hostname/fallback rule.
    self: { id: data.self.memberId, name: leadLabel(hostname(), data.self.memberId) },
    // Notifications for a peer's panes, derived on the lead from the body this sweep just parsed and
    // pushed through the same coordinator machinery a local session uses (M4/06).
    onPeerSnapshot: (memberId, body) => peerNotifier?.observe(memberId, body),
    onPeerGone: (memberId) => peerNotifier?.forget(memberId),
    // Warrant distribution (§18). Read through the store on every sweep for the reason the secret and
    // the roster are: `pack deputy` writes the designation in another process, and a captured copy
    // would keep pushing a warrant the operator has already superseded. A lead that has named nobody
    // has no warrant, `current()` answers `null`, and not one byte moves.
    warrant: {
      current: async (at) => {
        // The refresh is a WRITE, and it is the only one on this path: at most one an hour, and only
        // when a warrant exists (`refreshWarrant` answers `null` for everything else, including a
        // warrant already past its 30 days — a dark pack disarms rather than silently re-arming).
        await commitPackChange(trustStore, audit, (current) =>
          current === null ? null : refreshWarrant(current, at),
        );
        const held = trustStore.current();
        const stored = currentWarrant(held);
        if (stored === null || held === null) return null;
        // The deputy's certificate rides the push because a peer has no roster beyond its lead and
        // could not otherwise pin the second anchor (§18). Taken from THIS lead's roster, so it is
        // the certificate the lead itself pins — never a copy kept beside the warrant.
        const deputy = held.peers.find((p) => p.memberId === stored.warrant.deputyMemberId);
        if (stored.warrant.deputyMemberId !== null && deputy === undefined) return null;
        return deputy === undefined
          ? { warrant: stored.warrant }
          : { warrant: stored.warrant, deputyCertPem: deputy.certPem };
      },
      push: (link, payload) => client.warrant(link, payload),
    },
    // §18.10's fast path: a member told this lead, in as many words, that it follows somebody else.
    // Best-effort and time-boxed (it works only while this lead is still in that member's anchor
    // list), so it is a shortcut on top of the boot gate and never a replacement for it.
    onLeadConflict: (memberId, proof) =>
      void (async () => {
        if (deposed !== null) return;
        deposed = await applyDeposition(proof, `"${memberId}" says it follows another lead`);
      })(),
  });
})();

// THE SWEEP RIDES THE EXISTING POLL — there is no second timer (§10.1, §11). The primary session's
// engine is the lead's clock: it is created eagerly, never disposed, and already ticks at
// COLLIE_POLL_MS (relaxing to the idle cadence with the herd), so the pack inherits the exact
// cadence and idle relaxation the herd link has. `onTick` rather than `onUpdate` so a local Herdr
// outage cannot freeze a healthy peer's freshness.
// A DEPOSED collie stops polling (§18.12): its roster is void as a *lead's* roster, and dialling it
// would be a second lead's traffic on a pack that has already moved on. It keeps the roster's
// CONTENTS — the self-heal reads the new lead's certificate out of it — but it dials nobody.
if (packLead) registry.get()?.engine.onTick(() => (deposed === null ? void packLead.sweep() : undefined));

const server = startServer({
  cfg,
  registry,
  push,
  snooze,
  notifyPrefs,
  updateMonitor,
  audit,
  activity,
  pack,
  pairing,
  packLead,
  peerNotifier,
  // Registered on the EXISTENCE of a trust store, not on the mode: a lead answering its very first
  // `collie join` still has zero peers and is therefore still `solo` by mode. An instance that never
  // enrolled has no store, gets no handler, and so registers no pack route at all (§11). The
  // surface is handed back by server.ts so a peer answers its lead out of the same closures its own
  // browser routes use — the same snapshot body, and the same session-scoped handlers (§5).
  packRouter:
    trustStore.current() === null
      ? undefined
      : (surface) =>
          createPackRouter({
            store: trustStore,
            audit,
            transportPinned,
            version: packVersion,
            onMembershipChange: packStoreChanged,
            // Gap A (§18.9), and its rotation-shaped sibling. Two receipts, one holder, in memory.
            onLeadDialled: (at) => leadContact.record(at),
            onLeadRefused: (at) => leadContact.recordSecretRefusal(at),
            // §18.12's delivery path 1: the new lead tells this one, on first contact. The router has
            // already verified the proof against THIS collie's own certificate and written the healed
            // store; what is left is for the process to say so and to stop being a front door.
            onDeposed: (state) => {
              deposed ??= state;
            },
            ...surface,
          }),
  // Peer only, and only when the pin could actually be built. See `transportPinned` above.
  tls: listenerTls ?? undefined,
  // The one page a deposed collie serves, and the health check it must now fail (§18.12). `undefined`
  // until something deposes this process, so an ordinary instance's dispatch is byte-identical.
  deposed: (_req, url) => (deposed === null ? null : deposedAnswer(deposed, outcomeNow(deposed, leadContact.facts()), url)),
});

const shutdown = async () => {
  console.log("\n[bridge] shutting down");
  // Stop accepting new connections and let in-flight requests drain briefly (non-forced stop)
  // before we tear down the poll loops and exit.
  await server.stop();
  clearInterval(refreshTimer);
  registry.disposeAll();
  // Writes are debounced, so the last few seconds of "you looked at this" live only in memory —
  // persist them before exiting, or every restart quietly resurrects alerts you'd already cleared.
  activity.stop();
  await activity.flush();
  clearInterval(sweepTimer);
  clearTimeout(updateFirstCheck);
  clearInterval(updateTimer);
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
