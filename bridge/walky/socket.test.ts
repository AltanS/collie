import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BeaconMatcher } from "../beacon/decorate.ts";
import { HOST, hostFor } from "../host.ts";
import type { JsonObject, JsonValue } from "../json.ts";
import type { SendResult, WalkyHost, WalkyPane } from "./deliver.ts";
import { WalkyLog } from "./log.ts";
import { parseWalkyRequest, RAW_BODY_MAX, readWalkyRequest } from "./parse.ts";
import { BAD_ACK_IDS, BAD_MESSAGE_ID, BAD_REQUEST_LINE, BARE_BAD_REQUEST, bodyOverRaw, NO_ADDRESS, unknownOp, unreadAddress } from "./refusals.ts";
import { WalkyService } from "./service.ts";
import { WalkyOff } from "./off.ts";
import { answerRequest, answerUnread, CANCEL_NEEDS_A_PANE, HILL_NEEDS_A_PANE, placeMarkers, SWITCH_NEEDS_A_PANE, walkySocketPath, WalkyServer, type PlaceTarget } from "./socket.ts";
import { HILL_BAD_ID } from "../hill/parse.ts";
import { memoryHillReceipts } from "../hill/receipts.ts";
import type { HillLeadForward } from "../hill/crew.ts";
import { HillService } from "../hill/service.ts";
import { HillStore } from "../hill/store.ts";
import { walkyPlace } from "../hill/walky.ts";

import { spaceOf } from "./space.ts";

/** One unnamed space on one machine: every fixture pane shares it, and no rule reads it yet. */
const SOLO_SPACE = spaceOf({ memberId: "local", spaceId: "w1", spaceLabel: "w1" });

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
  { session: "main", paneId: "%1", agent: true, harness: "agent-x", label: "repo#a", state: "idle", activeAt: null, instance: "aaaa", terminal: true, off: false, space: SOLO_SPACE },
  { session: "main", paneId: "%2", agent: true, harness: "agent-y", label: "repo#b", state: "working", activeAt: null, instance: "bbbb", terminal: true, off: false, space: SOLO_SPACE },
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

