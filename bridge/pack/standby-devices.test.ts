import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EMPTY_REGISTRY, sha256Hex, type PairedRegistry } from "../pairing.ts";
import type { JsonObject, JsonValue } from "../json.ts";
import { T0 } from "./fixtures.ts";
import {
  adoptedRegistry,
  collidingLabels,
  noStandbyDevices,
  pairingPushNeeded,
  pairingReportOf,
  parsePairingReport,
  parsePairingSync,
  parseStandbyDevices,
  resolveSyncedToken,
  serializeStandbyDevices,
  StandbyDeviceStore,
  standbyDevicesPath,
  syncDigest,
  syncedDevicesOf,
  STANDBY_DEVICES_FILENAME,
  STANDBY_DEVICES_VERSION,
  type SyncedDevice,
} from "./standby-devices.ts";

// The lead's paired-device registry, synced to the DEPUTY and to nobody else (RFC §6.5). Everything
// here is a pure function of data except the store at the bottom, which is the one thing that
// touches a disk.

const HASH_A = sha256Hex("token-a");
const HASH_B = sha256Hex("token-b");

const devices = (...rows: SyncedDevice[]): SyncedDevice[] => rows;
const device = (label: string, tokenHash: string): SyncedDevice => ({ label, tokenHash, createdAt: T0 });

/** A device row as the JSON document it travels as, so a test can bend exactly one field. */
const wireDevice = (d: SyncedDevice): JsonObject => ({ ...d });
/** A sync body as it travels. Written out rather than spread, for `wireDevice`'s reason. */
const wireSync = (packId: string, leadMemberId: string, rows: readonly JsonValue[]): JsonObject => ({
  packId,
  leadMemberId,
  devices: [...rows],
});

function registry(...labels: string[]): PairedRegistry {
  return {
    devices: labels.map((label) => ({ label, tokenHash: sha256Hex(label), createdAt: T0, lastSeenAt: T0 })),
  };
}

describe("only hashes cross", () => {
  test("the projection carries label, hash and creation — and drops lastSeenAt", () => {
    const projected = syncedDevicesOf(registry("phone", "tablet"));
    expect(projected).toEqual([
      { label: "phone", tokenHash: sha256Hex("phone"), createdAt: T0 },
      { label: "tablet", tokenHash: sha256Hex("tablet"), createdAt: T0 },
    ]);
    // `lastSeenAt` is a fact about the LEAD's traffic that the deputy could not keep true, and it is
    // written on a throttle — so including it would make every 60 s stamp look like a change.
    expect(JSON.stringify(projected)).not.toContain("lastSeenAt");
  });

  test("nothing spendable is in the projection: no token can be recovered from it", () => {
    const projected = syncedDevicesOf(registry("phone"));
    expect(projected[0]!.tokenHash).toHaveLength(64);
    expect(JSON.stringify(projected)).not.toContain("phone-token");
  });
});

describe("the sync digest decides a push without a dial", () => {
  test("it changes when — and only when — the deputy's copy would", () => {
    const one = syncedDevicesOf(registry("phone"));
    expect(syncDigest(one)).toBe(syncDigest(syncedDevicesOf(registry("phone"))));
    expect(syncDigest(one)).not.toBe(syncDigest(syncedDevicesOf(registry("phone", "tablet"))));
    expect(syncDigest(one)).not.toBe(syncDigest([]));
  });

  test("a lastSeenAt stamp is NOT a change — a poll every 1.5 s must not be a pack dial", () => {
    const before = syncedDevicesOf({ devices: [{ label: "phone", tokenHash: HASH_A, createdAt: T0, lastSeenAt: T0 }] });
    const after = syncedDevicesOf({
      devices: [{ label: "phone", tokenHash: HASH_A, createdAt: T0, lastSeenAt: T0 + 60_000 }],
    });
    expect(syncDigest(before)).toBe(syncDigest(after));
  });
});

