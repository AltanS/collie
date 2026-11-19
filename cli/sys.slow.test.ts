// The slow cases of sys.test.ts: each waits more than a second on a real clock or a real process. The quick
// gate (`bun run gate`) leaves a `*.slow.test.*` file out; a full run keeps it.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realNet } from "./sys.ts";

describe("realNet().download clocks (a local server, injected small clocks)", () => {
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  const bytes = (n: number): Uint8Array => new Uint8Array(n).fill(7);

  // The production clocks are 20 s and 60 s; the rule under test is the same at 200 ms and 150 ms.
  const TIMING = { headersMs: 200, stallMs: 150, totalMs: 60_000 };

  const scratch = (): string => mkdtempSync(join(tmpdir(), "collie-dl-"));

  test("a slow body that keeps moving outlives the stall window and completes", async () => {
    // 20 chunks, one every 50 ms: 1 s in all, far past both clocks, and never silent for 150 ms.
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            for (let i = 0; i < 20; i++) {
              controller.enqueue(bytes(1000));
              await sleep(50);
            }
            controller.close();
          },
        });
        return new Response(body, { headers: { "content-length": "20000" } });
      },
    });
    const dir = scratch();
    try {
      const dest = join(dir, "asset.tgz");
      const got = await realNet(null, TIMING).download(`http://127.0.0.1:${server.port}/a`, dest);
      expect(got.ok).toBe(true);
      if (got.ok) expect(got.size).toBe(20000);
      expect(readFileSync(dest).byteLength).toBe(20000);
    } finally {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });
});
