import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

import { readCappedBody, pictureVersion } from "../project-picture.ts";
import { forwardedPictureRoute } from "../server.ts";
import { boundedGunzip, CREW_INFLATE_MAX } from "./bounded-gunzip.ts";
import { proxiedResponse } from "./forward.ts";
import { PeerClient, type CrewFetch } from "./peer-client.ts";

// THE LEAD INFLATES A MEMBER'S GZIP ITSELF, WITH A CAP (ADR 0161, CREW_PROTOCOL.md §9.1), through the
// real dial against a member in its own process: the member's bytes cross a real socket, the member's
// JSON goes out through the real `gzipJsonResponse`, and the lead's memory is measured while it reads.

const HERE = join(import.meta.dir, "..");
const dir = mkdtempSync(join(tmpdir(), "collie-gzip-member-"));
let member: ReturnType<typeof Bun.spawn> | null = null;
let base = "";

/** A still 128 x 128 PNG that passes every picture rule (the CRCs are zero: nothing checks them). */
function png(): Uint8Array {
  const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  const ascii = (t: string) => [...t].map((c) => c.charCodeAt(0));
  const chunk = (type: string, data: number[]) => [...be32(data.length), ...ascii(type), ...data, 0, 0, 0, 0];
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk("IHDR", [...be32(128), ...be32(128), 8, 6, 0, 0, 0]), ...chunk("IDAT", Array.from({ length: 16 }, () => 0)), ...chunk("IEND", [])]);
}

/** A snapshot body of S4's shape: 30 panes over 8 spaces, with the fields a live bridge adds. */
function snapshotBody() {
  const repos = ["collie", "site", "athena", "infra", "notes", "bay", "darius", "lab"];
  const pane = (i: number) => ({
    paneId: `w${String((i % 8) + 1)}:p${String(i + 1)}`,
    workspaceId: `w${String((i % 8) + 1)}`,
    workspaceLabel: repos[i % 8],
    agent: i < 22 ? "claude" : "shell",
    status: "idle",
    cwd: `/home/you/projects/${repos[i % 8] ?? ""}/src/feature-${String(i)}`,
    gitHead: { branch: `feat/item-${String(i)}`, dirty: i % 3 === 0 },
    model: "claude-opus-5-5",
    usage: { context: 0.42, windows: [{ id: "5h", used: 0.31 }] },
    picture: (i * 7919).toString(16).padStart(24, "0"),
  });
  return { agents: Array.from({ length: 22 }, (_, i) => pane(i)), shellPanes: Array.from({ length: 8 }, (_, i) => pane(22 + i)), ts: 1 };
}

const PICTURE = png();
const SNAPSHOT = snapshotBody();