describe("parsing refuses rather than repairs", () => {
  test("a well-formed sync body round-trips", () => {
    const row = device("phone", HASH_A);
    expect(parsePairingSync(wireSync("pack-1", "desk", [wireDevice(row)]))).toEqual({
      packId: "pack-1",
      leadMemberId: "desk",
      devices: [row],
    });
  });

  test("a device with an unusable hash refuses the WHOLE body, never just the row", () => {
    // `pairing.ts`'s own reason: an entry with an empty hash would authorise a caller whose token
    // hashes to "". Here refusal is stronger still — a registry with a hole disarms the door rather
    // than quietly authenticating fewer phones on the bad day.
    const bent: JsonObject[] = [
      { label: "phone", tokenHash: "", createdAt: 0 },
      { label: "phone", tokenHash: "abc" },
      { label: " ", tokenHash: HASH_A },
      { tokenHash: HASH_A },
    ];
    for (const bad of bent) {
      expect(parsePairingSync(wireSync("p", "desk", [bad]))).toBeNull();
    }
  });

  test("two rows sharing a label are refused — a label is the revoke handle", () => {
    expect(
      parsePairingSync(wireSync("p", "desk", [wireDevice(device("phone", HASH_A)), wireDevice(device("phone", HASH_B))])),
    ).toBeNull();
  });

  test("every field of the sync is required — the route is new, so it may require its own", () => {
    expect(parsePairingSync({ leadMemberId: "desk", devices: [] })).toBeNull();
    expect(parsePairingSync({ packId: "p", devices: [] })).toBeNull();
    expect(parsePairingSync({ packId: "p", leadMemberId: "desk" })).toBeNull();
    expect(parsePairingSync(wireSync("", "desk", []))).toBeNull();
    expect(parsePairingSync(null)).toBeNull();
    expect(parsePairingSync([])).toBeNull();
    // An EMPTY device list is legitimate: a revocation on the lead has to reach the deputy.
    expect(parsePairingSync(wireSync("p", "desk", []))).not.toBeNull();
  });

  test("the file has its OWN version, and an unknown one is refused", () => {
    const file = { ...noStandbyDevices("pack-1", "desk"), devices: devices(device("phone", HASH_A)) };
    expect(parseStandbyDevices(serializeStandbyDevices(file))).toEqual(file);
    expect(parseStandbyDevices(JSON.stringify({ ...file, version: 2 }))).toBeNull();
    expect(parseStandbyDevices("not json")).toBeNull();
    expect(parseStandbyDevices(JSON.stringify({ version: STANDBY_DEVICES_VERSION }))).toBeNull();
  });
});

// ── THE LIVE DRILL, BUG 4 ─────────────────────────────────────────────────────
// The lead used to remember what it had pushed. `pack deputy` restarts the local bridge as its last
// step, so the process holding that memory was replaced by one that had never offered the sync — and
// nothing ever asked the deputy. The decision is now the deputy's own answer, on an exchange that
// already happens, exactly as the warrant's is.
describe("the deputy reports what it holds, so the lead's decision survives a restart", () => {
  test("a member with no synced registry reports NOTHING, and nothing is up to date", () => {
    expect(pairingReportOf(null)).toBeNull();
    expect(pairingPushNeeded(syncDigest(devices(device("phone", HASH_A))), null)).toBe(true);
  });

  test("a member reports the digest of exactly what is on its disk", () => {
    const held = { ...noStandbyDevices("p", "desk"), devices: devices(device("phone", HASH_A)) };
    expect(pairingReportOf(held)).toBe(syncDigest(held.devices));
    expect(pairingPushNeeded(syncDigest(held.devices), pairingReportOf(held))).toBe(false);
  });

  test("a member that is BEHIND, or AHEAD, is pushed to — the lead's registry is the whole truth", () => {
    const mine = syncDigest(devices(device("phone", HASH_A), device("tablet", HASH_B)));
    expect(pairingPushNeeded(mine, syncDigest(devices(device("phone", HASH_A))))).toBe(true);
    // A revocation on the lead leaves the deputy holding MORE, and that must be corrected too.
    expect(pairingPushNeeded(syncDigest([]), syncDigest(devices(device("phone", HASH_A))))).toBe(true);
  });

  test("an EMPTY registry is still something to sync — a revoke has to be able to remove one", () => {
    expect(pairingPushNeeded(syncDigest([]), null)).toBe(true);
    expect(pairingPushNeeded(syncDigest([]), syncDigest([]))).toBe(false);
  });

  test("a lead with no registry at all pushes nothing", () => {
    expect(pairingPushNeeded(null, null)).toBe(false);
    expect(pairingPushNeeded(null, "anything")).toBe(false);
  });

  test("the wire reading is absent-means-closed, and the value is opaque", () => {
    expect(parsePairingReport({ pairingDigest: "abc" })).toBe("abc");
    // Nothing here checks it against SHA-256's shape: it is only ever compared for equality, and a
    // reader that pinned the current digest's length would silently read every report as absent the
    // day the digest changed.
    const absent: JsonValue[] = [{}, { pairingDigest: "" }, { pairingDigest: 1 }, { pairingDigest: null }, null, []];
    for (const body of absent) expect(parsePairingReport(body)).toBeNull();
    // …but it is bounded, so a hostile peer cannot hand over a megabyte.
    expect(parsePairingReport({ pairingDigest: "x".repeat(129) })).toBeNull();
    expect(parsePairingReport({ pairingDigest: "x".repeat(128) })).toBe("x".repeat(128));
  });
});

