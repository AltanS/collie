import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { JsonObject, JsonValue } from "../json.ts";
import { hashesEqual, sha256Hex, type PairedDevice, type PairedRegistry } from "../pairing.ts";
import { isMemberId } from "./identity.ts";

// The lead's paired-device registry, synced to the DEPUTY and to nobody else (RFC §6.5,
// PACK_PROTOCOL.md §18.14).
//
// ── WHY IT IS A SEPARATE FILE, AND WHY THAT IS NOT TIDINESS ──────────────────
// `PairingStore.enforced()` is **"the registry is non-empty"** (bridge/pairing.ts) — pairing is not a
// setting, it is the presence of a credential. So merging the lead's entries into the deputy's own
// `paired-devices.json` would silently switch on the deputy's OWN write gate, for its OWN operator, on
// a machine where nobody ever ran `collie pair`. A gate the operator did not arm is a lockout waiting
// for the day they use that machine directly. Hence: its own file, its own version, and one direction
// of travel — into the deputy's registry at takeover commit, never before, and never back.
//
// ── WHAT `bridge/server.ts` PROMISES, AND WHY THIS DOES NOT BREAK IT ─────────
// server.ts states that pairing is "NOT threaded into the pack surface … a lead does not hold one of
// this collie's pairing tokens and must never need one." That rule survives **verbatim**: no pack
// request is ever admitted by a pairing token, and `/pack/v1/pairing` is admitted by the pack's own
// two factors plus a role check like every other route. What is new is that a browser credential's
// HASH is carried ON a pack route and lands on a peer's disk — adjacent enough that the comment there
// gains this exception and a pointer (RFC §16, decision 5).
//
// ── ONLY HASHES CROSS ────────────────────────────────────────────────────────
// `{label, tokenHash, createdAt}` per device. The token was shown once, at claim time, and is not
// recoverable (`pairing.ts`), so a store that leaks yields nothing spendable — the same reasoning
// `PendingInvite` already runs on.
//
// PURE except for {@link StandbyDeviceStore}, which is the one thing here that touches a disk.

/** The synced registry's filename under `stateDir`. Never `paired-devices.json`; see the header. */
export const STANDBY_DEVICES_FILENAME = "standby-devices.json";

/**
 * On-disk schema version, **its own** and deliberately not the trust store's.
 *
 * The two files change for different reasons and are written by different code paths; sharing a
 * version integer would mean a shape change in one of them refusing the other.
 */
export const STANDBY_DEVICES_VERSION = 1;

/** One device as it crosses the pack link and lands on the deputy. Hash only — never a token. */
export interface SyncedDevice {
  readonly label: string;
  /** SHA-256 (hex) of the bearer token the phone holds. 64 hex characters or it is not a device. */
  readonly tokenHash: string;
  readonly createdAt: number;
}

/**
 * The whole file. It records **whose** registry this is, because a deputy that changed packs (or
 * whose lead changed) must not keep authenticating a phone against a registry from the old one.
 */
export interface StandbyDevices {
  readonly version: number;
  readonly packId: string;
  /** The lead that pushed it. Checked on every read against the lead this collie actually pins. */
  readonly leadMemberId: string;
  readonly syncedAt: number;
  readonly devices: readonly SyncedDevice[];
}

/** An empty synced registry — the state a deputy is in until its lead has pushed one. */
export function noStandbyDevices(packId: string, leadMemberId: string): StandbyDevices {
  return { version: STANDBY_DEVICES_VERSION, packId, leadMemberId, syncedAt: 0, devices: [] };
}

// ── Parsing ──────────────────────────────────────────────────────────────────

function asRecord(value: JsonValue | undefined): JsonObject | null {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value;
}

/**
 * Read one device row, or `null`.
 *
 * A `tokenHash` that is not exactly 64 characters is refused rather than kept, for the reason
 * `coerceRegistry` gives in `pairing.ts`: an entry with an empty hash would authorise a caller whose
 * token hashes to the empty string. Here the whole file is refused rather than the row dropped —
 * a synced registry with a hole in it is a phone that silently stops working at the worst moment,
 * and refusing is the reading that disarms the door instead.
 */
