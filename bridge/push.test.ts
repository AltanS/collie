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

// Issue #68: a subscription can be permanently dead while the push service answers with something
// other than 404/410 (Apple says 400 BadDeviceToken), so it was retried forever and re-logged every
// cycle. Eviction closes that, but only where the evidence is unambiguous — hence the origin guard.
describe("Push — eviction of persistently-failing subscriptions", () => {
  const APPLE = "https://web.push.apple.com";
  const FCM = "https://fcm.googleapis.com";
  /** A rejection shaped exactly like the WebPushError `web-push` throws (message is the useless
   *  constant; the real signal is statusCode + the service's reason in `body`). */
  const rejects = (statusCode: number, body: string) =>
    Object.assign(new Error("Received unexpected response code"), { statusCode, body });

  /** Collects console output so eviction/prune lines can be asserted (they're the operator's only
   *  view of this behaviour) without spraying the test run. */
  async function capturingConsole<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
    const lines: string[] = [];
    const collect = ((...args: unknown[]) => void lines.push(args.map(String).join(" "))) as typeof console.warn;
    const [origWarn, origLog] = [console.warn, console.log];
    console.warn = collect;
    console.log = collect;
    try {
      return { result: await fn(), lines };
    } finally {
      console.warn = origWarn;
      console.log = origLog;
    }
  }

  /** A sender that fails for `failing` endpoints and delivers for everything else. */
  function partialSender(failing: Map<string, Error>): PushSender {
    return (s) => {
      const err = failing.get(s.endpoint);
      return err ? Promise.reject(err) : Promise.resolve();
    };
  }

  const rounds = (push: Push, n: number) =>
    capturingConsole(async () => {
      for (let i = 0; i < n; i++) await push.notify("t", "b");
    });

  test("a dead-but-not-410 subscription is evicted once a sibling on its service succeeds", async () => {
    const cfg = await tempCfg();
    const [dead, live] = [`${APPLE}/dead`, `${APPLE}/live`];
    const push = new Push(cfg, partialSender(new Map([[dead, rejects(400, '{"reason":"BadDeviceToken"}')]])));
    const subs = enable(push, [sub(dead), sub(live)]);

    // Four rounds of failure are not enough — a run of transients must not cost anyone their pushes.
    await rounds(push, 4);
    expect([...subs.keys()]).toEqual([dead, live]);

    const { lines } = await rounds(push, 1);
    expect([...subs.keys()]).toEqual([live]);
    expect(await fileEndpoints(cfg.stateDir)).toEqual([live]);
    expect(lines.some((l) => l.includes("evicting subscription after 5 consecutive failures"))).toBe(true);
  });

  test("a service-wide rejection never evicts, however long it lasts", async () => {
    // The 403-storm case: a VAPID slip makes one service reject every device it holds. Nothing on
    // that origin succeeds, so nothing is counted — otherwise a sender-side mistake would silently
    // unsubscribe every iPhone in the herd. This test pins the design.
    const cfg = await tempCfg();
    const apples = [`${APPLE}/a`, `${APPLE}/b`, `${APPLE}/c`];
    const storm = rejects(403, '{"reason":"InvalidProviderToken"}');
    const push = new Push(cfg, partialSender(new Map(apples.map((e) => [e, storm]))));
    const subs = enable(push, [...apples.map(sub), sub(`${FCM}/ok`)]);

    await rounds(push, 20);

    expect([...subs.keys()].length).toBe(4);
  });

  test("the only subscription is never evicted, however long it fails", async () => {
    // No sibling ⇒ no proof the token is at fault. Losing the sole subscription would trade a loud
    // log line for silent no-push, which is strictly worse for the one-phone operator.
    const cfg = await tempCfg();
    const only = `${APPLE}/only`;
    const push = new Push(cfg, partialSender(new Map([[only, rejects(400, "BadDeviceToken")]])));
    const subs = enable(push, [sub(only)]);

    await rounds(push, 20);

    expect([...subs.keys()]).toEqual([only]);
  });

  test("one delivery resets the streak", async () => {
    const cfg = await tempCfg();
    const [flaky, live] = [`${APPLE}/flaky`, `${APPLE}/live`];
    const failing = new Map([[flaky, rejects(500, "")]]);
    const push = new Push(cfg, partialSender(failing));
    const subs = enable(push, [sub(flaky), sub(live)]);

    await rounds(push, 4);
    failing.delete(flaky);
    await rounds(push, 1); // recovers
    failing.set(flaky, rejects(500, ""));
    await rounds(push, 4); // four more is short of the threshold again

    expect([...subs.keys()]).toEqual([flaky, live]);
  });

  test("re-subscribing clears the streak of an identical endpoint", async () => {
    const cfg = await tempCfg();
    const [flaky, live] = [`${APPLE}/flaky`, `${APPLE}/live`];
    const push = new Push(cfg, partialSender(new Map([[flaky, rejects(400, "BadDeviceToken")]])));
    const subs = enable(push, [sub(flaky), sub(live)]);

    await rounds(push, 4);
    await push.addSubscription(sub(flaky)); // the device just asked for pushes again
    await rounds(push, 4);

    expect([...subs.keys()]).toEqual([flaky, live]);
  });

  test("a failure logs the status and the service's reason, not just the useless message", async () => {
    // `err.message` alone is the constant "Received unexpected response code" — the whole reason
    // this issue was undiagnosable from the logs.
    const cfg = await tempCfg();
    const endpoint = `${APPLE}/x`;
    const push = new Push(cfg, partialSender(new Map([[endpoint, rejects(400, '{"reason":"BadDeviceToken"}')]])));
    enable(push, [sub(endpoint)]);

    const { lines } = await rounds(push, 1);

    const failed = lines.find((l) => l.includes("send failed"));
    expect(failed).toContain("status=400");
    expect(failed).toContain("BadDeviceToken");
  });

  test("a 410 prune says so out loud", async () => {
    const cfg = await tempCfg();
    const push = new Push(cfg, (s) => (s.endpoint === "dead" ? Promise.reject(gone("dead")) : Promise.resolve()));
    enable(push, [sub("dead")]);

    const { lines } = await rounds(push, 1);

    expect(lines.some((l) => l.includes("pruning gone subscription (410)"))).toBe(true);
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
    const sends: { payload: string; options: { topic: string; TTL: number; urgency?: string } }[] = [];
    const sender: PushSender = (_s, payload, options) => {
      sends.push({ payload, options });
      return Promise.resolve();
    };
    return { sender, sends };
  }

  test("an update push rides its OWN topic + longer TTL at default urgency, and carries the settings target", async () => {
    const cfg = await tempCfg();
    const { sender, sends } = capturing();
    const push = new Push(cfg, sender);
    enable(push, [sub("a")]);

    await push.send({ type: "update", tag: "collie:update", title: "t", body: "b", target: "settings" });

    // No `urgency` — an update notice is NOT worth punching through Android's power-saving the way a
    // waiting agent is. The absence is the decision; `toEqual` pins it.
    expect(sends[0]!.options).toEqual({ topic: "collie-update", TTL: 259_200 });
    expect(JSON.parse(sends[0]!.payload).data.target).toBe("settings");
  });

  test("an agent send keeps the herd topic/TTL and carries NO target (byte-identical path)", async () => {
    const cfg = await tempCfg();
    const { sender, sends } = capturing();
    const push = new Push(cfg, sender);
    enable(push, [sub("a")]);

    await push.send({ title: "claude needs you", body: "…", tag: "collie:herd", paneId: "w1:p1" });

    // `urgency: "high"` is not cosmetic: at web-push's default (`normal`) FCM lets Android defer the
    // message by Doze / App Standby bucket, which silently ate alerts entirely. See push.ts.
    expect(sends[0]!.options).toEqual({ topic: "collie-herd", TTL: 21_600, urgency: "high" });
    expect("target" in JSON.parse(sends[0]!.payload).data).toBe(false);
  });

  test("a clear stays on the herd topic (it closes the herd slot)", async () => {
    const cfg = await tempCfg();
    const { sender, sends } = capturing();
    const push = new Push(cfg, sender);
    enable(push, [sub("a")]);

    await push.send({ type: "clear", tag: "collie:herd" });
    expect(sends[0]!.options.topic).toBe("collie-herd");
    // A deferred retraction is as bad as a deferred alert — it strands handled work on the lock
    // screen — so a clear is high-urgency too.
    expect(sends[0]!.options.urgency).toBe("high");
  });
});
