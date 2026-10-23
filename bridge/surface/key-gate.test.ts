import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { muxAck, muxRefused, type MuxAck } from "../mux/types.ts";
import { gateFor, KeyGate, TOKEN_LIFETIME_MS } from "./key-gate.ts";

class Recorder {
  readonly sent: { paneId: string; keys: readonly string[] }[] = [];
  answer: MuxAck = muxAck();
  writeKeys(paneId: string, keys: readonly string[]): Promise<MuxAck> {
    this.sent.push({ paneId, keys });
    return Promise.resolve(this.answer);
  }
}

function clock(start = 1000) {
  let at = start;
  return { now: () => at, advance: (ms: number) => (at += ms) };
}

describe("the key gate's protocol tokens", () => {
  test("a fresh token on the newest revision sends its keys once", async () => {
    const mux = new Recorder();
    const time = clock();
    const gate = new KeyGate(mux, time.now);
    const revision = gate.noteRead("%1");
    const token = gate.mint("%1", ["Enter"], revision);
    expect(await gate.commit(token)).toEqual({ ok: true });
    expect(mux.sent).toEqual([{ paneId: "%1", keys: ["Enter"] }]);
    // Spent: the same token again is stale, and nothing more is sent.
    expect(await gate.commit(token)).toMatchObject({ ok: false, reason: "stale_token" });
    expect(mux.sent).toHaveLength(1);
  });

  test("a token older than its lifetime is refused stale_token and sends nothing", async () => {
    const mux = new Recorder();
    const time = clock();
    const gate = new KeyGate(mux, time.now);
    const token = gate.mint("%1", ["Enter"], gate.noteRead("%1"));
    time.advance(TOKEN_LIFETIME_MS + 1);
    expect(await gate.commit(token)).toMatchObject({ ok: false, reason: "stale_token" });
    expect(mux.sent).toEqual([]);
  });

  test("a token at exactly its lifetime still sends", async () => {
    const mux = new Recorder();
    const time = clock();
    const gate = new KeyGate(mux, time.now);
    const token = gate.mint("%1", ["Enter"], gate.noteRead("%1"));
    time.advance(TOKEN_LIFETIME_MS);
    expect(await gate.commit(token)).toEqual({ ok: true });
  });

  test("a token minted on a read that is no longer the newest is refused stale_surface", async () => {
    const mux = new Recorder();
    const gate = new KeyGate(mux, clock().now);
    const old = gate.noteRead("%1");
    gate.noteRead("%1");
    expect(await gate.commit(gate.mint("%1", ["Enter"], old))).toMatchObject({ ok: false, reason: "stale_surface" });
    expect(mux.sent).toEqual([]);
  });

  test("a person's key between the read and the commit makes the token stale", async () => {
    const mux = new Recorder();
    const gate = new KeyGate(mux, clock().now);
    const token = gate.mint("%1", ["Enter"], gate.noteRead("%1"));
    await gate.press("%1", ["Down"], "person_tap");
    expect(await gate.commit(token)).toMatchObject({ ok: false, reason: "stale_surface" });
    expect(mux.sent).toEqual([{ paneId: "%1", keys: ["Down"] }]);
  });

  test("a text write noted between the read and the commit makes the token stale", async () => {
    const gate = new KeyGate(new Recorder(), clock().now);
    const token = gate.mint("%1", ["Enter"], gate.noteRead("%1"));
    gate.noteWrite("%1");
    expect(await gate.commit(token)).toMatchObject({ ok: false, reason: "stale_surface" });
  });

  test("revisions are per pane: a read on another pane leaves this token fresh", async () => {
    const gate = new KeyGate(new Recorder(), clock().now);
    const token = gate.mint("%1", ["Enter"], gate.noteRead("%1"));
    gate.noteRead("%2");
    expect(await gate.commit(token)).toEqual({ ok: true });
  });

  test("a token from another gate is refused stale_token", async () => {
    const a = new KeyGate(new Recorder(), clock().now);
    const b = new KeyGate(new Recorder(), clock().now);
    const token = a.mint("%1", ["Enter"], a.noteRead("%1"));
    expect(await b.commit(token)).toMatchObject({ ok: false, reason: "stale_token" });
  });

  test("a protocol token never carries Escape, and never nothing", () => {
    const gate = new KeyGate(new Recorder(), clock().now);
    expect(() => gate.mint("%1", ["Escape"], 0)).toThrow(/Escape/);
    expect(() => gate.mint("%1", ["Backspace", "esc"], 0)).toThrow(/Escape/);
    expect(() => gate.mint("%1", [], 0)).toThrow();
  });

  test("a multiplexer refusal comes back as the refusal, and the revision still moves", async () => {
    const mux = new Recorder();
    mux.answer = muxRefused("no such key");
    const gate = new KeyGate(mux, clock().now);
    const revision = gate.noteRead("%1");
    const result = await gate.commit(gate.mint("%1", ["Enter"], revision));
    expect(result).toMatchObject({ ok: false, reason: "mux", refusal: { reason: "refused", detail: "no such key" } });
    expect(gate.revision("%1")).toBe(revision + 1);
  });
});

