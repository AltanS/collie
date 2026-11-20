import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { forwardToPeer, proxiedResponse } from "./forward.ts";
import { maskForwardedAnswer } from "./mask.ts";
import { askSentMember, type SentMember } from "../sent.ts";
import { BODY_IDLE_MS, CREW_BODY_MAX, CREW_JSON_MAX, limitedBody, WHOLE_ANSWER_DEADLINE_MS } from "./guarded-body.ts";
import { CrewLead } from "./lead.ts";
import { member as trusted, neverProxy } from "./fixtures.ts";
import { PeerClient, type CrewFetch } from "./peer-client.ts";
import { CrewRegistry } from "./registry.ts";
import { DEFAULT_MAX_UPLOAD_BYTES } from "../uploads.ts";

// THE LEAD'S LIMITS ON A MEMBER'S ANSWER (CREW_PROTOCOL.md §9.1), through the real dial against a member
// in its own process: a slow, stuck or broken member cannot stall or bloat the lead. The time limit (a
// total deadline on a read the lead takes in full, an idle limit on a download), and the size limit on
// the bytes the lead reads, after the runtime's own decompression.

const dir = mkdtempSync(join(tmpdir(), "collie-body-member-"));
let member: ReturnType<typeof Bun.spawn> | null = null;
let base = "";
let phone: ReturnType<typeof Bun.serve> | null = null;

const MB = 1024 * 1024;

/**
 * How far the lead's resident memory may rise over twenty stalled forwarded reads. Measured four rounds
 * in a row in one process (2026-11-20): Linux 17, 19, 18 and 11 MB, the Windows VM 63, 69, 62 and 63 MB.
 * Both are level after the first round, so the bound is the host's one-time rise, not a leak.
 */
const LEVEL_MB = process.platform === "win32" ? 96 : 40;

/**
 * Bun 1.4 on Windows inflates a gzip answer far ahead of the reader: reading the first 4 MB of a 256 MB
 * gzip answer raised the resident memory by 455 MB on the Windows VM and by 7 MB on Linux (2026-11-20).
 * The size limits below still hold there and are still tested; the lead's memory does not stay level,
 * and that is an open question for the crew transport, not a test to loosen.
 */
const BUN_INFLATES_AHEAD = process.platform === "win32";

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
const held = { opened: 0, closed: 0, aborted: 0, packedSent: 0, plainSent: 0 };
// 64 MB of hex text, gzipped at about 2 to 1: a runtime that inflated the whole body before the reader
// saw it would have to take most of the packed bytes, one that streams takes little more than the limit.
const hexText = Buffer.from(crypto.getRandomValues(new Uint8Array(32 * 1024 * 1024)).buffer).toString("hex");
const packedText = Bun.gzipSync(new TextEncoder().encode(hexText), { level: 1 });
const packedHuge = Bun.gzipSync(new Uint8Array(256 * 1024 * 1024));
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
    // The reviewer's masked read: 1.9 MB of a History answer at once, then one byte every 8 s (under the
    // 10 s idle limit), for ever. Each stream counts itself open, and closed when it is cancelled.
    if (p.endsWith("/stats")) return Response.json(held);
    if (p.endsWith("/history") || p.endsWith("/crew/v1/sent")) {
      held.opened += 1;
      req.signal.addEventListener("abort", () => { held.aborted += 1; });
      let first = true;
      return new Response(new ReadableStream({
        async pull(c) { if (first) { first = false; c.enqueue(new TextEncoder().encode('{"entries":["' + "x".repeat(1900 * 1024))); return; } await sleep(8000); c.enqueue(new TextEncoder().encode("x")); },
        cancel() { held.closed += 1; },
      }), { headers: json });
    }
    // 4 MB announced as chunks: the first 2 MB, then silence.
    if (p.endsWith("/half")) {
      let sent = 0;
      return new Response(new ReadableStream({ async pull(c) { if (sent >= 2) { await new Promise(() => {}); } c.enqueue(piece); sent += 1; } }), { headers: bin });
    }
    // An identity body with no length and no end, 1 MB at a time, counted as the socket takes it.
    if (p.endsWith("/endless")) return new Response(new ReadableStream({ pull(c) { held.plainSent += piece.length; c.enqueue(piece); } }), { headers: bin });
    // The packed hex text, 64 KB at a time, counted as the socket takes it.
    if (p.endsWith("/packed-text")) {
      let at = 0;
      return new Response(new ReadableStream({ pull(c) { if (at >= packedText.length) { c.close(); return; } const next = packedText.subarray(at, at + 65536); at += next.length; held.packedSent += next.length; c.enqueue(next); } }), { headers: { ...json, "content-encoding": "gzip" } });
    }
    if (p.endsWith("/packed-size")) return Response.json({ packed: packedText.length });
    // A gzip answer that inflates to 256 MB of zeros, from about 256 KB on the wire.
    if (p.endsWith("/packed-huge")) return new Response(packedHuge, { headers: { ...json, "content-encoding": "gzip" } });
    // An honest snapshot, gzipped as a member gzips it.
    if (p.endsWith("/packed-snapshot")) return new Response(Bun.gzipSync(new TextEncoder().encode(JSON.stringify({ ok: "packed", panes: Array.from({ length: 300 }, (_, i) => ({ id: "w1:p" + i })) }))), { headers: { ...json, "content-encoding": "gzip" } });
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
function dial(timeoutMs = 1_000, streamDeadlineMs?: number): PeerClient {
  const fetch: CrewFetch = (url, init) => globalThis.fetch(url.replace(/^https?:\/\/[^/]+/, base), init);
  const deps = { self: "desk", secret: () => "s".repeat(32), timeoutMs, fetch, now: () => Date.now() };
  return new PeerClient(streamDeadlineMs === undefined ? deps : { ...deps, streamDeadlineMs });
}

