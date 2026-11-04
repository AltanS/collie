import { describe, expect, test } from "bun:test";

import {
  activate,
  sessionFileOf,
  type ExtensionApi,
  type LabelledEvent,
  type SessionContext,
  type SessionEvent,
} from "./collie-session-label.ts";

// What the extension writes into the pane's herdr-core terminal, and when. The `hc` runner is a fake
// that records each argument list; the real one is `hc label <terminal> omp.session_file=<path>`.

type Handler = (event: SessionEvent, ctx: SessionContext | undefined) => Promise<void> | void;

/** A fake omp: `emit` runs every handler of an event and waits for what they return, as omp does. */
function fakeOmp() {
  const handlers = new Map<LabelledEvent, Handler[]>();
  const pi: ExtensionApi = {
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  };
  const emit = async (event: LabelledEvent, ctx: SessionContext | undefined) => {
    await Promise.all((handlers.get(event) ?? []).map((handler) => handler({}, ctx)));
  };
  return { pi, handlers, emit };
}

/** A runner that records each call and answers with the next outcome (success by default). */
function recorder(outcomes: boolean[] = []) {
  const calls: string[] = [];
  const run = async (args: readonly string[]) => {
    calls.push(args.join(" "));
    return outcomes.shift() ?? true;
  };
  return { calls, run };
}

const session = (file: string | undefined, hasUI = true): SessionContext => ({
  hasUI,
  sessionManager: { getSessionFile: () => file },
});

const A = "/home/dev/.omp/agent/sessions/-proj/2026-11-04T10-00-00-000Z_aaaa.jsonl";
const B = "/home/dev/.omp/agent/sessions/-proj/2026-11-04T11-00-00-000Z_bbbb.jsonl";
const C = "/home/dev/.omp/agent/sessions/-proj/2026-11-04T12-00-00-000Z_cccc.jsonl";
const set = (file: string) => `label t7 omp.session_file=${file}`;
const REMOVE = "label t7 omp.session_file=";

describe("the omp.session_file label", () => {
  test("outside herdr-core, and in an omp started from another omp's shell, nothing is hooked", () => {
    for (const env of [{}, { HC_TERMINAL_ID: "" }, { HC_TERMINAL_ID: "t7", OMPCODE: "1" }]) {
      const omp = fakeOmp();
      expect(activate(omp.pi, env, recorder().run)).toBe(false);
      expect(omp.handlers.size).toBe(0);
    }
  });

  test("start, switch and branch name the file, and the end removes it", async () => {
    const omp = fakeOmp();
    const hc = recorder();
    expect(activate(omp.pi, { HC_TERMINAL_ID: "t7" }, hc.run)).toBe(true);
    await omp.emit("session_start", session(A));
    await omp.emit("session_switch", session(B));
    await omp.emit("session_branch", session(C));
    await omp.emit("session_shutdown", session(C));
    expect(hc.calls).toEqual([set(A), set(B), set(C), REMOVE]);
  });

  test("an unchanged file writes nothing more; a session with no file on disk removes the label", async () => {
    const omp = fakeOmp();
    const hc = recorder();
    activate(omp.pi, { HC_TERMINAL_ID: "t7" }, hc.run);
    await omp.emit("session_start", session(A));
    await omp.emit("agent_end", session(A));
    await omp.emit("session_switch", session(undefined));
    await omp.emit("session_switch", session("relative/path.jsonl"));
    expect(hc.calls).toEqual([set(A), REMOVE]);
  });

  test("a file that moved without an event is caught at the end of the turn", async () => {
    const omp = fakeOmp();
    const hc = recorder();
    activate(omp.pi, { HC_TERMINAL_ID: "t7" }, hc.run);
    await omp.emit("session_start", session(A));
    await omp.emit("agent_end", session(B));
    expect(hc.calls).toEqual([set(A), set(B)]);
  });

  test("a failed write is tried again at the next event, even for the same file", async () => {
    const omp = fakeOmp();
    const hc = recorder([false]);
    activate(omp.pi, { HC_TERMINAL_ID: "t7" }, hc.run);
    await omp.emit("session_start", session(A));
    await omp.emit("agent_end", session(A));
    await omp.emit("agent_end", session(A));
    expect(hc.calls).toEqual([set(A), set(A)]);
  });

  test("a session with no UI (a subagent, a print run) never touches the pane's label", async () => {
    const omp = fakeOmp();
    const hc = recorder();
    activate(omp.pi, { HC_TERMINAL_ID: "t7" }, hc.run);
    await omp.emit("session_start", session(A, false));
    await omp.emit("agent_end", session(B, false));
    await omp.emit("session_shutdown", session(A, false));
    await omp.emit("session_start", undefined);
    expect(hc.calls).toEqual([]);
  });

  test("switches during a slow write collapse into one write of the newest file", async () => {
    const omp = fakeOmp();
    const calls: string[] = [];
    const started = Promise.withResolvers<void>();
    const slow = Promise.withResolvers<boolean>();
    // The first `hc` hangs until released; every later one answers at once.
    const run = (args: readonly string[]) => {
      calls.push(args.join(" "));
      if (calls.length > 1) return Promise.resolve(true);
      started.resolve();
      return slow.promise;
    };
    activate(omp.pi, { HC_TERMINAL_ID: "t7" }, run);
    const first = omp.emit("session_start", session(A));
    await started.promise;
    // A is being written; two more changes arrive before it returns.
    const rest = [omp.emit("session_switch", session(B)), omp.emit("session_branch", session(C))];
    slow.resolve(true);
    await Promise.all([first, ...rest]);
    expect(calls).toEqual([set(A), set(C)]);
  });

  test("the shutdown handler resolves only once the label is removed, so omp can wait for it", async () => {
    const omp = fakeOmp();
    const slow = Promise.withResolvers<boolean>();
    activate(omp.pi, { HC_TERMINAL_ID: "t7" }, () => slow.promise);
    let done = false;
    const shutdown = (async () => {
      await omp.emit("session_shutdown", session(A));
      done = true;
    })();
    await Promise.resolve();
    expect(done).toBe(false);
    slow.resolve(true);
    await shutdown;
    expect(done).toBe(true);
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