describe("the key gate's tokens for an ask answer (M56 spec 08)", () => {
  test("a person_tap token keeps the revision check and the lifetime, may carry Escape, and counts as the person's", async () => {
    const mux = new Recorder();
    const time = clock();
    const gate = new KeyGate(mux, time.now);
    const revision = gate.noteRead("%1");
    const cancel = gate.mint("%1", ["Escape"], revision, "person_tap");
    expect(cancel.origin).toBe("person_tap");
    expect(await gate.commit(cancel)).toEqual({ ok: true });
    // A read after the token was minted makes the next one stale, as for the protocol.
    const stale = gate.mint("%1", ["Enter"], revision, "person_tap");
    expect(await gate.commit(stale)).toMatchObject({ ok: false, reason: "stale_surface" });
    const late = gate.mint("%1", ["Enter"], gate.revision("%1"), "person_tap");
    time.advance(TOKEN_LIFETIME_MS + 1);
    expect(await gate.commit(late)).toMatchObject({ ok: false, reason: "stale_token" });
    expect(mux.sent.map((s) => s.keys)).toEqual([["Escape"]]);
    expect(gate.sentBy()).toEqual({ person_tap: 1, legacy_reply: 0, protocol: 0 });
  });
});

describe("the key gate's door for a person", () => {
  test("a person's tap has no revision check and may press Escape", async () => {
    const mux = new Recorder();
    const gate = new KeyGate(mux, clock().now);
    gate.noteRead("%1");
    expect(await gate.press("%1", ["Escape"], "person_tap")).toEqual(muxAck());
    expect(await gate.press("%1", ["Enter"], "legacy_reply")).toEqual(muxAck());
    expect(mux.sent.map((s) => s.keys)).toEqual([["Escape"], ["Enter"]]);
    expect(gate.sentBy()).toEqual({ person_tap: 1, legacy_reply: 1, protocol: 0 });
  });

  test("a Stop's two-key Escape list (opencode needs Esc twice) passes the person's door in one call (M68 spec 01)", async () => {
    const mux = new Recorder();
    const gate = new KeyGate(mux, clock().now);
    gate.noteRead("%1");
    expect(await gate.press("%1", ["Escape", "Escape"], "person_tap")).toEqual(muxAck());
    expect(mux.sent).toEqual([{ paneId: "%1", keys: ["Escape", "Escape"] }]);
    expect(gate.sentBy()).toEqual({ person_tap: 1, legacy_reply: 0, protocol: 0 });
    // A protocol token still cannot carry Escape, one key or two.
    expect(() => gate.mint("%1", ["Escape", "Escape"], gate.revision("%1"))).toThrow();
  });

  test("Send now under a running turn: the queue's keys pass the person's door even after a protocol send queued", async () => {
    // A protocol send queued behind the turn (reads, a text write, its Enter token), then the person
    // taps Send now (`ChatWindow.sendQueuedNow`, ctrl+Enter on Claude Code). The door for a person
    // checks no revision and no Surface, so a running turn never refuses it.
    const time = clock();
    const mux = new Recorder();
    const gate = new KeyGate(mux, time.now);
    const read = gate.noteRead("%1");
    gate.noteWrite("%1");
    const token = gate.mint("%1", ["Enter"], gate.revision("%1"));
    expect(await gate.commit(token)).toEqual({ ok: true });
    expect(read).toBeLessThan(gate.revision("%1"));
    expect(await gate.press("%1", ["ctrl+Enter"], "person_tap")).toEqual(muxAck());
    expect(mux.sent.map((s) => s.keys)).toEqual([["Enter"], ["ctrl+Enter"]]);
    expect(gate.sentBy()).toEqual({ person_tap: 1, legacy_reply: 0, protocol: 1 });
  });

  test("the adapter's answer is handed back unchanged", async () => {
    const mux = new Recorder();
    mux.answer = muxRefused("pane is gone");
    expect(await new KeyGate(mux).press("%1", ["Enter"], "person_tap")).toEqual(muxRefused("pane is gone"));
  });

  test("gateFor gives one gate per adapter, so routes and the protocol share the counter", () => {
    const mux = new Recorder();
    expect(gateFor(mux)).toBe(gateFor(mux));
    expect(gateFor(mux)).not.toBe(gateFor(new Recorder()));
  });
});

describe("the key gate is the only key sender", () => {
  const root = join(import.meta.dirname, "..", "..");
  const grep = (pattern: string): string[] => {
    const run = spawnSync("git", ["grep", "--untracked", "-n", "-E", pattern, "--", "bridge/*.ts", "scripts/*.ts", "cli/*.ts"], { cwd: root, encoding: "utf8" });
    return run.stdout.split("\n").filter((line) => line.length > 0 && !/\.test\.ts:/u.test(line));
  };

  test("no file but the key gate names sendKeys( (the spec's grep)", () => {
    expect(grep("sendKeys\\(").filter((line) => line.startsWith("bridge/"))).toEqual([]);
  });

  test("outside the adapters, only the key gate and the two pass-through decorators call writeKeys", () => {
    const callers = grep("\\.writeKeys\\(")
      .map((line) => line.slice(0, line.indexOf(":")))
      // The adapters themselves, their fixtures and their conformance suite drive the raw call.
      .filter((file) => !file.startsWith("bridge/mux/") && file !== "scripts/mux-e2e.ts");
    expect([...new Set(callers)].toSorted()).toEqual(["bridge/beacon/decorate.ts", "bridge/beacon/hint.ts", "bridge/surface/key-gate.ts"]);
  });
});
