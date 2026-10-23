import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuditLog } from "../audit.ts";
import { walkyCancelRoute, walkyDropRoute, walkyOlderMemberAnswer, walkyPaneRoute, walkyPostRoute, walkyWhoRoute, WALKY_OFF_TEXT, WALKY_OLDER_MEMBER_TEXT } from "../server.ts";
import type { SendResult, WalkyHost, WalkyPane } from "./deliver.ts";
import { WalkyLog } from "./log.ts";
import { WalkyService } from "./service.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const panes: WalkyPane[] = [
  { session: "main", paneId: "w1:p1", agent: true, harness: "agent-x", label: "repo#a", state: "idle", instance: "aaaa", terminal: true },
  { session: "main", paneId: "w1:p2", agent: true, harness: "agent-y", label: "repo#b", state: "idle", instance: "aaaa", terminal: true },
];
const host: WalkyHost = { panes: () => panes, send: async () => ({ outcome: "sent" }), sendState: () => null, cancelHeld: () => undefined };

function service(): WalkyService {
  const root = mkdtempSync(join(tmpdir(), "walky-routes-"));
  roots.push(root);
  return new WalkyService({ log: new WalkyLog(join(root, "walky")), host, memberId: null, enabled: () => true, machine: "desk", keyPem: () => null });
}

function context(lines: string[]) {
  return {
    audit: new AuditLog((line) => {
      lines.push(line);
    }),
    device: "phone-altan",
    acceptEncoding: null,
  };
}

describe("POST /api/walky", () => {
  test("a message from the phone is an operator's, under the device label, and answers one receipt", async () => {
    const walky = service();
    const audit: string[] = [];
    const res = await walkyPostRoute(walky, { id: "wt_aaaaaaaaaaa1", to: "local/w1:p1", body: "Stop and report." }, context(audit));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ receipt: { id: "wt_aaaaaaaaaaa1", target: "local/w1:p1", state: "accepted" } });
    expect(walky.status("wt_aaaaaaaaaaa1").message).toMatchObject({ kind: "operator", from: { label: "phone-altan", address: null } });
    expect(audit.join("")).toContain("walky.send");
    expect(audit.join("")).not.toContain("Stop and report");
  });

  test("`all` answers one receipt per pane", async () => {
    const res = await walkyPostRoute(service(), { id: "wt_aaaaaaaaaaa1", to: "all", body: "hi" }, context([]));
    expect(await res.json()).toMatchObject({ receipts: [{ target: "local/w1:p1" }, { target: "local/w1:p2" }] });
  });

  test("a body over 4,000 characters is refused, never cut, and the refusal is counted", async () => {
    const walky = service();
    const res = await walkyPostRoute(walky, { id: "wt_aaaaaaaaaaa1", to: "local/w1:p1", body: "x".repeat(4001) }, context([]));
    expect(await res.json()).toMatchObject({ receipt: { target: "local/w1:p1", state: "refused", reason: "body over 4,000 characters" } });
    expect(walky.status("wt_aaaaaaaaaaa1").receipts).toEqual([]);
    expect(walky.refusals().counts).toEqual({ "body over 4,000 characters": 1 });
    const fits = await walkyPostRoute(walky, { id: "wt_aaaaaaaaaaa2", to: "local/w1:p1", body: "x".repeat(4000) }, context([]));
    expect(await fits.json()).toMatchObject({ receipt: { state: "accepted" } });
    expect(walky.status("wt_aaaaaaaaaaa2").message?.body).toHaveLength(4000);
  });

  test("the address is signed and logged without the blanks around it", async () => {
    const walky = service();
    await walkyPostRoute(walky, { id: "wt_aaaaaaaaaaa1", to: " local/w1:p1 ", body: "hi" }, context([]));
    expect(walky.status("wt_aaaaaaaaaaa1").message?.to).toBe("local/w1:p1");
  });

  test("a bad body is a 400 and sends nothing", async () => {
    for (const body of [null, { id: "x", to: "all", body: "hi" }, { id: "wt_aaaaaaaaaaa1", to: "../x", body: "hi" }, { id: "wt_aaaaaaaaaaa1", to: "all", body: 7 }]) {
      expect((await walkyPostRoute(service(), body, context([]))).status).toBe(400);
    }
  });

  test("without the service every route is a 404 that says so", async () => {
    const res = await walkyPostRoute(undefined, {}, context([]));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(WALKY_OFF_TEXT);
    expect(walkyWhoRoute(undefined, null).status).toBe(404);
  });
});

