import { describe, expect, test } from "bun:test";

import {
  CODEX_UNPROBED,
  createCodexAuthBroker,
  type CodexAppServerProcess,
} from "./codex-auth.ts";
import { SttError } from "./provider.ts";

// The broker's whole job is to hold ONE `codex app-server` child, speak its JSON-RPC correctly, and
// never let a token reach anywhere but memory. Every one of those is asserted here against a fake
// child rather than a real `codex` install: the process seam (CodexAppServerProcess) is four
// methods wide precisely so this file can exist.

/** One JSON-RPC frame, as the fake child reads it back off its own stdin. */
interface Frame {
  id?: number;
  method?: string;
  params?: { includeToken?: boolean; refreshToken?: boolean };
}

interface FakeConfig {
  /** Answer `initialize`. False models a child that starts and then hangs. */
  answerInitialize?: boolean;
  /** What `getAuthStatus` reports. `null` is "not signed in". */
  authMethod?: string | null;
  token?: string;
  /** Queue `getAuthStatus` answers until `release()` — the only way to overlap two calls. */
  hold?: boolean;
}

interface FakeAppServer {
  process: CodexAppServerProcess;
  /** Every frame the broker wrote, in order. */
  written: Frame[];
  killed: boolean;
  /** Flush the answers held back by `hold`. */
  release(): void;
  /** Emit a raw stdout line, newline included by the fake. For stale-bytes and garbage cases. */
  emit(line: string): void;
  /** Report the child as gone, the way a real exit would. */
  die(reason: string): void;
}

function fakeAppServer(config: FakeConfig = {}): FakeAppServer {
  const answerInitialize = config.answerInitialize ?? true;
  const authMethod = config.authMethod === undefined ? "chatgpt" : config.authMethod;
  const token = config.token ?? "access-token";
  let stdout: ((chunk: Uint8Array) => void) | null = null;
  let onExit: ((reason: string) => void) | null = null;
  const held: string[] = [];

  const fake: FakeAppServer = {
    written: [],
    killed: false,
    emit(line) {
      stdout?.(new TextEncoder().encode(`${line}\n`));
    },
    release() {
      const queued = held.splice(0, held.length);
      for (const line of queued) fake.emit(line);
    },
    die(reason) {
      onExit?.(reason);
    },
    process: {
      stdin: {
        write(chunk) {
          // SAFETY: the broker is the only writer here and it writes one JSON object per line; a
          // throw inside the fake would surface as a failing test, which is the point.
          const frame = JSON.parse(chunk) as Frame;
          fake.written.push(frame);
          if (frame.method === "initialize" && answerInitialize) {
            fake.emit(JSON.stringify({ id: frame.id, result: { codexHome: "/tmp/codex" } }));
          }
          if (frame.method === "getAuthStatus") {
            const line = JSON.stringify({
              id: frame.id,
              result: {
                authMethod,
                authToken: frame.params?.includeToken === true ? token : null,
              },
            });
            if (config.hold === true) held.push(line);
            else fake.emit(line);
          }
          return true;
        },
      },
      onStdout(listener) {
        stdout = listener;
      },
      onStderr() {},
      onExit(listener) {
        onExit = listener;
      },
      kill() {
        fake.killed = true;
      },
    },
  };
  return fake;
}

/**
 * Let the broker's async chain run until it has written `count` frames.
 *
 * The broker reaches its child across several `await`s, so a test that wants to act BETWEEN the
 * write and the answer has to wait for the write itself rather than for a guessed number of
 * microtask turns.
 */
async function written(fake: FakeAppServer, count: number): Promise<void> {
  for (let turn = 0; turn < 100 && fake.written.length < count; turn++) await Promise.resolve();
  expect(fake.written).toHaveLength(count);
}

/** The methods the broker sent, which is the handshake order stated as a list. */
function methods(fake: FakeAppServer): (string | undefined)[] {
  return fake.written.map((frame) => frame.method);
}