const link = { memberId: "laptop", address: "laptop.example:8787" };

/** The stream limit the next {@link throughThePhone} dials with (absent: the real 10 minutes). */
let phoneStreamDeadlineMs: number | undefined;

/** The lead's own front door for one forwarded body: what the phone's fetch sees when the lead streams it on. */
async function throughThePhone(route: string, streamDeadlineMs?: number): Promise<{ bytes: number; error: string | null; ms: number }> {
  const started = performance.now();
  phoneStreamDeadlineMs = streamDeadlineMs;
  phone ??= Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const asked = new URL(req.url).pathname.slice(1);
      const outcome = await dial(1_000, phoneStreamDeadlineMs).proxy(link, asked);
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

describe("the time limit: a stuck member never holds the lead", () => {
  test("headers then silence: the read ends within the budget, as a member out of reach", async () => {
    // A Bun member sends no headers before its first body byte, so this one meets the header budget.
    const started = performance.now();
    const outcome = await dial().json(link, "silent");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.state === "unreachable" && outcome.timedOut).toBe(true);
    expect(performance.now() - started).toBeLessThan(2_500);
  });

  test("headers and a first byte, then silence: the total deadline ends it, on the lead's own clock", async () => {
    const started = performance.now();
    const outcome = await dial().json(link, "open");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("open: the answer did not end in time");
    // An unreachable member, on the lead's own clock: §10.4 re-asks on the patient budget, as after a header timeout.
    expect(outcome.state === "unreachable" && outcome.timedOut).toBe(true);
    expect(performance.now() - started).toBeLessThan(3_600);
  }, 10_000);

  test("a body the lead reads ends by its total deadline, however steadily it drips", async () => {
    // 7 bytes over about 1.5 s: inside three budgets, so it passes.
    const short = await dial().json(link, "drip-short");
    expect(short.ok).toBe(true);
    if (short.ok) expect(short.value).toEqual({ a: 1 });
    // 17 bytes over about 4 s: the 3 s deadline ends it.
    const started = performance.now();
    const long = await dial().json(link, "drip");
    expect(long.ok).toBe(false);
    if (long.ok) return;
    expect(long.reason).toBe("drip: the answer did not end in time");
    expect(long.state === "unreachable" && long.timedOut).toBe(true);
    expect(performance.now() - started).toBeGreaterThan(2_800);
    expect(performance.now() - started).toBeLessThan(3_600);
  }, 15_000);

  test("a download streamed to the phone has no short deadline: the same 4 s drip reaches the phone whole", async () => {
    const run = await throughThePhone("blobs/drip");
    expect(run.error).toBeNull();
    expect(run.bytes).toBe('{"ok":"dripping"}'.length);
    expect(run.ms).toBeGreaterThan(3_000);
  }, 15_000);

  test("a download that drips for ever, never idle, ends at its total limit: the phone sees an error (round 16)", async () => {
    // One byte every 700 ms never trips the 10 s idle limit. The total limit is set to 2 s here; it is
    // STREAM_DEADLINE_MS, 10 minutes, in the lead.
    const run = await throughThePhone("blobs/drip-forever", 2_000);
    expect(run.error).not.toBeNull();
    expect(run.bytes).toBeGreaterThan(0);
    expect(run.ms).toBeGreaterThan(1_800);
    expect(run.ms).toBeLessThan(4_000);
  }, 15_000);

  test("one member drips for ever: the sweep still ends, the honest member is fresh, and the next sweep runs", async () => {
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
      if (!outcome.ok) expect(outcome.reason).toBe("half: the answer did not end in time");
      // The next sweep's dial to the same member runs and answers.
      const next = await dial().json(link, "snapshot");
      expect(next.ok).toBe(true);
    }
    Bun.gc(true);
    // Three stalls of 2 MB each: nothing of them is held once they end.
    expect(rss() - before).toBeLessThan(16);
  }, 30_000);

  test("a download that stalls half way breaks off at the idle limit: the phone sees an error", async () => {
    const run = await throughThePhone("blobs/half");
    expect(run.error).not.toBeNull();
    expect(run.bytes).toBeLessThan(4 * MB);
    expect(run.ms).toBeGreaterThan(BODY_IDLE_MS - 500);
    expect(run.ms).toBeLessThan(BODY_IDLE_MS + 5_000);
  }, 30_000);
});