function parseDevice(value: JsonValue | undefined): SyncedDevice | null {
  const d = asRecord(value);
  if (d === null) return null;
  if (typeof d.label !== "string" || d.label.trim() === "") return null;
  if (typeof d.tokenHash !== "string" || d.tokenHash.length !== 64) return null;
  return { label: d.label, tokenHash: d.tokenHash, createdAt: typeof d.createdAt === "number" ? d.createdAt : 0 };
}

/**
 * The list of devices inside a wire body or a file, or `null` for anything that is not a clean list.
 *
 * Duplicate labels inside ONE push are refused too: a label is the revoke handle, so two rows sharing
 * one is a registry the operator could not revoke by the name they know it by (RFC §16, decision 6).
 */
export function parseDevices(value: JsonValue | undefined): SyncedDevice[] | null {
  if (!Array.isArray(value)) return null;
  const out: SyncedDevice[] = [];
  for (const row of value) {
    const device = parseDevice(row);
    if (device === null) return null;
    if (out.some((d) => d.label === device.label)) return null;
    out.push(device);
  }
  return out;
}

/** The body of `POST /pack/v1/pairing` (PACK_PROTOCOL.md §18.14). */
export interface PairingSync {
  readonly packId: string;
  readonly leadMemberId: string;
  readonly devices: readonly SyncedDevice[];
}

/** Read a pairing-sync body, or `null`. Every field is required — the route is new (§7.1). */
export function parsePairingSync(value: JsonValue | undefined): PairingSync | null {
  const body = asRecord(value);
  if (body === null) return null;
  if (typeof body.packId !== "string" || body.packId === "") return null;
  if (!isMemberId(body.leadMemberId)) return null;
  const devices = parseDevices(body.devices);
  if (devices === null) return null;
  return { packId: body.packId, leadMemberId: body.leadMemberId, devices };
}

/** Parse the file. `null` for anything this reader does not understand — see {@link parseDevice}. */
export function parseStandbyDevices(raw: string): StandbyDevices | null {
  let value: JsonValue;
  try {
    // SAFETY: `JSON.parse` output IS a JsonValue by construction, and every field below is a checked
    // property access on it rather than an assertion through `unknown`.
    value = JSON.parse(raw) as JsonValue;
  } catch {
    return null;
  }
  const d = asRecord(value);
  if (d === null || d.version !== STANDBY_DEVICES_VERSION) return null;
  if (typeof d.packId !== "string" || d.packId === "") return null;
  if (!isMemberId(d.leadMemberId)) return null;
  const devices = parseDevices(d.devices);
  if (devices === null) return null;
  return {
    version: STANDBY_DEVICES_VERSION,
    packId: d.packId,
    leadMemberId: d.leadMemberId,
    syncedAt: typeof d.syncedAt === "number" ? d.syncedAt : 0,
    devices,
  };
}

/** Serialise for disk. Pretty and newline-terminated, like the trust store — a diffable secret file. */
export function serializeStandbyDevices(data: StandbyDevices): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}

// ── The lead's projection ────────────────────────────────────────────────────

/**
 * What the lead sends: hashes only, and nothing else off {@link PairedDevice}.
 *
 * `lastSeenAt` is deliberately dropped. It is a fact about the LEAD's traffic that the deputy would
 * be unable to keep true and would then render as though it were its own — and it is written on a
 * throttle, so including it would make every sixty-second stamp look like a registry change.
 */
export function syncedDevicesOf(registry: PairedRegistry): SyncedDevice[] {
  return registry.devices.map((d) => ({ label: d.label, tokenHash: d.tokenHash, createdAt: d.createdAt }));
}

/**
 * A stable fingerprint of what the lead would send, so the sweep can tell "the registry changed" from
 * "nothing happened" without a dial and without a second timer.
 *
 * Over the SENT projection rather than the file's bytes: `lastSeenAt` is stamped on a throttle and a
 * `stat`-shaped check would therefore report a change once a minute per active device, pushing a body
 * that is identical to the last one. Label + hash + creation is exactly what the deputy stores, so
 * this changes when and only when the deputy's copy would.
 */