describe("the off and on requests (M89)", () => {
  /** A service whose host reads the off store, as the bridge's does; pane `%3` is a shell. */
  function switched() {
    const root = mkdtempSync(join(tmpdir(), "walky-socket-"));
    roots.push(root);
    const off = new WalkyOff(join(root, "walky"));
    const shell: WalkyPane = { ...panes[0]!, paneId: "%3", agent: false, instance: "cccc" };
    const switchHost: WalkyHost = { ...host, panes: () => [...panes, shell].map((pane): WalkyPane => Object.assign({}, pane, { off: off.isOff(pane) })) };
    return { walky: new WalkyService({ log: new WalkyLog(join(root, "walky")), host: switchHost, off, memberId: null, enabled: () => true, machine: "desk", keyPem: () => null }), off };
  }
  const threePanes: PlaceTarget = { ...target, paneIds: () => ["%1", "%2", "%3"] };
  const ask = async (walky: WalkyService, line: JsonObject) => answerRequest(walky, parseWalkyRequest(JSON.stringify({ v: 1, ...line }))!, [threePanes]);

  test("off and on set the flag of the asker's own pane, and are idempotent", async () => {
    const { walky, off } = switched();
    expect(await ask(walky, { op: "off", markers: marker("%1") })).toEqual({ ok: true, off: true });
    expect(off.all()).toMatchObject([{ session: "main", paneId: "%1", token: "aaaa", by: "session" }]);
    expect(await ask(walky, { op: "off", markers: marker("%1") })).toEqual({ ok: true, off: true });
    expect(off.isOff({ session: "main", paneId: "%2", instance: "bbbb" })).toBe(false);
    expect(await ask(walky, { op: "on", markers: marker("%1") })).toEqual({ ok: true, off: false });
    expect(await ask(walky, { op: "on", markers: marker("%1") })).toEqual({ ok: true, off: false });
    expect(off.all()).toEqual([]);
  });

  test("a request with no markers, or from a shell pane, is refused; markers that name no pane here are `not here`", async () => {
    const { walky, off } = switched();
    expect(await ask(walky, { op: "off", markers: [] })).toEqual({ ok: false, error: SWITCH_NEEDS_A_PANE });
    expect(await ask(walky, { op: "off", markers: marker("%3") })).toEqual({ ok: false, error: SWITCH_NEEDS_A_PANE });
    expect(await ask(walky, { op: "on", markers: [] })).toEqual({ ok: false, error: SWITCH_NEEDS_A_PANE });
    expect(await ask(walky, { op: "off", markers: marker("%9") })).toEqual({ ok: false, error: "not here" });
    expect(off.all()).toEqual([]);
  });

  test("`pane` says whether the asking pane runs an agent, and needs a pane of this bridge", async () => {
    const { walky } = switched();
    expect(await ask(walky, { op: "pane", markers: marker("%1") })).toEqual({ ok: true, agent: true, session: "main", paneId: "%1" });
    expect(await ask(walky, { op: "pane", markers: marker("%3") })).toEqual({ ok: true, agent: false, session: "main", paneId: "%3" });
    expect(await ask(walky, { op: "pane", markers: [] })).toEqual({ ok: false, error: "needs a pane" });
    expect(await ask(walky, { op: "pane", markers: marker("%9") })).toEqual({ ok: false, error: "not here" });
  });

  test("`who` says so of the asker and of the pane, and says nothing when on", async () => {
    const { walky } = switched();
    const on = await ask(walky, { op: "who", markers: marker("%1") });
    expect("selfOff" in on).toBe(false);
    await ask(walky, { op: "off", markers: marker("%1") });
    expect(await ask(walky, { op: "who", markers: marker("%1") })).toMatchObject({ ok: true, selfOff: true, targets: [{ address: "local/%1#aaaa", walky: "off" }, { address: "local/%2#bbbb" }] });
    const other = await ask(walky, { op: "who", markers: marker("%2") });
    expect("selfOff" in other).toBe(false);
  });

  test("a socket send from the off pane is refused, and a send to it too", async () => {
    const { walky } = switched();
    await ask(walky, { op: "off", markers: marker("%1") });
    expect(await ask(walky, { op: "send", markers: marker("%1"), id: "wt_aaaaaaaaaaa1", to: "local/%2", body: "hi" })).toMatchObject({ ok: true, receipts: [{ state: "refused", reason: "your walky talky is off" }] });
    expect(await ask(walky, { op: "send", markers: marker("%2"), id: "wt_aaaaaaaaaaa2", to: "local/%1", body: "hi" })).toMatchObject({ ok: true, receipts: [{ state: "refused", reason: "walky talky off" }] });
    await ask(walky, { op: "on", markers: marker("%1") });
    expect(await ask(walky, { op: "send", markers: marker("%2"), id: "wt_aaaaaaaaaaa3", to: "local/%1", body: "hi" })).toMatchObject({ ok: true, receipts: [{ state: "accepted" }] });
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

  test("who carries the asking pane's own space (M98 spec 04), and none for a caller that is no pane", async () => {
    const walky = service();
    const asked = await answerRequest(walky, parseWalkyRequest(JSON.stringify({ v: 1, op: "who", markers: marker("%1") }))!, [target]);
    expect(asked).toMatchObject({ ok: true, ownSpace: { key: SOLO_SPACE.key, named: false, label: "w1" } });
    const anon = await answerRequest(walky, parseWalkyRequest(JSON.stringify({ v: 1, op: "who", markers: [] }))!, [target]);
    expect(anon).toMatchObject({ ok: true, self: null });
    expect(anon).not.toHaveProperty("ownSpace");
  });

  test("who on a member lists what its lead lists, with no note; a lead that does not answer leaves its own panes and the note", async () => {
    const root = mkdtempSync(join(tmpdir(), "walky-socket-"));
    roots.push(root);
    const lead = { address: "desk/w1:p1#d1d1", memberId: "desk", machine: "desk", harness: "claude", label: "repo#d", state: "idle", space: SOLO_SPACE };
    const member = (leadTargets: () => Promise<readonly (typeof lead)[] | null>) =>
      new WalkyService({ log: new WalkyLog(join(root, "walky")), host, memberId: "laptop", enabled: () => true, machine: "laptop", keyPem: () => null, outcomesOnLead: true, leadName: () => "desk", leadTargets });
    const request = parseWalkyRequest(JSON.stringify({ v: 1, op: "who", markers: marker("%1") }))!;
    const crew = await answerRequest(member(async () => [lead]), request, [target]);
    expect(crew).toMatchObject({ ok: true, targets: [{ address: "laptop/%1#aaaa" }, { address: "laptop/%2#bbbb" }, { address: "desk/w1:p1#d1d1" }] });
    expect(crew).not.toHaveProperty("note");
    const alone = await answerRequest(member(async () => null), request, [target]);
    expect(alone).toMatchObject({ ok: true, note: "other machines: run `collie walky who` on the lead (desk), or use the phone" });
    expect(alone).toMatchObject({ targets: [{ address: "laptop/%1#aaaa" }, { address: "laptop/%2#bbbb" }] });
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
    expect(await read("wt_aaaaaaaaaaa1")).toEqual({ ok: false, error: "not here", missing: "no message wt_aaaaaaaaaaa1 for this pane" });
    // A send to the old instance is refused, and one to the bare id reaches the new session.
    const stale = parseWalkyRequest(JSON.stringify({ v: 1, op: "send", markers: marker("%1"), id: "wt_aaaaaaaaaaa2", to: "local/%2#bbbb", body: "late" }));
    expect(await answerRequest(walky, stale!, [target])).toMatchObject({ ok: true, receipts: [{ state: "refused", reason: "pane replaced", target: "local/%2" }] });
  });

  test("a pane this bridge knows asks for a message it does not hold: `not here`, so the CLI asks the next bridge, with the sentence in `missing` (2026-10-30)", async () => {
    const walky = service();
    const ask = (op: string, markers: ReturnType<typeof marker>, id: string) => answerRequest(walky, parseWalkyRequest(JSON.stringify({ v: 1, op, markers, id, ack: false, all: false }))!, [target]);
    const sentence = "no message wt_zzzzzzzzzzzz for this pane";
    expect(await ask("inbox", marker("%2"), "wt_zzzzzzzzzzzz")).toEqual({ ok: false, error: "not here", missing: sentence });
    // Cancel is the same shape: the sender's bridge may be the other one.
    expect(await ask("cancel", marker("%2"), "wt_zzzzzzzzzzzz")).toEqual({ ok: false, error: "not here", missing: "no message wt_zzzzzzzzzzzz on this machine" });
    // A pane this bridge does not know is `not here` without a sentence; no pane at all keeps the machine wording.
    expect(await ask("inbox", marker("%9"), "wt_zzzzzzzzzzzz")).toEqual({ ok: false, error: "not here" });
    expect(await ask("inbox", [], "wt_zzzzzzzzzzzz")).toEqual({ ok: false, error: "no message wt_zzzzzzzzzzzz on this machine" });
  });

  test("a bad line is no request: wrong version, unknown op, bad id, bad address", () => {
    expect(parseWalkyRequest("{")).toBeNull();
    expect(parseWalkyRequest(JSON.stringify({ v: 2, op: "who" }))).toBeNull();
    expect(parseWalkyRequest(JSON.stringify({ v: 1, op: "drop" }))).toBeNull();
    expect(parseWalkyRequest(JSON.stringify({ v: 1, op: "status", id: "../x" }))).toBeNull();
    expect(parseWalkyRequest(JSON.stringify({ v: 1, op: "send", id: "wt_aaaaaaaaaaa1", to: "local/../x", body: "x" }))).toBeNull();
  });
});

describe("a request this bridge cannot read (added 2026-10-30)", () => {
  const unreadOf = (row: Record<string, JsonValue>) => {
    const read = readWalkyRequest(JSON.stringify(row));
    if (read.ok) throw new Error("the line was read");
    return read;
  };

  test("every unread line names its reason, and none is the bare word", () => {
    const cases: [string, string][] = [
      ["{", BAD_REQUEST_LINE],
      [JSON.stringify({ v: 2, op: "who" }), BAD_REQUEST_LINE],
      [JSON.stringify({ v: 1, op: "drop" }), unknownOp("drop")],
      [JSON.stringify({ v: 1, op: "status", id: "../x" }), BAD_MESSAGE_ID],
      [JSON.stringify({ v: 1, op: "send", id: "wt_aaaaaaaaaaa1", body: "x" }), NO_ADDRESS],
      [JSON.stringify({ v: 1, op: "send", id: "wt_aaaaaaaaaaa1", to: "local/../x", body: "x" }), unreadAddress("local/../x")],
      [JSON.stringify({ v: 1, op: "send", id: "wt_aaaaaaaaaaa1", to: "local/%2", body: "x".repeat(RAW_BODY_MAX + 1) }), bodyOverRaw(RAW_BODY_MAX)],
      [JSON.stringify({ v: 1, op: "ack", ids: "wt_aaaaaaaaaaa1" }), BAD_ACK_IDS],
    ];
    for (const [line, reason] of cases) {
      const read = readWalkyRequest(line);
      expect(read).toMatchObject({ ok: false, reason });
      expect(read.ok ? "" : read.reason).toStartWith(`${BARE_BAD_REQUEST}: `);
    }
    // `here` and the other scope words read on this build.
    for (const to of ["here", "collie-workspace", "collie-workspace#main"]) {
      expect(readWalkyRequest(JSON.stringify({ v: 1, op: "send", markers: marker("%1"), id: "wt_aaaaaaaaaaa1", to, body: "x" }))).toMatchObject({ ok: true, request: { to } });
    }
  });

  test("markers that name no pane here answer `not here`, so the CLI asks the next bridge; this bridge's own pane hears the reason", async () => {
    // An address form newer than this bridge, as `here` was to a bridge before M75.
    const newer = { v: 1, op: "send", id: "wt_aaaaaaaaaaa1", to: "desk/w1:p1/next", body: "x" };
    expect(await answerUnread(service(), unreadOf({ ...newer, markers: marker("%9") }), [target])).toEqual({ ok: false, error: "not here" });
    expect(await answerUnread(service(), unreadOf({ ...newer, markers: [{ namespace: "hc", scope: "/run/hc.sock", pane: "t1" }] }), [target])).toEqual({ ok: false, error: "not here" });
    expect(await answerUnread(service(), unreadOf({ ...newer, markers: marker("%1") }), [target])).toEqual({ ok: false, error: unreadAddress("desk/w1:p1/next") });
    expect(await answerUnread(service(), unreadOf({ ...newer, markers: [] }), [target])).toEqual({ ok: false, error: unreadAddress("desk/w1:p1/next") });
  });

  test.skipIf(POSIX_ONLY)("the server answers an unread line with its reason or `not here`, never the bare word", async () => {
    const root = mkdtempSync(join(tmpdir(), "walky-sock-"));
    roots.push(root);
    const path = walkySocketPath(root);
    const server = new WalkyServer({ socketPath: path, service: service(), targets: () => [target], log: () => undefined });
    expect(await server.start()).toBe(true);
    const ask = (row: Record<string, JsonValue>) =>
      new Promise<string>((resolve) => {
        const conn = createConnection({ path });
        let text = "";
        conn.setEncoding("utf8");
        conn.on("data", (chunk: string) => {
          text += chunk;
        });
        conn.on("close", () => resolve(text));
        conn.write(`${JSON.stringify(row)}\n`);
      });
    const newer = { v: 1, op: "send", id: "wt_aaaaaaaaaaa1", to: "a/b/c", body: "x" };
    expect(JSON.parse(await ask({ ...newer, markers: marker("%9") }))).toEqual({ ok: false, error: "not here" });
    expect(JSON.parse(await ask({ ...newer, markers: marker("%1") }))).toEqual({ ok: false, error: unreadAddress("a/b/c") });
    server.stop();
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

// ── The hill's operations (M96) ──────────────────────────────────────────────────────────────────
describe("the hill operations (M96)", () => {
  function withHill(mode: "solo" | "lead" | "peer" = "solo", forward?: HillLeadForward) {
    const walky = service();
    const hill = new HillService({
      forward,
      store: new HillStore(null, () => 1000),
      receipts: memoryHillReceipts(),
      place: walkyPlace(walky, null),
      send: async () => "typed",
      crewMode: () => mode,
      walkyOn: () => true,
      memberId: "m_aaaaaaaaaa",
      machine: "desk",
      now: () => 1000,
      mintId: () => "dc_aaaaaaaaaaa1",
    });
    return { walky, hill };
  }
  const shell: WalkyPane = { ...panes[0]!, paneId: "%3", agent: false, instance: "cccc" };
  const post = { requestId: "0f8b5c1e-5a7d-4b8e-9f00-1a2b3c4d5e6f", title: "Ship?", summary: "Green.", options: [{ intent: "yes", label: "Yes" }] };
  const ask = async (walky: WalkyService, hill: HillService | undefined, line: JsonObject, targets: PlaceTarget[] = [target]) =>
    answerRequest(walky, parseWalkyRequest(JSON.stringify({ v: 1, ...line }))!, targets, hill);

  test("post from an agent's pane: the decision is from that pane's address with its token, never from the request", async () => {
    const { walky, hill } = withHill();
    const answer = await ask(walky, hill, { op: "hill.post", markers: marker("%1"), ...post, from: { kind: "trick", trickId: "x" } });
    expect(answer).toMatchObject({ ok: true, decision: { id: "dc_aaaaaaaaaaa1", from: { kind: "agent", address: "local/%1#aaaa", harness: "agent-x", label: "repo#a", host: "desk" }, target: { label: "repo#a" } } });
  });

  test("a post that claims to be Collie's own is an agent's post: the socket cannot mint kind collie (crew slice 3)", async () => {
    const { walky, hill } = withHill();
    const ref = { type: "version", id: "legs", hash: "a".repeat(64) };
    const answer = await ask(walky, hill, { op: "hill.post", markers: marker("%1"), ...post, kind: "collie", ref, from: { kind: "collie", ref } });
    expect(answer).toMatchObject({ ok: true, decision: { from: { kind: "agent", address: "local/%1#aaaa" } } });
    expect(hill.collieDecisions("version")).toEqual([]);
    expect(hill.list().open.every((decision) => decision.from.kind === "agent" && decision.from.ref === undefined)).toBe(true);
  });

  test("no pane, or a shell pane: refused, with the hill's mark; markers that name no pane here are `not here`", async () => {
    const { walky, hill } = withHill();
    expect(await ask(walky, hill, { op: "hill.post", markers: [], ...post })).toEqual({ ok: false, error: HILL_NEEDS_A_PANE, hill: true });
    expect(await ask(walky, hill, { op: "hill.list", markers: [], mine: true })).toEqual({ ok: false, error: HILL_NEEDS_A_PANE, hill: true });
    expect(await ask(walky, hill, { op: "hill.post", markers: marker("%9"), ...post })).toEqual({ ok: false, error: "not here", hill: true });
    const shellHost: WalkyHost = { ...host, panes: () => [...panes, shell] };
    const root = mkdtempSync(join(tmpdir(), "walky-socket-"));
    roots.push(root);
    const withShell = new WalkyService({ log: new WalkyLog(join(root, "walky")), host: shellHost, memberId: null, enabled: () => true, machine: "desk", keyPem: () => null });
    expect(await ask(withShell, hill, { op: "hill.post", markers: marker("%3"), ...post }, [{ ...target, paneIds: () => ["%1", "%2", "%3"] }])).toEqual({ ok: false, error: HILL_NEEDS_A_PANE, hill: true });
  });

  test("a refusal carries its code and plain words", async () => {
    const { walky, hill } = withHill();
    expect(await ask(walky, hill, { op: "hill.post", markers: marker("%1"), ...post, title: "" })).toEqual({ ok: false, error: "a decision needs a title", hill: true, code: "bad_title" });
    const peer = withHill("peer");
    expect(await ask(peer.walky, peer.hill, { op: "hill.post", markers: marker("%1"), ...post })).toMatchObject({ ok: false, code: "not_on_lead", hill: true });
  });

  test("on a crew member from 1.29.0 the four go to the lead (CREW_PROTOCOL §22); a lead that does not answer is said plainly, with its code", async () => {
    const seen: string[] = [];
    const lead: HillLeadForward = {
      post: async (from, fields, requestId) => {
        seen.push(`post ${from.address} ${requestId} ${String(fields.title)}`);
        return { ok: false, code: "lead_unreachable", error: `the lead (desk) is not answering; nothing was posted. Post again with --request-id ${requestId}: it posts once` };
      },
      one: async (op, from, id) => {
        seen.push(`${op} ${from.address} ${id}`);
        return { ok: false, missing: false, error: "the lead (desk) is not answering; try again" };
      },
      list: async (from) => {
        seen.push(`list ${from.address}`);
        return { ok: false, error: "the lead (desk) is not answering; try again" };
      },
      state: async () => ({ ok: false, error: "the lead (desk) is not answering; try again" }),
    };
    const { walky, hill } = withHill("peer", lead);
    expect(await ask(walky, hill, { op: "hill.post", markers: marker("%1"), ...post })).toEqual({
      ok: false,
      code: "lead_unreachable",
      hill: true,
      error: `the lead (desk) is not answering; nothing was posted. Post again with --request-id ${post.requestId}: it posts once`,
    });
    expect(await ask(walky, hill, { op: "hill.status", markers: marker("%1"), id: "dc_aaaaaaaaaaa1" })).toEqual({ ok: false, error: "the lead (desk) is not answering; try again", hill: true });
    expect(await ask(walky, hill, { op: "hill.list", markers: marker("%1"), mine: true })).toEqual({ ok: false, error: "the lead (desk) is not answering; try again", hill: true });
    // The sender is the pane's own address with its token, as on a lead.
    expect(seen).toEqual([`post local/%1#aaaa ${post.requestId} Ship?`, "status local/%1#aaaa dc_aaaaaaaaaaa1", "list local/%1#aaaa"]);
  });

  test("status, withdraw and list answer the asker's own decisions; another pane's id is `not here` with the sentence", async () => {
    const { walky, hill } = withHill();
    await ask(walky, hill, { op: "hill.post", markers: marker("%1"), ...post });
    expect(await ask(walky, hill, { op: "hill.status", markers: marker("%1"), id: "dc_aaaaaaaaaaa1" })).toMatchObject({ ok: true, decision: { state: "open" } });
    expect(await ask(walky, hill, { op: "hill.status", markers: marker("%2"), id: "dc_aaaaaaaaaaa1" })).toEqual({ ok: false, error: "not here", hill: true, missing: "no decision dc_aaaaaaaaaaa1 from this session" });
    expect(await ask(walky, hill, { op: "hill.withdraw", markers: marker("%2"), id: "dc_aaaaaaaaaaa1" })).toMatchObject({ ok: false, error: "not here" });
    expect(await ask(walky, hill, { op: "hill.list", markers: marker("%2"), mine: true })).toEqual({ ok: true, decisions: [] });
    expect(await ask(walky, hill, { op: "hill.withdraw", markers: marker("%1"), id: "dc_aaaaaaaaaaa1" })).toMatchObject({ ok: true, decision: { state: "withdrawn", closedReason: "by the poster" } });
    expect(await ask(walky, hill, { op: "hill.list", markers: marker("%1"), mine: true })).toMatchObject({ ok: true, decisions: [{ id: "dc_aaaaaaaaaaa1", state: "withdrawn" }] });
  });

  test("a bad decision id is a bad request with its reason", () => {
    expect(readWalkyRequest(JSON.stringify({ v: 1, op: "hill.status", markers: [], id: "wt_aaaaaaaaaaa1" }))).toEqual({ ok: false, markers: [], reason: HILL_BAD_ID });
  });

  test("a bridge built without the hill answers its operations as today's bridge answers an unknown op", async () => {
    const walky = service();
    expect(await ask(walky, undefined, { op: "hill.post", markers: marker("%1"), ...post })).toEqual({ ok: false, error: unknownOp("hill.post") });
    expect(await ask(walky, undefined, { op: "hill.list", markers: marker("%9") })).toEqual({ ok: false, error: "not here" });
    expect(await ask(walky, undefined, { op: "hill.list", markers: [] })).toEqual({ ok: false, error: unknownOp("hill.list") });
  });

  test("walky's own operations answer exactly as before when the hill is wired", async () => {
    const { walky, hill } = withHill();
    expect(await ask(walky, hill, { op: "who", markers: marker("%9") })).toEqual({ ok: false, error: "not here" });
    expect(await ask(walky, hill, { op: "send", markers: [], id: "wt_aaaaaaaaaaa1", to: "local/%2", body: "hi" })).toEqual({ ok: false, error: "run this inside a pane, or send from the phone" });
  });
});
