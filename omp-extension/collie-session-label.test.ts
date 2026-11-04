import { describe, expect, test } from "bun:test";

import { activate, sessionFileOf, type ExtensionApi, type SessionContext, type SessionEvent } from "./collie-session-label.ts";

// What the extension writes into the pane's herdr-core terminal, and when. The `hc` runner is a fake
// that records each argument list; the real one is `hc label <terminal> omp.session_file=<path>`.

type Handler = (event: SessionEvent, ctx: SessionContext | undefined) => void;

function fakeOmp() {
  const handlers = new Map<string, Handler[]>();
  const pi: ExtensionApi = {
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  };
  const emit = (event: string, ctx: SessionContext | undefined) => {
    for (const handler of handlers.get(event) ?? []) handler({}, ctx);
  };
  return { pi, handlers, emit };
}

function recorder() {
  const calls: string[][] = [];
  return { calls, run: async (args: readonly string[]) => void calls.push([...args]) };
}

const session = (file: string | undefined, hasUI = true): SessionContext => ({
  hasUI,
  sessionManager: { getSessionFile: () => file },
});

const A = "/home/dev/.omp/agent/sessions/-proj/2026-11-04T10-00-00-000Z_aaaa.jsonl";
const B = "/home/dev/.omp/agent/sessions/-proj/2026-11-04T11-00-00-000Z_bbbb.jsonl";
/** Let the extension's write queue run: each write is a few promise reactions, no timer involved. */
const settle = async () => {
  for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
};

describe("the omp.session_file label", () => {
  test("outside herdr-core, and in an omp started from another omp's shell, nothing is hooked", () => {
    for (const env of [{}, { HC_TERMINAL_ID: "" }, { HC_TERMINAL_ID: "t7", OMPCODE: "1" }]) {
      const omp = fakeOmp();
      expect(activate(omp.pi, env, recorder().run)).toBe(false);
      expect(omp.handlers.size).toBe(0);
    }
  });

  test("start names the session file, a switch renames it, and the end removes it", async () => {
    const omp = fakeOmp();
    const hc = recorder();
    expect(activate(omp.pi, { HC_TERMINAL_ID: "t7" }, hc.run)).toBe(true);
    omp.emit("session_start", session(A));
    omp.emit("session_switch", session(B));
    omp.emit("session_shutdown", session(B));
    await settle();
    expect(hc.calls).toEqual([
      ["label", "t7", `omp.session_file=${A}`],
      ["label", "t7", `omp.session_file=${B}`],
      ["label", "t7", "omp.session_file="],
    ]);
  });

  test("the same file twice writes once; a session with no file on disk removes the label", async () => {
    const omp = fakeOmp();
    const hc = recorder();
    activate(omp.pi, { HC_TERMINAL_ID: "t7" }, hc.run);
    omp.emit("session_start", session(A));
    omp.emit("session_switch", session(A));
    omp.emit("session_switch", session(undefined));
    omp.emit("session_switch", session("relative/path.jsonl"));
    await settle();
    expect(hc.calls).toEqual([
      ["label", "t7", `omp.session_file=${A}`],
      ["label", "t7", "omp.session_file="],
    ]);
  });

  test("a session with no UI (a subagent, a print run) never touches the pane's label", async () => {
    const omp = fakeOmp();
    const hc = recorder();
    activate(omp.pi, { HC_TERMINAL_ID: "t7" }, hc.run);
    omp.emit("session_start", session(A, false));
    omp.emit("session_shutdown", session(A, false));
    omp.emit("session_start", undefined);
    await settle();
    expect(hc.calls).toEqual([]);
  });

  test("each write waits for the one before it, so a slow hc cannot leave an older file behind", async () => {
    const omp = fakeOmp();
    const started: string[] = [];
    const finish: (() => void)[] = [];
    const run = (args: readonly string[]) => {
      started.push(args[2] ?? "");
      const { promise, resolve } = Promise.withResolvers<void>();
      finish.push(resolve);
      return promise;
    };
    activate(omp.pi, { HC_TERMINAL_ID: "t7" }, run);
    omp.emit("session_start", session(A));
    omp.emit("session_switch", session(B));
    await settle();
    expect(started).toEqual([`omp.session_file=${A}`]);
    finish[0]?.();
    await settle();
    expect(started).toEqual([`omp.session_file=${A}`, `omp.session_file=${B}`]);
  });

  test("a session manager that throws reads as no file", () => {
    const broken: SessionContext = {
      hasUI: true,
      sessionManager: {
        getSessionFile: () => {
          throw new Error("closed");
        },
      },
    };
    expect(sessionFileOf(broken)).toBe("");
    expect(sessionFileOf(session(A))).toBe(A);
  });
});
