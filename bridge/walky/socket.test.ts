import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BeaconMatcher } from "../beacon/decorate.ts";
import { HOST, hostFor } from "../host.ts";
import type { SendResult, WalkyHost, WalkyPane } from "./deliver.ts";
import { WalkyLog } from "./log.ts";
import { parseWalkyRequest } from "./parse.ts";
import { WalkyService } from "./service.ts";
import { answerRequest, CANCEL_NEEDS_A_PANE, placeMarkers, walkySocketPath, WalkyServer, type PlaceTarget } from "./socket.ts";

// A Unix socket file with an owner-only mode is POSIX; Windows has no walky socket ("Windows has no
// socket" below), so every part of this test is about that socket.
const POSIX_ONLY = HOST.platform === "win32";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const matcher: BeaconMatcher = {
  namespace: "tmux",
  scope: async () => "/tmp/tmux-1/default",
  matches: (pane, marker, scope) => marker.scope === scope && pane.paneId === marker.pane,
  notesWithoutHooks: { agentDetection: "", agentSessionRef: "" },
};
const target: PlaceTarget = { session: "main", matcher, paneIds: () => ["%1", "%2"] };
const marker = (pane: string) => [{ namespace: "tmux", scope: "/tmp/tmux-1/default", pane }];

const panes: WalkyPane[] = [
  { session: "main", paneId: "%1", agent: true, harness: "agent-x", label: "repo#a", state: "idle", instance: "aaaa", terminal: true },
  { session: "main", paneId: "%2", agent: true, harness: "agent-y", label: "repo#b", state: "working", instance: "bbbb", terminal: true },
];

const host: WalkyHost = {
  panes: () => panes,
  send: async (): Promise<SendResult> => ({ outcome: "sent" }),
  sendState: () => ({ outcome: "sent" }),
  cancelHeld: () => undefined,
};

function service(): WalkyService {
  const root = mkdtempSync(join(tmpdir(), "walky-socket-"));
  roots.push(root);
  return new WalkyService({ log: new WalkyLog(join(root, "walky")), host, memberId: null, enabled: () => true, machine: "desk", keyPem: () => null });
}

describe("placing the CLI's pane", () => {
  test("exactly one pane must match a marker of its namespace and scope", async () => {
    expect(await placeMarkers(marker("%2"), [target])).toEqual({ session: "main", paneId: "%2" });
    expect(await placeMarkers(marker("%9"), [target])).toBeNull();
    expect(await placeMarkers([{ namespace: "tmux", scope: "/other", pane: "%2" }], [target])).toBeNull();
    expect(await placeMarkers(marker("%2"), [target, { ...target, session: "twin" }])).toBeNull();
  });
});

