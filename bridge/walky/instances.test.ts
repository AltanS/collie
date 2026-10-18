import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HOST } from "../host.ts";
import { INSTANCE_TOKEN } from "./address.ts";
import { INSTANCE_GRACE_MS, INSTANCE_TICK_MS, mintInstanceToken, WalkyInstances } from "./instances.ts";

// File modes are POSIX: the 0600 check sits in a test of its own, skipped on Windows.
const POSIX_ONLY = HOST.platform === "win32";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function dir(): string {
  const root = mkdtempSync(join(tmpdir(), "walky-instances-"));
  roots.push(root);
  return join(root, "walky");
}

const T0 = 1_786_000_000_000;
const p = (paneId: string, session = "main") => ({ session, paneId });

describe("a token", () => {
  test("is four characters of [a-z0-9], and skips a byte that would make one letter likelier", () => {
    expect(mintInstanceToken()).toMatch(INSTANCE_TOKEN);
    // 252 and above are skipped: the bytes 0, 1, 255, 2, 3 give a, b, c, d.
    expect(mintInstanceToken(() => Uint8Array.from([0, 1, 255, 2, 3, 4, 5, 6]))).toBe("abcd");
  });
});

describe("the instance registry", () => {
  test("mints once per session and pane id, and keeps the token while the pane is seen", () => {
    const at = { now: T0 };
    const reg = new WalkyInstances(null, () => at.now);
    const [a, b] = reg.stamp([p("w1:p1"), p("w1:p2")]);
    expect(a!.instance).toMatch(INSTANCE_TOKEN);
    at.now += 25_000;
    const again = reg.stamp([p("w1:p1"), p("w1:p2")]);
    expect(again.map((pane) => pane.instance)).toEqual([a!.instance, b!.instance]);
    expect(reg.all().find((entry) => entry.paneId === "w1:p1")).toMatchObject({ since: T0, lastSeen: T0 + 25_000 });
  });

  test("two sessions that share a pane id get two tokens", () => {
    // A fixed source that answers the same bytes twice: the second mint must roll again.
    let calls = 0;
    const random = (n: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (calls++ < 16 ? i : (i + 9) % 36));
    const reg = new WalkyInstances(null, () => T0, random);
    const [main, twin] = reg.stamp([p("w1:p1"), p("w1:p1", "twin")]);
    expect([main!.instance, twin!.instance]).toEqual(["abcd", "jklm"]);
  });

  test("drops a pane not seen for more than 30 seconds, tells the listeners, and mints anew for the id", () => {
    const at = { now: T0 };
    const reg = new WalkyInstances(null, () => at.now);
    const dropped: string[] = [];
    reg.onDrop((session, paneId, token) => dropped.push(`${session}/${paneId}#${token}`));
    const first = reg.stamp([p("w1:p1"), p("w1:p2")])[0]!.instance;
    // Out of sight for exactly the grace: kept. One millisecond past it: gone.
    at.now += INSTANCE_GRACE_MS;
    reg.observe([p("w1:p2")]);
    expect(reg.peek("main", "w1:p1")).toBe(first);
    at.now += 1;
    reg.observe([p("w1:p2")]);
    expect(reg.peek("main", "w1:p1")).toBeNull();
    expect(dropped).toEqual([`main/w1:p1#${first}`]);
    // A new pane that takes the id is a new instance.
    const next = reg.stamp([p("w1:p1")])[0]!.instance;
    expect(reg.all().find((entry) => entry.paneId === "w1:p1")?.since).toBe(at.now);
    expect(next).toMatch(INSTANCE_TOKEN);
  });

  test("`tokenOf` mints a pane the snapshot shows before a tick did, and drops nothing", () => {
    const at = { now: T0 };
    const reg = new WalkyInstances(null, () => at.now);
    const kept = reg.stamp([p("w1:p1")])[0]!.instance;
    at.now += INSTANCE_GRACE_MS * 10;
    const fresh = reg.tokenOf("main", "w1:p9");
    expect(fresh).toMatch(INSTANCE_TOKEN);
    expect(reg.tokenOf("main", "w1:p9")).toBe(fresh);
    expect(reg.peek("main", "w1:p1")).toBe(kept);
    expect(reg.peek("main", "w1:p404")).toBeNull();
  });

  test("a restart inside 30 seconds keeps the tokens; a longer one mints new ones and drops the old inboxes", () => {
    const at = { now: T0 };
    const folder = dir();
    const first = new WalkyInstances(folder, () => at.now);
    const token = first.stamp([p("w1:p1")])[0]!.instance;
    at.now += 20_000;
    const quick = new WalkyInstances(folder, () => at.now);
    expect(quick.peek("main", "w1:p1")).toBe(token);
    at.now += INSTANCE_GRACE_MS + 1;
    const slow = new WalkyInstances(folder, () => at.now);
    expect(slow.peek("main", "w1:p1")).toBeNull();
    // The load's drops reach a listener that registers after it.
    const dropped: string[] = [];
    slow.onDrop((session, paneId, gone) => dropped.push(`${session}/${paneId}#${gone}`));
    expect(dropped).toEqual([`main/w1:p1#${token}`]);
    expect(slow.stamp([p("w1:p1")])[0]!.instance).toMatch(INSTANCE_TOKEN);
  });

  test("writes a seen pane's clock at most every 10 seconds, and at once when a token comes or goes", () => {
    const at = { now: T0 };
    const folder = dir();
    const reg = new WalkyInstances(folder, () => at.now);
    const file = join(folder, "instances.json");
    expect(existsSync(file)).toBe(false);
    reg.observe([p("w1:p1")]);
    const lastSeen = (): number => JSON.parse(readFileSync(file, "utf8")).panes[0].lastSeen;
    expect(lastSeen()).toBe(T0);
    at.now += INSTANCE_TICK_MS - 1;
    reg.observe([p("w1:p1")]);
    expect(lastSeen()).toBe(T0);
    at.now += 1;
    reg.observe([p("w1:p1")]);
    expect(lastSeen()).toBe(T0 + INSTANCE_TICK_MS);
  });

  test("a file that does not parse, or holds a bad token, reads as empty", () => {
    const folder = dir();
    new WalkyInstances(folder, () => T0).observe([p("w1:p1")]);
    writeFileSync(join(folder, "instances.json"), "{ not json");
    expect(new WalkyInstances(folder, () => T0).all()).toEqual([]);
    writeFileSync(join(folder, "instances.json"), JSON.stringify({ v: 1, panes: [{ session: "main", paneId: "w1:p1", token: "../x", since: T0, lastSeen: T0 }] }));
    expect(new WalkyInstances(folder, () => T0).all()).toEqual([]);
  });

  test.skipIf(POSIX_ONLY)("keeps its tokens at 0600 in a 0700 folder", () => {
    const folder = dir();
    new WalkyInstances(folder, () => T0).observe([p("w1:p1")]);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect(statSync(join(folder, "instances.json")).mode & 0o777).toBe(0o600);
  });
});
