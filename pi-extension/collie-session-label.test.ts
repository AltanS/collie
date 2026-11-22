import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  activate,
  sessionFileOf,
  type ExtensionApi,
  type LabelledEvent,
  type LabelState,
  type SessionContext,
  type SessionEvent,
} from "./collie-session-label.ts";

// What the extension writes into the pane's herdr-core terminal, and when. The `hc` runner is a fake
// that records each argument list; the real one is `hc label <terminal> pi.session_file=<path>`.

type Handler = (event: SessionEvent, ctx: SessionContext | undefined) => Promise<void> | void;

/** A fake pi runtime: `emit` runs every handler of an event and waits for what they return, as pi does. */
function fakePi() {
  const handlers = new Map<LabelledEvent, Handler[]>();
  const pi: ExtensionApi = {
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  };
  const emit = async (event: LabelledEvent, ctx: SessionContext | undefined, payload: SessionEvent = {}) => {
    await Promise.all((handlers.get(event) ?? []).map((handler) => handler(payload, ctx)));
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

const session = (file: string | undefined, hasUI = true, mode: string | undefined = "tui"): SessionContext => ({
  hasUI,
  mode,
  sessionManager: { getSessionFile: () => file },
});

const A = resolve("/tmp/pi-sessions/-proj/2026-11-15T10-00-00-000Z_aaaa.jsonl");
const B = resolve("/tmp/pi-sessions/-proj/2026-11-15T11-00-00-000Z_bbbb.jsonl");
const C = resolve("/tmp/pi-sessions/-proj/2026-11-15T12-00-00-000Z_cccc.jsonl");
const D = resolve("/tmp/pi-sessions/-proj/2026-11-15T13-00-00-000Z_dddd.jsonl");
const set = (file: string) => `label t7 pi.session_file=${file}`;
const REMOVE = "label t7 pi.session_file=";

describe("the pi.session_file label", () => {
  test("outside herdr-core, and in a nested pi started from pi's bash tool, nothing is hooked", () => {
    for (const env of [{}, { HC_TERMINAL_ID: "" }, { HC_TERMINAL_ID: "t7", PI_SESSION_ID: "00000000-0000-0000-0000-000000000001" }]) {
      const runtime = fakePi();
      expect(activate(runtime.pi, env, recorder().run, new Map())).toBe(false);
      expect(runtime.handlers.size).toBe(0);
    }
  });

  test("startup, replacement runtimes (/new, /resume, /fork, /reload) and quit keep one label lifecycle", async () => {
    const hc = recorder();
    const env = { HC_TERMINAL_ID: "t7" };
    globalThis.__colliePiSessionLabel?.delete("t7");

    try {
      // Uses the default process-wide globalThis store across replacement runtimes.
      const first = fakePi();
      expect(activate(first.pi, env, hc.run)).toBe(true);
      await first.emit("session_start", session(A), { reason: "startup" });
      await first.emit("session_shutdown", session(A), { reason: "new" });

      const second = fakePi();
      activate(second.pi, env, hc.run);
      await second.emit("session_start", session(B), { reason: "new" });
      await second.emit("session_shutdown", session(B), { reason: "resume" });

      const third = fakePi();
      activate(third.pi, env, hc.run);
      await third.emit("session_start", session(C), { reason: "resume" });
      await third.emit("session_shutdown", session(C), { reason: "fork" });

      const fourth = fakePi();
      activate(fourth.pi, env, hc.run);
      await fourth.emit("session_start", session(D), { reason: "fork" });
      await fourth.emit("session_shutdown", session(D), { reason: "reload" });

      // Reload keeps the same file D; shared state avoids a redundant write until Ctrl+D quits.
      const fifth = fakePi();
      activate(fifth.pi, env, hc.run);
      await fifth.emit("session_start", session(D), { reason: "reload" });
      await fifth.emit("session_shutdown", session(D), { reason: "quit" });

      expect(hc.calls).toEqual([set(A), set(B), set(C), set(D), REMOVE]);
    } finally {
      globalThis.__colliePiSessionLabel?.delete("t7");
    }
  });

  test("an unchanged file writes nothing more; --no-session or a relative path removes the label", async () => {
    const shared = new Map<string, LabelState>();
    const runtime = fakePi();
    const hc = recorder();
    activate(runtime.pi, { HC_TERMINAL_ID: "t7" }, hc.run, shared);
    await runtime.emit("session_start", session(A), { reason: "startup" });
    await runtime.emit("agent_end", session(A));
    // Older pi without ctx.mode still counts when hasUI is true.
    await runtime.emit("agent_end", session(undefined, true, undefined));
    await runtime.emit("agent_end", session("relative/path.jsonl"));
    expect(hc.calls).toEqual([set(A), REMOVE]);
  });

  test("a failed write is tried again at agent_end, even for the same file", async () => {
    const runtime = fakePi();
    const hc = recorder([false]);
    activate(runtime.pi, { HC_TERMINAL_ID: "t7" }, hc.run, new Map());
    await runtime.emit("session_start", session(A), { reason: "startup" });
    await runtime.emit("agent_end", session(A));
    await runtime.emit("agent_end", session(A));
    expect(hc.calls).toEqual([set(A), set(A)]);
  });

  test("non-TUI modes (print, json, and rpc where hasUI is true) never touch the pane's label", async () => {
    const runtime = fakePi();
    const hc = recorder();
    activate(runtime.pi, { HC_TERMINAL_ID: "t7" }, hc.run, new Map());
    await runtime.emit("session_start", session(A, false, "print"), { reason: "startup" });
    await runtime.emit("session_start", session(A, true, "rpc"), { reason: "startup" });
    await runtime.emit("agent_end", session(B, true, "rpc"));
    await runtime.emit("session_shutdown", session(A, true, "rpc"), { reason: "quit" });
    await runtime.emit("session_start", undefined);
    expect(hc.calls).toEqual([]);
  });

  test("replacements during a slow write share one queue across runtimes and collapse to the newest file", async () => {
    const shared = new Map<string, LabelState>();
    const calls: string[] = [];
    const started = Promise.withResolvers<void>();
    const slow = Promise.withResolvers<boolean>();
    const run = (args: readonly string[]) => {
      calls.push(args.join(" "));
      if (calls.length > 1) return Promise.resolve(true);
      started.resolve();
      return slow.promise;
    };
    const r1 = fakePi();
    activate(r1.pi, { HC_TERMINAL_ID: "t7" }, run, shared);
    const first = r1.emit("session_start", session(A), { reason: "startup" });
    await started.promise;

    const r2 = fakePi();
    activate(r2.pi, { HC_TERMINAL_ID: "t7" }, run, shared);
    const second = r2.emit("session_start", session(B), { reason: "new" });

    const r3 = fakePi();
    activate(r3.pi, { HC_TERMINAL_ID: "t7" }, run, shared);
    const third = r3.emit("session_start", session(C), { reason: "new" });

    slow.resolve(true);
    await Promise.all([first, second, third]);
    expect(calls).toEqual([set(A), set(C)]);
  });

  test("quit resolves only once the label is removed, so pi waits for it before exiting", async () => {
    const runtime = fakePi();
    const slow = Promise.withResolvers<boolean>();
    activate(runtime.pi, { HC_TERMINAL_ID: "t7" }, () => slow.promise, new Map());
    let done = false;
    const shutdown = (async () => {
      await runtime.emit("session_shutdown", session(A), { reason: "quit" });
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
      mode: "tui",
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
