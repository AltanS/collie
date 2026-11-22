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

type Handler = (event: SessionEvent | undefined, ctx: SessionContext | undefined) => Promise<void> | void;

/**
 * A fake pi runtime: `emit` runs every handler of an event and answers what they returned, as pi
 * sees it. Pi waits for a returned promise; the extension returns one only at a quit, so a test that
 * wants the write of a start or a turn waits for the state's queue with `idle`.
 */
function fakePi() {
  const handlers = new Map<LabelledEvent, Handler[]>();
  const pi: ExtensionApi = {
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  };
  const emit = (event: LabelledEvent, ctx: SessionContext | undefined, payload: SessionEvent | undefined = {}) =>
    (handlers.get(event) ?? []).map((handler) => handler(payload, ctx));
  return { pi, handlers, emit };
}

/** Waits until every write the terminal's queue holds has run. */
async function idle(store: Map<string, LabelState> | undefined, terminal = "t7"): Promise<void> {
  await store?.get(terminal)?.queue;
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
      first.emit("session_start", session(A), { reason: "startup" });
      await idle(globalThis.__colliePiSessionLabel);
      first.emit("session_shutdown", session(A), { reason: "new" });

      const second = fakePi();
      activate(second.pi, env, hc.run);
      second.emit("session_start", session(B), { reason: "new" });
      await idle(globalThis.__colliePiSessionLabel);
      second.emit("session_shutdown", session(B), { reason: "resume" });

      const third = fakePi();
      activate(third.pi, env, hc.run);
      third.emit("session_start", session(C), { reason: "resume" });
      await idle(globalThis.__colliePiSessionLabel);
      third.emit("session_shutdown", session(C), { reason: "fork" });

      const fourth = fakePi();
      activate(fourth.pi, env, hc.run);
      fourth.emit("session_start", session(D), { reason: "fork" });
      await idle(globalThis.__colliePiSessionLabel);
      fourth.emit("session_shutdown", session(D), { reason: "reload" });

      // Reload keeps the same file D; shared state avoids a redundant write until Ctrl+D quits.
      const fifth = fakePi();
      activate(fifth.pi, env, hc.run);
      fifth.emit("session_start", session(D), { reason: "reload" });
      await idle(globalThis.__colliePiSessionLabel);
      await Promise.all(fifth.emit("session_shutdown", session(D), { reason: "quit" }));

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
    runtime.emit("session_start", session(A), { reason: "startup" });
    await idle(shared);
    runtime.emit("agent_end", session(A));
    await idle(shared);
    // Older pi without ctx.mode still counts when hasUI is true.
    runtime.emit("agent_end", session(undefined, true, undefined));
    await idle(shared);
    runtime.emit("agent_end", session("relative/path.jsonl"));
    await idle(shared);
    expect(hc.calls).toEqual([set(A), REMOVE]);
  });

  test("a failed write is tried again at agent_end, even for the same file", async () => {
    const shared = new Map<string, LabelState>();
    const runtime = fakePi();
    const hc = recorder([false]);
    activate(runtime.pi, { HC_TERMINAL_ID: "t7" }, hc.run, shared);
    runtime.emit("session_start", session(A), { reason: "startup" });
    await idle(shared);
    runtime.emit("agent_end", session(A));
    await idle(shared);
    runtime.emit("agent_end", session(A));
    await idle(shared);
    expect(hc.calls).toEqual([set(A), set(A)]);
  });

  test("non-TUI modes (print, json, and rpc where hasUI is true) never touch the pane's label", async () => {
    const shared = new Map<string, LabelState>();
    const runtime = fakePi();
    const hc = recorder();
    activate(runtime.pi, { HC_TERMINAL_ID: "t7" }, hc.run, shared);
    runtime.emit("session_start", session(A, false, "print"), { reason: "startup" });
    runtime.emit("session_start", session(A, true, "rpc"), { reason: "startup" });
    runtime.emit("agent_end", session(B, true, "rpc"));
    await Promise.all(runtime.emit("session_shutdown", session(A, true, "rpc"), { reason: "quit" }));
    runtime.emit("session_start", undefined);
    await idle(shared);
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
    r1.emit("session_start", session(A), { reason: "startup" });
    await started.promise;

    const r2 = fakePi();
    activate(r2.pi, { HC_TERMINAL_ID: "t7" }, run, shared);
    r2.emit("session_start", session(B), { reason: "new" });

    const r3 = fakePi();
    activate(r3.pi, { HC_TERMINAL_ID: "t7" }, run, shared);
    r3.emit("session_start", session(C), { reason: "new" });

    slow.resolve(true);
    await idle(shared);
    expect(calls).toEqual([set(A), set(C)]);
  });

  test("quit resolves only once the label is removed, so pi waits for it before exiting", async () => {
    const shared = new Map<string, LabelState>();
    const runtime = fakePi();
    const slow = Promise.withResolvers<boolean>();
    const calls: string[] = [];
    const started = Promise.withResolvers<void>();
    activate(runtime.pi, { HC_TERMINAL_ID: "t7" }, (args) => {
      calls.push(args.join(" "));
      if (calls.length > 1) return Promise.resolve(true);
      started.resolve();
      return slow.promise;
    }, shared);
    runtime.emit("session_start", session(A), { reason: "startup" });
    await started.promise;
    const returned = runtime.emit("session_shutdown", session(A), { reason: "quit" });
    expect(returned).toHaveLength(1);
    let done = false;
    const shutdown = (async () => {
      await Promise.all(returned);
      done = true;
    })();
    await Promise.resolve();
    expect(done).toBe(false);
    slow.resolve(true);
    await shutdown;
    expect(done).toBe(true);
    expect(calls).toEqual([set(A), REMOVE]);
  });

  test("session_start and agent_end return undefined at once, while the write is still pending", async () => {
    const shared = new Map<string, LabelState>();
    const runtime = fakePi();
    const slow = Promise.withResolvers<boolean>();
    activate(runtime.pi, { HC_TERMINAL_ID: "t7" }, () => slow.promise, shared);
    expect(runtime.emit("session_start", session(A), { reason: "startup" })).toEqual([undefined]);
    expect(runtime.emit("agent_end", session(A))).toEqual([undefined]);
    expect(runtime.emit("session_shutdown", session(A), { reason: "reload" })).toEqual([undefined]);
    slow.resolve(true);
    await idle(shared);
  });

  test("a runner that throws, or rejects, counts as not written and never rejects a handler; the next event writes", async () => {
    for (const fail of [
      () => {
        throw new Error("spawn failed");
      },
      () => Promise.reject(new Error("hc failed")),
    ]) {
      const shared = new Map<string, LabelState>();
      const runtime = fakePi();
      const calls: string[] = [];
      let first = true;
      activate(runtime.pi, { HC_TERMINAL_ID: "t7" }, (args) => {
        calls.push(args.join(" "));
        if (!first) return Promise.resolve(true);
        first = false;
        return fail();
      }, shared);
      expect(runtime.emit("session_start", session(A), { reason: "startup" })).toEqual([undefined]);
      await idle(shared);
      runtime.emit("agent_end", session(A));
      await idle(shared);
      expect(calls).toEqual([set(A), set(A)]);
      expect(shared.get("t7")?.written).toBe(A);
    }
  });

  test("quit clears a written label even when ctx is undefined or torn down", async () => {
    const tornDown: SessionContext = {
      get hasUI(): boolean {
        throw new Error("torn down");
      },
    };
    for (const ctx of [undefined, tornDown]) {
      const shared = new Map<string, LabelState>();
      const runtime = fakePi();
      const hc = recorder();
      activate(runtime.pi, { HC_TERMINAL_ID: "t7" }, hc.run, shared);
      runtime.emit("session_start", session(A), { reason: "startup" });
      await idle(shared);
      await Promise.all(runtime.emit("session_shutdown", ctx, { reason: "quit" }));
      expect(hc.calls).toEqual([set(A), REMOVE]);
    }
  });

  test("quit in a process that never wrote calls nothing, and a missing event is ignored", async () => {
    const shared = new Map<string, LabelState>();
    const runtime = fakePi();
    const hc = recorder();
    activate(runtime.pi, { HC_TERMINAL_ID: "t7" }, hc.run, shared);
    await Promise.all(runtime.emit("session_shutdown", session(A), { reason: "quit" }));
    await Promise.all(runtime.emit("session_shutdown", undefined, undefined));
    runtime.emit("session_start", undefined, undefined);
    await idle(shared);
    expect(hc.calls).toEqual([]);
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
