// Collie's own checks of the mod's pure half (M99 spec 02), run by `bun test inside/claude/`. The
// mod's engine tests are `tests/*.test.ts`, run by `claude plugin test inside/claude`.
import { describe, expect, test } from "bun:test";

import { MARKER_ENV_NAMES } from "../../bridge/beacon/env-markers.ts";
import { CAPABILITIES as WIRE_CAPABILITIES, ASK_KINDS as WIRE_ASKS, commandBody, parseHello, WIRE_VERSION as BRIDGE_WIRE } from "../../bridge/inside/wire.ts";
import {
  actionOf,
  answerResult,
  ASK_KINDS,
  askIdOf,
  CAPABILITIES,
  draftEvent,
  DRAFT_MAX,
  helloBody,
  isTargetFile,
  MARKER_NAMES,
  parseCommand,
  parseHelloAnswer,
  remember,
  rowEvent,
  seen,
  selfOfStat,
  socketOfTarget,
  TAKEN_KEEP,
  targetsDir,
  waitOf,
  WIRE_VERSION,
} from "./hooks/core.ts";

const PART = "p".repeat(22);

describe("the mod speaks the bridge's wire", () => {
  test("the same version, marker names, capability and ask words", () => {
    expect(WIRE_VERSION).toBe(BRIDGE_WIRE);
    expect(Array.from<string>(MARKER_NAMES)).toEqual(Array.from<string>(MARKER_ENV_NAMES));
    for (const word of CAPABILITIES) expect(WIRE_CAPABILITIES).toContain(word);
    for (const kind of ASK_KINDS) expect(WIRE_ASKS).toContain(kind);
    expect(CAPABILITIES).not.toContain("steer");
  });

  test("its hello parses on the bridge, with only the marker variables that hold a value", () => {
    const text = helloBody({
      harnessVersion: "2.1.323",
      partVersion: "1.29.0",
      session: "abc",
      cwd: "/home/a/p",
      pid: 4242,
      pidStartTime: 77,
      env: { HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/run/h.sock", TMUX: "", HOME: "/home/a" },
    });
    const parsed = parseHello(text);
    expect(parsed).toMatchObject({ ok: true, harness: "claude", pid: 4242, pidStartTime: 77, capabilities: ["send", "mail", "draft", "wake"], asks: ["permission"] });
    expect(JSON.parse(text).env).toEqual({ HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/run/h.sock" });
  });

  test("it reads back every command the bridge writes", () => {
    const commands = [
      { id: "req-12345678", kind: "prompt" as const, text: "hi" },
      { id: "req-12345678", kind: "mail" as const, text: "[walky-talky wt_1] hi" },
      { id: "req-12345678", kind: "answer" as const, ask: "perm-1-ab", decision: "deny" as const },
      { id: "req-12345678", kind: "draft" as const },
    ];
    for (const command of commands) expect(parseCommand(commandBody(command))).toEqual(command);
    for (const bad of ["", "{}", '{"wire":2,"id":"req-12345678","kind":"draft"}', '{"wire":1,"id":"x","kind":"draft"}', '{"wire":1,"id":"req-12345678","kind":"type"}']) {
      expect(parseCommand(bad)).toBeNull();
    }
  });
});

describe("finding the bridges", () => {
  test("the hook target folder follows XDG_STATE_HOME, else HOME", () => {
    expect(targetsDir("/home/a", undefined)).toBe("/home/a/.local/state/collie/hook-targets");
    expect(targetsDir("/home/a", "/x/state")).toBe("/x/state/collie/hook-targets");
    expect(targetsDir("/home/a", "relative")).toBe("/home/a/.local/state/collie/hook-targets");
    expect(targetsDir(undefined, undefined)).toBeNull();
  });

  test("a target file names a socket only for wire 1", () => {
    const base = { schemaVersion: 1, stateDir: "/s", pid: 1, pidStartTime: 1, bootedAt: 1 };
    expect(socketOfTarget(JSON.stringify({ ...base, inside: { wire: 1, socket: "/s/inside/sock" } }))).toBe("/s/inside/sock");
    expect(socketOfTarget(JSON.stringify(base))).toBeNull();
    expect(socketOfTarget(JSON.stringify({ ...base, inside: { wire: 2, socket: "/s/inside/sock" } }))).toBeNull();
    expect(socketOfTarget(JSON.stringify({ ...base, inside: { wire: 1, socket: "rel" } }))).toBeNull();
    expect(socketOfTarget("nope")).toBeNull();
    expect(isTargetFile("0123456789abcdef.json")).toBe(true);
    expect(isTargetFile(".1234.tmp")).toBe(false);
  });

  test("the pid and start time come from /proc/self/stat, past a name with spaces and brackets", () => {
    const fields = Array.from({ length: 50 }, (_, i) => String(i + 3));
    fields[19] = "987654";
    expect(selfOfStat(`4242 (my (odd) name) ${fields.join(" ")}`)).toEqual({ pid: 4242, start: 987654 });
    expect(selfOfStat("garbage")).toBeNull();
  });

  test("a hello answer: mine with a part id, not mine with a reason, anything else is no answer", () => {
    expect(parseHelloAnswer(200, JSON.stringify({ wire: 1, mine: true, part: PART }))).toEqual({ mine: true, part: PART });
    expect(parseHelloAnswer(200, JSON.stringify({ wire: 1, mine: false, reason: "no-pane" }))).toEqual({ mine: false, reason: "no-pane" });
    expect(parseHelloAnswer(400, "{}")).toBeNull();
    expect(parseHelloAnswer(200, JSON.stringify({ wire: 1, mine: true, part: "short" }))).toBeNull();
  });
});

describe("the door filter", () => {
  test("rows of the chat's doors wake; engine rows and subagent rows do not; no text ever", () => {
    for (const door of ["prompt", "command", "response", "tool-result", "delivery", "compaction"]) {
      expect(JSON.parse(rowEvent(PART, door, "u-1", undefined) ?? "null")).toEqual({ part: PART, kind: "row", door, row: "u-1" });
    }
    for (const door of ["attachment", "hook-context", "note", "notice", "queue", "tool-message"]) expect(rowEvent(PART, door, "u-1", undefined)).toBeNull();
    expect(rowEvent(PART, "response", "u-1", "agent-7")).toBeNull();
  });
});

describe("the command mapping", () => {
  test("a prompt and a mail are submitted as given; a draft reads the box; steer and a stray answer are refused", () => {
    expect(actionOf({ id: "req-12345678", kind: "prompt", text: "hi" })).toEqual({ do: "submit", text: "hi" });
    expect(actionOf({ id: "req-12345678", kind: "mail", text: "m" })).toEqual({ do: "submit", text: "m" });
    expect(actionOf({ id: "req-12345678", kind: "draft" })).toEqual({ do: "read-draft" });
    expect(actionOf({ id: "req-12345678", kind: "steer", text: "s" })).toEqual({ do: "refuse", reason: "unsupported" });
    expect(actionOf({ id: "req-12345678", kind: "answer", ask: "a", decision: "allow" })).toEqual({ do: "refuse", reason: "unexpected" });
  });

  test("a draft answer carries the box and its caret; past the cap it is a failure, never a cut", () => {
    expect(JSON.parse(draftEvent(PART, "req-12345678", { text: "abc", cursor: 2 }))).toEqual({ part: PART, kind: "draft", cmd: "req-12345678", text: "abc", caret: 2 });
    expect(JSON.parse(draftEvent(PART, "req-12345678", { text: "x".repeat(DRAFT_MAX + 1), cursor: 0 }))).toEqual({ part: PART, kind: "failed", cmd: "req-12345678", reason: "too-long" });
  });

  test("the ids acted on are remembered, newest kept, so a command acts once", () => {
    let taken: unknown;
    for (let i = 0; i < TAKEN_KEEP + 5; i += 1) taken = remember(taken, `req-${String(i).padStart(8, "0")}`);
    expect(seen(taken, `req-${String(TAKEN_KEEP + 4).padStart(8, "0")}`)).toBe(true);
    expect(seen(taken, "req-00000000")).toBe(false);
    expect(remember("not a list", "req-12345678")).toEqual(["req-12345678"]);
  });
});

describe("the permission answer", () => {
  test("the shape is the one the engine takes, the decision wrapper included", () => {
    expect(answerResult("allow")).toEqual({ decision: { behavior: "allow" } });
    expect(answerResult("deny")).toEqual({ decision: { behavior: "deny" } });
  });

  test("the bridge's wait verdict, capped at 15 minutes; anything else means do not wait", () => {
    expect(waitOf(200, '{"wait":true,"waitMs":60000}')).toBe(60_000);
    expect(waitOf(200, '{"wait":true,"waitMs":99999999}')).toBe(15 * 60_000);
    expect(waitOf(200, '{"wait":false}')).toBeNull();
    expect(waitOf(410, '{"wait":true,"waitMs":5}')).toBeNull();
  });

  test("an ask id is a wire id", () => {
    expect(askIdOf(1763000000000, "6f1c2b-x/y")).toMatch(/^perm-1763000000000-6f1c2bxy$/u);
  });
});