describe("`who` for the Crew page", () => {
  test("adds the shell panes a broadcast skips, and the refusal counts with no body", async () => {
    const root = mkdtempSync(join(tmpdir(), "walky-routes-"));
    roots.push(root);
    const withShell: WalkyHost = { ...host, panes: () => [...panes, { session: "main", paneId: "w1:p3", agent: false, harness: null, label: "repo#c", state: "idle", instance: "aaaa", terminal: true }] };
    const walky = new WalkyService({ log: new WalkyLog(join(root, "walky")), host: withShell, memberId: null, enabled: () => true, machine: "desk", keyPem: () => null, now: () => 7 });
    await walky.send({ id: "wt_aaaaaaaaaaa1", to: "local/w9:p9", body: "secret words", replyTo: null }, { kind: "operator", label: "cli" });
    const body = await walkyWhoRoute(walky, null).json();
    expect(body).toMatchObject({
      skipped: [{ address: "local/w1:p3", memberId: "local", machine: "desk", label: "repo#c" }],
      refusals: { since: 7, counts: { "no such pane": 1 } },
    });
    expect(JSON.stringify(body)).not.toContain("secret words");
  });
});

describe("the reads", () => {
  test("`who` lists the targets; a pane's list is newest first with its receipts", async () => {
    const walky = service();
    expect(await walkyWhoRoute(walky, null).json()).toMatchObject({ targets: [{ address: "local/w1:p1#aaaa" }, { address: "local/w1:p2#aaaa" }] });
    await walky.send({ id: "wt_aaaaaaaaaaa1", to: "local/w1:p1", body: "one", replyTo: null }, { kind: "operator", label: "cli" });
    await walky.send({ id: "wt_aaaaaaaaaaa2", to: "local/w1:p1", body: "two", replyTo: null }, { kind: "operator", label: "cli" });
    await walky.deliverer.settled();
    expect(await walkyPaneRoute(walky, "main", "w1:p1", null, null).json()).toMatchObject({
      messages: [
        { id: "wt_aaaaaaaaaaa2", receipt: { state: "delivered" } },
        { id: "wt_aaaaaaaaaaa1", receipt: { state: "delivered" } },
      ],
    });
  });

  test("a pane's list is its current instance's: a pane id no pane holds lists nothing", async () => {
    const walky = service();
    await walky.send({ id: "wt_aaaaaaaaaaa1", to: "local/w1:p1#aaaa", body: "one", replyTo: null }, { kind: "operator", label: "cli" });
    await walky.deliverer.settled();
    expect(await walkyPaneRoute(walky, "main", "w1:p9", null, null).json()).toEqual({ messages: [] });
    const replaced = new WalkyService({
      log: walky.log,
      host: { ...host, panes: () => [{ ...panes[0]!, instance: "bbbb" }, panes[1]!] },
      memberId: null,
      enabled: () => true,
      machine: "desk",
      keyPem: () => null,
    });
    expect(await walkyPaneRoute(replaced, "main", "w1:p1", null, null).json()).toEqual({ messages: [] });
  });

  test("a pane's list holds what it sent too, with the receipt; the inbox stays what it received", async () => {
    const walky = service();
    const agent = { kind: "agent" as const, pane: panes[0]! };
    await walky.send({ id: "wt_aaaaaaaaaaa1", to: "local/w1:p2", body: "from p1", replyTo: null }, agent);
    await walky.send({ id: "wt_aaaaaaaaaaa2", to: "local/w1:p1", body: "to p1", replyTo: null }, { kind: "operator", label: "cli" });
    await walky.deliverer.settled();
    expect(await walkyPaneRoute(walky, "main", "w1:p1", null, null).json()).toMatchObject({
      messages: [
        { id: "wt_aaaaaaaaaaa2", receipt: { target: "local/w1:p1" } },
        { id: "wt_aaaaaaaaaaa1", from: { address: "local/w1:p1#aaaa" }, receipt: { target: "local/w1:p2", state: "delivered" } },
      ],
    });
    expect(walky.inbox("main", "w1:p1", "aaaa", true).map((entry) => entry.id)).toEqual(["wt_aaaaaaaaaaa2"]);
    expect(walky.inbox("main", "w1:p1", "aaaa", false).map((entry) => entry.id)).not.toContain("wt_aaaaaaaaaaa1");
  });

  test("a bad pane id or limit is a 400", () => {
    expect(walkyPaneRoute(service(), "main", "..", null, null).status).toBe(400);
    expect(walkyPaneRoute(service(), "main", "w1:p1", "0", null).status).toBe(400);
    expect(walkyPaneRoute(service(), "main", "w1:p1", "201", null).status).toBe(400);
  });
});

describe("a crew member pane's list on the lead (§21, added 2026-10-18)", () => {
  test("a member the lead knows to predate walky talky is a 404 with no dial; any other is forwarded", async () => {
    const older = walkyOlderMemberAnswer("1.22.6", "1.23.0");
    expect(older?.status).toBe(404);
    expect(await older?.text()).toBe(WALKY_OLDER_MEMBER_TEXT);
    // At the floor, above it, and a member that reported no version or no release: asked, never guessed.
    for (const version of ["1.23.0", "1.24.1", null, "unknown"]) expect(walkyOlderMemberAnswer(version, "1.23.0")).toBeNull();
    // A development lead below 1.23.0 takes its own version as the floor, as the message route does.
    expect(walkyOlderMemberAnswer("1.22.5", "1.22.6")?.status).toBe(404);
    expect(walkyOlderMemberAnswer("1.22.6", "1.22.6")).toBeNull();
  });
});