describe("the codex auth broker — the handshake", () => {
  test("one child, one handshake, and the token only when it is asked for", async () => {
    const fake = fakeAppServer();
    let spawns = 0;
    const broker = createCodexAuthBroker({
      codexBin: "codex",
      spawn: () => {
        spawns += 1;
        return fake.process;
      },
      requestTimeoutMs: 1_000,
    });

    expect(await broker.probe()).toEqual({ available: true });
    expect(await broker.accessToken()).toEqual({ accessToken: "access-token" });

    expect(spawns).toBe(1);
    expect(methods(fake)).toEqual(["initialize", "initialized", "getAuthStatus", "getAuthStatus"]);
    expect(fake.written.at(-2)?.params).toEqual({ includeToken: false, refreshToken: false });
    expect(fake.written.at(-1)?.params).toEqual({ includeToken: true, refreshToken: false });
    broker.close();
  });

  test("concurrent first callers wait on one handshake rather than racing two children", async () => {
    const fake = fakeAppServer();
    let spawns = 0;
    const broker = createCodexAuthBroker({
      codexBin: "codex",
      spawn: () => {
        spawns += 1;
        return fake.process;
      },
      requestTimeoutMs: 1_000,
    });

    await Promise.all([broker.probe(), broker.accessToken(), broker.accessToken()]);

    expect(spawns).toBe(1);
    expect(methods(fake).filter((m) => m === "initialize")).toHaveLength(1);
    broker.close();
  });

  test("the binary from the settings is the one spawned", async () => {
    const fake = fakeAppServer();
    const seen: string[] = [];
    const broker = createCodexAuthBroker({
      codexBin: "/opt/codex/bin/codex",
      spawn: (bin) => {
        seen.push(bin);
        return fake.process;
      },
    });

    await broker.accessToken();
    expect(seen).toEqual(["/opt/codex/bin/codex"]);
    broker.close();
  });

  test("`lastKnown` is cold until something has really been asked, and never spawns", async () => {
    const fake = fakeAppServer();
    let spawns = 0;
    const broker = createCodexAuthBroker({
      codexBin: "codex",
      spawn: () => {
        spawns += 1;
        return fake.process;
      },
    });

    expect(broker.lastKnown()).toEqual(CODEX_UNPROBED);
    expect(spawns).toBe(0);

    await broker.accessToken();
    expect(broker.lastKnown()).toEqual({ available: true });
    expect(spawns).toBe(1);
    broker.close();
  });

  test("garbage on stdout is skipped, not fatal — app-server logs there too", async () => {
    const fake = fakeAppServer();
    const broker = createCodexAuthBroker({ codexBin: "codex", spawn: () => fake.process });

    // After a first call, so the child exists and stdout is really being read.
    await broker.accessToken();
    fake.emit("this is not json");
    fake.emit(JSON.stringify({ method: "someNotification", params: {} }));
    fake.emit(JSON.stringify({ id: 999, result: { authMethod: "chatgpt" } }));
    expect(await broker.accessToken()).toEqual({ accessToken: "access-token" });
    broker.close();
  });
});

describe("the codex auth broker — which sign-in counts", () => {
  test("an API-key login is refused BY NAME, before any audio exists", async () => {
    const fake = fakeAppServer({ authMethod: "apikey" });
    const broker = createCodexAuthBroker({ codexBin: "codex", spawn: () => fake.process });

    const error = await broker.accessToken().then(
      () => null,
      (err: Error) => err,
    );
    expect(error).toBeInstanceOf(SttError);
    expect(error instanceof SttError ? error.kind : null).toBe("unavailable");
    expect(error?.message).toContain("API key");
    expect(broker.lastKnown().available).toBe(false);
    expect(broker.lastKnown().reason).toContain("API key");
    broker.close();
  });

  test("no sign-in at all says so, and names the command that fixes it", async () => {
    const fake = fakeAppServer({ authMethod: null });
    const broker = createCodexAuthBroker({ codexBin: "codex", spawn: () => fake.process });

    await expect(broker.accessToken()).rejects.toThrow("codex login");
    expect(await broker.probe()).toEqual({ available: false, reason: expect.stringContaining("codex login") });
    broker.close();
  });

  test("a ChatGPT sign-in that hands back no token is a refusal, not an empty bearer", async () => {
    const fake = fakeAppServer({ token: "" });
    const broker = createCodexAuthBroker({ codexBin: "codex", spawn: () => fake.process });

    await expect(broker.accessToken()).rejects.toThrow("access token");
    broker.close();
  });
});

