import { describe, expect, test } from "bun:test";

import { herdrSizeHolder, holdArgv, refusalOf, startHold, type HoldProcess } from "./size-hold.ts";

// The first lines below are the records Herdr 0.9.1 actually sent in the 2026-09-24 probe
// (HERDR_API.md § `terminal session control`), trimmed of their base64 payloads.
const FRAME = '{"bytes":"G1s/MjAyNmg=","encoding":"ansi","full":true,"height":36,"seq":1,"type":"terminal.frame","width":48}';
const BUSY =
  '{"reason":"terminal attach failed: terminal term_1 already has an attached client; retry with --takeover","type":"terminal.closed"}';
const NOT_FOUND = '{"reason":"terminal session control failed: terminal target term_1 not found","type":"terminal.closed"}';
const TAKEN = '{"reason":"terminal attach taken over","type":"terminal.closed"}';

const FAST = { startMs: 200, graceMs: 50 };

/** A fake child: stdout is pushed by the test, and `exited` settles on kill or stdin EOF. */
function fakeProcess(options: { exitOnStdinEnd?: boolean } = {}) {
  const encoder = new TextEncoder();
  let push!: (chunk: string) => void;
  let finish!: () => void;
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (chunk) => controller.enqueue(encoder.encode(chunk));
      finish = () => {
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
    },
  });
  const stderr = new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
  let exit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => (exit = resolve));
  const record = { killed: false, stdinEnded: false };
  const proc: HoldProcess = {
    stdout,
    stderr,
    endStdin() {
      record.stdinEnded = true;
      if (options.exitOnStdinEnd !== false) {
        finish();
        exit(0);
      }
    },
    kill() {
      record.killed = true;
      finish();
      exit(143);
    },
    exited,
  };
  return { proc, push, finish, exit, record };
}

describe("the command line", () => {
  test("is the probed spelling: control, the terminal id, then --cols and --rows", () => {
    expect(holdArgv("term_65c38556854816", { cols: 48, rows: 36 })).toEqual([
      "herdr",
      "terminal",
      "session",
      "control",
      "term_65c38556854816",
      "--cols",
      "48",
      "--rows",
      "36",
    ]);
  });

  test("never passes --takeover", () => {
    expect(holdArgv("term_1", { cols: 48, rows: 36 })).not.toContain("--takeover");
  });

  test("targets the adapter's own socket through the environment, not a session name", async () => {
    let seen: Readonly<Record<string, string>> | undefined;
    const holder = herdrSizeHolder(
      "/run/herdr/sessions/work/herdr.sock",
      (_argv, env) => {
        seen = env;
        const fake = fakeProcess();
        queueMicrotask(() => fake.push(`${FRAME}\n`));
        return fake.proc;
      },
      FAST,
    );
    const held = await holder("term_1", { cols: 48, rows: 36 });
    expect(held.ok).toBe(true);
    expect(seen).toEqual({ HERDR_SOCKET_PATH: "/run/herdr/sessions/work/herdr.sock" });
  });
});

describe("the first line decides", () => {
  test("a frame means the size is held", async () => {
    const fake = fakeProcess();
    const pending = startHold(fake.proc, FAST);
    fake.push(`${FRAME}\n`);
    const held = await pending;
    expect(held.ok).toBe(true);
    expect(fake.record.killed).toBe(false);
  });

  test("a frame split across chunks still counts", async () => {
    const fake = fakeProcess();
    const pending = startHold(fake.proc, FAST);
    fake.push(FRAME.slice(0, 20));
    fake.push(`${FRAME.slice(20)}\n`);
    expect((await pending).ok).toBe(true);
  });

  test("another controller is `refused` — the busy answer — and the child is ended", async () => {
    const fake = fakeProcess();
    const pending = startHold(fake.proc, FAST);
    fake.push(`${BUSY}\n`);
    const held = await pending;
    expect(held).toMatchObject({ ok: false, reason: "refused" });
    expect(fake.record.killed).toBe(true);
  });

  test("a terminal that is not in this session is `gone`", async () => {
    const fake = fakeProcess();
    const pending = startHold(fake.proc, FAST);
    fake.push(`${NOT_FOUND}\n`);
    expect(await pending).toMatchObject({ ok: false, reason: "gone" });
  });

  test("a child that says nothing before it exits is `unreachable`", async () => {
    const fake = fakeProcess();
    const pending = startHold(fake.proc, FAST);
    fake.finish();
    fake.exit(1);
    expect(await pending).toMatchObject({ ok: false, reason: "unreachable" });
  });

  test("a child that says nothing in time is abandoned as `unreachable`", async () => {
    const fake = fakeProcess();
    const held = await startHold(fake.proc, FAST);
    expect(held).toMatchObject({ ok: false, reason: "unreachable" });
    expect(fake.record.killed).toBe(true);
  });

  test("a herdr that cannot be started is `unreachable`, not a throw", async () => {
    const holder = herdrSizeHolder(
      "/tmp/herdr.sock",
      () => {
        throw new Error("ENOENT: herdr");
      },
      FAST,
    );
    expect(await holder("term_1", { cols: 48, rows: 36 })).toMatchObject({ ok: false, reason: "unreachable" });
  });

  test("refusalOf reads only the words Herdr is known to use", () => {
    expect(refusalOf("something new")).toMatchObject({ reason: "unreachable" });
  });
});

describe("a held size", () => {
  async function held() {
    const fake = fakeProcess();
    const pending = startHold(fake.proc, FAST);
    fake.push(`${FRAME}\n`);
    const outcome = await pending;
    if (!outcome.ok) throw new Error("expected a hold");
    return { fake, hold: outcome.value };
  }

  test("release closes stdin, which is Herdr's clean detach", async () => {
    const { fake, hold } = await held();
    hold.release();
    expect(fake.record.stdinEnded).toBe(true);
    expect(await hold.ended).toBe("released");
  });

  test("release is idempotent", async () => {
    const { hold } = await held();
    hold.release();
    hold.release();
    expect(await hold.ended).toBe("released");
  });

  test("a child that ignores stdin EOF is killed after the grace period", async () => {
    const fake = fakeProcess({ exitOnStdinEnd: false });
    const pending = startHold(fake.proc, FAST);
    fake.push(`${FRAME}\n`);
    const outcome = await pending;
    if (!outcome.ok) throw new Error("expected a hold");
    outcome.value.release();
    expect(await outcome.value.ended).toBe("released");
    expect(fake.record.killed).toBe(true);
  });

  test("frames after the first are drained and never end the hold", async () => {
    const { fake, hold } = await held();
    for (let seq = 2; seq < 50; seq++) fake.push(`${FRAME.replace('"seq":1', `"seq":${seq}`)}\n`);
    let ended = false;
    void hold.ended.then(() => (ended = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ended).toBe(false);
    hold.release();
  });

  test("a takeover by another controller ends the hold with a reason", async () => {
    const { fake, hold } = await held();
    fake.push(`${TAKEN}\n`);
    expect(await hold.ended).toContain("another controller");
    expect(fake.record.killed).toBe(true);
  });
});
