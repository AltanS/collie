import { describe, expect, test } from "bun:test";

import type { ChatStatus } from "@web/lib/chat-window";

import { createGate, NO_RECORD, readGate, type GateInput } from "./pane-start";

const LIVE: ChatStatus = { kind: "live" };
const EMPTY: ChatStatus = { kind: "empty" };
const NO_LOG: ChatStatus = { kind: "unavailable", reason: "no-log" };
const NO_SESSION: ChatStatus = { kind: "unavailable", reason: "no-session" };
const DISABLED: ChatStatus = { kind: "unavailable", reason: "disabled" };
const STALE: ChatStatus = { kind: "stale" };

function input(over: Partial<GateInput>): GateInput {
  return {
    paneId: "w1:p1",
    harness: "claude",
    isShell: false,
    status: "idle",
    hasSession: true,
    chatChosen: true,
    sessionLog: true,
    chat: LIVE,
    asked: 1,
    answered: 1,
    ...over,
  };
}

// One row per rule of web/src/lib/chat-gate.ts `paneBody`, fed through the ported start record.
const TABLE: { name: string; in: Partial<GateInput>; body: "chat" | "start" | "terminal" }[] = [
  { name: "rule 1: device chose Terminal", in: { chatChosen: false }, body: "terminal" },
  { name: "rule 1: a bare shell", in: { isShell: true, harness: "" }, body: "terminal" },
  { name: "rule 1: multiplexer names no session", in: { sessionLog: false }, body: "terminal" },
  { name: "rule 1: reading switched off", in: { chat: DISABLED }, body: "terminal" },
  { name: "rule 1: member too old (404)", in: { chat: STALE }, body: "terminal" },
  { name: "rule 2: session and a readable log", in: {}, body: "chat" },
  { name: "rule 2: session, not asked yet", in: { chat: EMPTY }, body: "chat" },
  { name: "rule 3: missing log on an old idle claude pane", in: { chat: NO_LOG }, body: "terminal" },
  { name: "rule 3: no session on an old idle claude pane", in: { hasSession: false, chat: NO_SESSION }, body: "terminal" },
  { name: "rule 6: fresh codex pane before its first prompt", in: { harness: "codex", hasSession: false, chat: NO_SESSION }, body: "start" },
  { name: "rule 6: fresh pi pane before its first reply", in: { harness: "pi", chat: NO_LOG }, body: "start" },
  { name: "rule 4: blocked fresh codex pane", in: { harness: "codex", hasSession: false, chat: NO_SESSION, status: "blocked" }, body: "terminal" },
];

describe("gate rule table", () => {
  for (const row of TABLE) {
    test(row.name, () => {
      expect(readGate(NO_RECORD, input(row.in)).reading.body).toBe(row.body);
    });
  }

  test("rule 5: a fresh pane that ended without a session falls back to the terminal", () => {
    let record = readGate(NO_RECORD, input({ harness: "codex", hasSession: false, chat: NO_SESSION })).record;
    record = readGate(record, input({ harness: "codex", hasSession: false, chat: NO_SESSION, status: "working" })).record;
    const ended = readGate(record, input({ harness: "codex", hasSession: false, chat: NO_SESSION, status: "done", asked: 4 }));
    expect(ended.reading.body).toBe("terminal");
  });

  test("rule 5: ended with a session but no log yet stays on start until a later read settles", () => {
    const pi = { harness: "pi", chat: NO_LOG };
    let record = readGate(NO_RECORD, input(pi)).record;
    record = readGate(record, input({ ...pi, status: "working" })).record;
    const ended = readGate(record, input({ ...pi, status: "done", asked: 5, answered: 5 }));
    expect(ended.reading.body).toBe("start");
    const settled = readGate(ended.record, input({ ...pi, status: "done", asked: 6, answered: 6 }));
    expect(settled.reading.body).toBe("terminal");
  });

  test("the chat window is fetched only when chosen and the harness can draw it", () => {
    expect(readGate(NO_RECORD, input({})).reading.fetch).toBe(true);
    expect(readGate(NO_RECORD, input({ chatChosen: false })).reading.fetch).toBe(false);
    expect(readGate(NO_RECORD, input({ isShell: true, harness: "" })).reading.fetch).toBe(false);
  });
});

describe("createGate", () => {
  test("the last resort turns a working pane with no journal into the terminal", async () => {
    let woke = 0;
    const ctl = new AbortController();
    const gate = createGate(() => woke++, ctl.signal, 10);
    const fresh = { harness: "pi", chat: NO_LOG };
    expect(gate.read(input(fresh)).body).toBe("start");
    expect(gate.read(input({ ...fresh, status: "working" })).body).toBe("start");
    await new Promise((r) => setTimeout(r, 30));
    expect(woke).toBe(1);
    expect(gate.read(input({ ...fresh, status: "working" })).body).toBe("terminal");
    ctl.abort();
  });

  test("markSent counts as work on an agent pane", () => {
    const ctl = new AbortController();
    const gate = createGate(() => {}, ctl.signal);
    gate.read(input({ harness: "codex", hasSession: false, chat: NO_SESSION }));
    gate.markSent();
    expect(gate.record.sent).toBe(true);
    ctl.abort();
  });
});
