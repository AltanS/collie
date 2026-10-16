import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DurableMux, SYSTEM_CLOCK } from "./adapter.ts";
import { DurableSocketClient } from "./client.ts";
import type { DurableEventSink } from "./events.ts";
import type { DurableEvent } from "./protocol.ts";

// THE 10-LINE FIRST PROGRAM, DRIVEN BY THE REAL ADAPTER (M55 spec 04). `examples/durable-member/hello.ts` is the first thing a
// builder runs: one pane, one choice ask, "Deploy to staging?". This starts it on a socket in a fresh temp folder, then runs the
// adapter and its socket client against it: hello with the one cap, the snapshot, the open ask, an answer, and the program's exit.
//
// Like example.test.ts it needs the example's own install and skips without it, and it skips on Windows (no private socket).

const EXAMPLE = join(import.meta.dir, "..", "..", "..", "examples", "durable-member");
const INSTALLED = existsSync(join(EXAMPLE, "node_modules"));
const RUNS = INSTALLED && process.platform !== "win32";

const NOT_INSTALLED = "example deps not installed: run bun install in examples/durable-member";
if (!INSTALLED) {
  // Bun prints no name for a skipped test, so the reason goes to the log as well.
  console.warn(`example-hello.test.ts skipped: ${NOT_INSTALLED}`);
  test.skip(NOT_INSTALLED, () => {});
}

const noEvents: DurableEventSink = {
  apply: (_paneId: string, events: readonly DurableEvent[]) => Promise.resolve(events.length),
};

describe.skipIf(!RUNS)("hello.ts against the real adapter", () => {
  const dir = RUNS ? mkdtempSync(join(tmpdir(), "collie-dmh-")) : "";
  const socket = join(dir, "s.sock");
  const adapter = new DurableMux(new DurableSocketClient(socket), SYSTEM_CLOCK, noEvents);
  let child: ReturnType<typeof Bun.spawn> | null = null;

  beforeAll(async () => {
    child = Bun.spawn(["bun", join(EXAMPLE, "hello.ts")], {
      cwd: EXAMPLE,
      env: { ...process.env, COLLIE_DURABLE_SOCKET: socket },
      stdout: "pipe",
      stderr: "inherit",
    });
    const end = Date.now() + 10_000;
    while (!(await adapter.poll()).ok) {
      if (Date.now() > end) throw new Error("hello.ts did not answer within 10 s");
      await Bun.sleep(50);
    }
  }, 12_000);

  afterAll(async () => {
    if (child !== null && child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    if (dir !== "") rmSync(dir, { recursive: true, force: true });
  });

  test("example: hello.ts agrees version 1 and declares the one cap it uses", () => {
    const session = adapter.program()?.session;
    expect(session?.version).toBe(1);
    expect(session?.hostName).toBe("hello");
    expect(session?.caps).toEqual({ asks: true, starters: false, send: false, steer: false, abort: false, rename: false, close: false, actions: false, history: false, reopen: false });
  });

  test("example: hello.ts puts one pane in the snapshot, and it waits on one ask with Yes and No", async () => {
    const mux = await adapter.snapshot();
    expect(mux.panes).toHaveLength(1);
    const pane = mux.panes[0];
    expect(pane?.agent).toBe("durable");
    const open = adapter.openAsks(pane?.paneId ?? "") ?? [];
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ kind: "choice", title: "Deploy to staging?" });
    expect(open[0]?.options.map((option) => option.label)).toEqual(["Yes", "No"]);
  });

  test("example: an answer reaches the program, and the program exits 0 with that answer", async () => {
    const pane = (await adapter.snapshot()).panes[0];
    const ask = adapter.openAsks(pane?.paneId ?? "")?.[0];
    if (pane === undefined || ask === undefined) throw new Error("no open ask");
    const taken = await adapter.answerAsk(pane.paneId, { requestId: crypto.randomUUID(), askId: ask.id, revision: ask.revision, optionIds: ["no"] });
    expect(taken).toEqual({ ok: true, value: { kind: "taken", replayed: false } });
    expect(await child?.exited).toBe(0);
    // The child was started with `stdout: "pipe"`, so its stdout is a stream; the narrowing the type cannot see is spelled out here.
    const stdout = child?.stdout;
    if (!(stdout instanceof ReadableStream)) throw new Error("hello.ts stdout is not piped");
    expect(await new Response(stdout).text()).toContain("answer: no");
  }, 10_000);
});
