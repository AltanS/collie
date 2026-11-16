import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";

import type { AccountStatusRun } from "./account-adapters.ts";
import { AccountIdentities, settledWithin, statusRunner, type StatusSpawn } from "./account-identity.ts";

// The runner of an agent's status command (M101 spec 04), with a fake child: no test starts a process.

/** A child the test drives: it prints, exits, or never does. */
class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  killed: NodeJS.Signals | null = null;
  kill(signal: NodeJS.Signals): boolean {
    this.killed = signal;
    // A killed child closes with no code, as node reports a signal.
    queueMicrotask(() => this.emit("close", null));
    return true;
  }
}

function fakeSpawn(script: (child: FakeChild) => void) {
  const calls: { file: string; args: readonly string[]; options: Parameters<StatusSpawn>[2] }[] = [];
  const children: FakeChild[] = [];
  const spawn: StatusSpawn = (file, args, options) => {
    calls.push({ file, args, options });
    const child = new FakeChild();
    children.push(child);
    queueMicrotask(() => script(child));
    return child;
  };
  return { spawn, calls, children };
}

const ASK = { binary: "claude", args: ["auth", "status"], env: { HOME: "/home/you", CLAUDE_CONFIG_DIR: "/home/you/.claude-work" } } as const;

describe("statusRunner", () => {
  test("runs the located binary with the fixed words, no shell, stdin closed, and the given environment", async () => {
    const fake = fakeSpawn((c) => {
      c.stdout.emit("data", Buffer.from('{"loggedIn":true}'));
      c.emit("close", 0);
    });
    const run = statusRunner({ locate: async (b) => `/opt/bin/${b}`, spawn: fake.spawn });
    expect(await run(ASK)).toEqual({ code: 0, stdout: '{"loggedIn":true}', stderr: "" });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.file).toBe("/opt/bin/claude");
    expect(fake.calls[0]?.args).toEqual(["auth", "status"]);
    expect(fake.calls[0]?.options).toEqual({ shell: false, stdio: ["ignore", "pipe", "pipe"], env: { HOME: "/home/you", CLAUDE_CONFIG_DIR: "/home/you/.claude-work" }, windowsHide: true });
  });

  test("a binary that is not on this machine starts nothing", async () => {
    const fake = fakeSpawn(() => {});
    expect(await statusRunner({ locate: async () => null, spawn: fake.spawn })(ASK)).toBeNull();
    expect(fake.calls).toHaveLength(0);
  });

  test("a spawn that throws, or a child that errors, is no answer", async () => {
    const throws: StatusSpawn = () => {
      throw new Error("ENOENT");
    };
    expect(await statusRunner({ locate: async (b) => b, spawn: throws })(ASK)).toBeNull();
    const fake = fakeSpawn((c) => c.emit("error", new Error("EACCES")));
    expect(await statusRunner({ locate: async (b) => b, spawn: fake.spawn })(ASK)).toBeNull();
  });

  test("a run past the timeout is killed and is no answer", async () => {
    const fake = fakeSpawn(() => {});
    const answer = await statusRunner({ locate: async (b) => b, spawn: fake.spawn, timeoutMs: 20 })(ASK);
    expect(answer).toBeNull();
    expect(fake.children[0]?.killed).toBe("SIGKILL");
  });

  test("output over the cap, both streams together, is killed and is no answer", async () => {
    const fake = fakeSpawn((c) => {
      c.stdout.emit("data", Buffer.alloc(10, 0x61));
      c.stderr.emit("data", Buffer.alloc(10, 0x62));
      c.emit("close", 0);
    });
    expect(await statusRunner({ locate: async (b) => b, spawn: fake.spawn, capBytes: 16 })(ASK)).toBeNull();
    expect(fake.children[0]?.killed).toBe("SIGKILL");
  });
});