export function syncDigest(devices: readonly SyncedDevice[]): string {
  return sha256Hex(devices.map((d) => `${d.label} ${d.tokenHash} ${d.createdAt}`).join(""));
}

/**
 * What a member says about the registry it holds, on `hello` and `snapshot` (§18.14).
 *
 * **Absent means "nothing synced here", never "up to date"** — the same absent-means-closed reading
 * the warrant's own pair carries (§7.1), and it pushes for the same reason: a needless push costs one
 * small body, where reading silence as currency costs a deputy whose door can never arm.
 *
 * `null` for every member that holds no synced registry, which is every peer that is not the deputy.
 */
export function pairingReportOf(devices: StandbyDevices | null): string | null {
  return devices === null ? null : syncDigest(devices.devices);
}

/**
 * Read a member's report off a `hello`/`snapshot` body. Anything that is not a digest is absent.
 *
 * **The value is OPAQUE to this reader** — it is only ever compared for equality with the lead's own,
 * never parsed — so it is deliberately not checked against SHA-256's length. A reader that pinned the
 * current digest's shape would silently read every report as absent the day the digest changed, which
 * is a fail-closed direction but a silent one: the pack would re-push on every sweep, forever, with
 * nothing saying why. Bounded rather than shaped, so a hostile peer cannot hand over a megabyte.
 */
export function parsePairingReport(value: JsonValue | undefined): string | null {
  const body = asRecord(value);
  const digest = body?.pairingDigest;
  return typeof digest === "string" && digest !== "" && digest.length <= 128 ? digest : null;
}

/**
 * The labels this member's OWN paired devices share with the registry it was synced (§18.14).
 *
 * **Reported on the exchange, not carried by the sync answer** — and that distinction was paid for.
 * A finding delivered once, on the push that happened to land, is a finding the operator cannot see:
 * the very next sweep finds the two copies level, has nothing to push, and had no way to know the
 * collision was still there. Reported here, it is re-derived from disk on every answer, so it appears
 * the moment it is true, survives every restart, and clears the instant the operator renames or
 * revokes one of the two — with no dial, no memory and no second timer.
 */
export function collisionReportOf(own: PairedRegistry, held: StandbyDevices | null): string[] {
  return held === null ? [] : collidingLabels(own, held.devices);
}

/** Read a member's collision report. Absent, empty or malformed all read as "no finding" — closed. */
export function parseCollisionReport(value: JsonValue | undefined): string[] | null {
  const body = asRecord(value);
  if (!Array.isArray(body?.pairingCollision)) return null;
  const labels = body.pairingCollision.filter((l): l is string => typeof l === "string" && l !== "");
  return labels.length === 0 ? null : labels;
}

/**
 * Is this member behind the registry the lead currently holds? (§18.14's re-push rule.)
 *
 * **The whole reason this is a comparison against a REPORT rather than against a memory.** The lead
 * used to remember what it had pushed in a process-local field, and a live drill found the hole that
 * leaves: `pack deputy` restarts the local bridge as its last step, so the process that knew it still
 * owed a sync was replaced by one that had never offered it — and nothing ever asked the deputy. Now
 * the deputy answers for itself on an exchange that already happens, exactly as it does for the
 * warrant, so the decision survives a restart on either side and no timer is added.
 */
export function pairingPushNeeded(current: string | null, reported: string | null): boolean {
  if (current === null) return false;
  return reported !== current;
}

// ── The deputy's half ────────────────────────────────────────────────────────

/**
 * The labels an incoming sync would collide with in this collie's OWN registry.
 *
 * **Refuse and report, never namespace-and-merge** (RFC §16, decision 6). Labels are the revoke
 * handle (`pairing.ts` → `removeDevice`), so a silently renamed device is a device the operator
 * cannot revoke by the name they know it by. The noise is the correct cost.
 */
export function collidingLabels(own: PairedRegistry, incoming: readonly SyncedDevice[]): string[] {
  const mine = new Set(own.devices.map((d) => d.label));
  return incoming.filter((d) => mine.has(d.label)).map((d) => d.label);
}

