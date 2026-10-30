import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HOST } from "../host.ts";
import type { SendResult, WalkyHost, WalkyPane } from "./deliver.ts";
import { WalkyLog } from "./log.ts";
import {
  HERE_FROM_PHONE,
  hereWithoutFolder,
  OTHER_REASON,
  readRefusals,
  reasonKey,
  RefusalCounter,
  refusalLine,
  REFUSAL_REASONS_MAX,
  scopeEmpty,
  scopeIsMember,
  scopeTooWide,
} from "./refusals.ts";
import { WalkyService } from "./service.ts";
import { RECEIPT_REASON_MAX } from "./types.ts";

// File modes and Unix sockets are POSIX. Windows has no 0700 or 0600, so those checks sit in a test
// that is skipped there, and the behaviour beside them still runs.
const POSIX_ONLY = HOST.platform === "win32";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function dir(): string {
  const root = mkdtempSync(join(tmpdir(), "walky-refusals-"));
  roots.push(root);
  return join(root, "walky");
}

describe("the refusal counter", () => {
  test("a reason that names an Object property counts like any other", () => {
    const counter = new RefusalCounter(null, () => 1000);
    for (const reason of ["constructor", "toString", "__proto__", "constructor"]) counter.count(reason);
    // Entries, not an object literal: `{ __proto__: 1 }` in a literal sets a prototype, not a key.
    const entries = (counts: Readonly<Record<string, number>>) => Object.entries(counts).toSorted(([a], [b]) => a.localeCompare(b));
    expect(entries(counter.current().counts)).toEqual([["__proto__", 1], ["constructor", 2], ["toString", 1]]);
    expect(entries(readRefusals('{"v":1,"since":1,"counts":{"constructor":3,"__proto__":2}}').counts)).toEqual([["__proto__", 2], ["constructor", 3]]);
  });

  test("counts per reason, keeps the first time, and survives a restart in a file with no body", () => {
    const at = dir();
    const counter = new RefusalCounter(at, () => 1000);
    counter.count("rate limit");
    counter.count("rate limit");
    counter.count("pair limit");
    expect(counter.current()).toEqual({ since: 1000, counts: { "rate limit": 2, "pair limit": 1 } });
    const file = join(at, "refusals.json");
    expect(readFileSync(file, "utf8")).not.toContain("wt_");
    const again = new RefusalCounter(at, () => 9000);
    again.count("rate limit");
    expect(again.current()).toEqual({ since: 1000, counts: { "rate limit": 3, "pair limit": 1 } });
  });

  test.skipIf(POSIX_ONLY)("keeps its file at 0600 in a 0700 folder", () => {
    const at = dir();
    new RefusalCounter(at, () => 1000).count("rate limit");
    expect(statSync(join(at, "refusals.json")).mode & 0o777).toBe(0o600);
    expect(statSync(at).mode & 0o777).toBe(0o700);
  });

  test("a reason is cut at its first colon and to 40 characters, so one cause is one line", () => {
    expect(reasonKey("crew: HTTP 502")).toBe("crew");
    expect(reasonKey("x".repeat(90))).toBe("x".repeat(40));
    expect(reasonKey("")).toBe(OTHER_REASON);
  });

  test("past 32 reasons the rest count under `other`", () => {
    const counter = new RefusalCounter(null);
    for (let n = 0; n < REFUSAL_REASONS_MAX + 5; n += 1) counter.count(`reason ${String(n)}`);
    const counts = counter.current().counts;
    expect(Object.keys(counts).length).toBe(REFUSAL_REASONS_MAX + 1);
    expect(counts[OTHER_REASON]).toBe(5);
  });

  test("a damaged file reads as none, and the line lists the most first", () => {
    expect(readRefusals("{not json")).toEqual({ since: null, counts: {} });
    expect(readRefusals(JSON.stringify({ v: 1, since: 5, counts: { a: 2, b: -1, c: "x" } }))).toEqual({ since: 5, counts: { a: 2 } });
    expect(refusalLine({ "pair limit": 1, "rate limit": 3, stale: 1 })).toBe("rate limit 3, pair limit 1, stale 1");
  });
});

