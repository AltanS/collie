import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HOST } from "../host.ts";
import { inboxKey, LOG_KEEP_MS, LOG_MAX_LINES, LOG_ROTATE_TO, WalkyLog, INBOX_MAX } from "./log.ts";
import type { WalkyMessage, WalkyReceipt } from "./types.ts";

// File modes and Unix sockets are POSIX. Windows has no 0700 or 0600, so those checks sit in a test
// that is skipped there, and the behaviour beside them still runs.
const POSIX_ONLY = HOST.platform === "win32";

const dirs: string[] = [];
function fresh(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "walky-log-")), "walky");
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(join(dir, ".."), { recursive: true, force: true });
});

function message(n: number, at = 1000): WalkyMessage {
  return {
    v: 1,
    id: `wt_${String(n).padStart(12, "0")}`,
    kind: "operator",
    from: { memberId: null, address: null, harness: null, label: "cli" },
    to: "local/w1:p1",
    replyTo: null,
    at,
    body: `body ${n}`,
    signer: null,
    signature: null,
  };
}

function receipt(m: WalkyMessage, state: WalkyReceipt["state"], at = 1000): WalkyReceipt {
  return { id: m.id, target: "local/w1:p1", state, verified: "local", at, by: "solo" };
}

const here = { session: "main", paneId: "w1:p1", instance: "aaaa" };

describe("the log", () => {
  test("keeps a message with its newest receipt, across a restart", () => {
    const dir = fresh();
    const log = new WalkyLog(dir, () => 1000);
    const m = message(1);
    log.record(m, "local/w1:p1", here, receipt(m, "accepted"));
    log.update(receipt(m, "delivered", 1001));
    const again = new WalkyLog(dir, () => 1002);
    expect(again.get(m.id, "local/w1:p1")?.receipt.state).toBe("delivered");
    expect(again.forPane("main", "w1:p1", "aaaa", 10).map((entry) => entry.id)).toEqual([m.id]);
    expect(again.pending()).toEqual([]);
  });

  test("makes its own folder and one log file", () => {
    const dir = fresh();
    const log = new WalkyLog(dir, () => 1000);
    log.record(message(1), "local/w1:p1", here, receipt(message(1), "accepted"));
    expect(statSync(dir).isDirectory()).toBe(true);
    expect(statSync(join(dir, "log.jsonl")).isFile()).toBe(true);
  });

  test.skipIf(POSIX_ONLY)("is private: a 0700 folder and a 0600 file", () => {
    const dir = fresh();
    const log = new WalkyLog(dir, () => 1000);
    log.record(message(1), "local/w1:p1", here, receipt(message(1), "accepted"));
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "log.jsonl")).mode & 0o777).toBe(0o600);
  });

  test("skips a line it cannot read", () => {
    const dir = fresh();
    new WalkyLog(dir, () => 1000).record(message(1), "local/w1:p1", here, receipt(message(1), "accepted"));
    writeFileSync(join(dir, "log.jsonl"), `${readFileSync(join(dir, "log.jsonl"), "utf8")}{"t":"message","at":1}\nnot json\n`);
    expect(new WalkyLog(dir, () => 1000).all(message(1).id)).toHaveLength(1);
  });

  test("drops what is older than 7 days", () => {
    const dir = fresh();
    let now = 1000;
    const log = new WalkyLog(dir, () => now);
    log.record(message(1), "local/w1:p1", here, receipt(message(1), "accepted"));
    now = 1000 + LOG_KEEP_MS + 1;
    log.record(message(2, now), "local/w1:p1", here, receipt(message(2, now), "accepted", now));
    expect(log.get(message(1).id, "local/w1:p1")).toBeNull();
    expect(readFileSync(join(dir, "log.jsonl"), "utf8").trim().split("\n")).toHaveLength(2);
  });

  test("keeps at most 2,000 lines, rotating to the newest 1,500", () => {
    const dir = fresh();
    const log = new WalkyLog(dir, () => 1000);
    for (let n = 0; n < LOG_MAX_LINES / 2 + 1; n++) log.record(message(n), "local/w1:p1", here, receipt(message(n), "accepted"));
    const lines = readFileSync(join(dir, "log.jsonl"), "utf8").trim().split("\n");
    expect(lines.length).toBeLessThanOrEqual(LOG_MAX_LINES);
    // The rotate ran after the 2,001st line; the receipt line of that message came after it.
    expect(lines.length).toBe(LOG_ROTATE_TO + 1);
    expect(log.get(message(0).id, "local/w1:p1")).toBeNull();
    expect(log.get(message(LOG_MAX_LINES / 2).id, "local/w1:p1")).not.toBeNull();
  });
});

