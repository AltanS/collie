import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bodyCapOf, proxiedResponse } from "./forward.ts";
import { BODY_IDLE_MS, bodyIdleMs, CREW_BYTES_MAX, guardedBody } from "./guarded-body.ts";
import { CrewLead } from "./lead.ts";
import { member as trusted, neverProxy } from "./fixtures.ts";
import { PeerClient, type CrewFetch } from "./peer-client.ts";
import { CrewRegistry } from "./registry.ts";
import { DEFAULT_MAX_UPLOAD_BYTES } from "../uploads.ts";

// THE LEAD'S TWO BOUNDS ON A MEMBER'S BODY (review round 6, B1 and B2), through the real dial against a
// member in its own process: the idle limit after the headers, and the size cap on an identity body.

const dir = mkdtempSync(join(tmpdir(), "collie-body-member-"));
let member: ReturnType<typeof Bun.spawn> | null = null;
let base = "";
let phone: ReturnType<typeof Bun.serve> | null = null;

const MB = 1024 * 1024;

beforeAll(async () => {
  const script = join(dir, "member.ts");
  writeFileSync(
    script,
    `
const crew = { "x-crew-protocol": "2", "x-crew-member": "laptop" };
const json = { ...crew, "content-type": "application/json" };
const bin = { ...crew, "content-type": "application/octet-stream" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const piece = new Uint8Array(1024 * 1024).fill(7);
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0, idleTimeout: 0,
  fetch(req) {
    const p = new URL(req.url).pathname;
    // Headers, then silence for ever. Bun's server holds the headers back until the first body byte.
    if (p.endsWith("/silent")) return new Response(new ReadableStream({ start() {} }), { headers: json });
    // Headers and the first byte, then silence for ever.
    if (p.endsWith("/open")) return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("{")); } }), { headers: json });
    // A JSON body one byte every 250 ms: about 4 s in all, never 250 ms without a byte.
    if (p.endsWith("/drip")) {
      const text = new TextEncoder().encode('{"ok":"dripping"}');
      let at = 0;
      return new Response(new ReadableStream({ async pull(c) { if (at > 0) await sleep(250); if (at >= text.length) { c.close(); return; } c.enqueue(text.subarray(at, at + 1)); at += 1; } }), { headers: json });
    }
    // A short JSON body one byte every 250 ms: 7 bytes, about 1.5 s, inside a 3 s deadline.
    if (p.endsWith("/drip-short")) {
      const text = new TextEncoder().encode('{"a":1}');
      let at = 0;
      return new Response(new ReadableStream({ async pull(c) { if (at > 0) await sleep(250); if (at >= text.length) { c.close(); return; } c.enqueue(text.subarray(at, at + 1)); at += 1; } }), { headers: json });
    }
    // The reviewer's member: the snapshot headers, then one byte every 700 ms for ever, under the 1 s idle limit.
    if (p.endsWith("/drip-forever")) return new Response(new ReadableStream({ async pull(c) { await sleep(700); c.enqueue(new TextEncoder().encode(" ")); } }), { headers: json });
    // 4 MB announced as chunks: the first 2 MB, then silence.
    if (p.endsWith("/half")) {
      let sent = 0;
      return new Response(new ReadableStream({ async pull(c) { if (sent >= 2) { await new Promise(() => {}); } c.enqueue(piece); sent += 1; } }), { headers: bin });
    }
    // An identity body with no length and no end, 1 MB at a time.
    if (p.endsWith("/endless")) return new Response(new ReadableStream({ pull(c) { c.enqueue(piece); } }), { headers: bin });
    // An identity body that says 40 MB up front.
    if (p.endsWith("/long-declared")) return new Response(new Uint8Array(40 * 1024 * 1024), { headers: bin });
    // A 16 MB blob, the largest an honest member serves, in one go.
    if (p.endsWith("/blob-whole")) return new Response(new Uint8Array(16 * 1024 * 1024).fill(9), { headers: bin });
    return new Response(JSON.stringify({ ok: "snapshot" }), { headers: json });
  },
});
console.log(String(server.port));
`,
  );
  const proc = Bun.spawn(["bun", script], { stdout: "pipe", stderr: "inherit" });
  member = proc;
  const reader = proc.stdout.getReader();
  const first = await reader.read();
  reader.releaseLock();
  base = `http://127.0.0.1:${new TextDecoder().decode(first.value).trim()}`;
}, 60_000);

