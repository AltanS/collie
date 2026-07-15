import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Push } from "./push.ts";
import type { PushSender, PushSubscription } from "./push.ts";
import { loadConfig } from "./config.ts";

// The broadcast prune-vs-log logic and the on-disk persistence are the untested-by-Bun.serve parts.
// We inject a fake sender so the 404/410-prune path is exercised without the real web-push library,
// and round-trip the subscriptions file through a throwaway temp state dir.

const dirs: string[] = [];
async function tempCfg() {
  const stateDir = await mkdtemp(join(tmpdir(), "collie-push-"));
  dirs.push(stateDir);
  return { ...loadConfig(), stateDir };
}

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

function sub(endpoint: string): PushSubscription {
  return { endpoint, keys: { p256dh: "p", auth: "a" } };
}

/** Enable push and seed subscriptions without the real VAPID/web-push init handshake. */
function enable(push: Push, seed: PushSubscription[]): Map<string, PushSubscription> {
  const internals = push as unknown as { _enabled: boolean; subs: Map<string, PushSubscription> };
  internals._enabled = true;
  for (const s of seed) internals.subs.set(s.endpoint, s);
  return internals.subs;
}

async function fileEndpoints(dir: string): Promise<string[]> {
  const raw = JSON.parse(await readFile(join(dir, "push-subscriptions.json"), "utf8"));
  return (raw as PushSubscription[]).map((s) => s.endpoint);
}

const gone = (endpoint: string) => Object.assign(new Error(`${endpoint} gone`), { statusCode: 410 });

describe("Push — broadcast delivery & pruning", () => {
  test("a 410 response prunes the subscription and persists the pruned set", async () => {
    const cfg = await tempCfg();
    const sender: PushSender = (s) =>
      s.endpoint === "dead" ? Promise.reject(gone("dead")) : Promise.resolve();
    const push = new Push(cfg, sender);
    const subs = enable(push, [sub("live"), sub("dead")]);

    await push.notify("hi", "there");

    expect([...subs.keys()]).toEqual(["live"]);
    expect(await fileEndpoints(cfg.stateDir)).toEqual(["live"]);
  });

  test("a non-410 error logs and keeps the subscription", async () => {
    const cfg = await tempCfg();
    const sender: PushSender = () =>
      Promise.reject(Object.assign(new Error("boom"), { statusCode: 500 }));
    const push = new Push(cfg, sender);
    const subs = enable(push, [sub("live")]);

    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = ((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    }) as typeof console.warn;
    try {
      await push.notify("hi", "there");
    } finally {
      console.warn = origWarn;
    }

    expect([...subs.keys()]).toEqual(["live"]); // kept
    expect(warnings.some((w) => w.includes("send failed"))).toBe(true);
    // No prune ⇒ no write ⇒ no file created.
    await expect(readFile(join(cfg.stateDir, "push-subscriptions.json"), "utf8")).rejects.toThrow();
  });

  test("successful sends touch neither the in-memory set nor disk", async () => {
    const cfg = await tempCfg();
    let calls = 0;
    const sender: PushSender = () => {
      calls++;
      return Promise.resolve();
    };
    const push = new Push(cfg, sender);
    const subs = enable(push, [sub("a"), sub("b")]);

    await push.notify("hi", "there");

    expect(calls).toBe(2);
    expect([...subs.keys()]).toEqual(["a", "b"]);
    await expect(readFile(join(cfg.stateDir, "push-subscriptions.json"), "utf8")).rejects.toThrow();
  });
});

describe("Push — persistence", () => {
  test("addSubscription persists with owner-only (0600) permissions", async () => {
    const cfg = await tempCfg();
    const push = new Push(cfg, () => Promise.resolve());
    enable(push, []);

    await push.addSubscription(sub("one"));

    expect(await fileEndpoints(cfg.stateDir)).toEqual(["one"]);
    const mode = (await stat(join(cfg.stateDir, "push-subscriptions.json"))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("concurrent saves serialise to a consistent final file", async () => {
    const cfg = await tempCfg();
    const push = new Push(cfg, () => Promise.resolve());
    enable(push, []);

    await Promise.all([
      push.addSubscription(sub("a")),
      push.addSubscription(sub("b")),
      push.addSubscription(sub("c")),
    ]);

    expect((await fileEndpoints(cfg.stateDir)).sort()).toEqual(["a", "b", "c"]);
  });
});

describe("Push — per-message collapse topic (update must not share the herd slot)", () => {
  // The `topic` is the push service's collapse key: sharing it would let an offline device's queued
  // herd summary and an update push silently overwrite each other. Capture the options + payload the
  // sender receives to pin the seam the update feature must never regress.
  function capturing() {
    const sends: { payload: string; options: { topic: string; TTL: number } }[] = [];
    const sender: PushSender = (_s, payload, options) => {
      sends.push({ payload, options });
      return Promise.resolve();
    };
    return { sender, sends };
  }

  test("an update push rides its OWN topic + longer TTL, and carries the settings target", async () => {
    const cfg = await tempCfg();
    const { sender, sends } = capturing();
    const push = new Push(cfg, sender);
    enable(push, [sub("a")]);

    await push.send({ type: "update", tag: "collie:update", title: "t", body: "b", target: "settings" });

    expect(sends[0]!.options).toEqual({ topic: "collie-update", TTL: 259_200 });
    expect(JSON.parse(sends[0]!.payload).data.target).toBe("settings");
  });

  test("an agent send keeps the herd topic/TTL and carries NO target (byte-identical path)", async () => {
    const cfg = await tempCfg();
    const { sender, sends } = capturing();
    const push = new Push(cfg, sender);
    enable(push, [sub("a")]);

    await push.send({ title: "claude needs you", body: "…", tag: "collie:herd", paneId: "w1:p1" });

    expect(sends[0]!.options).toEqual({ topic: "collie-herd", TTL: 21_600 });
    expect("target" in JSON.parse(sends[0]!.payload).data).toBe(false);
  });

  test("a clear stays on the herd topic (it closes the herd slot)", async () => {
    const cfg = await tempCfg();
    const { sender, sends } = capturing();
    const push = new Push(cfg, sender);
    enable(push, [sub("a")]);

    await push.send({ type: "clear", tag: "collie:herd" });
    expect(sends[0]!.options.topic).toBe("collie-herd");
  });
});
