import { describe, expect, test } from "bun:test";
import { mkdir, readdir, realpath, rm, stat, symlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClaudeTranscriptSource, DIR_SCAN_TTL_MS } from "./claude.ts";

describe("ClaudeTranscriptSource — continuation scan caching", () => {
  const ROOT = "11111111-1111-4111-8111-111111111111";
  const OLD = "22222222-2222-4222-8222-222222222222";
  const NEW = "33333333-3333-4333-8333-333333333333";
  const ACTIVE_B = "44444444-4444-4444-8444-444444444444";

  const row = (uuid: string, text: string) =>
    JSON.stringify({
      type: "user",
      uuid,
      timestamp: "2026-11-20T07:00:00.000Z",
      message: { role: "user", content: text },
    });

  async function makeLargeProject(coldCount: number) {
    // The temp root by the OS's own real path, the spelling the source reads its folders by: a fake
    // `readdir` that matches one folder by name must name it the same way (the Windows runner's
    // `tmpdir()` is an 8.3 short name, `RUNNER~1`, Windows CI 2026-11-21).
    const dir = join(await realpath(tmpdir()), `collie-cont-cache-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    const project = join(dir, "-Users-dev-projects");
    await mkdir(project, { recursive: true });

    const nowSec = Date.now() / 1000;
    const coldSec = nowSec - 7200; // 2 hours old — cold
    for (let i = 0; i < coldCount; i++) {
      const hex = i.toString(16).padStart(12, "0");
      const file = join(project, `00000000-0000-4000-8000-${hex}.jsonl`);
      await Bun.write(file, row(`cold-${i}`, "old"));
      await utimes(file, coldSec, coldSec);
    }

    await Bun.write(join(project, `${OLD}.jsonl`), [row(ROOT, "one"), row("u2", "two")].join("\n"));
    await utimes(join(project, `${OLD}.jsonl`), nowSec - 60, nowSec - 60);
    await Bun.write(join(project, `${ACTIVE_B}.jsonl`), [row("other-root", "hi")].join("\n"));

    return { dir, project };
  }

  function countingFs() {
    let statCalls = 0;
    let readdirCalls = 0;
    return {
      get statCalls() {
        return statCalls;
      },
      get readdirCalls() {
        return readdirCalls;
      },
      reset() {
        statCalls = 0;
        readdirCalls = 0;
      },
      stat(path: string) {
        statCalls += 1;
        return stat(path);
      },
      readdir(path: string) {
        readdirCalls += 1;
        return readdir(path);
      },
    };
  }

  test("multiple panes sharing a large project directory share one scan per TTL window", async () => {
    const { dir } = await makeLargeProject(60);
    const fs = countingFs();
    let clock = Date.now();
    try {
      const src = new ClaudeTranscriptSource(dir, { now: () => clock, stat: fs.stat, readdir: fs.readdir });

      // Populate pathCache and the first shared directory snapshot.
      expect(await src.resolve({ kind: "id", value: OLD })).toEndWith(`${OLD}.jsonl`);
      expect(await src.resolve({ kind: "id", value: ACTIVE_B })).toEndWith(`${ACTIVE_B}.jsonl`);
      fs.reset();

      // Within the same TTL window, 10 resolves across panes do zero extra readdirs and never re-stat the 60 siblings.
      clock += DIR_SCAN_TTL_MS - 1;
      for (let i = 0; i < 5; i++) {
        expect(await src.resolve({ kind: "id", value: OLD })).toEndWith(`${OLD}.jsonl`);
        expect(await src.resolve({ kind: "id", value: ACTIVE_B })).toEndWith(`${ACTIVE_B}.jsonl`);
      }

      expect(fs.readdirCalls).toBe(0);
      expect(fs.statCalls).toBeLessThan(30);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("detects a newly created rotation file immediately when directory mtime changes", async () => {
    const { dir, project } = await makeLargeProject(60);
    const fs = countingFs();
    const clock = Date.now();
    try {
      const src = new ClaudeTranscriptSource(dir, { now: () => clock, stat: fs.stat, readdir: fs.readdir });
      expect(await src.resolve({ kind: "id", value: OLD })).toEndWith(`${OLD}.jsonl`);
      fs.reset();

      const newPath = join(project, `${NEW}.jsonl`);
      await Bun.write(newPath, [row(ROOT, "one"), row("u2", "two"), row("u3", "three")].join("\n"));
      const futureSec = Date.now() / 1000 + 2;
      await utimes(newPath, futureSec, futureSec);
      await utimes(project, futureSec, futureSec);

      expect(await src.resolve({ kind: "id", value: OLD })).toEndWith(`${NEW}.jsonl`);
      expect(fs.readdirCalls).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("detects in-place growth of a previously cold sibling after one TTL window", async () => {
    const { dir, project } = await makeLargeProject(60);
    const fs = countingFs();
    let clock = Date.now();
    try {
      // Seed NEW smaller and >1h old (cold) so OLD wins on the initial scan.
      const newPath = join(project, `${NEW}.jsonl`);
      await Bun.write(newPath, row(ROOT, "one"));
      const coldSec = Date.now() / 1000 - 7200;
      await utimes(newPath, coldSec, coldSec);

      const src = new ClaudeTranscriptSource(dir, { now: () => clock, stat: fs.stat, readdir: fs.readdir });
      expect(await src.resolve({ kind: "id", value: OLD })).toEndWith(`${OLD}.jsonl`);
      fs.reset();

      // Grow NEW in place without touching directory mtime.
      await Bun.write(newPath, [row(ROOT, "one"), row("u2", "two"), row("u3", "three")].join("\n"));
      const futureSec = Date.now() / 1000 + 5;
      await utimes(newPath, futureSec, futureSec);

      clock += DIR_SCAN_TTL_MS;
      expect(await src.resolve({ kind: "id", value: OLD })).toEndWith(`${NEW}.jsonl`);
      expect(fs.readdirCalls).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("recovers on the next TTL window after a transient sibling stat failure", async () => {
    const { dir, project } = await makeLargeProject(10);
    const newPath = join(project, `${NEW}.jsonl`);
    await Bun.write(newPath, [row(ROOT, "one"), row("u2", "two"), row("u3", "three")].join("\n"));
    const futureSec = Date.now() / 1000 + 5;
    await utimes(newPath, futureSec, futureSec);

    let clock = Date.now();
    let failNewOnce = true;
    try {
      const src = new ClaudeTranscriptSource(dir, {
        now: () => clock,
        stat(path: string) {
          if (failNewOnce && path.endsWith(`${NEW}.jsonl`)) {
            failNewOnce = false;
            return Promise.reject(new Error("transient EIO"));
          }
          return stat(path);
        },
        readdir,
      });

      // First scan misses NEW due to transient stat failure.
      expect(await src.resolve({ kind: "id", value: OLD })).toEndWith(`${OLD}.jsonl`);

      // Next TTL window retries and discovers NEW even with unchanged directory mtime.
      clock += DIR_SCAN_TTL_MS;
      expect(await src.resolve({ kind: "id", value: OLD })).toEndWith(`${NEW}.jsonl`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("coalesces concurrent resolves in the same directory into one scan", async () => {
    const { dir } = await makeLargeProject(40);
    const fs = countingFs();
    let clock = Date.now();
    try {
      const src = new ClaudeTranscriptSource(dir, { now: () => clock, stat: fs.stat, readdir: fs.readdir });
      // Prime pathCache so both panes hit followContinuation simultaneously.
      await src.resolve({ kind: "id", value: OLD });
      await src.resolve({ kind: "id", value: ACTIVE_B });
      fs.reset();

      clock += DIR_SCAN_TTL_MS;
      const [r1, r2] = await Promise.all([
        src.resolve({ kind: "id", value: OLD }),
        src.resolve({ kind: "id", value: ACTIVE_B }),
      ]);
      expect(r1).toEndWith(`${OLD}.jsonl`);
      expect(r2).toEndWith(`${ACTIVE_B}.jsonl`);
      expect(fs.readdirCalls).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a sibling not yet grown past the pane's own log is not followed inside the TTL, and is after it", async () => {
    const { dir, project } = await makeLargeProject(10);
    let clock = Date.now();
    try {
      // NEW starts smaller and cold, so OLD wins on the first scan.
      const newPath = join(project, `${NEW}.jsonl`);
      await Bun.write(newPath, row(ROOT, "one"));
      const coldSec = Date.now() / 1000 - 7200;
      await utimes(newPath, coldSec, coldSec);

      const src = new ClaudeTranscriptSource(dir, { now: () => clock, stat, readdir });
      expect(await src.resolve({ kind: "id", value: OLD })).toEndWith(`${OLD}.jsonl`);

      // Grow NEW in place past OLD without touching the directory mtime.
      await Bun.write(newPath, [row(ROOT, "one"), row("u2", "two"), row("u3", "three")].join("\n"));
      const futureSec = Date.now() / 1000 + 5;
      await utimes(newPath, futureSec, futureSec);

      // Inside the TTL the snapshot still holds the old size and time: the old path stays.
      clock += DIR_SCAN_TTL_MS - 1;
      expect(await src.resolve({ kind: "id", value: OLD })).toEndWith(`${OLD}.jsonl`);

      clock += 1;
      expect(await src.resolve({ kind: "id", value: OLD })).toEndWith(`${NEW}.jsonl`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a scan whose readdir fails is not cached: the next resolve scans again and follows the sibling", async () => {
    const { dir, project } = await makeLargeProject(10);
    const newPath = join(project, `${NEW}.jsonl`);
    await Bun.write(newPath, [row(ROOT, "one"), row("u2", "two"), row("u3", "three")].join("\n"));
    const futureSec = Date.now() / 1000 + 5;
    await utimes(newPath, futureSec, futureSec);

    const clock = Date.now();
    let failProjectOnce = true;
    try {
      const src = new ClaudeTranscriptSource(dir, {
        now: () => clock,
        stat,
        readdir(path: string) {
          // Only the sibling scan of the project folder fails, not the walk over the root.
          if (failProjectOnce && path === project) {
            failProjectOnce = false;
            return Promise.reject(new Error("transient EIO"));
          }
          return readdir(path);
        },
      });

      expect(await src.resolve({ kind: "id", value: OLD })).toEndWith(`${OLD}.jsonl`);
      // Same clock, same directory mtime: only an uncached failure lets this scan again.
      expect(await src.resolve({ kind: "id", value: OLD })).toEndWith(`${NEW}.jsonl`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // The snapshot holds names, sizes and times, never a verdict on containment. A sibling swapped for a
  // symlink out of the root inside the TTL (same name, so the snapshot still lists it as the winner,
  // and the directory mtime put back so no rescan fires) must still be refused at the point of use.
  test("a sibling swapped for a symlink out of the root inside the TTL is never followed", async () => {
    const { dir, project } = await makeLargeProject(10);
    const outside = `${dir}-outside`;
    const clock = Date.now();
    try {
      await mkdir(outside, { recursive: true });
      const secret = join(outside, "secret.jsonl");
      await Bun.write(secret, Array(50).fill(row(ROOT, "secret")).join("\n"));

      const newPath = join(project, `${NEW}.jsonl`);
      await Bun.write(newPath, [row(ROOT, "one"), row("u2", "two"), row("u3", "three")].join("\n"));
      const futureSec = Math.floor(Date.now() / 1000) + 5;
      await utimes(newPath, futureSec, futureSec);
      const dirSec = Math.floor(Date.now() / 1000) - 600;
      await utimes(project, dirSec, dirSec);

      const src = new ClaudeTranscriptSource(dir, { now: () => clock, stat, readdir });
      // The first resolve fills the snapshot and legitimately follows the real sibling.
      expect(await src.resolve({ kind: "id", value: OLD })).toEndWith(`${NEW}.jsonl`);

      // Swap it for a symlink to the outside file, and restore the directory mtime to its exact value.
      await rm(newPath);
      await symlink(secret, newPath);
      await utimes(project, dirSec, dirSec);

      // Same clock, same directory mtime: the snapshot is reused and still lists NEW as the winner.
      const resolved = await src.resolve({ kind: "id", value: OLD });
      expect(resolved).toEndWith(`${OLD}.jsonl`);
      expect(resolved).not.toContain(outside);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