afterAll(() => {
  member?.kill();
  void phone?.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

/** The real dial, with the member's address swapped for the child's loopback port. */
function dial(timeoutMs = 1_000): PeerClient {
  const fetch: CrewFetch = (url, init) => globalThis.fetch(url.replace(/^https?:\/\/[^/]+/, base), init);
  return new PeerClient({ self: "desk", secret: () => "s".repeat(32), timeoutMs, fetch, now: () => Date.now() });
}

const link = { memberId: "laptop", address: "laptop.example:8787" };

/** The lead's own front door for one forwarded body: what the phone's fetch sees when the lead streams it on. */
async function throughThePhone(route: string): Promise<{ bytes: number; error: string | null; ms: number }> {
  const started = performance.now();
  phone ??= Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const asked = new URL(req.url).pathname.slice(1);
      const outcome = await dial().proxy(link, asked, undefined, { bodyMax: bodyCapOf(asked) });
      if (!outcome.ok) return new Response(outcome.reason, { status: 503 });
      return proxiedResponse(outcome.value, null);
    },
    error: () => new Response("broken", { status: 500 }),
  });
  let bytes = 0;
  try {
    const res = await fetch(`http://127.0.0.1:${String(phone.port)}/${route}`);
    if (res.status !== 200) return { bytes, error: `status ${String(res.status)}`, ms: performance.now() - started };
    const reader = res.body!.getReader();
    let next = await reader.read();
    while (!next.done) {
      bytes += next.value.length;
      next = await reader.read();
    }
    return { bytes, error: null, ms: performance.now() - started };
  } catch (err) {
    return { bytes, error: err instanceof Error ? err.message : "error", ms: performance.now() - started };
  }
}

describe("B1: the idle limit on a member's body", () => {
  test("the limit is the call's budget for a body the lead reads, at least 10 s for one it streams on", () => {
    expect(bodyIdleMs("consumed", 1_200)).toBe(1_200);
    expect(bodyIdleMs("passthrough", 1_200)).toBe(BODY_IDLE_MS);
    expect(bodyIdleMs("passthrough", 30_000)).toBe(30_000);
  });

  test("headers then silence: the read ends within the budget, as a member out of reach", async () => {
    // A Bun member sends no headers before its first body byte, so this one meets the header budget.
    const started = performance.now();
    const outcome = await dial().json(link, "silent");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.state === "unreachable" && outcome.timedOut).toBe(true);
    expect(performance.now() - started).toBeLessThan(2_500);
  });

  test("headers and a first byte, then silence: the body's idle limit ends it, on the lead's own clock", async () => {
    const started = performance.now();
    const outcome = await dial().json(link, "open");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("open: no byte of the answer for 1000ms");
    // An unreachable member, on the lead's own clock: §10.4 re-asks on the patient budget, as after a header timeout.
    expect(outcome.state === "unreachable" && outcome.timedOut).toBe(true);
    expect(performance.now() - started).toBeLessThan(2_500);
  });

  test("a body the lead reads may drip under the idle limit only until its total deadline (review round 8)", async () => {
    // 7 bytes over about 1.5 s: inside three budgets, so it passes.
    const short = await dial().json(link, "drip-short");
    expect(short.ok).toBe(true);
    if (short.ok) expect(short.value).toEqual({ a: 1 });
    // 17 bytes over about 4 s: no gap reaches the 1 s idle limit, but the 3 s deadline ends it.
    const started = performance.now();
    const long = await dial().json(link, "drip");
    expect(long.ok).toBe(false);
    if (long.ok) return;
    expect(long.reason).toBe("drip: the answer did not end in time");
    expect(long.state === "unreachable" && long.timedOut).toBe(true);
    expect(performance.now() - started).toBeGreaterThan(2_800);
    expect(performance.now() - started).toBeLessThan(3_600);
  }, 15_000);

  test("a body streamed to the phone has no deadline: the same 4 s drip reaches the phone whole", async () => {
    const run = await throughThePhone("blobs/drip");
    expect(run.error).toBeNull();
    expect(run.bytes).toBe('{"ok":"dripping"}'.length);
    expect(run.ms).toBeGreaterThan(3_000);
  }, 15_000);

  test("the reviewer's case: one member drips for ever, the sweep still ends, the honest member is fresh, and the next sweep runs", async () => {
    // Two members on one child: the dripping one's snapshot is rewritten to the dripping route.
    const fetch: CrewFetch = (url, init) =>
      globalThis.fetch(url.replace(/^https?:\/\/drip\.example:8787\/crew\/v1\/snapshot/, `${base}/crew/v1/drip-forever`).replace(/^https?:\/\/[^/]+/, base), init);
    const client = new PeerClient({ self: "desk", secret: () => "s".repeat(32), timeoutMs: 1_000, fetch, now: () => Date.now() });
    const registry = new CrewRegistry({ sessions: { get: () => undefined }, self: "desk", members: () => [trusted({ memberId: "drip" }), trusted({ memberId: "honest" })] });
    const lead = new CrewLead({
      log: () => undefined,
      registry,
      snapshot: (l, view, fresh, follow) => client.snapshot(l, view, fresh, follow),
      proxy: neverProxy,
      self: { id: "desk", name: "the herd" },
      maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
      now: () => Date.now(),
    });
    for (const round of [1, 2]) {
      const started = performance.now();
      await lead.sweep();
      // Inside the bound: three budgets (3 s), and not stuck behind the drip.
      expect([round, performance.now() - started < 4_000]).toEqual([round, true]);
      expect(registry.state("honest").health).toBe("reachable");
      expect(registry.state("drip").health).toBe("unreachable");
    }
  }, 30_000);

  test("a body that stalls half way fails, the lead's memory stays level, and the next dial answers", async () => {
    const rss = () => process.memoryUsage().rss / MB;
    // One round first, so the runtime's own buffers are counted before the measure.
    await dial().json(link, "half");
    Bun.gc(true);
    const before = rss();
    for (let round = 0; round < 3; round += 1) {
      const outcome = await dial().json(link, "half");
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.reason).toBe("half: no byte of the answer for 1000ms");
      // The next sweep's dial to the same member runs and answers.
      const next = await dial().json(link, "snapshot");
      expect(next.ok).toBe(true);
    }
    Bun.gc(true);
    // Three stalls of 2 MB each: nothing of them is held once they end.
    expect(rss() - before).toBeLessThan(16);
  }, 30_000);

  test("a body streamed on to the phone that stalls half way breaks off there after 10 s: the phone sees an error", async () => {
    const run = await throughThePhone("blobs/half");
    expect(run.error).not.toBeNull();
    expect(run.bytes).toBeLessThan(4 * MB);
    expect(run.ms).toBeGreaterThan(BODY_IDLE_MS - 500);
    expect(run.ms).toBeLessThan(BODY_IDLE_MS + 5_000);
  }, 30_000);
});