describe("the credential check", () => {
  test("the right token resolves, and every other input is null", () => {
    const list = devices(device("phone", HASH_A), device("tablet", HASH_B));
    expect(resolveSyncedToken(list, "token-a")?.label).toBe("phone");
    expect(resolveSyncedToken(list, "token-b")?.label).toBe("tablet");
    for (const token of [null, "", "token-c", HASH_A]) {
      expect(resolveSyncedToken(list, token)).toBeNull();
    }
  });

  test("an EMPTY synced registry authenticates nobody, whatever they present", () => {
    expect(resolveSyncedToken([], "token-a")).toBeNull();
  });
});

describe("label collisions refuse and report (RFC §16, decision 6)", () => {
  test("a collision is named, and adoption writes nothing", () => {
    const own = registry("phone");
    const incoming = devices(device("phone", HASH_A), device("tablet", HASH_B));
    expect(collidingLabels(own, incoming)).toEqual(["phone"]);
    expect(adoptedRegistry(own, incoming)).toBeNull();
  });

  test("no collision: the synced entries are appended, never renamed", () => {
    const adopted = adoptedRegistry(registry("phone"), devices(device("tablet", HASH_B)));
    expect(adopted!.devices.map((d) => d.label)).toEqual(["phone", "tablet"]);
    // Never contacted THIS machine — copying the lead's stamp would assert traffic it never saw.
    expect(adopted!.devices[1]!.lastSeenAt).toBe(0);
    expect(adopted!.devices[1]!.tokenHash).toBe(HASH_B);
  });

  test("adopting into an empty registry is the ordinary case at a takeover", () => {
    const adopted = adoptedRegistry(EMPTY_REGISTRY, devices(device("phone", HASH_A)));
    expect(adopted!.devices).toHaveLength(1);
    expect(collidingLabels(EMPTY_REGISTRY, devices(device("phone", HASH_A)))).toEqual([]);
  });
});

describe("the file", () => {
  test("it is 0600 in a 0700 directory, and it is NOT paired-devices.json", async () => {
    const stateDir = join(await mkdtemp(join(tmpdir(), "collie-standby-")), "nested");
    try {
      const store = new StandbyDeviceStore(stateDir);
      expect(await store.load()).toBeNull();
      const next = { ...noStandbyDevices("pack-1", "desk"), syncedAt: T0, devices: devices(device("phone", HASH_A)) };
      await store.replace(next);
      expect(standbyDevicesPath(stateDir)).toBe(join(stateDir, STANDBY_DEVICES_FILENAME));
      expect(STANDBY_DEVICES_FILENAME).not.toBe("paired-devices.json");
      expect((await stat(standbyDevicesPath(stateDir))).mode & 0o777).toBe(0o600);
      expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
      // Re-read from disk by a fresh store: this is the file the door will authenticate against.
      expect(await new StandbyDeviceStore(stateDir).load()).toEqual(next);
      expect(JSON.parse(await readFile(standbyDevicesPath(stateDir), "utf8")).devices).toHaveLength(1);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test("a replace is wholesale — a revocation on the lead REMOVES a device here", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "collie-standby-"));
    try {
      const store = new StandbyDeviceStore(stateDir);
      await store.replace({ ...noStandbyDevices("p", "desk"), devices: devices(device("phone", HASH_A), device("tablet", HASH_B)) });
      await store.replace({ ...noStandbyDevices("p", "desk"), devices: devices(device("tablet", HASH_B)) });
      expect(store.current()!.devices.map((d) => d.label)).toEqual(["tablet"]);
      expect(resolveSyncedToken(store.current()!.devices, "token-a")).toBeNull();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test("a corrupt file reads as no registry at all — which disarms the door", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "collie-standby-"));
    try {
      await Bun.write(standbyDevicesPath(stateDir), "{ half-written");
      expect(await new StandbyDeviceStore(stateDir).load()).toBeNull();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
