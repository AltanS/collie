import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BeaconMatcher } from "../beacon/decorate.ts";
import { hostFor } from "../host.ts";
import type { SendResult, WalkyHost, WalkyPane } from "./deliver.ts";
import { WalkyLog } from "./log.ts";
import { parseWalkyRequest } from "./parse.ts";
import { WalkyService } from "./service.ts";
import { answerRequest, placeMarkers, walkySocketPath, WalkyServer, type PlaceTarget } from "./socket.ts";

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
  { session: "main", paneId: "%1", agent: true, harness: "agent-x", label: "repo#a", state: "idle", terminal: true },
  { session: "main", paneId: "%2", agent: true, harness: "agent-y", label: "repo#b", state: "working", terminal: true },
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
    expect(walky.status("wt_aaaaaaaaaaa1").message).toMatchObject({ kind: "agent", from: { address: "local/%1", harness: "agent-x", label: "repo#a" } });
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
    walky.log.inboxAdd("main", "%1", walky.status("wt_aaaaaaaaaaa1").message!);
    const who = await answerRequest(walky, parseWalkyRequest(JSON.stringify({ v: 1, op: "who", markers: marker("%1") }))!, [target]);
    expect(who).toMatchObject({ ok: true, self: "local/%1", targets: [{ address: "local/%1" }, { address: "local/%2" }] });
    const inbox = await answerRequest(walky, parseWalkyRequest(JSON.stringify({ v: 1, op: "inbox", markers: marker("%1"), ack: true }))!, [target]);
    expect(inbox).toMatchObject({ ok: true, pane: "local/%1", messages: [{ id: "wt_aaaaaaaaaaa1" }] });
    expect(walky.inbox("main", "%1", false)).toEqual([]);
    expect(await answerRequest(walky, parseWalkyRequest(JSON.stringify({ v: 1, op: "ack", markers: [] }))!, [target])).toEqual({ ok: false, error: "needs a pane" });
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
  test("is 0600, answers one line per connection, and refuses a second bridge on the same path", async () => {
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
    expect(JSON.parse(answer)).toMatchObject({ ok: true, self: null, targets: [{ address: "local/%1" }, { address: "local/%2" }] });
    server.stop();
  });

  test("Windows has no socket", async () => {
    const server = new WalkyServer({ socketPath: "/nowhere/sock", host: hostFor("win32"), service: service(), targets: () => [], log: () => undefined });
    expect(await server.start()).toBe(false);
  });
});
