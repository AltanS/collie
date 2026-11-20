// `POST /api/send` (M56 spec 05): the body check, the flag-off 404, the screenless refusal, the audit
// line with no text, and an answer through a real SendProtocol on a fake pane. The handler inside
// Bun.serve only gates and parses; `sendRoute` is everything after the gate.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "../audit.ts";
import { isRefusalReason, REFUSAL_REASONS } from "../refusal.ts";
import { parseJsonObject, type JsonValue } from "../../web/src/lib/json.ts";
import { muxAck, muxOk, type MuxAck, type MuxGrid, type MuxOutcome } from "../mux/types.ts";
import { ASK_OFF_TEXT, askRoute, paneTakesAskRoute, heldCancelRoute, parseSendRequest, REPLY_OFF_TEXT, replySendOf, replyThroughProtocol, SEND_MAX_TEXT, SEND_OFF_TEXT, sendReceiptsRoute, sendRoute, type AskRouteRuntime, type SendRouteRuntime } from "../server.ts";
import { readFileSync } from "node:fs";
import { parseAnsi } from "../../web/src/lib/ansi.ts";
import { splitLines } from "../../web/src/lib/blocks.ts";
import { parseAnswerBody } from "../../web/src/lib/surface/ask.ts";
import { liftDialog, readerBlocks } from "../../web/src/lib/surface/lift.ts";
import { AskAnswerer, AskBook } from "./ask.ts";
import { profileFor } from "../../web/src/lib/surface/profile.ts";
import { KeyGate } from "./key-gate.ts";
import { RowRing, SendProtocol, SessionLocks, type SendRequest } from "./protocol.ts";
import { RequestStore } from "./requests.ts";
import { HoldStore } from "./holds.ts";

const RULE = "─".repeat(40);