describe("AccountIdentities", () => {
  const KEY = "claude\u0000/home/you/.claude-work";
  const parse = (run: AccountStatusRun) => (run.stdout === "garbage" ? null : { signedIn: true, email: run.stdout });

  /** A cache over a run the test holds open and answers by hand. */
  function rig() {
    let now = 1_000;
    let runs = 0;
    let email = "first@example.com";
    let hold = false;
    const waiting: (() => void)[] = [];
    const ids = new AccountIdentities({
      now: () => now,
      run: async () => {
        runs += 1;
        // The answer is the one current when the run ends, so a test can change it while a run is held.
        if (hold) {
          await new Promise<void>((r) => {
            waiting.push(() => r());
          });
        }
        return { code: 0, stdout: email, stderr: "" };
      },
    });
    const ask = (maxAge = 60_000) => ids.read({ key: KEY, binary: "claude", args: ["auth", "status"], env: {}, parse, maxAge });
    return {
      ids,
      ask,
      runs: () => runs,
      advance: (ms: number) => (now += ms),
      answer: (next: string) => (email = next),
      hold: (on: boolean) => (hold = on),
      release: () => {
        for (const go of waiting.splice(0)) go();
      },
    };
  }

  test("a first read waits for its run; a fresh answer is served with no run", async () => {
    const r = rig();
    expect(await r.ask()).toEqual({ signedIn: true, email: "first@example.com" });
    r.advance(59_000);
    expect(await r.ask()).toEqual({ signedIn: true, email: "first@example.com" });
    expect(r.runs()).toBe(1);
  });

  test("a stale answer is served at once, with one run in the background", async () => {
    const r = rig();
    await r.ask();
    r.advance(61_000);
    r.answer("second@example.com");
    r.hold(true);
    // Served at once while the refresh is held open.
    expect(await r.ask()).toEqual({ signedIn: true, email: "first@example.com" });
    expect(r.runs()).toBe(2);
    r.release();
    await r.ids.idle(KEY);
    expect(r.ids.peek(KEY)).toEqual({ signedIn: true, email: "second@example.com" });
    expect(r.runs()).toBe(2);
  });

  test("no second run while one is in flight", async () => {
    const r = rig();
    await r.ask();
    r.advance(61_000);
    r.hold(true);
    await r.ask();
    await r.ask();
    await r.ask(5_000);
    expect(r.runs()).toBe(2);
    // A cold read during a run shares that run too.
    const cold = rig();
    cold.hold(true);
    const a = cold.ask();
    const b = cold.ask();
    cold.release();
    expect(await a).toEqual(await b);
    expect(cold.runs()).toBe(1);
    r.release();
  });

  test("a shorter age refreshes sooner: the sign-in pane's 5 s", async () => {
    const r = rig();
    await r.ask();
    r.advance(4_000);
    await r.ask(5_000);
    expect(r.runs()).toBe(1);
    r.advance(2_000);
    await r.ask(5_000);
    expect(r.runs()).toBe(2);
  });

  test("a drop is never followed by the old value: the next read waits for a new run", async () => {
    const r = rig();
    await r.ask();
    r.ids.drop(KEY);
    expect(r.ids.peek(KEY)).toBeUndefined();
    r.answer("second@example.com");
    expect(await r.ask()).toEqual({ signedIn: true, email: "second@example.com" });
    expect(r.runs()).toBe(2);
  });

  test("a drop during a run: that run's answer is not kept, and the read after it waits for a run of its own", async () => {
    const r = rig();
    await r.ask();
    r.advance(61_000);
    r.hold(true);
    await r.ask(); // stale served, refresh held open
    r.ids.drop(KEY);
    const after = r.ask();
    r.answer("second@example.com");
    r.release();
    // The held run ends; its answer is not kept, and a new run starts for the waiting read.
    await r.ids.idle(KEY);
    r.hold(false);
    r.release();
    expect(await after).toEqual({ signedIn: true, email: "second@example.com" });
    expect(r.runs()).toBe(3);
  });

  test("an unreadable answer is held as unknown, so it is not asked again at every read", async () => {
    const ids = new AccountIdentities({ now: () => 1, run: async () => ({ code: 0, stdout: "garbage", stderr: "" }) });
    const ask = { key: "k", binary: "claude", args: [], env: {}, parse, maxAge: 60_000 };
    expect(await ids.read(ask)).toBeNull();
    expect(ids.peek("k")).toBeNull();
  });
});

describe("settledWithin", () => {
  test("gives what is ready in time and leaves the slow one running", async () => {
    let late: (v: string) => void = () => {};
    const slow = new Promise<string>((r) => (late = r));
    const out = await settledWithin([Promise.resolve("a"), slow, Promise.reject(new Error("x"))], 20);
    expect(out).toEqual(["a", undefined, undefined]);
    late("b");
  });
});