describe("a forwarded read taken in full ends by its deadline, and a phone that leaves ends it", () => {
  /** The lead's real forward, the real dial and the lead's real mask, against the child member. */
  const forwardOnce = (req: Request) =>
    forwardToPeer(req, new URL(req.url), {
      link,
      state: { memberId: "laptop", health: "reachable", lastSeenAt: Date.now(), reason: null, version: "1.30.0", conflict: null, preflight: null },
      maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
      transport: (l, route, params, init, budgetMs) => dial().proxy(l, route, params, init, budgetMs),
      mask: maskForwardedAnswer,
      log: () => undefined,
    });
  const stats = async (): Promise<{ opened: number; closed: number }> => {
    const body: unknown = await (await fetch(`${base}/stats`)).json();
    if (typeof body !== "object" || body === null || !("opened" in body) || !("closed" in body)) throw new Error("no stats");
    const { opened, closed } = body;
    if (typeof opened !== "number" || typeof closed !== "number") throw new Error("no stats");
    return { opened, closed };
  };

  test("twenty polls of a stalled History: each ends at the deadline as a member out of reach, every member stream closes, the lead's memory is level", async () => {
    const before = await stats();
    Bun.gc(true);
    const rss = process.memoryUsage().rss / MB;
    const polls = Array.from({ length: 20 }, async (_, i) => {
      await Bun.sleep(i * 300);
      const started = performance.now();
      const res = await forwardOnce(new Request("https://lead.example/api/pane/w1:p1/history?host=laptop"));
      const body: unknown = await res.json();
      const code = typeof body === "object" && body !== null && "code" in body ? body.code : undefined;
      return { status: res.status, code, ms: performance.now() - started };
    });
    const answers = await Promise.all(polls);
    for (const a of answers) {
      expect([a.status, a.code]).toEqual([503, "host_unreachable"]);
      expect(a.ms).toBeGreaterThan(WHOLE_ANSWER_DEADLINE_MS - 500);
      expect(a.ms).toBeLessThan(WHOLE_ANSWER_DEADLINE_MS + 1_500);
    }
    await Bun.sleep(300);
    const after = await stats();
    expect(after.opened - before.opened).toBe(20);
    expect(after.closed - before.closed).toBe(20);
    Bun.gc(true);
    expect(process.memoryUsage().rss / MB - rss).toBeLessThan(LEVEL_MB);
  }, 60_000);

  test("Sent for all machines, redaction on: at its budget the member's read is aborted, not left held", async () => {
    const before = await stats();
    const dripping: SentMember = {
      host: "laptop",
      label: "laptop",
      ask: (params, signal) => {
        const url = new URL(`https://lead.example/api/sent?${params.toString()}`);
        url.searchParams.set("host", "laptop");
        return forwardOnce(new Request(url, { signal }));
      },
    };
    const started = performance.now();
    expect(await askSentMember(dripping, new URLSearchParams({ scope: "here" }), 1_000)).toEqual({ ok: false, reason: "timeout" });
    expect(performance.now() - started).toBeLessThan(2_500);
    await Bun.sleep(500);
    const after = await stats();
    expect(after.opened - before.opened).toBe(1);
    expect(after.closed - before.closed).toBe(1);
  }, 20_000);

  test("a phone that goes away aborts the member's read at once", async () => {
    const lead = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: (req) => forwardOnce(new Request(`https://lead.example${new URL(req.url).pathname}${new URL(req.url).search}`, { signal: req.signal })) });
    try {
      const before = await stats();
      const leaving = new AbortController();
      setTimeout(() => leaving.abort(), 500);
      await fetch(`http://127.0.0.1:${String(lead.port)}/api/pane/w1:p1/history?host=laptop`, { signal: leaving.signal }).catch(() => null);
      await Bun.sleep(500);
      const after = await stats();
      expect(after.opened - before.opened).toBe(1);
      expect(after.closed - before.closed).toBe(1);
    } finally {
      await lead.stop(true);
    }
  }, 20_000);
});