describe("the inbox", () => {
  test("holds a pane's unread messages under a hashed name, and ack takes them out", () => {
    const dir = fresh();
    const log = new WalkyLog(dir, () => 1000);
    log.inboxAdd("main", "../../etc", "aaaa", message(1));
    log.inboxAdd("main", "../../etc", "aaaa", message(2));
    log.inboxAdd("main", "../../etc", "aaaa", message(2));
    expect(readdirSync(join(dir, "inbox"))).toEqual([`${inboxKey("main", "../../etc", "aaaa")}.json`]);
    expect(log.inbox("main", "../../etc", "aaaa").map((m) => m.id)).toEqual([message(1).id, message(2).id]);
    expect(log.ack("main", "../../etc", "aaaa", [message(1).id])).toBe(1);
    expect(log.inbox("main", "../../etc", "aaaa").map((m) => m.id)).toEqual([message(2).id]);
    expect(log.ack("main", "../../etc", "aaaa", null)).toBe(1);
    expect(existsSync(join(dir, "inbox", `${inboxKey("main", "../../etc", "aaaa")}.json`))).toBe(false);
  });

  test("keeps at most 200, the oldest dropped", () => {
    const log = new WalkyLog(fresh(), () => 1000);
    for (let n = 0; n < INBOX_MAX + 5; n++) log.inboxAdd("main", "w1:p1", "aaaa", message(n));
    const held = log.inbox("main", "w1:p1", "aaaa");
    expect(held).toHaveLength(INBOX_MAX);
    expect(held[0]!.id).toBe(message(5).id);
  });

  test("an inbox whose newest message is past the 7 days goes on the log's rotate, and then reads empty", () => {
    const dir = fresh();
    let now = 1000;
    const log = new WalkyLog(dir, () => now);
    log.record(message(1), "local/w1:p1", here, receipt(message(1), "accepted"));
    log.inboxAdd("main", "w1:p1", "aaaa", message(1));
    now = 1000 + LOG_KEEP_MS + 1;
    log.inboxAdd("main", "w1:p2", "aaaa", message(2, now));
    // The next line ages the first one out: the rotate runs, and with it the inbox sweep.
    log.record(message(2, now), "local/w1:p2", here, receipt(message(2, now), "accepted", now));
    expect(readdirSync(join(dir, "inbox"))).toEqual([`${inboxKey("main", "w1:p2", "aaaa")}.json`]);
    expect(log.inbox("main", "w1:p1", "aaaa")).toEqual([]);
    expect(log.inbox("main", "w1:p2", "aaaa").map((m) => m.id)).toEqual([message(2).id]);
    // A restart sweeps too.
    expect(new WalkyLog(dir, () => now).inboxCount()).toBe(1);
  });

  test("a session and a pane are one inbox: another session's same pane id is another", () => {
    const log = new WalkyLog(fresh(), () => 1000);
    log.inboxAdd("main", "%1", "aaaa", message(1));
    expect(log.inbox("other", "%1", "aaaa")).toEqual([]);
  });

  test("a new instance of a pane id starts with an empty inbox, and a dropped instance takes its file", () => {
    const dir = fresh();
    const log = new WalkyLog(dir, () => 1000);
    log.inboxAdd("main", "w1:p1", "aaaa", message(1));
    expect(inboxKey("main", "w1:p1", "aaaa")).not.toBe(inboxKey("main", "w1:p1", "bbbb"));
    expect(log.inbox("main", "w1:p1", "bbbb")).toEqual([]);
    log.inboxAdd("main", "w1:p1", "bbbb", message(2));
    expect(log.inbox("main", "w1:p1", "aaaa").map((m) => m.id)).toEqual([message(1).id]);
    log.inboxDrop("main", "w1:p1", "aaaa");
    expect(readdirSync(join(dir, "inbox"))).toEqual([`${inboxKey("main", "w1:p1", "bbbb")}.json`]);
    expect(log.inbox("main", "w1:p1", "aaaa")).toEqual([]);
    // Dropping what is not there is a no-op.
    log.inboxDrop("main", "w1:p404", "aaaa");
  });

  test("an inbox file from before instances is never read under one, and the 7-day prune still takes it", () => {
    const dir = fresh();
    let now = 1000;
    const log = new WalkyLog(dir, () => now);
    log.inboxAdd("main", "w1:p1", "aaaa", message(1));
    const legacy = join(dir, "inbox", `${inboxKey("main", "w1:p1", null)}.json`);
    writeFileSync(legacy, `${JSON.stringify({ v: 1, session: "main", paneId: "w1:p1", messages: [message(2)] })}\n`);
    expect(log.inbox("main", "w1:p1", "aaaa").map((m) => m.id)).toEqual([message(1).id]);
    now = 1000 + LOG_KEEP_MS + 1;
    expect(new WalkyLog(dir, () => now).inboxCount()).toBe(0);
    expect(existsSync(legacy)).toBe(false);
  });
});

