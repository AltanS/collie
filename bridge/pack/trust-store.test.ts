import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deriveMode } from "./mode.ts";
import {
  enrollmentOf,
  parseTrustStore,
  serializeTrustStore,
  TrustStore,
  TRUST_STORE_FILENAME,
  trustStorePath,
  type TrustStoreData,
  type TrustStoreIo,
} from "./trust-store.ts";
import { fp, leadStore, member, peerStore } from "./fixtures.ts";

/** An in-memory io, so the store's logic is exercised without a disk. */
function memoryIo(initial: string | null = null): TrustStoreIo & { contents: string | null; writes: number } {
  const io = {
    contents: initial,
    writes: 0,
    read: async (_path: string) => io.contents,
    write: async (_path: string, data: string) => {
      io.writes++;
      io.contents = data;
    },
  };
  return io;
}

describe("parse — refusing beats repairing", () => {
  test("a round trip preserves the store exactly", () => {
    const data = leadStore({ peers: [member({ memberId: "nas" })] });
    expect(parseTrustStore(serializeTrustStore(data))).toEqual(data);
  });

  test("garbage, a wrong version and a missing identity are all `null`, not a partial store", () => {
    const good = leadStore();
    expect(parseTrustStore("")).toBeNull();
    expect(parseTrustStore("null")).toBeNull();
    expect(parseTrustStore("[]")).toBeNull();
    expect(parseTrustStore(JSON.stringify({ ...good, version: 2 }))).toBeNull();
    expect(parseTrustStore(JSON.stringify({ ...good, self: undefined }))).toBeNull();
    expect(parseTrustStore(JSON.stringify({ ...good, peers: undefined }))).toBeNull();
  });

  test("a member with an unpinnable fingerprint invalidates the WHOLE store", () => {
    // A hole in a roster is an unpinned member. Reading around it would leave the operator with a
    // store that looks enforced and is not.
    const bad = { ...leadStore(), peers: [{ ...member({ memberId: "nas" }), fingerprint: "nope" }] };
    expect(parseTrustStore(JSON.stringify(bad))).toBeNull();
  });

  test("a member with an out-of-grammar id, bad role or bad status invalidates it too", () => {
    for (const patch of [{ memberId: "NAS" }, { role: "boss" }, { status: "maybe" }, { address: 7 }]) {
      const bad = { ...leadStore(), peers: [{ ...member({ memberId: "nas" }), ...patch }] };
      expect(parseTrustStore(JSON.stringify(bad))).toBeNull();
    }
  });

  test("a store with no pack yet (invited nobody) is valid", () => {
    const data = leadStore({ pack: null });
    expect(parseTrustStore(serializeTrustStore(data))).toEqual(data);
  });

  test("`contactedAt` is accepted absent, null or a number, and rejected as anything else", () => {
    // Exercised through `parseTrustStore`, whose `isMember` guard is the gate. Absent field, an
    // explicit provisional `null`, and a real contact time all parse.
    for (const patch of [{}, { contactedAt: null }, { contactedAt: 123 }]) {
      const store = { ...leadStore(), peers: [{ ...member({ memberId: "nas" }), ...patch }] };
      expect(parseTrustStore(JSON.stringify(store))).not.toBeNull();
    }
    // A non-number/non-null value invalidates the whole store, like any unpinnable field.
    const bad = { ...leadStore(), peers: [{ ...member({ memberId: "nas" }), contactedAt: "soon" }] };
    expect(parseTrustStore(JSON.stringify(bad))).toBeNull();
  });

  test("`pendingHandover` survives a round trip — the whitelist names it in BOTH halves (§14.1)", () => {
    // THE TRAP THIS PINS: `parseTrustStore` builds its result from an explicit field whitelist, so a
    // field validated but left out of that literal vanishes on every load→save — and an approval that
    // cannot survive a read is an approval the demotion can never find. Gate 1 would be shut forever.
    const data = leadStore({
      peers: [member({ memberId: "nas" })],
      pendingHandover: { memberId: "nas", createdAt: 1, expiresAt: 2 },
    });
    const parsed = parseTrustStore(serializeTrustStore(data));
    expect(parsed).toEqual(data);
    expect(parsed!.pendingHandover).toEqual({ memberId: "nas", createdAt: 1, expiresAt: 2 });
  });

  test("absent or null is no approval, and a pre-spec store parses and reads CLOSED", () => {
    const old = leadStore({ peers: [member({ memberId: "nas" })] });
    const serialized = serializeTrustStore(old);
    expect(serialized).not.toContain("pendingHandover");
    // Absent stays absent rather than becoming an explicit `null`, so the bytes round-trip unchanged.
    expect(parseTrustStore(serialized)).toEqual(old);
    expect(parseTrustStore(serialized)!.pendingHandover ?? null).toBeNull();
    expect(parseTrustStore(JSON.stringify({ ...old, pendingHandover: null }))!.pendingHandover).toBeNull();
  });

  test("a malformed approval invalidates the WHOLE store, like any other pinned field", () => {
    for (const patch of [{ memberId: "NAS", createdAt: 1, expiresAt: 2 }, { memberId: "nas", expiresAt: 2 }, 7, "soon"]) {
      const bad = { ...leadStore(), pendingHandover: patch };
      expect(parseTrustStore(JSON.stringify(bad))).toBeNull();
    }
  });

  test("an old-shape store (no `contactedAt`) parses, and its member is NOT provisional", () => {
    // The live-pack back-compat rule: a member serialised before this field existed comes back with
    // `contactedAt` absent (undefined), which is STRICTLY NOT `null` — so it never reads as provisional.
    const old = leadStore({ peers: [member({ memberId: "minibuch" })] });
    const serialized = serializeTrustStore(old);
    expect(serialized).not.toContain("contactedAt");
    const parsed = parseTrustStore(serialized)!;
    expect(parsed).not.toBeNull();
    expect(parsed.peers[0]!.contactedAt).toBeUndefined();
    expect(parsed.peers[0]!.contactedAt === null).toBe(false);
  });
});