describe("B2: the size cap on an identity body", () => {
  test("an honest 16 MB blob reaches the phone whole", async () => {
    const run = await throughThePhone("blobs/blob-whole");
    expect(run.error).toBeNull();
    expect(run.bytes).toBe(16 * MB);
  }, 30_000);

  test("a body with no end breaks off at the cap: the phone's read ends in an error, never a short file", async () => {
    Bun.gc(true);
    const before = process.memoryUsage().rss / MB;
    const run = await throughThePhone("blobs/endless");
    expect(run.error).not.toBeNull();
    expect(run.bytes).toBeLessThanOrEqual(CREW_BYTES_MAX);
    // Streamed through: the lead holds no copy of the 32 MB it passed on.
    expect(process.memoryUsage().rss / MB - before).toBeLessThan(64);
  }, 30_000);

  test("a body that declares more than the cap is refused before a byte is read", async () => {
    const outcome = await dial().proxy(link, "blobs/long-declared", undefined, { bodyMax: CREW_BYTES_MAX });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe(`blobs/long-declared: the peer's answer is larger than the lead reads (${String(CREW_BYTES_MAX)} bytes)`);
  });

  test("the cap holds on a route's own smaller number too", async () => {
    const outcome = await dial().proxy(link, "project-picture/endless", undefined, { bodyMax: 256 * 1024 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const error = await outcome.value.arrayBuffer().then(
      () => null,
      (err: Error) => err.message,
    );
    expect(error).toBe(`the answer passed ${String(256 * 1024)} bytes`);
  });
});

describe("guardedBody on its own", () => {
  test("a body exactly at the cap passes, one byte over does not", async () => {
    const read = (n: number) =>
      new Response(guardedBody(new Response(new Uint8Array(n)).body!, { idleMs: 1_000, max: 4096 })).arrayBuffer().then(
        (b) => b.byteLength,
        (err: Error) => err.message,
      );
    expect(await read(4096)).toBe(4096);
    expect(await read(4097)).toBe("the answer passed 4096 bytes");
  });

  test("a slow reader never trips the idle limit: the clock runs only while a read waits", async () => {
    const body = guardedBody(new Response(new Uint8Array(3)).body!, { idleMs: 50, max: 10 });
    const reader = body.getReader();
    await Bun.sleep(200);
    const first = await reader.read();
    expect(first.done).toBe(false);
  });
});