describe("the take-backs (M62 spec 03)", () => {
  /** A service whose Send Protocol holds every send until a cancel, and whose watcher never wakes. */
  function heldService(): WalkyService {
    const root = mkdtempSync(join(tmpdir(), "walky-routes-"));
    roots.push(root);
    const states = new Map<string, SendResult>();
    const heldHost: WalkyHost = {
      panes: () => panes,
      send: async (_pane, sendId): Promise<SendResult> => {
        states.set(sendId, { outcome: "held", reason: "draft_present" });
        return { outcome: "held", reason: "draft_present" };
      },
      sendState: (sendId) => states.get(sendId) ?? null,
      cancelHeld: (_session, _paneId, sendId) => states.set(sendId, { outcome: "cancelled" }),
    };
    return new WalkyService({ log: new WalkyLog(join(root, "walky")), host: heldHost, memberId: null, enabled: () => true, machine: "desk", keyPem: () => null, sleep: () => new Promise(() => undefined) });
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  test("POST /api/walky/<id>/cancel takes an operator's held message back, once; an agent's is 403, an unknown id 404", async () => {
    const walky = heldService();
    const audit: string[] = [];
    await walkyPostRoute(walky, { id: "wt_aaaaaaaaaaa1", to: "local/w1:p1", body: "Stop and report." }, context(audit));
    await walky.send({ id: "wt_aaaaaaaaaaa2", to: "local/w1:p2", body: "hi", replyTo: null }, { kind: "agent", pane: panes[0]! });
    await settle();
    expect(walky.status("wt_aaaaaaaaaaa1").receipts[0]).toMatchObject({ state: "accepted", reason: "draft present" });
    const res = walkyCancelRoute(walky, "wt_aaaaaaaaaaa1", context(audit));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ results: [{ target: "local/w1:p1", result: "taken", receipt: { state: "inbox-only", reason: "cancelled by sender" } }] });
    expect(audit.join("")).toContain("walky.cancel");
    expect(audit.join("")).not.toContain("Stop and report");
    const again = walkyCancelRoute(walky, "wt_aaaaaaaaaaa1", context(audit));
    expect(await again.json()).toMatchObject({ results: [{ result: "repeat" }] });
    // The id's shape is checked here, not in the route table: a segment that is no walky id is a 400.
    expect(walkyCancelRoute(walky, "nope", context(audit)).status).toBe(400);
    expect(walkyDropRoute(walky, "main", "w1:p1", "nope", context(audit)).status).toBe(400);
    expect(walkyCancelRoute(walky, "wt_aaaaaaaaaaa2", context(audit)).status).toBe(403);
    expect(walky.status("wt_aaaaaaaaaaa2").receipts[0]).toMatchObject({ state: "accepted", reason: "draft present" });
    expect(walkyCancelRoute(walky, "wt_zzzzzzzzzzzz", context(audit)).status).toBe(404);
    expect(walkyCancelRoute(undefined, "wt_aaaaaaaaaaa1", context(audit)).status).toBe(404);
  });

  test("POST /api/pane/<pane>/walky/<id>/drop ends a message held for that pane as dropped; another pane, or no such pane, is 404", async () => {
    const walky = heldService();
    const audit: string[] = [];
    await walky.send({ id: "wt_aaaaaaaaaaa1", to: "local/w1:p2", body: "hi", replyTo: null }, { kind: "agent", pane: panes[0]! });
    await settle();
    expect(walkyDropRoute(walky, "main", "w1:p1", "wt_aaaaaaaaaaa1", context(audit)).status).toBe(404);
    expect(walkyDropRoute(walky, "main", "w9:p9", "wt_aaaaaaaaaaa1", context(audit)).status).toBe(404);
    expect(walkyDropRoute(walky, "main", "../x", "wt_aaaaaaaaaaa1", context(audit)).status).toBe(400);
    const res = walkyDropRoute(walky, "main", "w1:p2", "wt_aaaaaaaaaaa1", context(audit));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ results: [{ target: "local/w1:p2", result: "taken", receipt: { state: "inbox-only", reason: "dropped by the pane's owner" } }] });
    expect(audit.join("")).toContain("walky.drop");
    expect(audit.join("")).not.toContain('"hi"');
    // The message stays in the pane's inbox, readable.
    expect(walky.inbox("main", "w1:p2", "aaaa", false).map((entry) => entry.id)).toEqual(["wt_aaaaaaaaaaa1"]);
  });
});