describe("the size limit: a far too large answer never bloats the lead", () => {
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
    expect(run.bytes).toBeLessThanOrEqual(CREW_BODY_MAX);
    // Streamed through: the lead holds no copy of the 32 MB it passed on.
    expect(process.memoryUsage().rss / MB - before).toBeLessThan(64);
  }, 30_000);

  test("a gzip answer that inflates far past the limit is cut at the limit, and the lead's memory stays level", async () => {
    // The runtime inflates as a stream, so the lead holds about the limit, never the 256 MB.
    Bun.gc(true);
    const before = process.memoryUsage().rss / MB;
    const read = await dial().json(link, "packed-huge");
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toBe(`packed-huge: the answer passed ${String(CREW_JSON_MAX)} bytes`);
    const passed = await dial().proxy(link, "packed-huge");
    expect(passed.ok).toBe(true);
    if (!passed.ok) return;
    const error = await passed.value.arrayBuffer().then(
      () => null,
      (err: Error) => err.message,
    );
    expect(error).toBe(`the answer passed ${String(CREW_BODY_MAX)} bytes`);
    Bun.gc(true);
    // Not on Windows: there Bun's fetch inflates a gzip body far ahead of the reader (BUN_INFLATES_AHEAD).
    if (!BUN_INFLATES_AHEAD) expect(process.memoryUsage().rss / MB - before).toBeLessThan(160);
  }, 30_000);

  test("the real fetch inflates as a stream: a 64 MB gzip answer stops near the 2 MB limit, and so does an endless plain one at 32 MB", async () => {
    const started = performance.now();
    const counter = { pulled: 0 };
    // The real fetch; only its body is wrapped, to count the inflated bytes the dial pulls through it.
    const counting: CrewFetch = async (url, init) => {
      const res = await globalThis.fetch(url.replace(/^https?:\/\/[^/]+/, base), init);
      if (res.body === null) return res;
      const reader = res.body.getReader();
      const body = new ReadableStream<Uint8Array>(
        {
          async pull(c) {
            const next = await reader.read();
            if (next.done) {
              c.close();
              return;
            }
            counter.pulled += next.value.length;
            c.enqueue(next.value);
          },
          cancel: (reason) => reader.cancel(reason),
        },
        { highWaterMark: 0 },
      );
      return new Response(body, { status: res.status, headers: res.headers });
    };
    const client = new PeerClient({ self: "desk", secret: () => "s".repeat(32), timeoutMs: 1_000, fetch: counting, now: () => Date.now() });
    const sent = async () => {
      const body: unknown = await (await fetch(`${base}/stats`)).json();
      if (typeof body !== "object" || body === null || !("packedSent" in body) || !("plainSent" in body)) throw new Error("no stats");
      const { packedSent, plainSent } = body;
      if (typeof packedSent !== "number" || typeof plainSent !== "number") throw new Error("no stats");
      return { packedSent, plainSent };
    };
    const sizeBody: unknown = await (await fetch(`${base}/packed-size`)).json();
    const packed = typeof sizeBody === "object" && sizeBody !== null && "packed" in sizeBody && typeof sizeBody.packed === "number" ? sizeBody.packed : 0;
    expect(packed).toBeGreaterThan(30 * MB);

    const before = await sent();
    const read = await client.json(link, "packed-text");
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toBe(`packed-text: the answer passed ${String(CREW_JSON_MAX)} bytes`);
    // The inflated bytes the dial pulled: the limit and at most one more piece of the runtime's.
    expect(counter.pulled).toBeGreaterThan(CREW_JSON_MAX);
    expect(counter.pulled).toBeLessThan(CREW_JSON_MAX + MB);
    const jsonPulled = counter.pulled;
    await Bun.sleep(100);
    const afterPacked = await sent();
    // The packed bytes the member got to send: a small part of the whole, never most of it.
    const packedTaken = afterPacked.packedSent - before.packedSent;
    expect(packedTaken).toBeLessThan(packed / 4);

    counter.pulled = 0;
    const endless = await client.proxy(link, "blobs/endless");
    expect(endless.ok).toBe(true);
    if (!endless.ok) return;
    const error = await endless.value.arrayBuffer().then(
      () => null,
      (err: Error) => err.message,
    );
    expect(error).toBe(`the answer passed ${String(CREW_BODY_MAX)} bytes`);
    expect(counter.pulled).toBeLessThan(CREW_BODY_MAX + 2 * MB);
    await Bun.sleep(100);
    const plainTaken = (await sent()).plainSent - afterPacked.plainSent;
    expect(plainTaken).toBeLessThan(CREW_BODY_MAX + 16 * MB);
    console.log(`packed ${String(packed)} B; json read pulled ${String(jsonPulled)} inflated, member sent ${String(packedTaken)} packed; endless sent ${String(plainTaken)}; ${String(Math.round(performance.now() - started))} ms`);
    expect(performance.now() - started).toBeLessThan(3_000);
  }, 20_000);

  test("an honest gzip answer arrives whole and equal", async () => {
    const outcome = await dial().json(link, "packed-snapshot");
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.value).toMatchObject({ ok: "packed" });
  });
});

describe("limitedBody on its own", () => {
  test("a body exactly at the cap passes, one byte over does not", async () => {
    const read = (n: number) =>
      new Response(limitedBody(new Response(new Uint8Array(n)).body!, { max: 4096, onStop: () => undefined, late: () => false })).arrayBuffer().then(
        (b) => b.byteLength,
        (err: Error) => err.message,
      );
    expect(await read(4096)).toBe(4096);
    expect(await read(4097)).toBe("the answer passed 4096 bytes");
  });

  test("a slow reader never trips the idle limit: the clock runs only while a read waits", async () => {
    const body = limitedBody(new Response(new Uint8Array(3)).body!, { max: 10, idleMs: 50, onStop: () => undefined, late: () => false });
    const reader = body.getReader();
    await Bun.sleep(200);
    const first = await reader.read();
    expect(first.done).toBe(false);
  });
});