describe("the requests", () => {
  test("a send from inside a pane is an agent's; a send with no markers is refused, never the operator's", async () => {
    const walky = service();
    const fromPane = parseWalkyRequest(JSON.stringify({ v: 1, op: "send", markers: marker("%1"), id: "wt_aaaaaaaaaaa1", to: "local/%2", body: "hi" }));
    expect(await answerRequest(walky, fromPane!, [target])).toMatchObject({ ok: true, receipts: [{ state: "accepted" }] });
    expect(walky.status("wt_aaaaaaaaaaa1").message).toMatchObject({ kind: "agent", from: { address: "local/%1#aaaa", harness: "agent-x", label: "repo#a" } });
    const fromDesk = parseWalkyRequest(JSON.stringify({ v: 1, op: "send", markers: [], id: "wt_aaaaaaaaaaa2", to: "local/%2", body: "hi" }));
    expect(await answerRequest(walky, fromDesk!, [target])).toEqual({ ok: false, error: "run this inside a pane, or send from the phone" });
    expect(walky.status("wt_aaaaaaaaaaa2").receipts).toEqual([]);
  });

  test("an agent's body over 4,000 characters is refused with the reason, and nothing is logged", async () => {
    const walky = service();
    const long = parseWalkyRequest(JSON.stringify({ v: 1, op: "send", markers: marker("%1"), id: "wt_aaaaaaaaaaa1", to: "local/%2", body: "\u{1f415}".repeat(4001) }));
    expect(await answerRequest(walky, long!, [target])).toMatchObject({ ok: true, receipts: [{ state: "refused", reason: "body over 4,000 characters" }] });
    expect(walky.log.all("wt_aaaaaaaaaaa1")).toEqual([]);
  });

  test("cancel (M62 spec 03): the sender's pane takes a held message back; another pane, or no pane, cannot", async () => {
    const root = mkdtempSync(join(tmpdir(), "walky-socket-"));
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
    // The watcher never wakes: the hold stands until a cancel.
    const walky = new WalkyService({ log: new WalkyLog(join(root, "walky")), host: heldHost, memberId: null, enabled: () => true, machine: "desk", keyPem: () => null, sleep: () => new Promise(() => undefined) });
    const sent = parseWalkyRequest(JSON.stringify({ v: 1, op: "send", markers: marker("%1"), id: "wt_aaaaaaaaaaa1", to: "local/%2", body: "hi" }));
    expect(await answerRequest(walky, sent!, [target])).toMatchObject({ ok: true, receipts: [{ state: "accepted" }] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(walky.status("wt_aaaaaaaaaaa1").receipts[0]).toMatchObject({ state: "accepted", reason: "draft present" });
    const line = (markers: ReturnType<typeof marker>) => parseWalkyRequest(JSON.stringify({ v: 1, op: "cancel", markers, id: "wt_aaaaaaaaaaa1" }));
    expect(line([])).toEqual({ op: "cancel", markers: [], id: "wt_aaaaaaaaaaa1" });
    expect(parseWalkyRequest(JSON.stringify({ v: 1, op: "cancel", markers: [], id: "nope" }))).toBeNull();
    expect(await answerRequest(walky, line([])!, [target])).toEqual({ ok: false, error: CANCEL_NEEDS_A_PANE });
    expect(await answerRequest(walky, line(marker("%2"))!, [target])).toEqual({ ok: false, error: "only the sender can cancel it" });
    expect(await answerRequest(walky, line(marker("%1"))!, [target])).toMatchObject({ ok: true, results: [{ target: "local/%2", result: "taken", receipt: { state: "inbox-only", reason: "cancelled by sender" } }] });
    expect(await answerRequest(walky, line(marker("%1"))!, [target])).toMatchObject({ ok: true, results: [{ result: "repeat" }] });
  });

  test("the address is kept as the bridge spells it, without the blanks around it", () => {
    const request = parseWalkyRequest(JSON.stringify({ v: 1, op: "send", markers: marker("%1"), id: "wt_aaaaaaaaaaa1", to: " desk/%2\n", body: "hi" }));
    expect(request).toMatchObject({ op: "send", to: "desk/%2" });
  });

  test("markers this bridge cannot place answer `not here`, so the CLI asks the next bridge", async () => {
    const request = parseWalkyRequest(JSON.stringify({ v: 1, op: "who", markers: marker("%9") }));
    expect(await answerRequest(service(), request!, [target])).toEqual({ ok: false, error: "not here" });
  });

  test("who names the asking pane; inbox and ack read and clear that pane's", async () => {
    const walky = service();
    await walky.send({ id: "wt_aaaaaaaaaaa1", to: "local/%1", body: "one", replyTo: null }, { kind: "operator", label: "phone" });
    await walky.deliverer.settled();
    walky.log.inboxAdd("main", "%1", "aaaa", walky.status("wt_aaaaaaaaaaa1").message!);
    const who = await answerRequest(walky, parseWalkyRequest(JSON.stringify({ v: 1, op: "who", markers: marker("%1") }))!, [target]);
    expect(who).toMatchObject({ ok: true, self: "local/%1#aaaa", targets: [{ address: "local/%1#aaaa" }, { address: "local/%2#bbbb" }] });
    const inbox = await answerRequest(walky, parseWalkyRequest(JSON.stringify({ v: 1, op: "inbox", markers: marker("%1"), ack: true }))!, [target]);
    expect(inbox).toMatchObject({ ok: true, pane: "local/%1#aaaa", messages: [{ id: "wt_aaaaaaaaaaa1" }] });
    expect(walky.inbox("main", "%1", "aaaa", false)).toEqual([]);
    expect(await answerRequest(walky, parseWalkyRequest(JSON.stringify({ v: 1, op: "ack", markers: [] }))!, [target])).toEqual({ ok: false, error: "needs a pane" });
  });

  test("inbox reads the pane's current instance: a new session that took the pane id starts empty", async () => {
    const list: WalkyPane[] = [...panes];
    const root = mkdtempSync(join(tmpdir(), "walky-socket-"));
    roots.push(root);
    const walky = new WalkyService({ log: new WalkyLog(join(root, "walky")), host: { ...host, panes: () => list }, memberId: null, enabled: () => true, machine: "desk", keyPem: () => null });
    // An agent's message waits in %2's inbox, unread, and its record names instance bbbb.
    const fromPane = parseWalkyRequest(JSON.stringify({ v: 1, op: "send", markers: marker("%1"), id: "wt_aaaaaaaaaaa1", to: "local/%2#bbbb", body: "for the first" }));
    expect(await answerRequest(walky, fromPane!, [target])).toMatchObject({ ok: true, receipts: [{ state: "accepted", target: "local/%2" }] });
    await walky.deliverer.settled();
    const read = (id: string | null = null) => answerRequest(walky, parseWalkyRequest(JSON.stringify({ v: 1, op: "inbox", markers: marker("%2"), ack: false, all: false, id }))!, [target]);
    expect(await read()).toMatchObject({ ok: true, pane: "local/%2#bbbb", messages: [{ id: "wt_aaaaaaaaaaa1" }] });
    // The pane closed, and a new session took %2: same id, another instance.
    list[1] = { ...list[1]!, instance: "cccc" };
    expect(await read()).toEqual({ ok: true, pane: "local/%2#cccc", messages: [] });
    expect(await read("wt_aaaaaaaaaaa1")).toEqual({ ok: false, error: "no message wt_aaaaaaaaaaa1 for this pane" });
    // A send to the old instance is refused, and one to the bare id reaches the new session.
    const stale = parseWalkyRequest(JSON.stringify({ v: 1, op: "send", markers: marker("%1"), id: "wt_aaaaaaaaaaa2", to: "local/%2#bbbb", body: "late" }));
    expect(await answerRequest(walky, stale!, [target])).toMatchObject({ ok: true, receipts: [{ state: "refused", reason: "pane replaced", target: "local/%2" }] });
  });

  test("a bad line is no request: wrong version, unknown op, bad id, bad address", () => {
    expect(parseWalkyRequest("{")).toBeNull();
    expect(parseWalkyRequest(JSON.stringify({ v: 2, op: "who" }))).toBeNull();
    expect(parseWalkyRequest(JSON.stringify({ v: 1, op: "drop" }))).toBeNull();
    expect(parseWalkyRequest(JSON.stringify({ v: 1, op: "status", id: "../x" }))).toBeNull();
    expect(parseWalkyRequest(JSON.stringify({ v: 1, op: "send", id: "wt_aaaaaaaaaaa1", to: "local/../x", body: "x" }))).toBeNull();
  });
});

describe("the socket", () => {
  test.skipIf(POSIX_ONLY)("is 0600, answers one line per connection, and refuses a second bridge on the same path", async () => {
    const root = mkdtempSync(join(tmpdir(), "walky-sock-"));
    roots.push(root);
    const path = walkySocketPath(root);
    const server = new WalkyServer({ socketPath: path, service: service(), targets: () => [target], log: () => undefined });
    expect(await server.start()).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const second = new WalkyServer({ socketPath: path, service: service(), targets: () => [target], log: () => undefined });
    expect(await second.start()).toBe(false);
    const answer = await new Promise<string>((resolve) => {
      const conn = createConnection({ path });
      let text = "";
      conn.setEncoding("utf8");
      conn.on("data", (chunk: string) => {
        text += chunk;
      });
      conn.on("close", () => resolve(text));
      conn.write(`${JSON.stringify({ v: 1, op: "who", markers: [] })}\n`);
    });
    expect(JSON.parse(answer)).toMatchObject({ ok: true, self: null, targets: [{ address: "local/%1#aaaa" }, { address: "local/%2#bbbb" }] });
    server.stop();
  });

  test("Windows has no socket", async () => {
    const server = new WalkyServer({ socketPath: "/nowhere/sock", host: hostFor("win32"), service: service(), targets: () => [], log: () => undefined });
    expect(await server.start()).toBe(false);
  });
});
