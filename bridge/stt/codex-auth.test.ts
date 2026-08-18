import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";

import {
  CodexAppServerAuthBroker,
  type CodexAppServerProcess,
} from "./codex-auth.ts";

class FakeStream extends EventEmitter {
  write = (_chunk: string): boolean => true;
}

class FakeProcess extends EventEmitter implements CodexAppServerProcess {
  readonly stdin = new FakeStream();
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  readonly requests: Array<Record<string, unknown>> = [];
  killed = false;

  constructor(replyToInitialize = true) {
    super();
    this.stdin.write = (chunk) => {
      const message = JSON.parse(chunk) as Record<string, unknown>;
      this.requests.push(message);
      const id = message.id;
      if (message.method === "initialize" && replyToInitialize) {
        this.reply({ id, result: { codexHome: "/tmp/codex" } });
      } else if (message.method === "getAuthStatus") {
        const params = message.params as { includeToken?: boolean };
        this.reply({
          id,
          result: {
            authMethod: "chatgpt",
            authToken: params.includeToken ? "access-token" : null,
            requiresOpenaiAuth: true,
          },
        });
      }
      return true;
    };
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }

  private reply(message: unknown) {
    queueMicrotask(() => this.stdout.emit("data", `${JSON.stringify(message)}\n`));
  }
}

describe("CodexAppServerAuthBroker", () => {
  test("reuses one initialized process and only returns a token when requested", async () => {
    const child = new FakeProcess();
    let spawnCount = 0;
    const broker = new CodexAppServerAuthBroker({
      spawn: () => {
        spawnCount += 1;
        return child;
      },
      requestTimeoutMs: 1_000,
    });

    expect(await broker.status()).toEqual({ available: true });
    expect(await broker.accessToken()).toEqual({
      accessToken: "access-token",
      authMethod: "chatgpt",
    });
    expect(spawnCount).toBe(1);
    expect(child.requests.map((request) => request.method)).toEqual([
      "initialize",
      "initialized",
      "getAuthStatus",
      "getAuthStatus",
    ]);
    expect(child.requests.at(-2)?.params).toEqual({
      includeToken: false,
      refreshToken: false,
    });
    expect(child.requests.at(-1)?.params).toEqual({
      includeToken: true,
      refreshToken: false,
    });

    broker.close();
    expect(child.killed).toBe(true);
  });

  test("waits for initialization before serving concurrent auth requests", async () => {
    const child = new FakeProcess();
    const broker = new CodexAppServerAuthBroker({ spawn: () => child, requestTimeoutMs: 1_000 });

    await Promise.all([broker.status(), broker.accessToken()]);

    expect(child.requests.map((request) => request.method)).toEqual([
      "initialize",
      "initialized",
      "getAuthStatus",
      "getAuthStatus",
    ]);
    broker.close();
  });

  test("retires a child whose initialization times out and starts cleanly next time", async () => {
    const first = new FakeProcess(false);
    const second = new FakeProcess();
    const children = [first, second];
    const broker = new CodexAppServerAuthBroker({
      spawn: () => {
        const child = children.shift()!;
        if (child === second) first.stdout.emit("data", '{"id":999');
        return child;
      },
      requestTimeoutMs: 10,
    });

    expect((await broker.status()).available).toBe(false);
    expect(first.killed).toBe(true);
    expect(await broker.accessToken()).toEqual({
      accessToken: "access-token",
      authMethod: "chatgpt",
    });
    expect(second.requests.map((request) => request.method)).toEqual([
      "initialize",
      "initialized",
      "getAuthStatus",
    ]);
    broker.close();
  });
});
