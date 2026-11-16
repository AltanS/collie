import { describe, expect, test } from "bun:test";

import type { JsonObject } from "../../web/src/lib/json.ts";
import { MARKER_ENV_NAMES } from "../beacon/env-markers.ts";
import {
  ASK_INPUT_MAX,
  checkCommand,
  commandBody,
  COMMAND_TEXT_MAX,
  DRAFT_TEXT_MAX,
  FAIL_DETAIL_MAX,
  HELLO_MAX,
  NEXT_WAIT_MIN_MS,
  NEXT_WAIT_MS,
  parseEvent,
  parseHello,
  parseCommand,
  parseNextQuery,
  WIRE_VERSION,
} from "./wire.ts";

const PART = "p".repeat(22);
const hello = {
  wire: 1,
  harness: "claude",
  harnessVersion: "2.1.323",
  partVersion: "1.29.0",
  session: "0d0c5b3e-aaaa",
  cwd: "/home/a/project",
  pid: 4242,
  pidStartTime: 77,
  env: { HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/run/herdr.sock" },
  capabilities: ["send", "mail", "draft", "wake"],
  asks: ["permission"],
};

describe("parseHello", () => {
  test("a whole hello parses", () => {
    const parsed = parseHello(JSON.stringify(hello));
    expect(parsed).toMatchObject({ ok: true, wire: 1, harness: "claude", pid: 4242, pidStartTime: 77, capabilities: ["send", "mail", "draft", "wake"], asks: ["permission"] });
    expect(parsed.ok && parsed.env).toEqual(hello.env);
  });

  test("the optional fields may be absent or null", () => {
    const parsed = parseHello(JSON.stringify({ wire: 1, harness: "pi", pid: 9, session: null, pidStartTime: null }));
    expect(parsed).toMatchObject({ ok: true, harnessVersion: null, partVersion: null, session: null, cwd: null, pidStartTime: null, env: {}, capabilities: [], asks: [] });
  });

  test("unknown fields are ignored, unknown capabilities and ask kinds are dropped (fail closed)", () => {
    const parsed = parseHello(JSON.stringify({ ...hello, future: { x: 1 }, capabilities: ["send", "fly", "send", "type-keys"], asks: ["permission", "everything"] }));
    expect(parsed).toMatchObject({ ok: true, capabilities: ["send"], asks: ["permission"] });
  });

  test("only the marker table's variables are kept from env; nothing else crosses", () => {
    const parsed = parseHello(JSON.stringify({ ...hello, env: { ...hello.env, HOME: "/home/a", ANTHROPIC_API_KEY: "sk-ant-placeholder", TMUX_PANE: "%3" } }));
    expect(parsed.ok && Object.keys(parsed.env).toSorted()).toEqual(["HERDR_PANE_ID", "HERDR_SOCKET_PATH", "TMUX_PANE"]);
    expect(MARKER_ENV_NAMES).toContain("HC_TERMINAL_ID");
  });

  test("another wire version is refused and the bridge names its own", () => {
    const parsed = parseHello(JSON.stringify({ ...hello, wire: 2 }));
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toContain(`speaks ${String(WIRE_VERSION)}`);
  });

  test("bad input is refused, never thrown", () => {
    for (const text of ["", "not json", "[]", "null"]) expect(parseHello(text).ok).toBe(false);
    const bad: JsonObject[] = [
      { ...hello, wire: "1" },
      { ...hello, harness: "Claude Code" },
      { ...hello, harness: "" },
      { ...hello, pid: 0 },
      { ...hello, pid: 1.5 },
      { ...hello, pid: "4242" },
      { ...hello, pidStartTime: -1 },
      { ...hello, cwd: "relative/dir" },
      { ...hello, session: "x".repeat(200) },
      { ...hello, env: "HERDR_PANE_ID=w1" },
      { ...hello, env: { HERDR_PANE_ID: 7 } },
      { ...hello, env: { HERDR_PANE_ID: "x".repeat(2000) } },
      { ...hello, capabilities: "send" },
      { ...hello, capabilities: [1] },
      { ...hello, capabilities: Array.from({ length: 40 }, () => "send") },
    ];
    for (const body of bad) {
      const parsed = parseHello(JSON.stringify(body));
      expect(parsed.ok, JSON.stringify(body)).toBe(false);
    }
  });

  test("a hello past its size cap is refused before it is parsed", () => {
    const parsed = parseHello(JSON.stringify({ ...hello, pad: "x".repeat(HELLO_MAX) }));
    expect(parsed).toEqual({ ok: false, error: "too large" });
  });
});

describe("parseEvent", () => {
  const ok = (body: JsonObject): ReturnType<typeof parseEvent> => parseEvent(JSON.stringify({ part: PART, ...body }));

  test("every event kind parses", () => {
    expect(ok({ kind: "turn.start", turn: "t-1" })).toMatchObject({ ok: true, kind: "turn.start", turn: "t-1" });
    expect(ok({ kind: "turn.end", reason: "answer" })).toMatchObject({ ok: true, kind: "turn.end", turn: null, reason: "answer" });
    expect(ok({ kind: "row", door: "response", row: "6f1c-uuid" })).toMatchObject({ ok: true, kind: "row", door: "response", row: "6f1c-uuid" });
    expect(ok({ kind: "ask.open", ask: "a1", askKind: "permission", tool: "Bash", input: { command: "ls" } })).toMatchObject({
      ok: true,
      kind: "ask.open",
      askKind: "permission",
      tool: "Bash",
      input: { command: "ls" },
    });
    expect(ok({ kind: "ask.close", ask: "a1", how: "desk" })).toMatchObject({ ok: true, kind: "ask.close", how: "desk" });
    expect(ok({ kind: "taken", cmd: "req-12345678" })).toMatchObject({ ok: true, kind: "taken", cmd: "req-12345678" });
    expect(ok({ kind: "sent", cmd: "req-12345678" })).toMatchObject({ ok: true, kind: "sent" });
    expect(ok({ kind: "failed", cmd: "req-12345678", reason: "submit" })).toMatchObject({ ok: true, kind: "failed", reason: "submit", detail: null });
    expect(ok({ kind: "draft", cmd: "req-12345678", text: "half a thought", caret: 4 })).toMatchObject({ ok: true, kind: "draft", text: "half a thought", caret: 4 });
    expect(ok({ kind: "bye" })).toMatchObject({ ok: true, kind: "bye" });
  });

  test("a failed's detail is read leniently: one line, capped, and never the reason the word is refused for", () => {
    expect(ok({ kind: "failed", cmd: "req-12345678", reason: "dropped", detail: "blocked by a hook" })).toMatchObject({ kind: "failed", reason: "dropped", detail: "blocked by a hook" });
    expect(ok({ kind: "failed", cmd: "req-12345678", reason: "submit", detail: "TypeError:\n  two\u0000lines\u2028" })).toMatchObject({ detail: "TypeError: two lines" });
    expect(ok({ kind: "failed", cmd: "req-12345678", reason: "submit", detail: "a\u007fb\u009bc\u001b[31md" })).toMatchObject({ detail: "a b c [31md" });
    const long = ok({ kind: "failed", cmd: "req-12345678", reason: "submit", detail: "x".repeat(10_000) });
    expect(long.ok && long.kind === "failed" ? long.detail?.length : -1).toBe(FAIL_DETAIL_MAX);
    // Not a string, or nothing left: no detail, and the word still counts.
    expect(ok({ kind: "failed", cmd: "req-12345678", reason: "submit", detail: 42 })).toMatchObject({ kind: "failed", detail: null });
    expect(ok({ kind: "failed", cmd: "req-12345678", reason: "submit", detail: { a: 1 } })).toMatchObject({ kind: "failed", detail: null });
    expect(ok({ kind: "failed", cmd: "req-12345678", reason: "submit", detail: " \n " })).toMatchObject({ kind: "failed", detail: null });
  });

  test("draft.state carries a boolean only: a text a part sends with it is never kept", () => {
    const parsed = ok({ kind: "draft.state", present: true, text: "the person's half sentence" });
    expect(parsed).toEqual({ ok: true, part: PART, kind: "draft.state", present: true, seq: null });
    expect(JSON.stringify(parsed)).not.toContain("half sentence");
    expect(ok({ kind: "draft.state", present: false })).toEqual({ ok: true, part: PART, kind: "draft.state", present: false, seq: null });
    expect(ok({ kind: "draft.state" }).ok).toBe(false);
    for (const present of [null, "true", 1]) expect(ok({ kind: "draft.state", present }).ok).toBe(false);
  });

  test("a state word may carry its count (seq), a whole number from 0; an older part sends none", () => {
    expect(ok({ kind: "turn.start", turn: "t1", seq: 7 })).toMatchObject({ kind: "turn.start", seq: 7 });
    expect(ok({ kind: "turn.end", seq: 0 })).toMatchObject({ kind: "turn.end", seq: 0 });
    expect(ok({ kind: "draft.state", present: false, seq: 12 })).toMatchObject({ kind: "draft.state", seq: 12 });
    expect(ok({ kind: "turn.end" })).toMatchObject({ seq: null });
    for (const seq of [-1, 1.5, "3", true]) expect(ok({ kind: "turn.end", seq }).ok).toBe(false);
  });

  test("a hello may declare draft.state", () => {
    const parsed = parseHello(JSON.stringify({ ...hello, capabilities: ["mail", "draft.state", "wake"] }));
    expect(parsed.ok && parsed.capabilities).toEqual(["mail", "draft.state", "wake"]);
  });

  test("unknown fields are ignored; a row carries no text even when a part sends one", () => {
    const parsed = ok({ kind: "row", door: "prompt", text: "the whole prompt", extra: [1, 2] });
    expect(parsed).toEqual({ ok: true, part: PART, kind: "row", door: "prompt", row: null });
  });

  test("bad input is refused", () => {
    const bad: JsonObject[] = [
      { kind: "nope" },
      { kind: "row" },
      { kind: "row", door: "Response Rows" },
      { kind: "taken" },
      { kind: "taken", cmd: "short" },
      { kind: "taken", cmd: "../../etc" },
      { kind: "ask.open", ask: "a1" },
      { kind: "ask.open", ask: "a1", askKind: "everything" },
      { kind: "ask.open", ask: "a b", askKind: "permission" },
      { kind: "ask.open", ask: "a1", askKind: "permission", input: { blob: "x".repeat(ASK_INPUT_MAX) } },
      { kind: "draft", cmd: "req-12345678", text: "x".repeat(DRAFT_TEXT_MAX + 1) },
      { kind: "draft", cmd: "req-12345678", text: "abc", caret: 9 },
      { kind: "failed", cmd: "req-12345678", reason: "A Sentence." },
    ];
    for (const body of bad) expect(ok(body).ok, JSON.stringify(body).slice(0, 80)).toBe(false);
    expect(parseEvent(JSON.stringify({ kind: "bye" })).ok).toBe(false);
    expect(parseEvent(JSON.stringify({ part: "short", kind: "bye" })).ok).toBe(false);
    expect(parseEvent("{").ok).toBe(false);
  });
});

describe("parseNextQuery", () => {
  const url = (query: string): URL => new URL(`http://inside/v1/next?${query}`);

  test("the part, an ask filter and a wait clamped to the wire's limits", () => {
    expect(parseNextQuery(url(`part=${PART}`))).toEqual({ ok: true, part: PART, ask: null, waitMs: NEXT_WAIT_MS });
    expect(parseNextQuery(url(`part=${PART}&ask=a1&wait=5`))).toEqual({ ok: true, part: PART, ask: "a1", waitMs: NEXT_WAIT_MIN_MS });
    expect(parseNextQuery(url(`part=${PART}&wait=999999`))).toMatchObject({ waitMs: NEXT_WAIT_MS });
  });

  test("bad queries are refused", () => {
    for (const query of ["", "part=x", `part=${PART}&ask=a%20b`, `part=${PART}&wait=-1`, `part=${PART}&wait=1e9`]) expect(parseNextQuery(url(query)).ok).toBe(false);
  });
});

describe("commands", () => {
  test("checkCommand holds the id shape, the text limit and the decisions", () => {
    expect(checkCommand({ id: "req-12345678", kind: "prompt", text: "hi" })).toBeNull();
    expect(checkCommand({ id: "x", kind: "prompt", text: "hi" })).toBe("bad id");
    expect(checkCommand({ id: "req-12345678", kind: "mail", text: "" })).toBe("empty text");
    expect(checkCommand({ id: "req-12345678", kind: "prompt", text: "x".repeat(COMMAND_TEXT_MAX + 1) })).toBe("text too long");
    expect(checkCommand({ id: "req-12345678", kind: "answer", ask: "a1", decision: "allow" })).toBeNull();
    // SAFETY: a decision the type does not allow, as a caller with bad data would pass it.
    expect(checkCommand({ id: "req-12345678", kind: "answer", ask: "a1", decision: "maybe" as "allow" })).toBe("bad decision");
  });

  test("parseCommand reads back what commandBody wrote, and refuses anything else", () => {
    const commands = [
      { id: "req-12345678", kind: "prompt" as const, text: "hi" },
      { id: "req-12345678", kind: "mail" as const, text: "hi" },
      { id: "req-12345678", kind: "answer" as const, ask: "a1", decision: "allow" as const },
      { id: "req-12345678", kind: "draft" as const },
    ];
    for (const command of commands) expect(parseCommand(commandBody(command))).toEqual(command);
    for (const bad of [{ wire: 2, id: "req-12345678", kind: "draft" }, { wire: 1, id: "x", kind: "draft" }, { wire: 1, id: "req-12345678", kind: "type" }, { wire: 1, id: "req-12345678", kind: "prompt" }]) {
      expect(parseCommand(JSON.stringify(bad))).toMatchObject({ ok: false });
    }
  });

  test("a command's body carries the wire version", () => {
    expect(JSON.parse(commandBody({ id: "req-12345678", kind: "draft" }))).toEqual({ wire: 1, id: "req-12345678", kind: "draft" });
  });
});