describe("the refusals of a workspace scope (M75 spec 02)", () => {
  const AT = 1_786_000_000_000;
  const pane = (paneId: string, label: string): WalkyPane => ({ session: "main", paneId, agent: true, harness: "agent-x", label, state: "idle", instance: "aaaa", terminal: true });
  const host = (panes: WalkyPane[]): WalkyHost => ({
    panes: () => panes,
    send: async (): Promise<SendResult> => ({ outcome: "sent" }),
    sendState: () => null,
    cancelHeld: () => undefined,
  });
  function walky(panes: WalkyPane[], memberId: string | null = null): WalkyService {
    const root = mkdtempSync(join(tmpdir(), "walky-refusals-scope-"));
    roots.push(root);
    return new WalkyService({
      log: new WalkyLog(join(root, "walky"), () => AT),
      host: host(panes),
      memberId,
      enabled: () => true,
      machine: "desk",
      keyPem: () => null,
      now: () => AT,
      knownMembers: () => (memberId === null ? [] : [memberId, "laptop"]),
    });
  }
  const refusalOf = async (service: WalkyService, to: string, sender: Parameters<WalkyService["send"]>[1]) => {
    const answer = await service.send({ id: "wt_aaaaaaaaaaa1", to, body: "hello", replyTo: null }, sender);
    return answer.ok ? answer.receipts : [];
  };
  const phone = { kind: "operator" as const, label: "phone" };

  test("each text opens with a fixed key, so the counter keeps one line per kind, never one per word", () => {
    expect(scopeIsMember("bluefin")).toBe("member word: `bluefin` is a member; write `bluefin/all` for its panes");
    expect(scopeEmpty("collie-workspace")).toBe("no panes in scope: none in `collie-workspace`, `collie walky who` shows the labels");
    expect(scopeTooWide(63, 50)).toBe("scope too wide: 63 panes, the most is 50");
    expect(HERE_FROM_PHONE).toBe("here from a phone: a phone has no workspace, name the folder");
    expect(hereWithoutFolder("w1:p2")).toBe("here without a folder: the label `w1:p2` names no folder, name the folder");
    expect([scopeIsMember("a"), scopeIsMember("b")].map(reasonKey)).toEqual(["member word", "member word"]);
    expect([scopeEmpty("x"), scopeTooWide(51, 50), HERE_FROM_PHONE, hereWithoutFolder("w1:p2")].map(reasonKey)).toEqual(["no panes in scope", "scope too wide", "here from a phone", "here without a folder"]);
    // Every text fits a receipt's reason whole, with a folder name as long as an address allows and a 32-character member id.
    expect(scopeEmpty("a".repeat(48)).length).toBeLessThanOrEqual(RECEIPT_REASON_MAX);
    expect(scopeIsMember("a".repeat(32)).length).toBeLessThanOrEqual(RECEIPT_REASON_MAX);
  });

  test("a bare word that is a member id, or `local`, is refused and names `<word>/all`", async () => {
    const service = walky([pane("w1:p1", "laptop#main")], "desk");
    expect(await refusalOf(service, "laptop", phone)).toMatchObject([{ target: "laptop", state: "refused", reason: scopeIsMember("laptop") }]);
    expect(await refusalOf(walky([pane("w1:p1", "local#main")]), "local", phone)).toMatchObject([{ state: "refused", reason: scopeIsMember("local") }]);
    // With a branch it is a folder again: `laptop#main` names no member.
    expect(await refusalOf(service, "laptop#main", phone)).toMatchObject([{ target: "desk/w1:p1", state: "accepted" }]);
  });

  test("zero hits names the folder and says where the labels are", async () => {
    expect(await refusalOf(walky([pane("w1:p1", "other#main")]), "collie-workspace", phone)).toMatchObject([{ target: "collie-workspace", state: "refused", reason: scopeEmpty("collie-workspace") }]);
  });

  test("more panes than one message may reach is refused with the count", async () => {
    const many = Array.from({ length: 51 }, (_, i) => pane(`w1:p${String(i + 1)}`, "big#main"));
    expect(await refusalOf(walky(many), "big", phone)).toMatchObject([{ target: "big", state: "refused", reason: scopeTooWide(51, 50) }]);
  });

  test("`here` from the phone, and from a pane whose label names no folder, is refused", async () => {
    const bare = pane("w1:p2", "w1:p2");
    const service = walky([pane("w1:p1", "repo#main"), bare]);
    expect(await refusalOf(service, "here", phone)).toMatchObject([{ target: "here", state: "refused", reason: HERE_FROM_PHONE }]);
    expect(await refusalOf(service, "here", { kind: "agent", pane: bare })).toMatchObject([{ target: "here", state: "refused", reason: hereWithoutFolder("w1:p2") }]);
    expect(service.refusals().counts).toEqual({ "here from a phone": 1, "here without a folder": 1 });
  });
});
