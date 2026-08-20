import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

import { ActivityLedger } from "./activity.ts";
import { AuditLog, fileAuditAppender } from "./audit.ts";
import { beaconReader, hooksInstalledProbe } from "./beacon-io.ts";
import { withAgentBeacons } from "./beacon/decorate.ts";
import { withAgentHints } from "./beacon/hint.ts";
import { loadConfig, resolveConfigDir } from "./config.ts";
import type { PackMode } from "./types.ts";
import { EventPoker } from "./event-poker.ts";
import {
  instanceSuffixOf,
  managedHandlerPath,
  realFrontDoorExec,
  realFrontDoorFiles,
  releaseManagedFrontDoor,
  shouldReleaseFrontDoor,
} from "./front-door.ts";
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
import { deputyAnchorOf, dialTls, peerListenerTls } from "./pack/transport.ts";
import { commitPackChange } from "./pack/enrollment.ts";
import { PackLead } from "./pack/lead.ts";
import { leadLabel } from "./pack/merge.ts";
import { herdPushGate, PeerNotifier } from "./pack/notify.ts";
import { packHelloBudget, packTimeoutBudget, packTimeoutClampWarning, PeerClient } from "./pack/peer-client.ts";
import { PackRegistry } from "./pack/registry.ts";
import { createPackRouter, type PackRouterDeps } from "./pack/router.ts";
import {
  checkpointMarker,
  formatMarker,
  markerFor,
  NO_RUNTIME_FACTS,
  packRuntimePath,
  rosterDrift,
  type PackRuntimeFacts,
  type PairingCollision,
} from "./pack/staleness.ts";
import { signDial, signRequest } from "./pack/signing.ts";
import {
  armThresholdMs,
  armThresholdWarning,
  createStandbyDoor,
  frontDoorHealth,
  standbyHostOf,
  silenceOf,
  STANDBY_PREFIX,
  standbyPortOf,
  warrantNamesSelf,
  type StandbyFacts,
} from "./pack/standby.ts";
import {
  collidingLabels,
  collisionReportOf,
  pairingReportOf,
  StandbyDeviceStore,
  STANDBY_DEVICES_VERSION,
  syncDigest,
  syncedDevicesOf,
  type SyncedDevice,
} from "./pack/standby-devices.ts";
import {
  adoptLeadership,
  clearRePin,
  pendingRePin,
  runTakeover,
  rosterRowsOf,
  takeoverMessage,
  TAKEOVER_RESTART_EXIT,
  type CommitOutcome,
} from "./pack/takeover.ts";
import { enrollmentOf, TrustStore, type TrustStoreData, type Warrant } from "./pack/trust-store.ts";
import { currentWarrant, refreshWarrant, type WarrantPush } from "./pack/warrant.ts";
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

/**
 * Where OTHER members dial this collie — the address the previous lead used for it, kept in the
 * roster that rode the warrant push (RFC §7.4).
 *
 * `""` on a lead that was never a deputy, which is every lead that did not take over. It is only
 * ever needed by a machine that DID: its peers must be told where to dial their new lead, and this
 * is the one address in the pack that other machines have demonstrably reached it at. An address is
 * a hint the operator may re-point (§4, `collie reconnect`), never an identity, so a wrong one costs
 * a `reconnect` and nothing else.
 */
function selfAddress(data: TrustStoreData): string {
  return data.standbyRoster?.find((r) => r.memberId === data.self.memberId)?.address ?? "";
}

/** This process's deposed state (§18.12), or `null`. Set at most once, at boot or from the wire. */
let deposed: DeposedState | null = null;

/**
 * Take THIS machine's own managed `tailscale serve` mapping down, when it is no longer a machine
 * that may hold one (ADR 0001, ADR 0013; `bridge/front-door.ts` has the whole argument).
 *
 * Two callers, one rule: the boot below, once the mode has resolved to `peer`, and a deposition that
 * arrives on the wire. It is deliberately SYNCHRONOUS at boot — tailscaled owns the serve port until
 * the mapping is gone, so a peer listener that binds first crash-loops, which is precisely what the
 * live drill saw.
 *
 * **Never fatal.** A missing `tailscale`, a refusal, a `tailscale` that errors: all of them are one
 * warning and the bridge comes up anyway. A peer that failed to unpublish is a routing problem the
 * operator can still fix from a keyboard; a peer that refused to start is not.
 */