describe("enrollmentOf — what the mode seam is handed", () => {
  test("no store is `null`, which is the only untaxed state", () => {
    expect(enrollmentOf(null)).toBeNull();
    expect(deriveMode(enrollmentOf(null)).mode).toBe("solo");
  });

  test("a lead with peers derives `lead`; a peer with a lead derives `peer`", () => {
    expect(deriveMode(enrollmentOf(leadStore({ peers: [member({ memberId: "nas" })] }))).mode).toBe("lead");
    expect(deriveMode(enrollmentOf(peerStore())).mode).toBe("peer");
  });

  test("an `unenrolled` member does not count toward the mode", () => {
    // A lead whose only peer was dropped by a rotation is a solo lead again — it must not keep
    // behaving as a lead over a roster of nobody.
    const dropped = leadStore({ peers: [member({ memberId: "nas", status: "unenrolled" })] });
    expect(enrollmentOf(dropped)!.peers).toEqual([]);
    expect(deriveMode(enrollmentOf(dropped)).mode).toBe("solo");
  });

  test("a store that has minted an invite but enrolled nobody is still `solo`", () => {
    // Which is exactly why the pack ROUTER is registered on the store's existence, not on the mode:
    // this instance must be able to answer the enrollment it invited.
    expect(deriveMode(enrollmentOf(leadStore())).mode).toBe("solo");
  });
});

describe("TrustStore — solo touches nothing", () => {
  test("loading a store that does not exist returns null and writes NOTHING", async () => {
    const dir = await mkdtemp(join(tmpdir(), "collie-pack-"));
    try {
      const store = new TrustStore(dir);
      expect(await store.load()).toBeNull();
      expect(await store.load()).toBeNull();
      // The zero-tax contract at its sharpest: no file, no directory, no default materialised.
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the state dir is not even created when nothing enrolled", async () => {
    const parent = await mkdtemp(join(tmpdir(), "collie-pack-"));
    const missing = join(parent, "state");
    try {
      expect(await new TrustStore(missing).load()).toBeNull();
      expect(await readdir(parent)).toEqual([]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test("an unreadable store stays solo and is NOT overwritten", async () => {
    const dir = await mkdtemp(join(tmpdir(), "collie-pack-"));
    try {
      const path = trustStorePath(dir);
      await writeFile(path, "{ not json");
      const store = new TrustStore(dir);
      expect(await store.load()).toBeNull();
      expect(await Bun.file(path).text()).toBe("{ not json");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("TrustStore — the write discipline", () => {
  test("the file lands 0600 inside a 0700 directory, with no temp file left behind", async () => {
    const parent = await mkdtemp(join(tmpdir(), "collie-pack-"));
    const stateDir = join(parent, "state");
    try {
      const store = new TrustStore(stateDir);
      const data = leadStore();
      await store.update(() => ({ next: data, result: "ok" as const }));

      const entries = await readdir(stateDir);
      expect(entries).toEqual([TRUST_STORE_FILENAME]);
      expect((await stat(trustStorePath(stateDir))).mode & 0o777).toBe(0o600);
      expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
      // A second process reads back exactly what was written.
      expect(await new TrustStore(stateDir).load()).toEqual(data);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test("concurrent updates serialise — no interleaving, last enqueued wins", async () => {
    const io = memoryIo();
    const store = new TrustStore("/unused", io);
    const seen: number[] = [];
    await Promise.all(
      [1, 2, 3].map((n) =>
        store.update((current) => {
          seen.push(current?.peers.length ?? 0);
          const peers = [...(current?.peers ?? []), member({ memberId: `nas-${n}` })];
          return { next: { ...leadStore(), peers }, result: n };
        }),
      ),
    );
    expect(seen).toEqual([0, 1, 2]);
    expect(io.writes).toBe(3);
    expect(store.current()!.peers).toHaveLength(3);
  });

  test("a failed write rejects for its caller and does not wedge the next update", async () => {
    const io = memoryIo();
    let boom = true;
    const failing: TrustStoreIo = {
      read: io.read,
      write: async (p, d) => {
        if (boom) {
          boom = false;
          throw new Error("disk full");
        }
        await io.write(p, d);
      },
    };
    const store = new TrustStore("/unused", failing);
    await expect(store.update(() => ({ next: leadStore(), result: 1 }))).rejects.toThrow("disk full");
    expect(await store.update(() => ({ next: leadStore(), result: 2 }))).toBe(2);
  });

  test("a transition returning null writes nothing at all", async () => {
    const io = memoryIo(serializeTrustStore(leadStore()));
    const store = new TrustStore("/unused", io);
    expect(await store.update(() => null)).toBeNull();
    expect(io.writes).toBe(0);
  });

  test("the path is composed in exactly one place", () => {
    expect(trustStorePath("/state")).toBe(join("/state", TRUST_STORE_FILENAME));
    expect(TRUST_STORE_FILENAME).toBe("pack-trust.json");
  });
});

describe("the store holds what §8.2 says it holds", () => {
  test("a peer's store, after enrollment, carries every transferred item", () => {
    const data: TrustStoreData = peerStore();
    expect(data.self.keyPem).toContain("PRIVATE KEY");
    expect(data.self.fingerprint).toBe(fp("laptop"));
    expect(data.pack!.secret).toBeString();
    expect(data.pack!.packId).toBeString();
    expect(data.lead!.fingerprint).toBe(fp("desk"));
    expect(data.lead!.address).toContain("desk");
    expect(data.self.memberId).toBe("laptop");
  });
});
