// The core on its own: the shared protocol tests against `handle(Request)` with no socket, and what only the core
// promises: no runtime import, the same digests `node:crypto` gives, a receipt store that outlives the core, and a
// weak ETag that still gets its 304.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { api, type Dial } from "./client.ts";
import {
  askIdFor,
  createCore,
  digestOf,
  MemoryReceiptStore,
  RECEIPTS_PER_GROUP,
  type ReceiptRecord,
  Receipts,
  type ReceiptStore,
  safeId,
  versionLine,
} from "../../../packages/durable-sdk/src/core/index.ts";
import { sha256Hex } from "../../../packages/durable-sdk/src/core/hash.ts";
import { protocolSuite } from "./protocol-suite.ts";

protocolSuite({
  name: "against the core",
  async open({ hostName, caps, hooks, onRename }) {
    const core = createCore({ hostName, caps, hooks, onRename });
    return { collie: { ...core, ready: () => core.ready(), close: async () => {} }, dial: { handler: (r) => core.handle(r), version: 1 } };
  },
});

describe("the core alone", () => {
  test("no file in the SDK core imports a runtime module: no node:, bun, cloudflare: or a package", () => {
    const dir = new URL("../../../packages/durable-sdk/src/core/", import.meta.url).pathname;
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

  test("the memory store keeps at least 500 ids per pane, and remembers the ids it dropped past its limit", () => {
    expect(() => new MemoryReceiptStore(499)).toThrow("500");
    const m = new MemoryReceiptStore(500);
    for (let i = 0; i < 600; i++) m.put(`r${i}`, { digest: "d", reply: {} }, "p");
    m.put("q0", { digest: "d", reply: {} }, "q");
    expect([m.size, m.get("r99"), m.get("r100")?.digest, m.get("q0")?.digest]).toEqual([501, { dropped: true, digest: "d" }, "d", "d"]);
    expect(m.get("never")).toBeUndefined();
  });

  test("receipts cap: the newest 1000 per pane are kept; replaying the first of 1001 is refused (an unknown outcome) and runs nothing", async () => {
    const core = createCore({ hostName: "cap" });
    let stops = 0;
    const tab = core.workspace("w", { title: "W" }).tab("t", { title: "T" });
    for (const id of ["p", "q"]) tab.pane(id, { title: id, harness: "x" }).onAbort(() => void stops++);
    core.ready();
    const d: Dial = { handler: (r) => core.handle(r), version: 1 };
    const turn = (await api.snapshot(d)).body.panes[0]!.turnId;
    for (let i = 0; i <= RECEIPTS_PER_GROUP; i++) expect((await api.abort(d, "p", { turnId: turn, requestId: `cap-${i}` })).status).toBe(200);
    const other = (await api.snapshot(d)).body.panes[1]!.turnId;
    expect((await api.abort(d, "q", { turnId: other, requestId: "q-0" })).status).toBe(200);
    const replay = await api.abort(d, "p", { turnId: turn, requestId: "cap-0" });
    expect([replay.status, replay.body.code]).toEqual([500, "receipt-dropped"]);
    expect((await api.abort(d, "p", { turnId: turn, requestId: "cap-1" })).body).toEqual({ ok: true, replayed: true }); // the newest 1000 replay
    expect((await api.abort(d, "q", { turnId: other, requestId: "q-0" })).body).toEqual({ ok: true, replayed: true }); // another pane keeps its own
    expect(stops).toBe(0); // the panes are idle: nothing ran, the first time or after
  });

  test("a core made with allowAlways false refuses an allow-always option, naming WIRE.md 1B; the default takes it", () => {
    const options = [
      { id: "allow", label: "Allow", effect: "allow" as const },
      { id: "always", label: "Always", effect: "allow-always" as const },
    ];
    const raise = (allowAlways?: boolean) => {
      const core = createCore(allowAlways === undefined ? { hostName: "a" } : { hostName: "a", allowAlways });
      const pane = core.workspace("w", { title: "W" }).tab("t", { title: "T" }).pane("p", { title: "P", harness: "x" });
      return () => void pane.ask({ kind: "permission", toolCallId: "c", itemId: "c", title: "write_note", options }).catch(() => {});
    };
    expect(raise(false)).toThrow(TypeError);
    expect(raise(false)).toThrow("WIRE.md 1B");
    expect(raise()).not.toThrow();
    expect(raise(true)).not.toThrow();
  });

  test("after a restart (a new core, a new epoch) the same tool call asks under the same id, and an answer to it is taken", async () => {
    const raise = () => {
      const core = createCore({ hostName: "wake" });
      const pane = core.workspace("w", { title: "W" }).tab("t", { title: "T" }).pane("p", { title: "P", harness: "x" });
      const options = [{ id: "allow", label: "Allow", effect: "allow" as const }];
      const answer = pane.ask({ kind: "permission", toolCallId: "call-1", itemId: "call-1", title: "write_note", options });
      core.ready();
      return { core, answer, d: { handler: (r: Request) => core.handle(r), version: 1 } satisfies Dial };
    };
    const before = raise();
    const listed = (await api.snapshot(before.d)).body.panes[0]!.openAsks[0]!;
    const after = raise(); // the restart: a new core, a new epoch
    const again = (await api.snapshot(after.d)).body.panes[0]!.openAsks[0]!;
    expect(after.core.epoch).not.toBe(before.core.epoch);
    expect([again.id, again.revision]).toEqual([listed.id, 1]);
    expect(listed.id).toMatch(/^[0-9a-f]{32}$/);
    expect((await api.answer(after.d, "p", listed.id, "allow")).body).toEqual({ result: "taken" });
    expect(await after.answer).toEqual({ optionId: "allow" });
    expect(askIdFor("p", "call-2")).not.toBe(listed.id);
    expect(askIdFor("q", "call-1")).not.toBe(listed.id);
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

  test("the refusal sentence names who acts: the agent's SDK, or Collie", () => {
    expect(versionLine({ code: "version", collie: [2, 2], program: [1, 1] })).toBe("Collie speaks wire v2, this durable agent speaks v1. Update the agent's SDK, or Collie.");
  });
});
