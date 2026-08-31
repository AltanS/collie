import { describe, expect, test } from "bun:test";

import {
  emptyPackOps,
  packOpsPath,
  parsePackOps,
  PackOpsStore,
  serializePackOps,
  type OpsRecord,
} from "./ops-store.ts";
import type { TrustStoreIo } from "./trust-store.ts";

// The ops store, against an in-memory `TrustStoreIo` — the same seam the trust store's own suite
// uses, for the same reason: nothing here touches a disk, and nothing here holds a secret.

const T0 = 1_754_000_000_000;

// The anchor pair is optional on the type and EXPLICIT after a read: the parser builds its result
// from a whitelist and normalises absent to `null`, so a record written by a build that predates
// `pack deputy` reads back with two named nulls rather than two missing keys.
const RECORD: OpsRecord = {
  sshHost: "nas.example",
  path: "/home/pat/.collie",
  port: 8787,
  recordedAt: T0,
  anchoredGeneration: null,
  anchoredAt: null,
};

/** An in-memory file, plus what was written to it and how often. */
function fakeIo(initial: string | null = null): TrustStoreIo & { contents: string | null; writes: number } {
  const state = { contents: initial, writes: 0 };
  return {
    get contents() {
      return state.contents;
    },
    get writes() {
      return state.writes;
    },
    read: async () => state.contents,
    write: async (_p, data) => {
      state.contents = data;
      state.writes += 1;
    },
  };
}

describe("the ops store's path and shape", () => {
  test("lives beside the trust store, under the state dir", () => {
    expect(packOpsPath("/state")).toBe("/state/pack-ops.json");
  });

  test("round-trips through its own serialiser", () => {
    const data = { version: 1, members: { nas: RECORD } };
    expect(parsePackOps(serializePackOps(data))).toEqual(data);
    expect(serializePackOps(data).endsWith("\n")).toBe(true);
  });

  test("an empty store is a version and no members", () => {
    expect(emptyPackOps()).toEqual({ version: 1, members: {} });
  });
});

describe("parsing fails closed", () => {
  const bad: [string, string][] = [
    ["not JSON at all", "{{{"],
    ["not an object", '"nope"'],
    ["an unknown version", '{"version":2,"members":{}}'],
    ["no members map", '{"version":1}'],
    ["a member with no ssh host", '{"version":1,"members":{"nas":{"sshHost":"","port":1,"path":null,"recordedAt":0}}}'],
    ["a member with a string port", '{"version":1,"members":{"nas":{"sshHost":"h","port":"8787","path":null,"recordedAt":0}}}'],
    ["a member that is not an object", '{"version":1,"members":{"nas":7}}'],
  ];
  for (const [what, raw] of bad) {
    test(`refuses ${what} rather than reading around it`, () => {
      expect(parsePackOps(raw)).toBeNull();
    });
  }

  test("one malformed member invalidates the whole file — never a partial roster of hosts", () => {
    const raw = JSON.stringify({
      version: 1,
      members: { nas: RECORD, web: { sshHost: "w" } },
    });
    expect(parsePackOps(raw)).toBeNull();
  });
});

describe("PackOpsStore", () => {
  test("a machine that never ran `pack add` reads as absent, not as an error", async () => {
    const store = new PackOpsStore("/state", fakeIo());
    expect(await store.load()).toEqual({ data: null, unreadable: false });
    expect(await store.get("nas")).toBeNull();
  });

  test("records a member and reads it back", async () => {
    const io = fakeIo();
    const store = new PackOpsStore("/state", io);
    expect(await store.record("nas", RECORD)).toBe(true);
    expect(await store.get("nas")).toEqual(RECORD);
    expect(parsePackOps(io.contents!)).toEqual({ version: 1, members: { nas: RECORD } });
  });

  test("a second record for the same member REPLACES it — that is what an override refresh is", async () => {
    const store = new PackOpsStore("/state", fakeIo());
    await store.record("nas", RECORD);
    const moved: OpsRecord = {
      sshHost: "nas.lan",
      path: "/srv/collie",
      port: 9000,
      recordedAt: T0 + 1,
      anchoredGeneration: null,
      anchoredAt: null,
    };
    await store.record("nas", moved);
    expect(await store.get("nas")).toEqual(moved);
    expect((await store.load()).data?.members).toEqual({ nas: moved });
  });

  test("recording one member leaves every other alone", async () => {
    const store = new PackOpsStore("/state", fakeIo());
    await store.record("nas", RECORD);
    await store.record("web", { ...RECORD, sshHost: "web.example" });
    expect(Object.keys((await store.load()).data!.members).toSorted()).toEqual(["nas", "web"]);
  });

  // F16: there is no `forget`. Removal is the exact moment the operator needs the ssh destination —
  // the far machine keeps its copy of the pack until `collie leave` runs there — so `pack remove`
  // prints the line and keeps the row. This pins that no verb can drop one behind the operator.
  test("nothing deletes a row: a member recorded once stays recorded", async () => {
    const store = new PackOpsStore("/state", fakeIo());
    await store.record("nas", RECORD);
    await store.record("web", { ...RECORD, sshHost: "web.example" });
    expect("forget" in store).toBe(false);
    expect(await store.get("nas")).not.toBeNull();
  });

  test("an unreadable file is reported, and is NEVER overwritten", async () => {
    const io = fakeIo("{ this is not the file we left }");
    const store = new PackOpsStore("/state", io);
    expect(await store.load()).toEqual({ data: null, unreadable: true });
    expect(await store.record("nas", RECORD)).toBe(false);
    expect(io.writes).toBe(0);
    expect(io.contents).toBe("{ this is not the file we left }");
  });
});
