// `POST /api/send` (M56 spec 05): the body check, the flag-off 404, the screenless refusal, the audit
// line with no text, and an answer through a real SendProtocol on a fake pane. The handler inside
// Bun.serve only gates and parses; `sendRoute` is everything after the gate.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "../audit.ts";
import type { JsonValue } from "../../web/src/lib/json.ts";
import { muxAck, muxOk, type MuxAck, type MuxGrid, type MuxOutcome } from "../mux/types.ts";
import { ASK_OFF_TEXT, askRoute, parseSendRequest, REPLY_OFF_TEXT, replySendOf, replyThroughProtocol, SEND_MAX_TEXT, SEND_OFF_TEXT, sendRoute, type AskRouteRuntime, type SendRouteRuntime } from "../server.ts";
import { readFileSync } from "node:fs";
import { parseAnsi } from "../../web/src/lib/ansi.ts";
import { splitLines } from "../../web/src/lib/blocks.ts";
import { parseAnswerBody } from "../../web/src/lib/surface/ask.ts";
import { liftDialog, readerBlocks } from "../../web/src/lib/surface/lift.ts";
import { AskAnswerer, AskBook } from "./ask.ts";
import { profileFor } from "../../web/src/lib/surface/profile.ts";
import { KeyGate } from "./key-gate.ts";
import { RowRing, SendProtocol, SessionLocks } from "./protocol.ts";
import { RequestStore } from "./requests.ts";

const RULE = "─".repeat(40);

describe("parseSendRequest", () => {
  const good = { id: "route-req-0001", pane: "%1", text: "hello" };
  test("takes a well-formed body and defaults the mode to send", () => {
    expect(parseSendRequest(good)).toEqual({ ...good, mode: "send" });
    expect(parseSendRequest({ ...good, mode: "append", rowsHash: "0abc12", revision: 3 })).toEqual({ ...good, mode: "append", rowsHash: "0abc12", revision: 3 });
    expect(parseSendRequest({ ...good, text: "", mode: "prepare" })).toEqual({ ...good, text: "", mode: "prepare" });
  });

  test("refuses every malformed field", () => {
    for (const bad of [
      null,
      "text",
      [],
      { ...good, id: "../x" },
      { ...good, id: "short" },
      { ...good, pane: "" },
      { ...good, text: 5 },
      { ...good, text: "   " },
      { ...good, text: "x".repeat(SEND_MAX_TEXT + 1) },
      { ...good, mode: "shout" },
      { ...good, rowsHash: "NOT-HEX" },
      { ...good, revision: -1 },
      { ...good, revision: 1.5 },
    ]) {
      // SAFETY: each case is plain JSON data (null, strings, arrays, objects of strings and numbers), a JsonValue.
      expect(parseSendRequest(bad as JsonValue)).toBeNull();
    }
  });
});

/** A pane that shows one idle box and takes text into it; Enter empties it. */
function idlePane() {
  let box = "";
  let revision = 1;
  const written: string[] = [];
  const render = (): string =>
    ["> earlier", "", RULE, box === "" ? "❯ \u001b[2mTry something\u001b[0m" : `❯ ${box}`, RULE, "  status row"].join("\n");
  return {
    written,
    readGrid: (paneId: string): Promise<MuxOutcome<MuxGrid>> => Promise.resolve(muxOk({ paneId, text: render(), truncated: false, revision })),
    typeText: (_paneId: string, text: string): Promise<MuxAck> => {
      written.push(text);
      box += text;
      revision++;
      return Promise.resolve(muxAck());
    },
    writeKeys: (_paneId: string, keys: readonly string[]): Promise<MuxAck> => {
      for (const key of keys) if (key === "Enter") box = "";
      revision++;
      return Promise.resolve(muxAck());
    },
  };
}

