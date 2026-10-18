import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuditLog } from "../audit.ts";
import { walkyPaneRoute, walkyPostRoute, walkyWhoRoute, WALKY_OFF_TEXT } from "../server.ts";
import type { WalkyHost, WalkyPane } from "./deliver.ts";
import { WalkyLog } from "./log.ts";
import { WalkyService } from "./service.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const panes: WalkyPane[] = [
  { session: "main", paneId: "w1:p1", agent: true, harness: "agent-x", label: "repo#a", state: "idle", terminal: true },
  { session: "main", paneId: "w1:p2", agent: true, harness: "agent-y", label: "repo#b", state: "idle", terminal: true },
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
    const withShell: WalkyHost = { ...host, panes: () => [...panes, { session: "main", paneId: "w1:p3", agent: false, harness: null, label: "repo#c", state: "idle", terminal: true }] };
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
    expect(await walkyWhoRoute(walky, null).json()).toMatchObject({ targets: [{ address: "local/w1:p1" }, { address: "local/w1:p2" }] });
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

  test("a bad pane id or limit is a 400", () => {
    expect(walkyPaneRoute(service(), "main", "..", null, null).status).toBe(400);
    expect(walkyPaneRoute(service(), "main", "w1:p1", "0", null).status).toBe(400);
    expect(walkyPaneRoute(service(), "main", "w1:p1", "201", null).status).toBe(400);
  });
});