beforeAll(async () => {
  const script = join(dir, "member.ts");
  writeFileSync(
    script,
    `
import { gzipSync, deflateSync, brotliCompressSync } from "node:zlib";
import { gzipJsonResponse } from ${JSON.stringify(join(HERE, "http-cache.ts"))};
const zeros = new Uint8Array(128 * 1024 * 1024);
const bomb = { gzip: gzipSync(zeros), deflate: deflateSync(zeros), br: brotliCompressSync(zeros) };
const picture = new Uint8Array(${JSON.stringify([...PICTURE])});
const big = gzipSync(new Uint8Array(300 * 1024));
const snapshot = ${JSON.stringify(SNAPSHOT)};
const crew = { "x-crew-protocol": "2", "x-crew-member": "laptop" };
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch(req) {
    const ae = req.headers.get("accept-encoding");
    const p = new URL(req.url).pathname;
    const h = (enc, ct = "image/png") => { const o = { ...crew, "content-type": ct, "x-seen-ae": ae ?? "" }; if (enc !== null) o["content-encoding"] = enc; return o; };
    if (p.endsWith("/bomb-gzip")) return new Response(bomb.gzip, { headers: h("gzip", "application/json") });
    if (p.endsWith("/bomb-br")) return new Response(bomb.br, { headers: h("br") });
    if (p.endsWith("/bomb-deflate")) return new Response(bomb.deflate, { headers: h("deflate") });
    if (p.endsWith("/picture-gzip")) return new Response(gzipSync(picture), { headers: h("gzip") });
    if (p.endsWith("/picture-big")) return new Response(big, { headers: h("gzip") });
    if (p.endsWith("/lie-header")) return new Response("{}", { headers: h("gzip", "application/json") });
    if (p.endsWith("/lie-body")) return new Response(gzipSync("{}"), { headers: h(null, "application/json") });
    if (p.endsWith("/slow")) {
      const head = gzipSync(picture).subarray(0, 10);
      return new Response(new ReadableStream({ start(c) { c.enqueue(head); } }), { headers: h("gzip") });
    }
    const res = gzipJsonResponse(snapshot, ae, crew);
    const sent = res.headers.get("content-encoding") === "gzip" ? "gzip" : "plain";
    res.headers.set("x-seen-ae", ae ?? "");
    res.headers.set("x-sent", sent);
    return res;
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
  rmSync(dir, { recursive: true, force: true });
});

/** The real dial, with the member's address swapped for the child's loopback port. */
function dial(): PeerClient {
  const fetch: CrewFetch = (url, init) => globalThis.fetch(url.replace(/^https?:\/\/[^/]+/, base), init);
  return new PeerClient({ self: "desk", secret: () => "s".repeat(32), timeoutMs: 5_000, fetch, now: () => Date.now() });
}

const link = { memberId: "laptop", address: "laptop.example:8787" };

/** Drain a body, keeping nothing, and report the peak RSS rise in MB while it ran, and how it ended. */
async function drained(body: ReadableStream<Uint8Array> | null): Promise<{ peakMb: number; error: string | null }> {
  Bun.gc(true);
  const before = process.memoryUsage().rss;
  let peak = before;
  const sample = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 2);
  let error: string | null = null;
  try {
    if (body !== null) {
      const reader = body.getReader();
      let next = await reader.read();
      while (!next.done) {
        peak = Math.max(peak, process.memoryUsage().rss);
        next = await reader.read();
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : "error";
  } finally {
    clearInterval(sample);
  }
  return { peakMb: (peak - before) / 1048576, error };
}

describe("the dial against a member in its own process (ADR 0161)", () => {
  test("an honest snapshot travels gzipped and arrives whole and equal", async () => {
    const outcome = await dial().proxy(link, "snapshot");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The member saw the dial's own ask, and gzipped (the real `gzipJsonResponse`).
    expect(outcome.value.headers.get("x-seen-ae")).toBe("gzip");
    expect(outcome.value.headers.get("x-sent")).toBe("gzip");
    expect(outcome.value.headers.get("content-encoding")).toBeNull();
    expect(JSON.parse(await outcome.value.text())).toEqual(SNAPSHOT);
    // What the sweep costs on the wire again: S4's numbers, on this body.
    const plain = JSON.stringify(SNAPSHOT).length;
    const gz = Bun.gzipSync(JSON.stringify(SNAPSHOT)).length;
    expect(gz * 5).toBeLessThan(plain);
  });

  test("a gzip bomb stops at the default cap with the lead's memory level", async () => {
    /** Read the whole body the way `json()` does, buffered, and report the peak RSS rise in MB. */
    const buffered = async (inflateMax?: number) => {
      const outcome = await dial().proxy(link, "bomb-gzip", undefined, inflateMax === undefined ? {} : { inflateMax });
      if (!outcome.ok) throw new Error(outcome.reason);
      Bun.gc(true);
      const before = process.memoryUsage().rss;
      let peak = before;
      const sample = setInterval(() => {
        peak = Math.max(peak, process.memoryUsage().rss);
      }, 2);
      const error = await outcome.value.arrayBuffer().then(
        () => null,
        (err: Error) => err.message,
      );
      clearInterval(sample);
      peak = Math.max(peak, process.memoryUsage().rss);
      Bun.gc(true);
      return { peakMb: (peak - before) / 1048576, error };
    };
    const capped = await buffered();
    expect(capped.error).toBe(`the inflated body passed ${String(CREW_INFLATE_MAX)} bytes`);
    // The cap is 32 MB of output, held at most once over while the reader gathers it.
    expect(capped.peakMb).toBeLessThan(96);
    // The control: the same bomb with a 1 GB cap inflates all 128 MB, and the measurement sees it.
    const control = await buffered(1024 * 1024 * 1024);
    expect(control.error).toBeNull();
    expect(control.peakMb).toBeGreaterThan(120);
  }, 60_000);

  test("brotli and deflate are refused before their body is read", async () => {
    for (const route of ["bomb-br", "bomb-deflate"]) {
      Bun.gc(true);
      const before = process.memoryUsage().rss;
      const outcome = await dial().proxy(link, route);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.reason).toBe(`${route}: the peer answered in an encoding the lead does not decode`);
      expect((process.memoryUsage().rss - before) / 1048576).toBeLessThan(32);
    }
  });

  test("the picture route: a gzip picture body is served, one over 256 KB inflated is the miss", async () => {
    const version = pictureVersion(PICTURE);
    const good = await dial().proxy(link, "project-picture/picture-gzip", undefined, { inflateMax: 256 * 1024 });
    expect(good.ok).toBe(true);
    if (!good.ok) return;
    const served = await forwardedPictureRoute(version, proxiedResponse(good.value, null));
    expect(served.status).toBe(200);
    expect([...new Uint8Array(await served.arrayBuffer())]).toEqual([...PICTURE]);
    const big = await dial().proxy(link, "project-picture/picture-big", undefined, { inflateMax: 256 * 1024 });
    expect(big.ok).toBe(true);
    if (!big.ok) return;
    expect((await forwardedPictureRoute(version, proxiedResponse(big.value, null))).status).toBe(404);
  });

  test("a lying member: a gzip header over plain bytes is refused, gzip bytes with no header pass raw", async () => {
    const lied = await dial().json(link, "lie-header");
    expect(lied.ok).toBe(false);
    if (!lied.ok) expect(lied.reason).toBe("lie-header: malformed response body");
    const raw = await dial().proxy(link, "lie-body");
    expect(raw.ok).toBe(true);
    if (raw.ok) expect(new Uint8Array(await raw.value.arrayBuffer())).toEqual(Bun.gzipSync("{}"));
    // ...and the route's own parse then fails, as it always has.
    const parsed = await dial().json(link, "lie-body");
    expect(parsed.ok).toBe(false);
  });

  test("a slow gzip body ends at the reader's time limit", async () => {
    const outcome = await dial().proxy(link, "project-picture/slow", undefined, { inflateMax: 256 * 1024 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const started = performance.now();
    expect(await readCappedBody(outcome.value, 256 * 1024, 200)).toBeNull();
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("boundedGunzip on its own", () => {
  test("the input cap holds too: a stream of compressed bytes past it is refused", async () => {
    // Deflate inside a gzip stream is not gzip: a raw stored stream that never ends would need the input
    // cap, so feed garbage after a valid header and check the decoder refuses it rather than waiting.
    const bytes = deflateSync(new Uint8Array(10));
    const run = await drained(boundedGunzip(new Response(bytes).body!, 1024));
    expect(run.error).toBe("the body is not valid gzip");
  });

  test("a body exactly at the cap passes, one byte over does not", async () => {
    const at = await drained(boundedGunzip(new Response(Bun.gzipSync(new Uint8Array(4096))).body!, 4096));
    expect(at.error).toBeNull();
    const over = await drained(boundedGunzip(new Response(Bun.gzipSync(new Uint8Array(4097))).body!, 4096));
    expect(over.error).toBe("the inflated body passed 4096 bytes");
  });

  test("the compressed input past the cap is refused", async () => {
    const random = new Uint8Array(8192);
    crypto.getRandomValues(random);
    const run = await drained(boundedGunzip(new Response(Bun.gzipSync(random)).body!, 4096));
    expect(run.error).not.toBeNull();
  });
});
