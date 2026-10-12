// The core on its own: the shared protocol tests against `handle(Request)` with no socket, and what only the core
// promises: no runtime import, the same digests `node:crypto` gives, a receipt store that outlives the core, and a
// weak ETag that still gets its 304.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { api, type Dial } from "./client.ts";
import { createCore, digestOf, MemoryReceiptStore, type ReceiptRecord, Receipts, type ReceiptStore, safeId } from "../sdk/core/index.ts";
import { sha256Hex } from "../sdk/core/hash.ts";
import { protocolSuite } from "./protocol-suite.ts";

protocolSuite({
  name: "against the core",
  async open({ hostName, caps }) {
    const core = createCore({ hostName, caps });
    return { collie: { ...core, ready: () => core.ready(), close: async () => {} }, dial: { handler: (r) => core.handle(r), version: 1 } };
  },
});

describe("the core alone", () => {
  test("no file in sdk/core imports a runtime module: no node:, bun, cloudflare: or a package", () => {
    const dir = new URL("../sdk/core/", import.meta.url).pathname;
    for (const f of readdirSync(dir)) {
      const code = readFileSync(join(dir, f), "utf8");
      const specifiers = [...code.matchAll(/(?:^|\n)\s*(?:import|export)[^;]*?from\s+"([^"]+)"/g)].map((m) => m[1]!);
      for (const s of specifiers) expect([f, s]).toEqual([f, expect.stringMatching(/^\.\/[a-z-]+\.ts$/)]);
      expect([f, /\b(Bun|Buffer|process)\.[A-Za-z]|\brequire\(/.test(code)]).toEqual([f, false]);
    }
  });

  test("its SHA-256 is the one node:crypto gives, so request digests and safeId stay the same", () => {
    for (const s of ["", "abc", "é 中 \u{1f600}", "x".repeat(1000), "a\u0000b", JSON.stringify({ verb: "send", text: "hi" }), "\ud800 lone"]) {
      expect(sha256Hex(s)).toBe(createHash("sha256").update(s).digest("hex"));
    }
    expect(digestOf({ a: 1 })).toBe(createHash("sha256").update('{"a":1}').digest("hex"));
    expect(safeId("a b")).toBe(`a_b~${createHash("sha256").update("a b").digest("hex").slice(0, 16)}`);
  });

  test("a receipt store that outlives the core replays after a restart, and refuses the id for another payload", async () => {
    const kept = new Map<string, ReceiptRecord>();
    const store: ReceiptStore = { get: async (id) => kept.get(id), put: async (id, r) => void kept.set(id, r) };
    let runs = 0;
    const first = new Receipts(store);
    expect(await first.run("r1", "d1", async () => (runs++, { ok: true }))).toEqual({ ok: true });
    const afterRestart = new Receipts(store); // a new process, the same storage
    expect(await afterRestart.run("r1", "d1", async () => (runs++, { ok: true }))).toEqual({ ok: true, replayed: true });
    await expect(afterRestart.run("r1", "d2", async () => ({ ok: true }))).rejects.toMatchObject({ status: 409, code: "request-id-reused" });
    expect(runs).toBe(1);
    expect(kept.get("r1")).toEqual({ digest: "d1", reply: { ok: true } }); // the digest and the reply, never the payload
  });

  test("two requests with one id at once run once, even when the store answers late", async () => {
    const store: ReceiptStore = { get: () => new Promise((r) => setTimeout(() => r(undefined), 20)), put: () => {} };
    const r = new Receipts(store);
    let runs = 0;
    const act = async () => (runs++, { ok: true });
    const [a, b] = await Promise.all([r.run("x", "d", act), r.run("x", "d", act)]);
    expect([a, b]).toEqual([{ ok: true }, { ok: true, replayed: true }]);
    expect(runs).toBe(1);
  });

  test("the memory store keeps at least 500 ids and drops the oldest past its limit", () => {
    expect(() => new MemoryReceiptStore(499)).toThrow("500");
    const m = new MemoryReceiptStore(500);
    for (let i = 0; i < 600; i++) m.put(`r${i}`, { digest: "d", reply: {} });
    expect([m.size, m.get("r99"), m.get("r100")?.digest]).toEqual([500, undefined, "d"]);
  });

  test("a weak ETag (W/ added by a compressing proxy) still gets 304", async () => {
    const core = createCore({ hostName: "w" });
    core.ready();
    const d: Dial = { handler: (r) => core.handle(r), version: 1 };
    const { etag } = await api.snapshot(d);
    expect((await api.snapshot(d, etag)).status).toBe(304);
    expect((await api.snapshot(d, `W/${etag}`)).status).toBe(304);
    expect((await api.snapshot(d, `W/"other-1"`)).status).toBe(200);
  });

  test("a request outside /session/v1 is 404, and an unexpected throw is a 500 internal, never a thrown error", async () => {
    const core = createCore({ hostName: "e" });
    core.workspace("w", { title: "W" }).tab("t", { title: "T" }).pane("p", { title: "P", harness: "x" }).onSend(() => {
      throw new Error("boom");
    });
    core.ready();
    expect((await core.handle(new Request("http://localhost/other"))).status).toBe(404);
    const d: Dial = { handler: (r) => core.handle(r), version: 1 };
    const original = console.error;
    console.error = () => {};
    try {
      const r = await api.send(d, "p", "x");
      expect([r.status, r.body.code]).toEqual([500, "internal"]);
    } finally {
      console.error = original;
    }
  });
});