describe("a record and its instance", () => {
  test("matches only its own instance; a line from before instances matches any", () => {
    const dir = fresh();
    const log = new WalkyLog(dir, () => 1000);
    log.record(message(1), "local/w1:p1", here, receipt(message(1), "accepted"));
    // A line written before instances: no `instance` key at all.
    const old = { t: "message", at: 1000, target: "local/w1:p1", session: "main", paneId: "w1:p1", message: message(2) };
    writeFileSync(join(dir, "log.jsonl"), `${readFileSync(join(dir, "log.jsonl"), "utf8")}${JSON.stringify(old)}\n`);
    const again = new WalkyLog(dir, () => 1000);
    expect(again.get(message(1).id, "local/w1:p1")?.instance).toBe("aaaa");
    expect(again.get(message(2).id, "local/w1:p1")?.instance).toBeNull();
    expect(again.forPane("main", "w1:p1", "aaaa", 10).map((entry) => entry.id)).toEqual([message(2).id, message(1).id]);
    expect(again.forPane("main", "w1:p1", "bbbb", 10).map((entry) => entry.id)).toEqual([message(2).id]);
  });

  test("lists what a pane instance sent as well as what it received, newest first, when asked for both", () => {
    // The phone's list (added 2026-10-18): the receipt of an agent's own message, to a pane here or on
    // another machine (a remote target has no placement on this bridge).
    const dir = fresh();
    let clock = 1000;
    const log = new WalkyLog(dir, () => clock);
    const p2 = { session: "main", paneId: "w1:p2", instance: "cccc" };
    const nowhere = { session: null, paneId: null, instance: null };
    log.record(message(1), "local/w1:p1", here, receipt(message(1), "accepted"), p2);
    clock += 1;
    log.record(message(2), "laptop/w9:p9", nowhere, { ...receipt(message(2), "accepted"), target: "laptop/w9:p9" }, p2);
    clock += 1;
    log.record(message(3), "local/w1:p2", p2, { ...receipt(message(3), "accepted"), target: "local/w1:p2" }, here);
    log.update({ ...receipt(message(2), "delivered", 1003), target: "laptop/w9:p9", by: "laptop" });
    const again = new WalkyLog(dir, () => 1004);
    // Received only, as `collie walky inbox --all` reads it.
    expect(again.forPane("main", "w1:p2", "cccc", 10).map((entry) => entry.id)).toEqual([message(3).id]);
    // Both, each with its newest receipt.
    const both = again.forPane("main", "w1:p2", "cccc", 10, true);
    expect(both.map((entry) => entry.id)).toEqual([message(3).id, message(2).id, message(1).id]);
    expect(both[1]?.receipt).toMatchObject({ target: "laptop/w9:p9", state: "delivered", by: "laptop" });
    // The sender's instance must match, as the target's does, and the limit counts both kinds.
    expect(again.forPane("main", "w1:p2", "dddd", 10, true).map((entry) => entry.id)).toEqual([]);
    expect(again.forPane("main", "w1:p2", "cccc", 2, true)).toHaveLength(2);
    // A sent message is never in the sender's unread inbox.
    expect(again.inbox("main", "w1:p2", "cccc").map((m) => m.id)).not.toContain(message(1).id);
  });

  test("keeps the sender's instance, and reads a sender from before instances as null", () => {
    const dir = fresh();
    const log = new WalkyLog(dir, () => 1000);
    log.record(message(1), "local/w1:p1", here, receipt(message(1), "accepted"), { session: "main", paneId: "w1:p2", instance: "cccc" });
    const old = { t: "message", at: 1000, target: "local/w1:p1", session: "main", paneId: "w1:p1", message: message(2), sender: { session: "main", paneId: "w1:p2" } };
    writeFileSync(join(dir, "log.jsonl"), `${readFileSync(join(dir, "log.jsonl"), "utf8")}${JSON.stringify(old)}\n`);
    const again = new WalkyLog(dir, () => 1000);
    expect(again.get(message(1).id, "local/w1:p1")?.sender).toEqual({ session: "main", paneId: "w1:p2", instance: "cccc" });
    expect(again.get(message(2).id, "local/w1:p1")?.sender).toEqual({ session: "main", paneId: "w1:p2", instance: null });
  });
});