function runtime(withSend: boolean, dir: string) {
  const pane = idlePane();
  let clock = 0;
  const send = withSend
    ? new SendProtocol({
        mux: pane,
        gate: new KeyGate(pane, () => clock),
        store: new RequestStore(join(dir, "sends"), () => clock),
        locks: new SessionLocks(),
        ring: new RowRing(),
        profile: (harness) => Promise.resolve(profileFor(harness, "2.1.200", { log: () => undefined })),
        generation: () => "gen",
        now: () => clock,
        sleep: (ms) => {
          clock += ms;
          return Promise.resolve();
        },
      })
    : undefined;
  let pokes = 0;
  const engine = {
    current: () => ({ agents: [{ paneId: "%1", agent: "claude" }], shellPanes: [{ paneId: "%7" }] }),
    noteInput: () => undefined,
    pokeNow: () => {
      pokes++;
    },
  };
  // The herdr stub has no `controlTurn`, so it is a screen pane.
  const rt: SendRouteRuntime = { send, engine, herdr: {}, name: "main" };
  return { rt, pane, pokes: () => pokes };
}

function auditLines() {
  const lines: string[] = [];
  return { audit: new AuditLog((line) => void lines.push(line)), lines };
}

describe("sendRoute", () => {
  test("with the flag off the route is not there: a 404 that says why, and nothing is read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-route-"));
    try {
      const { rt, pane } = runtime(false, dir);
      const { audit, lines } = auditLines();
      const res = await sendRoute(rt, { id: "route-req-0001", pane: "%1", text: "hi there" }, { audit, device: null, redact: false, acceptEncoding: null });
      expect(res.status).toBe(404);
      expect(await res.text()).toBe(SEND_OFF_TEXT);
      expect(pane.written).toEqual([]);
      expect(lines).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a send on the flag answers 200 with the receipt, audits the outcome and never the text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-route-"));
    try {
      const { rt, pane, pokes } = runtime(true, dir);
      const { audit, lines } = auditLines();
      const res = await sendRoute(rt, { id: "route-req-0002", pane: "%1", text: "a secret-ish message" }, { audit, device: "phone", redact: false, acceptEncoding: null });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.receipt).toMatchObject({ requestId: "route-req-0002", outcome: "sent", session: "main", paneId: "%1" });
      expect(pane.written).toEqual(["a secret-ish message"]);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('"action":"send"');
      expect(lines[0]).toContain('"outcome":"sent"');
      expect(lines[0]).not.toContain("secret-ish");
      expect(pokes()).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a malformed body is a 400, an unknown pane a 404, and a screenless pane refuses it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-route-"));
    try {
      const { rt } = runtime(true, dir);
      const { audit } = auditLines();
      const context = { audit, device: null, redact: false, acceptEncoding: null };
      expect((await sendRoute(rt, { id: "x" }, context)).status).toBe(400);
      expect((await sendRoute(rt, { id: "route-req-0003", pane: "%9", text: "hi" }, context)).status).toBe(404);
      // A herdr stub with `controlTurn` is what makes a pane screenless for rawInputRefusal.
      const screenless: SendRouteRuntime = { ...rt, herdr: { controlTurn: () => Promise.reject(new Error("never called")) } };
      expect((await sendRoute(screenless, { id: "route-req-0004", pane: "%1", text: "hi" }, context)).status).toBe(409);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the reply route runs the protocol (M56 spec 06)", () => {
  const context = (audit: AuditLog) => ({ audit, device: "phone", redact: false, acceptEncoding: null });

  test("a reply that submits text is one protocol request: the old shape plus the answer, audited with no text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-route-"));
    try {
      const { rt, pane } = runtime(true, dir);
      const { audit, lines } = auditLines();
      const res = await replyThroughProtocol(replySendOf(rt), "%1", "main", { text: "a reply from a member's pane", submit: true }, context(audit));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ ok: true, send: { receipt: { outcome: "sent", keys: ["Enter"] } } });
      expect(body.send.receipt.requestId).toMatch(/^reply-/u);
      expect(pane.written).toEqual(["a reply from a member's pane"]);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('"action":"reply"');
      expect(lines[0]).not.toContain("member's pane");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the body may carry the phone's id, mode and rows hash, and a reserved lead becomes a command", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-route-"));
    try {
      const { rt, pane } = runtime(true, dir);
      const { audit } = auditLines();
      const named = await (await replyThroughProtocol(replySendOf(rt), "%1", "main", { text: "named request", submit: true, id: "phone-req-0001" }, context(audit))).json();
      expect(named.send.receipt.requestId).toBe("phone-req-0001");
      const command = await (await replyThroughProtocol(replySendOf(rt), "%1", "main", { text: "/compact", submit: true }, context(audit))).json();
      expect(command).toMatchObject({ ok: true, send: { receipt: { outcome: "sent" } } });
      expect(pane.written).toEqual(["named request", "/compact"]);
      const prepared = await (await replyThroughProtocol(replySendOf(rt), "%1", "main", { text: "", submit: true, mode: "prepare", id: "phone-req-0002" }, context(audit))).json();
      expect(prepared).toMatchObject({ ok: true, send: { offers: [], surface: { turn: "idle", modal: "none", composer: "empty" } } });
      expect((await replyThroughProtocol(replySendOf(rt), "%1", "main", { text: "x", submit: true, mode: "shout" }, context(audit))).status).toBe(400);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a refusal is ok false with the protocol's words, and nothing is typed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-route-"));
    try {
      const { rt, pane } = runtime(true, dir);
      const { audit } = auditLines();
      const res = await replyThroughProtocol(replySendOf(rt), "%1", "main", { text: "/compact", submit: true, mode: "send" }, context(audit));
      const body = await res.json();
      expect(body).toMatchObject({ ok: false, code: "reply.send_failed", textDelivered: false, send: { receipt: { outcome: "refused", reason: "reserved_lead" } } });
      expect(pane.written).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a bare shell pane is a terminal pane with no profile; an unknown pane is a 404", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-route-"));
    try {
      const { rt } = runtime(true, dir);
      expect(replySendOf(rt).harnessOf("%1")).toBe("claude");
      expect(replySendOf(rt).harnessOf("%7")).toBe("");
      expect(replySendOf(rt).harnessOf("%9")).toBeNull();
      const { audit } = auditLines();
      expect((await replyThroughProtocol(replySendOf(rt), "%9", "main", { text: "hi", submit: true }, context(audit))).status).toBe(404);
      // A shell has no profile: the first tap is refused unconfirmed and offers the commit tap.
      const shell = await (await replyThroughProtocol(replySendOf(rt), "%7", "main", { text: "ls -la", submit: true }, context(audit))).json();
      expect(shell.send).toMatchObject({ receipt: { outcome: "refused", reason: "unconfirmed", profileId: null }, offers: ["commit", "keys"] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("with the protocol off a submitting reply is refused 409 and nothing is typed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-route-"));
    try {
      const { rt, pane } = runtime(false, dir);
      const { audit, lines } = auditLines();
      const res = await replyThroughProtocol(replySendOf(rt), "%1", "main", { text: "hello", submit: true }, context(audit));
      expect(res.status).toBe(409);
      expect(await res.text()).toBe(REPLY_OFF_TEXT);
      expect(pane.written).toEqual([]);
      expect(lines).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// `POST /api/ask/<id>` (M56 spec 08): the body check, the 404 with the protocol off, the audit line
// with the option and the keys and never a label, and the mask on the new ask's labels.
describe("askRoute", () => {
  const BASH = readFileSync(join(import.meta.dir, "..", "..", "web", "src", "fixtures", "panes", "claude--permission-bash.txt"), "utf8");
  const EDIT = readFileSync(join(import.meta.dir, "..", "..", "web", "src", "fixtures", "panes", "claude--permission-edit.txt"), "utf8");

  function askRuntime(dir: string) {
    const screen = { text: BASH };
    const keys: string[] = [];
    const pane = {
      readGrid: (paneId: string): Promise<MuxOutcome<MuxGrid>> => Promise.resolve(muxOk({ paneId, text: screen.text, truncated: false, revision: 0 })),
      writeKeys: (_paneId: string, sent: readonly string[]): Promise<MuxAck> => {
        keys.push(...sent);
        screen.text = "> done";
        return Promise.resolve(muxAck());
      },
    };
    let clock = 0;
    const book = new AskBook(() => clock, "route-salt");
    const asks = new AskAnswerer({
      mux: pane,
      gate: new KeyGate(pane, () => clock),
      store: new RequestStore(join(dir, "sends"), () => clock),
      locks: new SessionLocks(),
      book,
      profile: (harness) => Promise.resolve(profileFor(harness, "2.1.200", { log: () => undefined })),
      generation: () => "gen",
      now: () => clock,
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
    });
    const engine = { current: () => ({ agents: [{ paneId: "%1", agent: "claude" }], shellPanes: [] }), noteInput: () => undefined, pokeNow: () => undefined };
    const rt: AskRouteRuntime = { asks, engine, herdr: {}, name: "main" };
    const poll = () => book.publish("%1", "gen", liftDialog(readerBlocks(splitLines(parseAnsi(screen.text)), "claude")))!;
    return { rt, keys, screen, poll };
  }

  test("parseAnswerBody takes the contract's Answer and refuses every malformed field", () => {
    const good = { pane: "%1", hash: "0abc12", optionId: "2", origin: "person_tap" };
    expect(parseAnswerBody("ask-0123456789abcd", good)).toEqual({ pane: "%1", askId: "ask-0123456789abcd", hash: "0abc12", optionId: "2", origin: "person_tap" });
    expect(parseAnswerBody("../etc", good)).toBeNull();
    for (const bad of [null, [], { ...good, pane: "" }, { ...good, hash: "XYZ" }, { ...good, optionId: "two" }, { ...good, origin: "protocol" }, { ...good, origin: undefined }]) {
      // SAFETY: each case is plain JSON data, a JsonValue.
      expect(parseAnswerBody("ask-0123456789abcd", bad as JsonValue)).toBeNull();
    }
  });

  test("with the protocol off the route is not there: a 404 that says why", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-route-"));
    try {
      const { rt } = askRuntime(dir);
      const { audit, lines } = auditLines();
      const off: AskRouteRuntime = { engine: rt.engine, herdr: {}, name: "main" };
      const res = await askRoute(off, "ask-0123456789abcd", { pane: "%1", hash: "00", optionId: "1", origin: "person_tap" }, { audit, device: null, redact: false, acceptEncoding: null });
      expect(res.status).toBe(404);
      expect(await res.text()).toBe(ASK_OFF_TEXT);
      expect(lines).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an answer is a 200 with the receipt, audited with the option and the keys and never a label", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-route-"));
    try {
      const { rt, keys, poll } = askRuntime(dir);
      const ask = poll();
      const { audit, lines } = auditLines();
      const context = { audit, device: "phone", redact: false, acceptEncoding: null };
      expect((await askRoute(rt, ask.id, { pane: "%1" }, context)).status).toBe(400);
      expect((await askRoute(rt, ask.id, { pane: "%9", hash: ask.hash, optionId: "1", origin: "person_tap" }, context)).status).toBe(404);
      const res = await askRoute(rt, ask.id, { pane: "%1", hash: ask.hash, optionId: "1", origin: "person_tap" }, context);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.receipt).toMatchObject({ askId: ask.id, outcome: "sent", keys: ["1"] });
      expect(keys).toEqual(["1"]);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('"action":"ask"');
      expect(lines[0]).toContain('"optionId":"1"');
      expect(lines[0]).not.toContain("mkfifo");
      // The same answer again is the stored receipt: audited as a replay, and no key leaves.
      const again = await askRoute(rt, ask.id, { pane: "%1", hash: ask.hash, optionId: "1", origin: "person_tap" }, context);
      expect((await again.json()).replayed).toBe(true);
      expect(keys).toEqual(["1"]);
      expect(lines[1]).toContain('"replayed":true');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a changed dialog answers the new ask, with its labels masked under the redact switch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-route-"));
    try {
      const { rt, keys, poll, screen } = askRuntime(dir);
      const ask = poll();
      // A label that holds something the mask takes: the reply must carry it masked, as the mirror does.
      screen.text = EDIT.replace("Yes, allow all edits during this session", "Yes, password=placeholder1");
      const { audit } = auditLines();
      const res = await askRoute(rt, ask.id, { pane: "%1", hash: ask.hash, optionId: "1", origin: "person_tap" }, { audit, device: null, redact: true, acceptEncoding: null });
      const body = await res.json();
      expect(body.receipt).toMatchObject({ outcome: "refused", reason: "ask_changed", keys: [] });
      expect(body.ask.id).not.toBe(ask.id);
      expect(JSON.stringify(body.ask)).not.toContain("placeholder1");
      expect(body.ask.options[1].label).toContain("password=");
      expect(keys).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