let frontDoorReleased = false;
function releaseFrontDoor(mode: PackMode, isDeposed: boolean, why: string): void {
  if (frontDoorReleased) return;
  const handlerFile = managedHandlerPath(
    resolveConfigDir(),
    instanceSuffixOf(process.env.COLLIE_INSTANCE),
  );
  // The record — and nothing else — decides whether there is anything of ours to take down. An
  // unrecorded mapping is by definition not ours and is never touched.
  if (!shouldReleaseFrontDoor({ mode, deposed: isDeposed, hasRecord: existsSync(handlerFile) })) return;
  frontDoorReleased = true;
  console.warn(`[pack] ${why} — taking this machine's own tailscale serve mapping down.`);
  try {
    releaseManagedFrontDoor({
      handlerFile,
      io: { out: (l) => console.log(`[pack] ${l}`), err: (l) => console.warn(`[pack] ${l}`) },
      exec: realFrontDoorExec(process.env, homedir()),
      files: realFrontDoorFiles,
    });
  } catch (err) {
    console.warn(`[pack] could not take the front door down: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * The last pairing sync this LEAD had refused for a label collision (§18.14), or `null`.
 *
 * Reassigned on every *decided* outcome of the sweep's sync — set on a refusal, cleared on a success
 * — so the operator's rename clears the finding by itself, with no verb and no restart.
 */
let pairingCollision: PairingCollision | null = null;

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
    // EVERY dial is attested with this collie's own key (§8.6's dial attestation). A peer that has
    // anchored a deputy can no longer read "the handshake was pin-enforcing" as "this is my lead" —
    // the list names one of two — so the caller says which, and it says it on every route rather than
    // on a closed set, because this signature covers no body and pulls no upload into memory.
    dialSign: (parts) => signDial(trustStore.current()?.self.keyPem ?? data.self.keyPem, parts),
    // §8.6's REQUEST signature, on the closed set of routes that accept one (`router.ts` →
    // SIGNABLE_PATHS). The lead→peer direction does not need it — that hop is pinned at the
    // handshake — but ONE delivery does, and it is the delivery that ends a split brain: a new lead
    // telling a machine that still believes it leads. That listener pins nothing inbound (§8.1), so
    // without a signature the deposed machine could not admit the one member that can prove its
    // deposition (§18.12, RFC §9). A streamed upload is never signed — `PeerClient.proxy` refuses to,
    // for §8.6's own reason — so nothing is pulled into memory on the security path.
    sign: (parts) => signRequest(trustStore.current()?.self.keyPem ?? data.self.keyPem, parts),
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
        "is down and its health check now fails.",
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
  // Either outcome ends this machine's claim on the pack's front door, so the door comes down here
  // rather than at the mode check below: a machine that PARKED never reaches `peer` mode at all, and
  // a parked ex-lead holding a live mapping is the "public hostname routes into a void" half of what
  // the drill found. Healing reaches this too, and the flag makes the second call a no-op.
  releaseFrontDoor(resolvePackRuntime(enrollmentOf(trustStore.current())).mode, true, "the crown has moved");
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

// A peer publishes nothing (§3, ADR 0013) — including a mapping it published back when it was a
// lead. BEFORE any listener binds: tailscaled holds the serve port until this returns, and the peer
// listener that tried to bind it first is what crash-looped in the drill.
releaseFrontDoor(pack.mode, deposed !== null, "this collie is a peer");

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
 * The facts only THIS PROCESS holds, for the checkpoint below. Reassigned once, after the listener
 * has been built — until then this process has resolved none of them and says so (§18.9).
 */
let runtimeFacts: () => PackRuntimeFacts = () => NO_RUNTIME_FACTS;

/**
 * Re-stamp the runtime marker with those facts, so `collie pack status` — a different process — can
 * print them (`bridge/pack/staleness.ts`, PACK_PROTOCOL.md §18.9's 2026-08-20 amendment).
 *
 * **It rides the session-refresh tick and adds no timer of its own.** The pack's rule is that a
 * sweep costs one budget no matter what else it decided to do, and the same reasoning applies to a
 * diagnostic: a second interval for a file nobody reads between `pack status` runs would be a second
 * clock to explain. Best effort throughout — a marker that failed to write is a missing line in a
 * status report, never a reason to disturb a running bridge.
 */
async function checkpointRuntime(): Promise<void> {
  if (bootTrust === null) return;
  try {
    const marker = checkpointMarker(bootMarker, runtimeFacts(), Date.now());
    await writeFile(packRuntimePath(cfg.stateDir), formatMarker(marker), { mode: 0o600 });
  } catch {
    // Deliberately silent, unlike the boot write above: that one happens once and a failure there is
    // news, while this one repeats every 15 s and a warning per tick would be the actual problem.
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
const refreshTimer = setInterval(() => {
  void registry.refresh();
  void checkpointRuntime();
}, SESSION_REFRESH_MS);
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
//
// The second anchor is read HERE, off one clock, and handed to both the listener and the admission
// gate — a listener built with two anchors while the gate believed there was one would be exactly
// the mis-resolution §8.1's amendment exists to close.
const listenerBuiltAt = Date.now();
const listenerTls = peerListenerTls(pack.mode, trustStore.current(), listenerBuiltAt);
const deputyAnchorPem = deputyAnchorOf(pack.mode, trustStore.current(), listenerBuiltAt);
const deputyAnchorId = currentWarrant(trustStore.current())?.warrant.deputyMemberId ?? null;
const deputyAnchor =
  deputyAnchorPem === null || deputyAnchorId === null
    ? undefined
    : { memberId: deputyAnchorId, certPem: deputyAnchorPem };
const transportPinned = listenerTls !== null;

// ── The standby half (RFC §6, §7; PACK_PROTOCOL.md §18.14–§18.16) ────────────
// A deputy is a peer that holds its lead's standing, signed permission to take the crown. Three
// things follow from that and nothing else does: it keeps a SYNCED copy of the lead's paired-device
// registry (in its own file, never merged — `standby-devices.ts` says why at length), it may bind a
// second listener the phone can reach, and it may run the takeover exchange.
//
// The threshold is read ONCE, here, and handed to everything that needs it: the door, the router's
// witness answer and — through `pack status`'s own copy of the formula — the operator's screen. RFC
// §10.1's rule is that there is exactly one silence clock in a pack.
const standbyArmMs = armThresholdMs(process.env);
{
  const warning = armThresholdWarning(process.env);
  if (warning !== null) console.warn(warning);
}

/** A verified warrant on this machine's own disk names THIS machine. Re-read: a revocation disarms. */
const holdsOwnWarrant = (): boolean => warrantNamesSelf(pack.mode, trustStore.current(), Date.now());

/**
 * The lead's synced pairing registry, on a peer. Constructed for any peer with a trust store — the
 * warrant that makes this machine the deputy can arrive over the wire at any time, and a store built
 * only for a machine that was ALREADY the deputy at boot would have nowhere to put the first sync.
 * Constructing it opens nothing and writes nothing; solo never reaches this line (§11).
 */
const standbyStore = pack.mode === "peer" && bootTrust !== null ? new StandbyDeviceStore(cfg.stateDir) : null;
if (standbyStore !== null) await standbyStore.load();

/** The synced devices, or none. The credential the standby door checks a confirm against — only that. */
const syncedDevices = (): readonly SyncedDevice[] => standbyStore?.current()?.devices ?? [];

/**
 * What the two standby-shaped pack routes need from this process (`router.ts` → `StandbySurface`).
 *
 * `undefined` on a lead and on solo — a lead has no lead to be silent, no warrant naming itself and
 * nothing to sync. That absence is what makes `/pack/v1/pairing` refuse and a takeover probe read as
 * maximally silent, both of which are the closed readings.
 */
const standbySurface: PackRouterDeps["standby"] =
  standbyStore === null
    ? undefined
    : {
        warrantsSelf: () => holdsOwnWarrant(),
        // Gap A's number, from the one holder — the door below reads this same call (RFC §10.1).
        silentForMs: () => silenceOf(leadContact.facts(), Date.now()),
        armMs: standbyArmMs,
        collidingLabels: (devices: readonly SyncedDevice[]) => collidingLabels(pairing.registry(), devices),
        // §18.14's report: what this collie ACTUALLY holds, read off the store on every call. It is
        // what makes the lead's re-push decision survive a restart on either side.
        syncedDigest: () => pairingReportOf(standbyStore.current()),
        // §18.14's finding, re-derived from disk on every answer: which of THIS machine's own paired
        // devices share a label with the registry it was synced. Empty is the ordinary case.
        syncedCollision: () => collisionReportOf(pairing.registry(), standbyStore.current()),
        applySync: async (sync) => {
          // Wholesale, never a merge: the lead's registry is the whole truth, so a revocation there
          // has to be able to REMOVE a device here.
          await standbyStore.replace({
            version: STANDBY_DEVICES_VERSION,
            packId: sync.packId,
            leadMemberId: sync.leadMemberId,
            syncedAt: Date.now(),
            devices: sync.devices,
          });
        },
      };

// From here on the process knows the four things a store cannot say, so the checkpoint can say them
// (§18.9).
//
// ── WHICH GENERATION THIS PROCESS ACTUALLY ACTIVATED AT BIND TIME ────────────
// RFC §5's phase 2 is "the restart made the stored warrant real", and a peer can be on EITHER side of
// that sentence — which is the bug the live drill found. There are two roles and they activate two
// different things:
//
//   • a peer the warrant does NOT name activates a SECOND TLS ANCHOR — `deputyAnchorOf`, which is
//     what lets the deputy complete a handshake there one day;
//   • the peer the warrant DOES name activates its own DEPUTY ROLE — the standby door and the
//     takeover exchange — and anchors nothing at all, because a machine does not anchor its own
//     certificate (`transport.ts`'s `deputyAnchor` refuses exactly that case, by name).
//
// Deriving this from `deputyAnchorPem` alone therefore reported the DEPUTY — the one machine the
// whole feature is about — as "stored, NOT anchored" forever, through any number of clean restarts.
// Both roles are read here, off one clock, and the store says which one applies.
//
// It is also captured AT BIND rather than read per checkpoint: the question is what this listener
// came up holding, and a warrant that landed a minute after boot is stored without being active.
const boundWarrantGeneration = currentWarrant(trustStore.current())?.warrant.generation ?? null;
const deputyRoleAtBind = warrantNamesSelf(pack.mode, trustStore.current(), listenerBuiltAt);
const activatedGeneration =
  deputyAnchorPem === null && !deputyRoleAtBind ? null : boundWarrantGeneration;

runtimeFacts = () => {
  const facts = leadContact.facts();
  return {
    anchoredGeneration: activatedGeneration,
    leadLastDialledAt: facts.lastDialledAt,
    leadRefusedSecretAt: facts.leadRefusedSecretAt,
    deposed: deposed === null ? null : { ...deposed, outcome: outcomeNow(deposed, facts) },
    pairingCollision,
  };
};
void checkpointRuntime();

if (deputyAnchor !== undefined) {
  console.log(
    `[pack] this peer anchors its deputy "${deputyAnchor.memberId}" as a second TLS anchor — every ` +
      "caller must now attest its dials, and a caller that is not this peer's lead is refused on every route.",
  );
}
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
      pending: () => pendingRePin(trustStore.current()),
      // RFC §9's other half: the member took the proof, so it never needs telling again. One extra
      // round trip, once per member, on the first contact after a takeover — and never again.
      confirm: async (memberId) => {
        await commitPackChange(trustStore, audit, (current) =>
          current === null ? null : clearRePin(current, memberId),
        );
      },
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
        const named = stored.warrant.deputyMemberId;
        // The SPENT warrant, after a takeover: this collie is the member its own warrant names. It
        // carries no certificate (nobody anchors the lead) and no roster; it is pure proof, and the
        // only thing left to do with it is hand it to the members that were down (RFC §9).
        if (named === data.self.memberId) return { warrant: stored.warrant, address: selfAddress(held) };
        const deputy = held.peers.find((p) => p.memberId === named);
        if (named !== null && deputy === undefined) return null;
        if (deputy === undefined) return { warrant: stored.warrant, address: selfAddress(held) };
        return {
          warrant: stored.warrant,
          deputyCertPem: deputy.certPem,
          // The roster rides to the DEPUTY and is stripped for everyone else in `push` below (RFC
          // §7.4). It is refreshed on every push, so an enrollment, a removal or a `reconnect` reaches
          // the deputy on the same body that was going there anyway.
          roster: rosterRowsOf(held.peers),
          address: selfAddress(held),
        };
      },
      push: (link, payload) => {
        // TO THE DEPUTY AND ONLY TO THE DEPUTY. An ordinary peer discards a roster it is sent
        // (`checkWarrantPush`), so this is not a security boundary — it is the wire cost, and a
        // certificate for every member on every push to every member is a body nobody reads.
        if (link.memberId === payload.warrant.deputyMemberId) return client.warrant(link, payload);
        const trimmed: WarrantPush =
          payload.deputyCertPem === undefined
            ? { warrant: payload.warrant, address: payload.address ?? "" }
            : { warrant: payload.warrant, deputyCertPem: payload.deputyCertPem, address: payload.address ?? "" };
        return client.warrant(link, trimmed);
      },
    },
    // RFC §6.5: keep the DEPUTY's copy of the paired-device registry current, and nobody else's.
    // Hashes only, and never merged into that machine's own registry — the reasoning is in
    // `bridge/pack/standby-devices.ts` and in the amended note at `bridge/server.ts`.
    pairing: {
      deputy: () => trustStore.current()?.deputy ?? null,
      current: () => {
        const held = trustStore.current();
        if (held === null || held.pack === null) return null;
        const devices = syncedDevicesOf(pairing.registry());
        return {
          sync: { packId: held.pack.packId, leadMemberId: held.self.memberId, devices },
          digest: syncDigest(devices),
        };
      },
      push: (link, sync) => client.pairing(link, sync),
      // §18.14's refusal, carried to the checkpoint so `collie pack status` here can name the labels.
      // An empty list would be a warning with nothing to rename in it, so it reads as "no finding".
      collision: (labels) => {
        pairingCollision = labels === null || labels.length === 0 ? null : { at: Date.now(), labels };
      },
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

/**
 * The client the TAKEOVER dials with. A deputy is a peer — it has no `peers` in its own store — so its
 * pins come out of the roster that rode the warrant push (RFC §7.4) plus its own lead, and nowhere
 * else. It signs no request bodies: the deputy is in nobody's roster, so a §8.6 signature could only
 * ever fail to verify and become a refusal. What authenticates it is the pinned handshake against the
 * certificate the receiver anchored, plus the dial attestation naming which anchor is calling.
 */
function takeoverClient(data: TrustStoreData): PeerClient {
  const certOf = (memberId: string): string | null => {
    const held = trustStore.current();
    if (held === null) return null;
    if (held.lead !== null && held.lead.memberId === memberId) return held.lead.certPem;
    return held.standbyRoster?.find((r) => r.memberId === memberId)?.certPem ?? null;
  };
  return new PeerClient({
    self: data.self.memberId,
    secret: () => trustStore.current()?.pack?.secret ?? null,
    timeoutMs: packTimeoutBudget(cfg.pollMs),
    patientTimeoutMs: packHelloBudget(cfg.pollMs),
    fetch: (url, init) => fetch(url, init),
    dialSign: (parts) => signDial(trustStore.current()?.self.keyPem ?? data.self.keyPem, parts),
    tls: (link) => {
      const certPem = certOf(link.memberId);
      return certPem === null ? undefined : (dialTls(trustStore.current(), { certPem }) ?? undefined);
    },
  });
}

/**
 * RFC §7, wired: the exchange, the local commit, and the one restart in this file.
 *
 * **The restart is the deliberate exception to "the bridge does not restart itself".** Every other
 * membership change says so in the journal and waits for `collie restart`, because the supervision
 * tier is the CLI's knowledge. This one cannot: the operator asked from a phone, on the bad day, and
 * a machine whose store says `lead` while its process still runs a peer's pinned listener is a
 * machine nobody can reach. So it commits, says so, and exits — a supervised install (systemd
 * `Restart=always`, the Herdr plugin) comes straight back up as the lead, and an unsupervised one is
 * left with a store that is correct and a message naming the command.
 */
async function performTakeover(deviceLabel: string): Promise<{ ok: boolean; message: string }> {
  const data = trustStore.current();
  if (data === null || data.lead === null) {
    return { ok: false, message: takeoverMessage({ kind: "refused", reason: "no-roster" }) };
  }
  const client = takeoverClient(data);
  const outcome = await runTakeover({
    warrant: () => (holdsOwnWarrant() ? (currentWarrant(trustStore.current())?.warrant ?? null) : null),
    leadLink: () => {
      const held = trustStore.current();
      return held?.lead === null || held?.lead === undefined
        ? null
        : { memberId: held.lead.memberId, address: held.lead.address };
    },
    witnesses: () => {
      const held = trustStore.current();
      if (held === null) return [];
      return (held.standbyRoster ?? [])
        .filter((r) => r.memberId !== held.self.memberId && r.memberId !== held.lead?.memberId)
        .map((r) => ({ memberId: r.memberId, address: r.address }));
    },
    address: () => selfAddress(data) || `${cfg.host}:${cfg.port}`,
    hello: (link) => client.hello(link),
    ask: (link, body) => client.takeover(link, body),
    commit: async (confirmed): Promise<CommitOutcome> => {
      const held = trustStore.current();
      if (held === null || held.lead === null) return { kind: "refused", reason: "commit-failed" };
      const roster = held.standbyRoster ?? null;
      if (roster === null) return { kind: "refused", reason: "no-roster" };
      // RFC §6.5: the synced entries become this machine's OWN paired devices at commit and only at
      // commit, because after it this machine IS the lead and the phone must keep working against the
      // credential it already holds. A label collision refuses the whole takeover and writes nothing —
      // checked BEFORE the store is rewritten, so a refusal really does leave everything as it was.
      const devices = syncedDevices();
      const clash = collidingLabels(pairing.registry(), devices);
      if (clash.length > 0) return { kind: "refused", reason: "pairing-collision", labels: clash };
      const result = await commitPackChange(trustStore, audit, (current) =>
        current === null ? null : adoptLeadership(current, { roster, confirmed, now: Date.now() }),
      );
      if (result === null) return { kind: "refused", reason: "commit-failed" };
      const collisions = await pairing.adopt(devices);
      if (collisions.length > 0) {
        // Belt and braces: the read-only check above already passed, so reaching this means the
        // registry changed underneath. The store is already a lead's, which is the state that matters;
        // say so rather than pretending the adoption happened.
        console.warn(`[pack] takeover: could not adopt ${collisions.join(", ")} — rename or revoke, then re-pair.`);
      }
      return { kind: "committed", pending: result.pending };
    },
    now: Date.now,
  });

  const message = takeoverMessage(outcome);
  audit.record({
    action: "pack.takeover",
    device: deviceLabel,
    detail: { outcome: outcome.kind === "committed" ? "committed" : outcome.reason },
  });
  if (outcome.kind !== "committed") return { ok: false, message };
  console.warn(
    `[pack] TOOK OVER — this machine is the lead of pack "${data.pack?.name ?? "?"}" now (warrant ` +
      `generation ${currentWarrant(trustStore.current())?.warrant.generation ?? 0}), confirmed by ` +
      `${outcome.repinned.length} peer(s). Exiting ${TAKEOVER_RESTART_EXIT} so the supervisor brings ` +
      "this machine back up in LEAD mode — that status is non-zero on purpose, because `Restart=" +
      "on-failure` does not revive a clean exit. If nothing restarts this process, its supervision is " +
      "unmanaged: run `herdr plugin action invoke restart --plugin herdr.collie` here.",
  );
  // Long enough for the answer above to reach the phone, short enough that the failover proxy's next
  // health check finds a lead. Not unref'd: this timer is the whole remaining purpose of the process.
  setTimeout(() => process.exit(TAKEOVER_RESTART_EXIT), 1000);
  return { ok: true, message };
}

/** The door proper — peer-only. A lead binds the port above for its health answer and nothing else. */
const standbyDoor = standbyStore === null ? null : createStandbyDoor({
  facts: (): StandbyFacts => {
    const held = trustStore.current();
    const roster = held?.standbyRoster ?? [];
    return {
      warrantsSelf: holdsOwnWarrant(),
      silentForMs: silenceOf(leadContact.facts(), Date.now()),
      armMs: standbyArmMs,
      deviceCount: syncedDevices().length,
      witnessCount: roster.filter(
        (r) => r.memberId !== held?.self.memberId && r.memberId !== held?.lead?.memberId,
      ).length,
      leadMemberId: held?.lead?.memberId ?? null,
      selfMemberId: held?.self.memberId ?? "this machine",
      packName: held?.pack?.name ?? null,
    };
  },
  devices: syncedDevices,
  takeover: (device) => performTakeover(device),
});

/**
 * The standby door's listener (RFC §6.2), or nothing at all.
 *
 * **`COLLIE_STANDBY_PORT` absent ⇒ nothing is bound**, and a deputy without it is a plain peer that
 * can still be taken over from a keyboard by §14's promotion. Collie BINDS this; it publishes
 * nothing — no `tailscale serve`, never `funnel`, no ownership record (ADR 0001 untouched).
 *
 * **A LEAD with the key set binds it too, and answers only the health check.** That is not an
 * oversight in the other direction: a failover proxy's fallback backend points at THIS port
 * (RFC §14.2), so a deputy that took over and came back up as the lead would leave the proxy
 * health-checking a closed port and swinging the phone back onto the machine that died. One port,
 * one question — *should anything route here?* — and a lead answers it `200` on both of its ports.
 */
const standbyPort = standbyPortOf(process.env);
const standbyServer =
  standbyPort === null || bootTrust === null
    ? null
    : Bun.serve({
        hostname: standbyHostOf(process.env),
        port: standbyPort,
        fetch: async (req) => {
          const url = new URL(req.url);
          // Three kinds of machine answer here, in the order their states supersede one another: a
          // DEPOSED collie fails the check (§18.12), a LEAD passes it, and a peer holding a warrant
          // runs the door. A path nobody owns gets a bare 404 with no body worth reading — three
          // routes exist on this port and nothing else does.
          const answered =
            deposed !== null
              ? deposedAnswer(deposed, outcomeNow(deposed, leadContact.facts()), url)
              : (frontDoorHealth(pack.mode, url) ?? (standbyDoor === null ? null : await standbyDoor(req, url)));
          return answered ?? new Response("not found", { status: 404 });
        },
      });

if (standbyServer !== null && standbyDoor !== null) {
  console.log(
    `[pack] standby door listening on http://${standbyHostOf(process.env)}:${standbyPort} — it arms ` +
      `after ${Math.round(standbyArmMs / 1000)}s of silence from this peer's lead, and only while a ` +
      "verified warrant names this machine and its lead has synced a paired device here.",
  );
} else if (standbyServer !== null) {
  console.log(
    `[pack] standby port ${standbyPort} answers the failover proxy's health check only — this collie ` +
      "is not a deputy standing by.",
  );
}

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
            // Present only on a two-anchored peer. Its presence is what makes a dial attestation
            // mandatory and identity signature-resolved (§8.1's 2026-08-20 amendment).
            deputyAnchor,
            version: packVersion,
            // §18.17: what THIS listener activated, reported so the lead stops inferring it from
            // whether its own operator once restarted this machine. A restart done any other way —
            // an update, a systemd unit, a hand on a keyboard — is invisible to `pack-ops.json` and
            // was therefore rendered as `anchor INACTIVE` on a machine that was fully armed.
            warrantActiveGeneration: activatedGeneration,
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
            // The standby half (RFC §6.5, §7), or nothing at all — see `standbySurface` above.
            standby: standbySurface,
            ...surface,
          }),
  // Peer only, and only when the pin could actually be built. See `transportPinned` above.
  tls: listenerTls ?? undefined,
  // The one page a deposed collie serves, and the health check it must now fail (§18.12). `undefined`
  // until something deposes this process, so an ordinary instance's dispatch is byte-identical.
  // The paths this file's route table does not name and must not: `/standby/*` is declared in
  // `bridge/pack/deposed.ts` and `bridge/pack/standby.ts`, so `solo-baseline.test.ts` can keep
  // proving by grep that server.ts routes exactly today's set. Three answers, in order:
  //
  //   1. a DEPOSED collie serves its one page everywhere and FAILS `/standby/health` (§18.12) — the
  //      asymmetry that stops a proxy swinging the phone back onto a machine with a stale roster;
  //   2. a LEAD answers `/standby/health` with 200 while it leads (RFC §14.2's health check);
  //   3. `/standby` and `/standby/takeover` on the FRONT door are reserved and honest: the door is a
  //      separate port on a different machine, and the alternative is the SPA fallback handing the
  //      operator the app shell of the collie they were trying to escape.
  //
  // A solo instance answers `null` to all three and gains no route at all (§11).
  deposed: (_req, url) => {
    if (deposed !== null) return deposedAnswer(deposed, outcomeNow(deposed, leadContact.facts()), url);
    if (bootTrust === null) return null;
    const health = frontDoorHealth(pack.mode, url);
    if (health !== null) return health;
    if (url.pathname === STANDBY_PREFIX || url.pathname.startsWith(`${STANDBY_PREFIX}/`)) {
      return new Response(
        "This machine is not standing by. The standby door is a separate port on the pack's deputy " +
          "(COLLIE_STANDBY_PORT), reachable through your failover proxy — see PACK_PROTOCOL.md \u00a718.15.\n",
        { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }
    return null;
  },
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