/**
 * The device a bearer token belongs to, or `null` — the standby door's whole authentication.
 *
 * Constant-time per entry and deliberately not short-circuited, exactly as `findByToken` is: the only
 * timing signal is how far down the list a label sits, which is not a secret and has nothing to do
 * with the token's bytes.
 */
export function resolveSyncedToken(devices: readonly SyncedDevice[], token: string | null): SyncedDevice | null {
  if (token === null || token === "") return null;
  const hash = sha256Hex(token);
  let found: SyncedDevice | null = null;
  for (const d of devices) {
    if (hashesEqual(d.tokenHash, hash)) found = d;
  }
  return found;
}

/**
 * The deputy's own registry with the synced entries folded in — RFC §6.5's adoption, which happens
 * **at takeover commit and only then**, because after the commit this machine IS the lead and the
 * phone must keep working against the very credential it already holds.
 *
 * `null` on a label collision. The collision was already refused at sync time, so reaching it here
 * means the deputy's own registry gained that label in between; refusing again is the fail-closed
 * reading and it costs the operator one `collie devices revoke` rather than a device they can no
 * longer name.
 */
export function adoptedRegistry(own: PairedRegistry, synced: readonly SyncedDevice[]): PairedRegistry | null {
  if (collidingLabels(own, synced).length > 0) return null;
  const adopted: PairedDevice[] = synced.map((d) => ({
    label: d.label,
    tokenHash: d.tokenHash,
    createdAt: d.createdAt,
    // Never contacted THIS machine — and `lastSeenAt: 0` is the honest way to say so. Copying the
    // lead's stamp would be this machine asserting traffic it never saw.
    lastSeenAt: 0,
  }));
  return { devices: [...own.devices, ...adopted] };
}

// ── The file ─────────────────────────────────────────────────────────────────

/** Absolute path of the synced registry for a state dir. The only place this path is composed. */
export function standbyDevicesPath(stateDir: string): string {
  return join(stateDir, STANDBY_DEVICES_FILENAME);
}

/**
 * The synced registry as the process holds it: one cached read, one atomic write, no ambient state.
 *
 * 0600 in a 0700 directory, temp-then-rename — the discipline the trust store and
 * `push-subscriptions.json` already share, and this file holds credential hashes, so it inherits it
 * rather than inventing one.
 *
 * **Solo writes none of it.** Nothing constructs this outside a peer that holds a warrant naming
 * itself, which is a state a solo instance cannot reach (§11's zero-tax contract).
 */
export class StandbyDeviceStore {
  private cached: StandbyDevices | null = null;
  private loaded = false;
  private readonly path: string;

  constructor(
    stateDir: string,
    private readonly io = fsStandbyIo(stateDir),
  ) {
    this.path = standbyDevicesPath(stateDir);
  }

  async load(): Promise<StandbyDevices | null> {
    if (this.loaded) return this.cached;
    const raw = await this.io.read(this.path);
    this.cached = raw === null ? null : parseStandbyDevices(raw);
    this.loaded = true;
    return this.cached;
  }

  /** The last loaded value, without touching the disk. `null` before {@link load} has run. */
  current(): StandbyDevices | null {
    return this.cached;
  }

  /** Replace the file wholesale. A sync is never a merge — the lead's registry is the whole truth. */
  async replace(next: StandbyDevices): Promise<void> {
    await this.io.write(this.path, serializeStandbyDevices(next));
    this.cached = next;
    this.loaded = true;
  }
}

/** Every disk touch this module makes, injected so the logic above is testable without a disk. */
export interface StandbyDeviceIo {
  read(path: string): Promise<string | null>;
  write(path: string, data: string): Promise<void>;
}

export function fsStandbyIo(stateDir: string): StandbyDeviceIo {
  return {
    async read(path) {
      try {
        return await readFile(path, "utf8");
      } catch (err) {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") return null;
        throw err;
      }
    },
    async write(path, data) {
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      const tmp = `${path}.tmp`;
      // Mode on create: the hashes are never briefly world-readable between write and chmod.
      await writeFile(tmp, data, { mode: 0o600 });
      await rename(tmp, path);
    },
  };
}
