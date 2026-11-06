import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { machineAlertMessage } from "./machine-alerts.ts";
import { CLEAR_BURST_MS, LOOKING_MS, machineTopic, paneTopic, Push, redactPushMessage, topicIsSendable } from "./push.ts";
import { makeNotifySink, NotificationCoordinator, type NotifyClock } from "./notifications.ts";
import { pushTitle } from "./push-titles.ts";
import type { AgentStatus, AgentView } from "./types.ts";
import type { PushMessage, PushSender, PushSubscription, SendOptions } from "./push.ts";
import { loadConfig } from "./config.ts";
import type { JsonObject } from "./json.ts";
import { HOST } from "./host.ts";
import { ensureOwnerOnlyDir, isOwnerOnly, privateRoot } from "./owner-only.ts";

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
function enable(push: Push, seed: PushSubscription[]) {
  // Bracket access reaches Push's private state without an assertion, so the compiler still checks
  // both fields against their real declarations.
  push["_enabled"] = true;
  for (const s of seed) push["subs"].set(s.endpoint, s);
  return push["subs"];
}

async function fileEndpoints(dir: string): Promise<string[]> {
  const raw = JSON.parse(await readFile(join(dir, "push-subscriptions.json"), "utf8"));
  // SAFETY: Push is the only writer of this file and always serialises its whole subscription list.
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
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
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
    const collect = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
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
  // Windows: the bridge gives the state dir an owner-only access list at start (M43 spec 04), and the
  // file the store writes inherits it. NTFS has no 0600, so the check reads that list instead.
  test("addSubscription persists with owner-only (0600) permissions", async () => {
    const cfg = await tempCfg();
    if (process.platform === "win32") ensureOwnerOnlyDir(cfg.stateDir, HOST, { root: privateRoot("state"), repair: true });
    const push = new Push(cfg, () => Promise.resolve());
    enable(push, []);

    await push.addSubscription(sub("one"));

    expect(await fileEndpoints(cfg.stateDir)).toEqual(["one"]);
    if (process.platform === "win32") {
      expect(isOwnerOnly(join(cfg.stateDir, "push-subscriptions.json"), HOST)).toEqual({ state: "private" });
      return;
    }
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

    expect((await fileEndpoints(cfg.stateDir)).toSorted()).toEqual(["a", "b", "c"]);
  });
});