describe("parseSendRequest", () => {
  const good = { id: "route-req-0001", pane: "%1", text: "hello" };
  test("takes a well-formed body and defaults the mode to send", () => {
    expect(parseSendRequest(good)).toEqual({ ...good, mode: "send" });
    expect(parseSendRequest({ ...good, mode: "append", rowsHash: "0abc12", revision: 3 })).toEqual({ ...good, mode: "append", rowsHash: "0abc12", revision: 3 });
    expect(parseSendRequest({ ...good, text: "", mode: "prepare" })).toEqual({ ...good, text: "", mode: "prepare" });
  });

  test("takes the cap's extra confirm as a boolean, and refuses anything else (M56 spec 09)", () => {
    expect(parseSendRequest({ ...good, rowsHash: "0abc12", capAck: true })).toEqual({ ...good, mode: "send", rowsHash: "0abc12", capAck: true });
    expect(parseSendRequest({ ...good, capAck: false })).toEqual({ ...good, mode: "send", capAck: false });
    for (const bad of ["yes", 1, null, []]) {
      // SAFETY: each case is plain JSON data, a JsonValue.
      expect(parseSendRequest({ ...good, capAck: bad } as JsonValue)).toBeNull();
    }
  });

  test("takes secret only as true: a send into a sign-in field (M56, /login)", () => {
    expect(parseSendRequest({ ...good, secret: true })).toEqual({ ...good, mode: "send", secret: true });
    for (const bad of [false, "yes", 1, null]) {
      // SAFETY: each case is plain JSON data, a JsonValue.
      expect(parseSendRequest({ ...good, secret: bad } as JsonValue)).toBeNull();
    }
  });

  test("takes override only as true, and only with a rows hash on a plain send or command (M102 spec 01)", () => {
    const commit = { ...good, rowsHash: "0abc12" };
    expect(parseSendRequest({ ...commit, override: true })).toEqual({ ...commit, mode: "send", override: true });
    expect(parseSendRequest({ ...commit, mode: "command", override: true })).toEqual({ ...commit, mode: "command", override: true });
    for (const bad of [false, "yes", 1, null, []]) {
      // SAFETY: each case is plain JSON data, a JsonValue.
      expect(parseSendRequest({ ...commit, override: bad } as JsonValue)).toBeNull();
    }
    // No rows hash, a resend, a steer, a secret, or a staged mode: the shape of no commit tap at all.
    expect(parseSendRequest({ ...good, override: true })).toBeNull();
    expect(parseSendRequest({ ...commit, override: true, resendOf: "route-old-0001" })).toBeNull();
    expect(parseSendRequest({ ...commit, override: true, when: "steer" })).toBeNull();
    expect(parseSendRequest({ ...commit, override: true, secret: true })).toBeNull();
    for (const mode of ["append", "replace", "submit", "discard", "prepare"]) expect(parseSendRequest({ ...commit, override: true, mode })).toBeNull();
  });

  test("takes when: steer, refuses any other word, and never takes the caller's word for fromPhone (M69)", () => {
    expect(parseSendRequest({ ...good, when: "steer" })).toEqual({ ...good, mode: "send", when: "steer" });
    expect(parseSendRequest({ ...good, when: null })).toEqual({ ...good, mode: "send" });
    expect(parseSendRequest({ ...good, fromPhone: true })).toEqual({ ...good, mode: "send" });
    for (const bad of ["now", "Steer", 1, true, []]) {
      // SAFETY: each case is plain JSON data, a JsonValue.
      expect(parseSendRequest({ ...good, when: bad } as JsonValue)).toBeNull();
    }
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
    // %7 is the engine's bare shell pane: a shell prompt, which the blind road types into.
    readGrid: (paneId: string): Promise<MuxOutcome<MuxGrid>> => Promise.resolve(muxOk({ paneId, text: paneId === "%7" ? "$ ls\nnotes.txt\n$ " : render(), truncated: false, revision })),
    typeText: (_paneId: string, text: string): Promise<MuxAck> => {
      written.push(text);
      box += text;
      revision++;
      return Promise.resolve(muxAck());
    },
    writeKeys: (_paneId: string, keys: readonly string[]): Promise<MuxAck> => {
      for (const key of keys) {
        if (key === "Enter") box = "";
        else if (key === "Backspace") box = [...box].slice(0, -1).join("");
      }
      revision++;
      return Promise.resolve(muxAck());
    },
    /** A draft typed at the desk: the box as a person left it. */
    setBox: (text: string): void => {
      box = text;
      revision++;
    },
    box: (): string => box,
  };
}

function runtime(withSend: boolean, dir: string, holds?: HoldStore, status?: "idle" | "working" | "blocked" | "done" | "unknown") {
  const pane = idlePane();
  let clock = 0;
  const store = new RequestStore(join(dir, "sends"), () => clock);
  const send = withSend
    ? new SendProtocol({
        mux: pane,
        gate: new KeyGate(pane, () => clock),
        store,
        holds,
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
    current: () => ({ agents: [status === undefined ? { paneId: "%1", agent: "claude" } : { paneId: "%1", agent: "claude", status }], shellPanes: [{ paneId: "%7" }] }),
    noteInput: () => undefined,
    pokeNow: () => {
      pokes++;
    },
  };
  // The herdr stub has no `controlTurn`, so it is a screen pane.
  const rt: SendRouteRuntime = { send, engine, herdr: {}, name: "main" };
  return { rt, pane, store, pokes: () => pokes };
}

/** Every request the route hands the protocol, in order; the protocol still runs each one. */
function spyHandle(rt: SendRouteRuntime): SendRequest[] {
  const send = rt.send!;
  const seen: SendRequest[] = [];
  const handle = send.handle.bind(send);
  send.handle = (request, target) => {
    seen.push(request);
    return handle(request, target);
  };
  return seen;
}

function auditLines() {
  const lines: string[] = [];
  return { audit: new AuditLog((line) => void lines.push(line)), lines };
}

describe("sendRoute", () => {
  test("tells the Hill a send that spoke, and whether it started the next turn of a session that waited (M96 spec 10)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-route-"));
    try {
      for (const [status, started] of [
        ["idle", true],
        ["done", true],
        ["working", false],
        ["blocked", false],
        ["unknown", false],
        [undefined, false],
      ] as const) {
        const { rt } = runtime(true, join(dir, String(status)), undefined, status);
        const { audit } = auditLines();
        const told: Array<[string, boolean]> = [];
        const res = await sendRoute(rt, { id: `route-turn-${String(status).padEnd(4, "x").slice(0, 4)}`, pane: "%1", text: "go ahead" }, { audit, device: "phone", redact: false, acceptEncoding: null, spoke: (paneId, s) => void told.push([paneId, s]) });
        // SAFETY: the route answers the Send Protocol's answer as JSON; only `receipt.outcome` is read.
        const body = (await res.json()) as { receipt?: { outcome: string } };
        expect(body.receipt?.outcome).toBe("sent");
        expect(told).toEqual([["%1", started]]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("with the flag off the route is not there: a 404 that says why, and nothing is read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-route-"));
    try {
      const { rt, pane } = runtime(false, dir);
      const { audit, lines } = auditLines();
      const res = await sendRoute(rt, { id: "route-req-0001", pane: "%1", text: "hi there" }, { audit, device: null, redact: false, acceptEncoding: null });
      expect(res.status).toBe(404);
      expect(await res.text()).toBe(SEND_OFF_TEXT);
      expect(pane.written).toEqual([]);
      // Nothing is read; the refusal leaves its one record with the code (M102 spec 14).
      expect(lines.map((line) => JSON.parse(line).detail)).toEqual([{ by: "bridge", outcome: "refused", reason: "send_off" }]);
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

  test("a bare shell pane (the engine's shell panes, harness \"\") takes a send and a command blind: sent on the first tap (2026-10-17 field case)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-route-"));
    try {
      const { rt, pane, pokes } = runtime(true, dir);
      const { audit, lines } = auditLines();
      const context = { audit, device: "phone", redact: false, acceptEncoding: null };
      const sent = await (await sendRoute(rt, { id: "route-shell-0001", pane: "%7", text: "claude-danger" }, context)).json();
      expect(sent.receipt).toMatchObject({ outcome: "sent", harness: "", profileId: null, keys: ["Enter"], saw: { reason: "no-profile" } });
      expect(sent.offers).toEqual([]);
      const command = await (await sendRoute(rt, { id: "route-shell-0002", pane: "%7", text: "/usr/bin/true", mode: "command" }, context)).json();
      expect(command.receipt).toMatchObject({ outcome: "sent", keys: ["Enter"] });
      expect(pane.written).toEqual(["claude-danger", "/usr/bin/true"]);
      expect(lines).toHaveLength(2);
      for (const line of lines) {
        expect(line).toContain('"outcome":"sent"');
        expect(line).toContain('"probed":false');
      }
      expect(pokes()).toBe(2);
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

// M102 spec 14 (I3): a 400 or a 404 of the send and ask routes stored nothing, so a refused tap left no
// trace. Each now leaves one audit line with the code, the pane when the body names one, and no text.
describe("a refusal before the protocol leaves one record with its code", () => {
  const detailOf = (line: string) => parseJsonObject(line) ?? {};

  test("the send route: a bad body, an unknown pane, a screenless pane and a Resend of nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-route-"));
    try {
      const { rt } = runtime(true, dir);
      const { audit, lines } = auditLines();
      const context = { audit, device: "phone", redact: false, acceptEncoding: null };
      const cases: [SendRouteRuntime, JsonValue, number, string, string | undefined][] = [
        [rt, { id: "x", pane: "%1", text: "a secret word" }, 400, "bad_body", "%1"],
        [rt, { id: "route-rec-0001", pane: "%9", text: "a secret word" }, 404, "no_pane", "%9"],
        [{ ...rt, herdr: { controlTurn: () => Promise.reject(new Error("never called")) } }, { id: "route-rec-0002", pane: "%1", text: "a secret word" }, 409, "no_raw_input", "%1"],
        [rt, { id: "route-rec-0003", pane: "%1", text: "", resendOf: "route-rec-9999" }, 404, "no_held_send", "%1"],
        [{ ...rt, send: undefined }, { id: "route-rec-0004", pane: "%1", text: "a secret word" }, 404, "send_off", "%1"],
      ];
      for (const [runtimeOf, body, status, reason, paneId] of cases) {
        const before = lines.length;
        const res = await sendRoute(runtimeOf, body, context);
        expect(res.status).toBe(status);
        expect(res.headers.get("x-collie-reason")).toBe(reason);
        expect(res.headers.get("x-collie-by")).toBe("bridge");
        expect(lines.length - before).toBe(1);
        const line = detailOf(lines.at(-1)!);
        expect(line).toMatchObject({ action: "send", session: "main", device: "phone", detail: { by: "bridge", outcome: "refused", reason } });
        expect(line.paneId).toBe(paneId!);
        expect(lines.at(-1)).not.toContain("secret");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a terminal pane with an ask book marks askRoute; a program pane and a session with no ask book do not (decision 2)", () => {
    expect(paneTakesAskRoute({ asks: {} })).toBe(true);
    expect(paneTakesAskRoute({ asks: {}, driver: {} })).toBe(false);
    expect(paneTakesAskRoute({})).toBe(false);
  });

  test("every code a record writes is in the one exported list", () => {
    for (const reason of ["bad_body", "no_pane", "no_raw_input", "no_held_send", "send_off", "member_unreachable", "link_timeout", "foreign-mux", "no_markers"]) {
      expect(isRefusalReason(reason)).toBe(true);
    }
    expect(isRefusalReason("anything at all")).toBe(false);
    expect(new Set(REFUSAL_REASONS).size).toBe(REFUSAL_REASONS.length);
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

  test("a member's reply route binds Add to it and Replace to the draft the offer showed, as /api/send does (ADR 0166)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-route-"));
    try {
      const { rt, pane } = runtime(true, dir);
      const { audit } = auditLines();
      pane.setBox("half a thought");
      // The phone's first tap on a member's pane goes through the lead to this route, the body as the phone sent it.
      const offer = await (await replyThroughProtocol(replySendOf(rt), "%1", "main", { text: "new words", submit: true, id: "phone-req-0101" }, context(audit))).json();
      expect(offer).toMatchObject({ ok: false, send: { receipt: { outcome: "refused", reason: "draft_present" }, offers: ["append", "replace", "cancel"] } });
      expect(offer.send.rowsHash).toBeString();
      // The draft the offer is over comes with it, from the same read (Brief 6).
      expect(offer.send.draftText).toBe("half a thought");
      pane.setBox("a different draft");
      // The offer's draft was proven with one probe character and its Backspace; nothing is typed after it.
      const typed = pane.written.length;
      for (const [id, mode] of [["phone-req-0102", "replace"], ["phone-req-0103", "append"]] as const) {
        const again = await (await replyThroughProtocol(replySendOf(rt), "%1", "main", { text: "new words", submit: true, id, mode, rowsHash: offer.send.rowsHash }, context(audit))).json();
        expect(again, mode).toMatchObject({ ok: false, send: { receipt: { outcome: "refused", reason: "draft_present", keys: [] }, offers: ["append", "replace", "cancel"] } });
        expect(again.send.rowsHash, mode).not.toBe(offer.send.rowsHash);
        expect(again.send.draftText, mode).toBe("a different draft");
        expect(pane.written.slice(typed), mode).toEqual([]);
        expect(pane.box(), mode).toBe("a different draft");
      }
      const shown = await (await replyThroughProtocol(replySendOf(rt), "%1", "main", { text: "new words", submit: true, id: "phone-req-0104" }, context(audit))).json();
      const replaced = await (await replyThroughProtocol(replySendOf(rt), "%1", "main", { text: "new words", submit: true, id: "phone-req-0105", mode: "replace", rowsHash: shown.send.rowsHash }, context(audit))).json();
      expect(replaced).toMatchObject({ ok: true, send: { receipt: { outcome: "sent" } } });
      expect(pane.written.filter((text) => text === "new words")).toHaveLength(1);
      expect(pane.box()).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a member's offer quotes the draft masked, as the mirror is, and keeps it out of the audit line (Brief 6)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-route-"));
    try {
      const { rt, pane } = runtime(true, dir);
      const { audit, lines } = auditLines();
      // A shape the mask catches; a made-up value, not a real key.
      const key = `ghp_${"a1B2".repeat(9)}`;
      pane.setBox(`use ${key} here`);
      const masked = await (await replyThroughProtocol(replySendOf(rt), "%1", "main", { text: "new words", submit: true, id: "phone-req-0201" }, { audit, device: "phone", redact: true, acceptEncoding: null })).json();
      expect(masked.send.receipt).toMatchObject({ outcome: "refused", reason: "draft_present" });
      expect(masked.send.draftText).toStartWith("use ghp_");
      expect(masked.send.draftText).not.toContain(key);
      expect(lines.join("\n")).not.toContain("ghp_");
      expect(lines.join("\n")).not.toContain("use ");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a reply that names no request id is no phone's tap: an override in its body is dropped, never recorded (M102 spec 01)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-route-"));
    try {
      const { rt } = runtime(true, dir);
      const seen = spyHandle(rt);
      const { audit } = auditLines();
      await replyThroughProtocol(replySendOf(rt), "%1", "main", { text: "from an agent", submit: true, rowsHash: "0abc12", override: true }, context(audit));
      await replyThroughProtocol(replySendOf(rt), "%1", "main", { text: "from the phone", submit: true, id: "phone-req-0009", rowsHash: "0abc12", override: true }, context(audit));
      expect(seen.map((request) => [request.fromPhone, request.override])).toEqual([[undefined, undefined], [true, true]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a discard that emptied the box is ok true with the outcome discarded, audited as discarded and never as sent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-route-"));
    try {
      const { rt, pane } = runtime(true, dir);
      const { audit, lines } = auditLines();
      await pane.typeText("%1", "kept text");
      const res = await replyThroughProtocol(replySendOf(rt), "%1", "main", { text: "kept text", submit: true, mode: "discard", id: "phone-req-0003" }, context(audit));
      expect(await res.json()).toMatchObject({ ok: true, send: { receipt: { outcome: "discarded" } } });
      expect(lines[0]).toContain('"outcome":"discarded"');
      expect(lines[0]).not.toContain('"outcome":"sent"');
      expect(lines[0]).not.toContain("kept text");
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
      // A shell has no profile: the reply is typed and Entered blind, sent on the first tap.
      const shell = await (await replyThroughProtocol(replySendOf(rt), "%7", "main", { text: "ls -la", submit: true }, context(audit))).json();
      expect(shell).toMatchObject({ ok: true, send: { receipt: { outcome: "sent", profileId: null, keys: ["Enter"] }, offers: [] } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the reply route and /api/send set fromPhone; a body cannot (M69)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-route-"));
    try {
      const { rt } = runtime(true, dir);
      const seen = spyHandle(rt);
      const { audit } = auditLines();
      // /api/send is the phone's route: fromPhone, whatever the body says.
      await sendRoute(rt, { id: "route-phone-0001", pane: "%1", text: "from the phone", fromPhone: false }, context(audit));
      // The reply route with the phone's request id: fromPhone.
      await replyThroughProtocol(replySendOf(rt), "%1", "main", { text: "a reply with an id", submit: true, id: "route-phone-0002" }, context(audit));
      // The reply route with no id is not the phone: a body that says fromPhone does not make it so.
      await replyThroughProtocol(replySendOf(rt), "%1", "main", { text: "a reply with no id", submit: true, fromPhone: true }, context(audit));
      expect(seen.map((request) => [request.text, request.fromPhone])).toEqual([
        ["from the phone", true],
        ["a reply with an id", true],
        ["a reply with no id", undefined],
      ]);
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

describe("sendReceiptsRoute (M56 spec 09)", () => {
  test("with the flag off the route is a 404 that says why, and a call with no pane is a 400", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-route-"));
    try {
      const off = runtime(false, dir);
      const res = sendReceiptsRoute(off.rt, "%1", null);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe(SEND_OFF_TEXT);
      const on = runtime(true, dir);
      expect(sendReceiptsRoute(on.rt, null, null).status).toBe(400);
      expect(sendReceiptsRoute(on.rt, "", null).status).toBe(400);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("answers the pane's last ten receipts newest first, each with the line Sent would keep, and no rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-route-"));
    try {
      const { rt } = runtime(true, dir);
      const { audit } = auditLines();
      const context = { audit, device: null, redact: false, acceptEncoding: null };
      for (let n = 0; n < 12; n++) await sendRoute(rt, { id: `route-rcpt-${String(n).padStart(4, "0")}`, pane: "%1", text: `message number ${String(n)} is plain` }, context);
      const res = sendReceiptsRoute(rt, "%1", null);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.receipts).toHaveLength(10);
      expect(body.receipts[0]).toMatchObject({ requestId: "route-rcpt-0011", outcome: "sent", mode: "send", harness: "claude", keys: ["Enter"], line: "message number 11 is plain" });
      expect(Object.keys(body.receipts[0]).toSorted()).toEqual(["at", "gapsMs", "harness", "keys", "line", "mode", "outcome", "profileId", "profileStatus", "requestId", "version"]);
      const other = await sendReceiptsRoute(rt, "%9", null).json();
      expect(other.receipts).toEqual([]);
      // A text Sent's rule refuses is listed with no line at all, and nothing of it is in the body.
      await sendRoute(rt, { id: "route-rcpt-0012", pane: "%1", text: "the token is hunter2" }, context);
      const after = await sendReceiptsRoute(rt, "%1", null).json();
      expect(after.receipts[0]).toMatchObject({ requestId: "route-rcpt-0012", outcome: "sent" });
      expect(after.receipts[0].line).toBeUndefined();
      expect(JSON.stringify(after)).not.toMatch(/hunter2|token/u);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("sendReceiptsRoute: a refusal's line and Surface words (2026-10-17 field case)", () => {
  test("a refused send lists the detail and saw its answer had; a sent one lists neither", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-route-"));
    try {
      const { rt, pane } = runtime(true, dir);
      const { audit } = auditLines();
      const context = { audit, device: null, redact: false, acceptEncoding: null };
      await sendRoute(rt, { id: "route-ok-0001", pane: "%1", text: "a private first message" }, context);
      // Someone typed at the desk: the next send meets a draft and is refused.
      await pane.typeText("%1", "half a private thought");
      const res = await sendRoute(rt, { id: "route-no-0001", pane: "%1", text: "a private second message" }, context);
      const answer = await res.json();
      expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "draft_present" });
      expect(answer.receipt.detail).toEqual(expect.any(String));
      expect(answer.receipt.saw).toMatchObject({ composer: "draft" });
      const listed = await sendReceiptsRoute(rt, "%1", null).json();
      expect(listed.receipts[0]).toMatchObject({ requestId: "route-no-0001", outcome: "refused", detail: answer.receipt.detail, saw: answer.receipt.saw });
      expect(listed.receipts[1].requestId).toBe("route-ok-0001");
      expect(listed.receipts[1].detail).toBeUndefined();
      expect(listed.receipts[1].saw).toBeUndefined();
      // Both rows carry their own text as a line; the draft someone typed at the desk is a screen row and never listed.
      expect(listed.receipts[0].line).toBe("a private second message");
      expect(listed.receipts[1].line).toBe("a private first message");
      expect(JSON.stringify(listed)).not.toContain("half a private thought");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// `DELETE /api/send/<id>` (M56 spec 15): the Cancel on a queued row.
describe("heldCancelRoute (M56 spec 15)", () => {
  /** A held request on pane %1, as the protocol leaves one: the record held, the row on disk. */
  const seed = (store: RequestStore, holds: HoldStore, id: string): void => {
    const accepted = store.accept({ id, session: "main", paneId: "%1", paneGeneration: "gen", surfaceRevision: 0, mode: "send", text: "a private message" });
    const { reason: _crash, ...receipt } = SendProtocol.crashReceipt(accepted.record);
    store.hold(id, { ...receipt, outcome: "held" });
    holds.add({ id, session: "main", paneId: "%1", harness: "claude", mode: "send", text: "a private message", revision: 0, command: false });
  };

  test("flag off is a 404; a bad id or pane is a 400; a pane that holds no such request is a 404", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-route-"));
    try {
      const { audit } = auditLines();
      const context = { audit, device: null, acceptEncoding: null };
      const off = runtime(false, dir);
      expect(heldCancelRoute(off.rt, "route-held-0001", "%1", context).status).toBe(404);
      const holds = new HoldStore(join(dir, "held"));
      const { rt, store } = runtime(true, dir, holds);
      expect(heldCancelRoute(rt, "../x", "%1", context).status).toBe(400);
      expect(heldCancelRoute(rt, "route-held-0001", null, context).status).toBe(400);
      expect(heldCancelRoute(rt, "route-held-0001", "%1", context).status).toBe(404);
      seed(store, holds, "route-held-0001");
      expect(heldCancelRoute(rt, "route-held-0001", "%2", context).status).toBe(404);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a held request ends cancelled with its receipt, one audit line and never the text; a running one is a 409 busy; an ended one is dismissed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-route-"));
    try {
      const { audit, lines } = auditLines();
      const context = { audit, device: "phone", acceptEncoding: null };
      const holds = new HoldStore(join(dir, "held"));
      const { rt, store } = runtime(true, dir, holds);
      seed(store, holds, "route-held-0002");
      const res = heldCancelRoute(rt, "route-held-0002", "%1", context);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ result: "cancelled", receipt: { requestId: "route-held-0002", outcome: "cancelled" } });
      expect(holds.get("route-held-0002")).toBeNull();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("send-cancel");
      expect(lines.join("\n")).not.toMatch(/private/u);

      seed(store, holds, "route-held-0003");
      holds.markRunning("route-held-0003");
      const busy = heldCancelRoute(rt, "route-held-0003", "%1", context);
      expect(busy.status).toBe(409);
      expect(await busy.json()).toEqual({ result: "refused", reason: "busy" });

      seed(store, holds, "route-held-0004");
      holds.end("route-held-0004", "expired");
      expect(await heldCancelRoute(rt, "route-held-0004", "%1", context).json()).toEqual({ result: "dismissed" });
      expect(holds.get("route-held-0004")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a Resend through sendRoute (M56 spec 15 review, H7)", () => {
  test("resendOf sends the stored text of the ended row under the new id, and the old row goes; an unknown row is a 404", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-route-"));
    try {
      const { audit } = auditLines();
      const context = { audit, device: null, redact: true, acceptEncoding: null };
      const holds = new HoldStore(join(dir, "held"));
      const { rt, store } = runtime(true, dir, holds);
      const accepted = store.accept({ id: "route-res-0001", session: "main", paneId: "%1", paneGeneration: "gen", surfaceRevision: 0, mode: "send", text: "a name the mask would hide" });
      const { reason: _crash, ...receipt } = SendProtocol.crashReceipt(accepted.record);
      store.hold("route-res-0001", { ...receipt, outcome: "held" });
      holds.add({ id: "route-res-0001", session: "main", paneId: "%1", harness: "claude", mode: "send", text: "a name the mask would hide", revision: 0, command: false });
      holds.end("route-res-0001", "expired");
      expect((await sendRoute(rt, { id: "route-res-0002", pane: "%1", text: "", resendOf: "route-res-9999" }, context)).status).toBe(404);
      const res = await sendRoute(rt, { id: "route-res-0003", pane: "%1", text: "", resendOf: "route-res-0001" }, context);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ receipt: { requestId: "route-res-0003", outcome: "sent", textLength: "a name the mask would hide".length } });
      expect(holds.get("route-res-0001")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a Resend whose answer was lost answers its stored receipt on the retry, sends nothing twice, and an unknown id stays a 404", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-route-"));
    try {
      const { audit } = auditLines();
      const context = { audit, device: null, redact: true, acceptEncoding: null };
      const holds = new HoldStore(join(dir, "held"));
      const { rt, pane, store } = runtime(true, dir, holds);
      const accepted = store.accept({ id: "route-lost-0001", session: "main", paneId: "%1", paneGeneration: "gen", surfaceRevision: 0, mode: "send", text: "the words of the held send" });
      const { reason: _crash, ...receipt } = SendProtocol.crashReceipt(accepted.record);
      store.hold("route-lost-0001", { ...receipt, outcome: "held" });
      holds.add({ id: "route-lost-0001", session: "main", paneId: "%1", harness: "claude", mode: "send", text: "the words of the held send", revision: 0, command: false });
      holds.end("route-lost-0001", "expired");
      // The first try goes through and takes the old row away; its answer never reaches the phone.
      const first = await sendRoute(rt, { id: "route-lost-0002", pane: "%1", text: "", resendOf: "route-lost-0001" }, context);
      expect(first.status).toBe(200);
      const firstBody = await first.json();
      expect(firstBody).toMatchObject({ receipt: { requestId: "route-lost-0002", outcome: "sent" } });
      expect(holds.get("route-lost-0001")).toBeNull();
      expect(pane.written).toEqual(["the words of the held send"]);
      // The retry carries the same id: the stored receipt comes back, not a 404, and nothing is typed again.
      const retry = await sendRoute(rt, { id: "route-lost-0002", pane: "%1", text: "", resendOf: "route-lost-0001" }, context);
      expect(retry.status).toBe(200);
      const retryBody = await retry.json();
      expect(retryBody).toMatchObject({ replayed: true, receipt: { requestId: "route-lost-0002", outcome: "sent" } });
      expect(retryBody.receipt).toEqual(firstBody.receipt);
      expect(pane.written).toEqual(["the words of the held send"]);
      // A request id the store never saw, naming a row that is gone, is still a 404.
      expect((await sendRoute(rt, { id: "route-lost-0003", pane: "%1", text: "", resendOf: "route-lost-0001" }, context)).status).toBe(404);
      expect(pane.written).toEqual(["the words of the held send"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a Resend that asks to steer goes as a plain send: no when and no fromPhone reach the protocol (M69)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-route-"));
    try {
      const { audit } = auditLines();
      const context = { audit, device: null, redact: false, acceptEncoding: null };
      const holds = new HoldStore(join(dir, "held"));
      const { rt, store } = runtime(true, dir, holds);
      const seen = spyHandle(rt);
      const accepted = store.accept({ id: "route-res-0011", session: "main", paneId: "%1", paneGeneration: "gen", surfaceRevision: 0, mode: "send", text: "the held text" });
      const { reason: _crash, ...receipt } = SendProtocol.crashReceipt(accepted.record);
      store.hold("route-res-0011", { ...receipt, outcome: "held" });
      holds.add({ id: "route-res-0011", session: "main", paneId: "%1", harness: "claude", mode: "send", text: "the held text", revision: 0, command: false });
      holds.end("route-res-0011", "expired");
      const res = await sendRoute(rt, { id: "route-res-0012", pane: "%1", text: "", resendOf: "route-res-0011", when: "steer" }, context);
      expect(await res.json()).toMatchObject({ receipt: { requestId: "route-res-0012", outcome: "sent" } });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ id: "route-res-0012", text: "the held text", mode: "send" });
      expect(seen[0] && "when" in seen[0]).toBe(false);
      expect(seen[0] && "fromPhone" in seen[0]).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("parseSendRequest takes resendOf with an empty text, and refuses a resendOf that is not a request id or is the new id", () => {
    expect(parseSendRequest({ id: "route-res-0004", pane: "%1", text: "", resendOf: "route-res-0001" })).toMatchObject({ resendOf: "route-res-0001", text: "" });
    expect(parseSendRequest({ id: "route-res-0004", pane: "%1", text: "", resendOf: "../x" })).toBeNull();
    expect(parseSendRequest({ id: "route-res-0004", pane: "%1", text: "", resendOf: "route-res-0004" })).toBeNull();
    expect(parseSendRequest({ id: "route-res-0004", pane: "%1", text: "" })).toBeNull();
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
      log: () => undefined,
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
      // One record of the refusal, with its code and no text (M102 spec 14).
      expect(lines.map((line) => JSON.parse(line).detail)).toEqual([{ by: "bridge", outcome: "refused", reason: "send_off" }]);
      expect(res.headers.get("x-collie-reason")).toBe("send_off");
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
      // The 400 and the 404 above each left one record (M102 spec 14); then the answer's own line.
      expect(lines).toHaveLength(3);
      expect(lines[2]).toContain('"action":"ask"');
      expect(lines[2]).toContain('"optionId":"1"');
      expect(lines[2]).not.toContain("mkfifo");
      // The same answer again is the stored receipt: audited as a replay, and no key leaves.
      const again = await askRoute(rt, ask.id, { pane: "%1", hash: ask.hash, optionId: "1", origin: "person_tap" }, context);
      expect((await again.json()).replayed).toBe(true);
      expect(keys).toEqual(["1"]);
      expect(lines[3]).toContain('"replayed":true');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rule 6 of agent views (review 9 R3, ask door): an answer whose keys reached the pane is a person turn in its session; a replay is none", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-route-"));
    try {
      const { rt, poll } = askRuntime(dir);
      const ask = poll();
      const { audit } = auditLines();
      const turns: string[] = [];
      const context = { audit, device: "phone", redact: false, acceptEncoding: null, personTurn: (paneId: string) => turns.push(paneId) };
      expect((await askRoute(rt, ask.id, { pane: "%1", hash: ask.hash, optionId: "1", origin: "person_tap" }, context)).status).toBe(200);
      expect(turns).toEqual(["%1"]);
      await askRoute(rt, ask.id, { pane: "%1", hash: ask.hash, optionId: "1", origin: "person_tap" }, context);
      expect(turns).toEqual(["%1"]);
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
