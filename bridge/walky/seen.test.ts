import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HOST } from "../host.ts";
import { sendIdOf, type SendResult, type WalkyHost, type WalkyPane } from "./deliver.ts";
import { WalkyLog } from "./log.ts";
import { SEEN_KEEP_MS, seenHash, WalkySeen } from "./seen.ts";
import { WalkyService } from "./service.ts";
import type { WalkyMessage } from "./types.ts";

// File modes and Unix sockets are POSIX. Windows has no 0700 or 0600, so those checks sit in a test
// that is skipped there, and the behaviour beside them still runs.
const POSIX_ONLY = HOST.platform === "win32";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function dir(): string {
  const root = mkdtempSync(join(tmpdir(), "walky-seen-"));
  roots.push(root);
  return join(root, "walky");
}

const message = (id: string, body = "hello"): WalkyMessage => ({
  v: 1,
  id,
  kind: "operator",
  from: { memberId: null, address: null, harness: null, label: "phone" },
  to: "all",
  replyTo: null,
  at: 1,
  body,
  signer: null,
  signature: null,
});

function pane(paneId: string): WalkyPane {
  return { session: "main", paneId, agent: true, harness: "agent-x", label: `repo#${paneId}`, state: "idle", instance: "aaaa", terminal: true };
}

class Host implements WalkyHost {
  readonly typed: string[] = [];
  constructor(public list: WalkyPane[]) {}
  panes(): readonly WalkyPane[] {
    return this.list;
  }
  async send(target: WalkyPane): Promise<SendResult> {
    this.typed.push(target.paneId);
    return { outcome: "sent" };
  }
  sendState(): SendResult | null {
    return { outcome: "sent" };
  }
  cancelHeld(): void {}
}

describe("the seen file", () => {
  test("keeps an id and target a day, apart from the log, on disk", () => {
    const at = { now: 1_786_000_000_000 };
    const folder = dir();
    const seen = new WalkySeen(folder, () => at.now);
    seen.add(message("wt_aaaaaaaaaaa1"), "local/%1");
    seen.add(message("wt_aaaaaaaaaaa1"), "local/%1");
    expect(seen.of("wt_aaaaaaaaaaa1")).toEqual([{ target: "local/%1", firstSeen: at.now, hash: seenHash(message("wt_aaaaaaaaaaa1")) }]);
    expect(new WalkySeen(folder, () => at.now).has("wt_aaaaaaaaaaa1", "local/%1")).toBe(true);
    at.now += SEEN_KEEP_MS + 1;
    expect(new WalkySeen(folder, () => at.now).has("wt_aaaaaaaaaaa1", "local/%1")).toBe(false);
  });

  test.skipIf(POSIX_ONLY)("keeps an id and target a day, apart from the log, on disk at 0600", () => {
    const folder = dir();
    new WalkySeen(folder).add(message("wt_aaaaaaaaaaa1"), "local/%1");
    expect(statSync(join(folder, "seen.json")).mode & 0o777).toBe(0o600);
  });

  test("a file that does not parse reads as empty", () => {
    const folder = dir();
    new WalkySeen(folder).add(message("wt_aaaaaaaaaaa1"), "local/%1");
    writeFileSync(join(folder, "seen.json"), "{not json");
    expect(new WalkySeen(folder).of("wt_aaaaaaaaaaa1")).toEqual([]);
  });
});

describe("dedupe through the seen file (M62 hardening E)", () => {
  function bridge(folder: string, host: Host) {
    return new WalkyService({ log: new WalkyLog(folder), seen: new WalkySeen(folder), host, memberId: null, enabled: () => true, machine: "desk", keyPem: () => null });
  }
  const send = (id: string, to: string, body = "hello") => ({ id, to, body, replyTo: null });
  const operator = { kind: "operator" as const, label: "phone" };

  test("a repeat after the log lost its record answers `unknown` and types nothing", async () => {
    const folder = dir();
    const host = new Host([pane("%1")]);
    const first = bridge(folder, host);
    await first.send(send("wt_aaaaaaaaaaa1", "local/%1"), operator);
    await first.deliverer.settled();
    expect(host.typed).toEqual(["%1"]);
    // The log rotated the record away; the seen file still has the id.
    rmSync(join(folder, "log.jsonl"));
    const again = bridge(folder, host);
    expect(await again.send(send("wt_aaaaaaaaaaa1", "local/%1"), operator)).toMatchObject({ ok: true, receipts: [{ state: "unknown", reason: "no log record", target: "local/%1" }] });
    // And the id cannot be reused for another text.
    expect(await again.send(send("wt_aaaaaaaaaaa1", "local/%1", "another"), operator)).toMatchObject({ ok: true, receipts: [{ state: "refused", reason: "id reused" }] });
    await again.deliverer.settled();
    expect(host.typed).toEqual(["%1"]);
    expect(existsSync(join(folder, "seen.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(folder, "seen.json"), "utf8"))).toMatchObject({ v: 1, seen: { wt_aaaaaaaaaaa1: [{ target: "local/%1" }] } });
  });

  test("a repeated fan-out returns the receipts it has and finishes the targets it lacks", async () => {
    const folder = dir();
    const host = new Host([pane("%1")]);
    const walky = bridge(folder, host);
    expect(await walky.send(send("wt_aaaaaaaaaaa1", "all"), operator)).toMatchObject({ ok: true, receipts: [{ target: "local/%1", state: "accepted" }] });
    await walky.deliverer.settled();
    // The fan-out was cut short (a crash, a pane that came up late): the repeat resumes it.
    host.list = [pane("%1"), pane("%2")];
    const resumed = bridge(folder, host);
    expect(await resumed.send(send("wt_aaaaaaaaaaa1", "all"), operator)).toMatchObject({
      ok: true,
      receipts: [
        { target: "local/%1", state: "delivered" },
        { target: "local/%2", state: "accepted" },
      ],
    });
    await resumed.deliverer.settled();
    expect(host.typed).toEqual(["%1", "%2"]);
    expect(resumed.status("wt_aaaaaaaaaaa1").receipts.map((receipt) => receipt.sendId)).toEqual([sendIdOf("wt_aaaaaaaaaaa1", "local/%1"), sendIdOf("wt_aaaaaaaaaaa1", "local/%2")]);
    // A third time, all done: nothing more.
    expect(await bridge(folder, host).send(send("wt_aaaaaaaaaaa1", "all"), operator)).toMatchObject({ ok: true, receipts: [{ state: "delivered" }, { state: "delivered" }] });
    expect(host.typed).toEqual(["%1", "%2"]);
  });
});