describe("Push — per-message collapse topic (update must not share the herd slot)", () => {
  // The `topic` is the push service's collapse key: sharing it would let an offline device's queued
  // herd summary and an update push silently overwrite each other. Capture the options + payload the
  // sender receives to pin the seam the update feature must never regress.
  function capturing() {
    const sends: { payload: string; options: { topic?: string; TTL: number; urgency?: string } }[] = [];
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
    expect(sends[0]!.options).toEqual({ topic: "collie-updates", TTL: 259_200 });
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

  test("the payload `data` gains `host` only when the message names one", async () => {
    const cfg = await tempCfg();
    const { sender, sends } = capturing();
    const push = new Push(cfg, sender);
    enable(push, [sub("a")]);

    // A local (or solo) alert: no `host` key at all — omitted, not null, exactly as `session` is.
    await push.send({ title: "claude needs you", body: "…", tag: "collie:herd", paneId: "w1:p1" });
    expect(JSON.parse(sends[0]!.payload).data).toEqual({ paneId: "w1:p1" });

    // A peer's alert, raised by the lead: the host completes the `(host, session, paneId)` address.
    await push.send({
      title: "claude needs you",
      body: "…",
      tag: "collie:herd@laptop",
      paneId: "w1:p1",
      host: "laptop",
    });
    expect(JSON.parse(sends[1]!.payload).data).toEqual({ paneId: "w1:p1", host: "laptop" });

    // Both dimensions at once still stamp independently.
    await push.send({ title: "t", body: "b", paneId: "w1:p1", session: "work", host: "laptop" });
    expect(JSON.parse(sends[2]!.payload).data).toEqual({ paneId: "w1:p1", session: "work", host: "laptop" });
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

  // Apple decodes the RFC 8030 `Topic` and refuses a length base64 cannot produce (≡ 1 mod 4), where
  // FCM and Mozilla treat it as opaque. So a topic shortened for tidiness can break Apple delivery
  // while every other service keeps working, and nothing surfaces it but that service's 400 —
  // "collie-update" (13) shipped that way from 0.11.0. Assert the topics the code ACTUALLY emits: a
  // guard that restated the constants would still pass after someone edited one, which is the only
  // failure it exists to catch.
  test("every topic the bridge emits is a shape all push services accept", async () => {
    const cfg = await tempCfg();
    const { sender, sends } = capturing();
    const push = new Push(cfg, sender);
    enable(push, [sub("a")]);

    await push.send({ type: "update", tag: "collie:update", title: "t", body: "b", target: "settings" });
    await push.send({ title: "claude needs you", body: "…", tag: "collie:herd", paneId: "w1:p1" });
    await push.send({ type: "clear", tag: "collie:herd" });
    await push.send(machineAlertMessage({ id: "desk", name: "desk", metric: "cpu", rule: { above: 0.9, forMin: 10 }, value: 0.95 }));
    await push.send({ type: "machine", tag: "collie:machine:desk:cpu", title: "t", body: "b", machine: "desk", target: "machine" });

    expect(sends.length).toBe(5);
    for (const { options } of sends) expect(topicIsSendable(options.topic ?? "")).toBe(true);
  });

  test("a load alert rides a topic per machine and metric, and its tap data names the machine, not a host (ADR 0084)", async () => {
    const cfg = await tempCfg();
    const { sender, sends } = capturing();
    const push = new Push(cfg, sender);
    enable(push, [sub("a")]);

    const rule = { above: 0.9, forMin: 10 };
    await push.send(machineAlertMessage({ id: "local", name: "desk", metric: "cpu", rule, value: 0.95 }));
    await push.send(machineAlertMessage({ id: "local", name: "desk", metric: "mem", rule, value: 0.95 }));
    await push.send(machineAlertMessage({ id: "laptop", name: "laptop", metric: "cpu", rule, value: 0.95 }));
    // Its own collapse keys: a queued load alert must replace neither a queued herd summary nor
    // another machine's or metric's alert.
    const topics = sends.map((s) => s.options.topic);
    expect(new Set(topics).size).toBe(3);
    for (const topic of topics) {
      expect(topic).toMatch(/^collie-machines-[A-Za-z0-9_-]{12}$/);
      expect(topicIsSendable(topic ?? "")).toBe(true);
    }
    expect(topics[0]).toBe(machineTopic("local", "cpu"));
    expect(machineTopic("local", "cpu")).toBe(machineTopic("local", "cpu"));
    expect(sends[0]!.options).toEqual({ TTL: 3_600, topic: machineTopic("local", "cpu"), urgency: "high" });
    // `machine`, never `host`: an old service worker reads `host` and would open `/?h=local`.
    const payload = JSON.parse(sends[0]!.payload);
    expect(payload.data).toEqual({ target: "machine", machine: "local" });
    expect("host" in payload).toBe(false);
    // The topic is the push service's, never the device's.
    expect("topic" in payload).toBe(false);
  });

  test("a machine message with no topic, or one no push service accepts, falls back to collie-machines", async () => {
    const cfg = await tempCfg();
    const { sender, sends } = capturing();
    const push = new Push(cfg, sender);
    enable(push, [sub("a")]);

    await push.send({ type: "machine", tag: "collie:machine:desk:cpu", title: "t", body: "b", machine: "desk", target: "machine" });
    await push.send({ type: "machine", tag: "collie:machine:desk:cpu", title: "t", body: "b", machine: "desk", target: "machine", topic: "collie-update" });
    expect(sends.map((s) => s.options.topic)).toEqual(["collie-machines", "collie-machines"]);
  });

  test("topicIsSendable rejects the lengths base64 cannot produce — the Apple trap", () => {
    expect(topicIsSendable("collie-update")).toBe(false); // 13 ≡ 1 (mod 4) — the shipped bug
    expect(topicIsSendable("collie-herdab")).toBe(false); // 13 too, unrelated wording, fails alike
    expect(topicIsSendable("collie-update-xyz")).toBe(false); // 17 ≡ 1 (mod 4)
    expect(topicIsSendable("a")).toBe(false); // 1 ≡ 1 (mod 4)
  });

  test("topicIsSendable still enforces RFC 8030's alphabet and ceiling", () => {
    expect(topicIsSendable("collie herd")).toBe(false); // space
    expect(topicIsSendable("collie.herd")).toBe(false); // dot is not URL-safe base64
    expect(topicIsSendable("")).toBe(false);
    expect(topicIsSendable("a".repeat(33))).toBe(false); // over the 32-char ceiling
    expect(topicIsSendable("a".repeat(32))).toBe(true); // exactly 32, and 32 ≡ 0
  });
});

// ── The store: superseding, metadata, and the hand-operated forget (issue #104) ──────────────────
// The send-time prune above can only ever catch an endpoint the push service DISOWNS. A subscription
// orphaned by a service-worker re-registration was never `unsubscribe()`d, so Apple keeps answering
// 201 for it and it accumulates forever — twenty rows in a one-phone install. The two mechanisms
// that do reach those rows are asserted here.
describe("Push — superseding, metadata and forget", () => {
  /** An enabled, empty push over a fresh state dir — the store starts as it does in production. */
  async function fresh(sender?: PushSender) {
    const cfg = await tempCfg();
    const push = new Push(cfg, sender);
    enable(push, []);
    return { cfg, push };
  }

  test("a re-subscribe that names its predecessor removes the row it supersedes", async () => {
    const { cfg, push } = await fresh();
    await push.addSubscription(sub("old"));
    await push.addSubscription(sub("new"), { replaces: "old" });

    expect(push.listSubscriptions().map((r) => r.endpoint)).toEqual(["new"]);
    expect(await fileEndpoints(cfg.stateDir)).toEqual(["new"]);
  });

  test("naming ITSELF is not a replacement — the row survives its own re-subscribe", async () => {
    const { cfg, push } = await fresh();
    await push.addSubscription(sub("same"));
    await push.addSubscription(sub("same"), { replaces: "same" });

    expect(push.listSubscriptions().map((r) => r.endpoint)).toEqual(["same"]);
    expect(await fileEndpoints(cfg.stateDir)).toEqual(["same"]);
  });

  test("an unknown `replaces` is harmless — it drops nothing and still registers", async () => {
    const { push } = await fresh();
    await push.addSubscription(sub("a"));
    await push.addSubscription(sub("b"), { replaces: "never-seen" });

    expect(push.listSubscriptions().map((r) => r.endpoint)).toEqual(["a", "b"]);
  });

  test("createdAt is when the endpoint FIRST appeared, not when it last re-subscribed", async () => {
    const { push } = await fresh();
    await push.addSubscription(sub("a"), { userAgent: "first" });
    const first = push.listSubscriptions()[0]!.createdAt;
    expect(first).toBeString();

    await push.addSubscription(sub("a"), { userAgent: "second" });
    const again = push.listSubscriptions()[0]!;
    expect(again.createdAt).toBe(first);
    // The user agent, unlike the clock, IS the latest thing the device said about itself.
    expect(again.userAgent).toBe("second");
  });

  test("a user agent is trimmed and capped, and absent when the request carried none", async () => {
    const { push } = await fresh();
    await push.addSubscription(sub("long"), { userAgent: `  ${"U".repeat(400)}  ` });
    await push.addSubscription(sub("none"));

    const [long, none] = push.listSubscriptions();
    expect(long!.userAgent).toBe("U".repeat(160));
    expect(none!.userAgent).toBeUndefined();
  });

  test("web-push is handed `{ endpoint, keys }` and nothing else", async () => {
    const seen: unknown[] = [];
    const { push } = await fresh((s) => {
      seen.push(s);
      return Promise.resolve();
    });
    await push.addSubscription(sub("a"), { userAgent: "iPhone" });

    await push.notify("hi", "there");
    // Not `toMatchObject`: the point is that the metadata does NOT ride along into the signer.
    expect(seen).toEqual([{ endpoint: "a", keys: { p256dh: "p", auth: "a" } }]);
  });

  test("rows written before the metadata existed load unchanged", async () => {
    const cfg = await tempCfg();
    await writeFile(
      join(cfg.stateDir, "push-subscriptions.json"),
      JSON.stringify([sub("legacy"), { endpoint: "junk" }, sub("also")]),
    );
    const push = new Push(cfg);
    await push.loadStore();

    // The malformed row is dropped; the two usable ones arrive with no metadata invented for them.
    expect(push.listSubscriptions()).toEqual([{ endpoint: "legacy" }, { endpoint: "also" }]);
  });

  test("loadStore needs no VAPID — the store is a file, and that is when you clean it up", async () => {
    const cfg = await tempCfg();
    await writeFile(join(cfg.stateDir, "push-subscriptions.json"), JSON.stringify([sub("a")]));
    const push = new Push(cfg);
    await push.loadStore();

    expect(push.enabled).toBe(false);
    expect(push.listSubscriptions().map((r) => r.endpoint)).toEqual(["a"]);
    expect(await push.forget("*")).toBe(1);
  });

  test("forget drops every row whose endpoint CONTAINS the match, and persists", async () => {
    const { cfg, push } = await fresh();
    for (const e of [
      "https://web.push.apple.com/aaa",
      "https://web.push.apple.com/bbb",
      "https://fcm.googleapis.com/aaa",
    ]) {
      await push.addSubscription(sub(e));
    }

    expect(await push.forget("apple.com")).toBe(2);
    expect(await fileEndpoints(cfg.stateDir)).toEqual(["https://fcm.googleapis.com/aaa"]);
  });

  test("`*` forgets everything; a match nobody has forgets nothing and writes nothing", async () => {
    const { cfg, push } = await fresh();

    // Nothing subscribed at all: asking the question must not materialise the file.
    expect(await push.forget("*")).toBe(0);
    expect(await stat(join(cfg.stateDir, "push-subscriptions.json")).catch(() => null)).toBeNull();

    await push.addSubscription(sub("a"));
    expect(await push.forget("zzz")).toBe(0);
    expect(await fileEndpoints(cfg.stateDir)).toEqual(["a"]);
    expect(await push.forget("*")).toBe(1);
    expect(await fileEndpoints(cfg.stateDir)).toEqual([]);
  });
});

// ── M46: what a push carries is masked, and a pane is named by the operator, never by its program ──
// A push crosses a third-party push service and shows on a lock screen. Placeholders only; the AWS
// one is joined at runtime so a repo-wide secret scan finds nothing here.
describe("Push — redact and the operator's label", () => {
  const key = ["AKIA", "PLACEHOLDER00000"].join("");
  const maskedKey = `AKIA${"•".repeat(16)}`;

  function capturing() {
    const payloads: string[] = [];
    const sender: PushSender = (_s, payload) => {
      payloads.push(payload);
      return Promise.resolve();
    };
    return { sender, payloads };
  }

  /** Fire every armed timer at once — the debounce, without the wait. */
  class InstantClock implements NotifyClock<number> {
    private readonly timers = new Map<number, () => void>();
    private next = 1;
    schedule(fn: () => void): number {
      this.timers.set(this.next, fn);
      return this.next++;
    }
    cancel(handle: number): void {
      this.timers.delete(handle);
    }
    fireAll(): void {
      const fns = [...this.timers.values()];
      this.timers.clear();
      for (const fn of fns) fn();
    }
  }

  function pane(paneId: string, status: AgentStatus, extra: Partial<AgentView> = {}): AgentView {
    return {
      paneId,
      workspaceId: "w1",
      workspaceLabel: "demo",
      workspaceNumber: 1,
      tabId: "w1:t1",
      agent: "claude",
      status,
      cwd: "/home/you/demo",
      focused: false,
      kind: "agent",
      ...extra,
    };
  }

  /** The real chain a local session drives: coordinator → sink → Push → the push service. */
  async function herd(cfgRedact: boolean) {
    const cfg = { ...(await tempCfg()), redact: cfgRedact };
    const { sender, payloads } = capturing();
    const push = new Push(cfg, sender);
    enable(push, [sub("a")]);
    const clock = new InstantClock();
    const sink = makeNotifySink(push, { isMuted: () => false }, "collie:herd");
    const coord = new NotificationCoordinator(clock, sink, 0, (s) => s === "blocked" || s === "done");
    return { coord, clock, payloads };
  }

  test("redact: a push body is masked before it leaves, and an untouched title keeps its code", async () => {
    const cfg = await tempCfg();
    const { sender, payloads } = capturing();
    const push = new Push(cfg, sender);
    enable(push, [sub("a")]);
    await push.send({ ...pushTitle("agent.blocked", { agent: "claude" }), body: `demo · ${key}`, tag: "t" });
    const sent = JSON.parse(payloads[0]!);
    expect(sent.body).toBe(`demo · ${maskedKey}`);
    expect(sent.title).toBe("claude needs you");
    expect(sent.titleCode).toBe("agent.blocked");
    expect(payloads[0]).not.toContain(key);
  });

  test("redact: a title the mask changed drops its code and detail, so no translation rebuilds it", () => {
    const out = redactPushMessage({ ...pushTitle("machine.cpu", { machine: key }), body: "b" });
    expect(out.title).toBe(`CPU stays high on ${maskedKey}`);
    expect(out.titleCode).toBeUndefined();
    expect(out.titleDetail).toBeUndefined();
  });

  test("redact off: COLLIE_REDACT=off sends the body as it is", async () => {
    const cfg = { ...(await tempCfg()), redact: false };
    const { sender, payloads } = capturing();
    const push = new Push(cfg, sender);
    enable(push, [sub("a")]);
    await push.notify("hi", `body ${key}`);
    expect(JSON.parse(payloads[0]!).body).toBe(`body ${key}`);
  });

  test("a program title with a path and a placeholder secret never appears in a push payload", async () => {
    // Even with redaction OFF: the title is kept out by the name rule, not by the mask.
    const { coord, clock, payloads } = await herd(false);
    const title = `~/work/client/.env ${key}`;
    coord.onTransition(pane("p1", "blocked", { terminalTitle: title }), "working", "blocked");
    coord.onTransition(pane("p2", "blocked", { terminalTitle: title, workspaceLabel: "api" }), "working", "blocked");
    clock.fireAll();
    expect(payloads.length).toBeGreaterThan(0);
    for (const payload of payloads) {
      expect(payload).not.toContain("~/work");
      expect(payload).not.toContain(key);
    }
  });

  test("a pane with no label gets the neutral name, and a labelled one keeps the operator's", async () => {
    const { coord, clock, payloads } = await herd(true);
    coord.onTransition(pane("p1", "blocked", { terminalTitle: "vim notes.md" }), "working", "blocked");
    coord.onTransition(pane("p2", "blocked", { agent: "codex", paneLabel: "backend" }), "working", "blocked");
    clock.fireAll();
    expect(JSON.parse(payloads.at(-1)!).body).toBe("claude, backend");
  });
});

// ── The three rules that cut silent pushes (1.27.1) ───────────────────────────────────────────────
// Chrome charges a push that ends with no notification on screen to a small per-site budget, and
// shows "This site has been updated in the background" once it is spent. These pin what each device
// is sent, from the device's polls and from what the bridge knows each slot holds.
describe("Push — silent pushes are cut per device", () => {
  /** A clock the test moves by hand, with the timers due at each step fired in order. */
  class ManualClock {
    t = 1_000_000;
    private timers: { at: number; fn: () => void; id: number }[] = [];
    private next = 1;
    now = () => this.t;
    schedule = (fn: () => void, delayMs: number): number => {
      const id = this.next++;
      this.timers.push({ at: this.t + delayMs, fn, id });
      return id;
    };
    async advance(ms: number): Promise<void> {
      this.t += ms;
      const due = this.timers.filter((x) => x.at <= this.t).toSorted((a, b) => a.at - b.at);
      this.timers = this.timers.filter((x) => x.at > this.t);
      for (const x of due) x.fn();
      // Let the deliveries the timers started settle.
      await Bun.sleep(0);
    }
  }

  type Sent = { endpoint: string; body: JsonObject; options: SendOptions };
  async function rig(rows: { endpoint: string; device?: string; closesOwn?: boolean; badges?: boolean }[]) {
    const cfg = await tempCfg();
    const sent: Sent[] = [];
    const sender: PushSender = (s, payload, options) => {
      sent.push({ endpoint: s.endpoint, body: JSON.parse(payload), options });
      return Promise.resolve();
    };
    const clock = new ManualClock();
    const push = new Push(cfg, sender, { clock });
    const subs = enable(push, []);
    for (const r of rows) subs.set(r.endpoint, { ...sub(r.endpoint), ...r });
    const to = (endpoint: string) => sent.filter((x) => x.endpoint === endpoint);
    return { push, sent, clock, to };
  }

  const render = (tag: string, badge = 1): PushMessage => ({ title: "claude needs you", body: "demo", tag, badge, renotify: true });

  test("rule 1: a render is held from a device that polled just now, and sent to the one in a pocket", async () => {
    const { push, clock, to } = await rig([
      { endpoint: "phone", device: "pixel" },
      { endpoint: "laptop", device: "mac" },
    ]);
    push.notePoll("pixel");
    await clock.advance(3_000);
    await push.send(render("collie:herd:p1"));
    expect(to("phone")).toHaveLength(0);
    expect(to("laptop")).toHaveLength(1);
  });

  test("rule 1: a held render the page saw is dropped, and its icon count rides the next push", async () => {
    const { push, clock, to } = await rig([{ endpoint: "phone", device: "pixel" }]);
    push.notePoll("pixel");
    await push.send(render("collie:herd:p1", 1));
    // The page polls on: it showed the agent's state, which is all its worker would have done.
    for (let i = 0; i < 4; i++) {
      await clock.advance(5_000);
      push.notePoll("pixel");
    }
    await clock.advance(LOOKING_MS);
    expect(to("phone")).toHaveLength(0);
    expect(push.tallies().get("pixel")).toMatchObject({ held: 1, dropped: 1, render: 0 });
    // The next push the phone does get carries the count its worker never stored.
    await clock.advance(LOOKING_MS);
    await push.send(render("collie:herd:p2", 1));
    expect(to("phone")).toHaveLength(1);
    expect(to("phone")[0]!.body.badgeSlots).toEqual({ "collie:herd:p1": 1 });
    expect(to("phone")[0]!.body.tag).toBe("collie:herd:p2");
  });

  test("rule 1: a held render goes out late when the device stopped polling first (the phone locked)", async () => {
    const { push, clock, to } = await rig([{ endpoint: "phone", device: "pixel" }]);
    push.notePoll("pixel");
    await clock.advance(2_000);
    await push.send(render("collie:herd:p1"));
    expect(to("phone")).toHaveLength(0);
    await clock.advance(LOOKING_MS - 2_000 + 1);
    expect(to("phone")).toHaveLength(1);
    expect(to("phone")[0]!.body.tag).toBe("collie:herd:p1");
    expect(push.tallies().get("pixel")).toMatchObject({ held: 1, late: 1 });
  });

  test("rule 1: a clear while a render is held sends nothing to that device, the slot never showed", async () => {
    const { push, clock, to } = await rig([{ endpoint: "phone", device: "pixel" }]);
    // The slot is known closed: its last push was a clear.
    await push.send({ type: "clear", tag: "collie:herd:p1" });
    expect(to("phone")).toHaveLength(1);
    push.notePoll("pixel");
    await push.send(render("collie:herd:p1"));
    await push.send({ type: "clear", tag: "collie:herd:p1" });
    await clock.advance(LOOKING_MS * 2);
    expect(to("phone")).toHaveLength(1);
  });

  test("rule 1 holds nothing from a row without a device, nor a machine alert from anyone", async () => {
    const { push, to } = await rig([{ endpoint: "old" }, { endpoint: "phone", device: "pixel" }]);
    push.notePoll("pixel");
    await push.send(render("collie:herd:p1"));
    await push.send({ type: "machine", tag: "collie:machine:desk:cpu", title: "t", body: "b", target: "machine" });
    expect(to("old")).toHaveLength(2);
    expect(to("phone").map((x) => x.body.type)).toEqual(["machine"]);
  });

  test("a clear still reaches a looking device whose slot shows a notification", async () => {
    const { push, clock, to } = await rig([{ endpoint: "phone", device: "pixel" }]);
    await push.send(render("collie:herd:p1"));
    push.notePoll("pixel");
    await clock.advance(1_000);
    await push.send({ type: "clear", tag: "collie:herd:p1" });
    expect(to("phone").map((x) => x.body.type)).toEqual([undefined, "clear"]);
  });

  test("rule 2: a clear is skipped for a slot already closed, and sent for one the bridge knows nothing of", async () => {
    const { push, to } = await rig([{ endpoint: "phone", device: "pixel" }]);
    await push.send({ type: "clear", tag: "collie:herd:p1" });
    await push.send({ type: "clear", tag: "collie:herd:p1" });
    expect(to("phone")).toHaveLength(1);
    expect(push.tallies().get("pixel")).toMatchObject({ clear: 1, skipped: 1 });
  });

  test("rule 2: the device whose page read the pane gets no clear; every other device does", async () => {
    const { push, to } = await rig([
      { endpoint: "phone", device: "pixel", closesOwn: true, badges: false },
      { endpoint: "laptop", device: "mac", closesOwn: true, badges: false },
    ]);
    await push.send(render("collie:herd:p1"));
    push.noteSeen("pixel", "collie:herd:p1");
    await push.send({ type: "clear", tag: "collie:herd:p1" });
    expect(to("phone").map((x) => x.body.type)).toEqual([undefined]);
    expect(to("laptop").map((x) => x.body.type)).toEqual([undefined, "clear"]);
  });

  test("rule 2 never applies to a page that did not promise the close, or to one that shows an icon count", async () => {
    const { push, to } = await rig([
      { endpoint: "old-page", device: "a", badges: false },
      { endpoint: "iphone", device: "b", closesOwn: true, badges: true },
      { endpoint: "unsaid", device: "c", closesOwn: true },
    ]);
    await push.send(render("collie:herd:p1"));
    for (const d of ["a", "b", "c"]) push.noteSeen(d, "collie:herd:p1");
    await push.send({ type: "clear", tag: "collie:herd:p1" });
    for (const e of ["old-page", "iphone", "unsaid"]) expect(to(e).map((x) => x.body.type)).toEqual([undefined, "clear"]);
  });

  test("rule 3: ten clears in one burst are one push per device, naming every slot, on no collapse topic", async () => {
    const { push, sent } = await rig([{ endpoint: "phone", device: "pixel" }, { endpoint: "laptop" }]);
    const tags = Array.from({ length: 10 }, (_, i) => `collie:herd:w${i}:p1`);
    for (const tag of tags) await push.send({ ...render(tag), topic: paneTopic(tag) });
    sent.length = 0;
    await Promise.all(tags.map((tag) => push.send({ type: "clear", tag, topic: paneTopic(tag) })));
    expect(sent).toHaveLength(2);
    for (const { body, options } of sent) {
      expect(body).toEqual({ type: "clear", tag: tags[0], tags, data: {} });
      expect(options.topic).toBeUndefined();
      expect(options.urgency).toBe("high");
    }
  });

  test("rule 3: a burst of one is the clear every earlier bridge sent, byte for byte, on its pane topic", async () => {
    const { push, sent } = await rig([{ endpoint: "phone", device: "pixel" }]);
    const tag = "collie:herd:p1";
    await push.send({ type: "clear", tag, topic: paneTopic(tag) });
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0]!.body)).toBe(`{"type":"clear","tag":"${tag}","data":{}}`);
    expect(sent[0]!.options.topic).toBe(paneTopic(tag));
  });

  test("rule 3: each device's burst names only the slots it may still show", async () => {
    const { push, to } = await rig([
      { endpoint: "phone", device: "pixel", closesOwn: true, badges: false },
      { endpoint: "laptop", device: "mac" },
    ]);
    await push.send(render("collie:herd:p1"));
    await push.send(render("collie:herd:p2"));
    push.noteSeen("pixel", "collie:herd:p1");
    await Promise.all(["collie:herd:p1", "collie:herd:p2"].map((tag) => push.send({ type: "clear", tag })));
    expect(to("phone").at(-1)!.body).toEqual({ type: "clear", tag: "collie:herd:p2", data: {} });
    expect(to("laptop").at(-1)!.body).toEqual({
      type: "clear",
      tag: "collie:herd:p1",
      tags: ["collie:herd:p1", "collie:herd:p2"],
      data: {},
    });
  });

  test("the bridge's own Push waits CLEAR_BURST_MS for company, so clears from separate calls still join", async () => {
    const cfg = await tempCfg();
    const sent: string[] = [];
    const clock = new ManualClock();
    const push = new Push(cfg, (_s, payload) => (sent.push(payload), Promise.resolve()), { clock, clearBurstMs: CLEAR_BURST_MS });
    enable(push, [sub("phone")]);
    void push.send({ type: "clear", tag: "collie:herd:a" });
    await clock.advance(CLEAR_BURST_MS / 2);
    void push.send({ type: "clear", tag: "collie:herd:b" });
    expect(sent).toHaveLength(0);
    await clock.advance(CLEAR_BURST_MS);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!).tags).toEqual(["collie:herd:a", "collie:herd:b"]);
  });

  test("a counted hour prints one line per device and starts again", async () => {
    const { push, clock } = await rig([{ endpoint: "phone", device: "pixel" }]);
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => void lines.push(line);
    try {
      await push.send({ type: "clear", tag: "collie:herd:p1" });
      await clock.advance(3_600_000);
      await push.send(render("collie:herd:p2"));
    } finally {
      console.log = log;
    }
    expect(lines.some((l) => l.startsWith("[push] last hour, pixel: 0 rendered, 1 silent clears"))).toBe(true);
    expect(push.tallies().get("pixel")).toMatchObject({ render: 1, clear: 0 });
  });

  test("a registration stamps its device and its page's promises, and a reload keeps them", async () => {
    const cfg = await tempCfg();
    const push = new Push(cfg);
    push["_enabled"] = true;
    await push.addSubscription(sub("e1"), { device: "pixel", closesOwn: true, badges: false });
    await push.addSubscription(sub("e2"), { closesOwn: true });
    const again = new Push(cfg);
    await again.loadStore();
    expect(again["subs"].get("e1")).toMatchObject({ device: "pixel", closesOwn: true, badges: false });
    // No device token, no promise: a close nobody can be matched to counts for nothing.
    expect(again["subs"].get("e2")?.closesOwn).toBeUndefined();
    expect(again.listSubscriptions().find((r) => r.endpoint === "e1")?.device).toBe("pixel");
    // An older page re-registers without the promise, and the row goes back to every clear.
    await push.addSubscription(sub("e1"), { device: "pixel" });
    expect(push["subs"].get("e1")?.closesOwn).toBeUndefined();
  });

  test("looking outlasts the page's slowest poll gap (IDLE_MS in web/src/hooks/use-polling.ts)", async () => {
    const source = await readFile(join(import.meta.dir, "../web/src/hooks/use-polling.ts"), "utf8");
    const idle = Number(/export const IDLE_MS = ([\d_]+);/.exec(source)?.[1]?.replaceAll("_", ""));
    expect(idle).toBeGreaterThan(0);
    expect(LOOKING_MS).toBeGreaterThanOrEqual(idle + 4_000);
  });
});