describe("the codex auth broker — refresh is shared, never raced", () => {
  test("two callers that both hit a 401 cause exactly ONE renewal", async () => {
    const fake = fakeAppServer({ hold: true });
    const broker = createCodexAuthBroker({ codexBin: "codex", spawn: () => fake.process });

    const both = Promise.all([broker.accessToken(true), broker.accessToken(true)]);
    // initialize + initialized + ONE getAuthStatus: the second caller never reached the child.
    await written(fake, 3);
    fake.release();

    expect(await both).toEqual([{ accessToken: "access-token" }, { accessToken: "access-token" }]);
    const refreshes = fake.written.filter((frame) => frame.params?.refreshToken === true);
    expect(refreshes).toHaveLength(1);
    broker.close();
  });

  test("a later refresh is a new round trip — the sharing is per flight, not a cache", async () => {
    const fake = fakeAppServer();
    const broker = createCodexAuthBroker({ codexBin: "codex", spawn: () => fake.process });

    await broker.accessToken(true);
    await broker.accessToken(true);

    expect(fake.written.filter((frame) => frame.params?.refreshToken === true)).toHaveLength(2);
    broker.close();
  });
});

describe("the codex auth broker — a dead child", () => {
  test("a child that times out during initialize is retired, and the next demand starts clean", async () => {
    const first = fakeAppServer({ answerInitialize: false });
    const second = fakeAppServer();
    const children = [first, second];
    const broker = createCodexAuthBroker({
      codexBin: "codex",
      spawn: () => {
        const next = children.shift();
        if (next === undefined) throw new Error("spawned more children than the test allows");
        // The retired child flushes a torn line after its replacement exists. It must not land in
        // the replacement's buffer.
        if (next === second) first.emit('{"id":999');
        return next.process;
      },
      requestTimeoutMs: 10,
    });

    expect((await broker.probe()).available).toBe(false);
    expect(first.killed).toBe(true);
    expect(await broker.accessToken()).toEqual({ accessToken: "access-token" });
    expect(methods(second)).toEqual(["initialize", "initialized", "getAuthStatus"]);
    broker.close();
  });

  test("a child that exits is respawned lazily, on the next demand and not before", async () => {
    const first = fakeAppServer();
    const second = fakeAppServer();
    const children = [first, second];
    let spawns = 0;
    const broker = createCodexAuthBroker({
      codexBin: "codex",
      spawn: () => {
        spawns += 1;
        const next = children.shift();
        if (next === undefined) throw new Error("spawned more children than the test allows");
        return next.process;
      },
    });

    await broker.accessToken();
    expect(spawns).toBe(1);

    first.die("the Codex app-server exited");
    expect(spawns).toBe(1); // lazily: nothing is restarted until something is wanted
    expect(broker.lastKnown().available).toBe(false);

    expect(await broker.accessToken()).toEqual({ accessToken: "access-token" });
    expect(spawns).toBe(2);
    broker.close();
  });

  test("close kills the child, fails what was waiting, and refuses to start another", async () => {
    const fake = fakeAppServer({ hold: true });
    const broker = createCodexAuthBroker({ codexBin: "codex", spawn: () => fake.process });

    const pending = broker.accessToken();
    await written(fake, 3);
    broker.close();

    await expect(pending).rejects.toThrow("shut down");
    expect(fake.killed).toBe(true);
    await expect(broker.accessToken()).rejects.toThrow("shut down");
    broker.close(); // twice is safe
  });
});
