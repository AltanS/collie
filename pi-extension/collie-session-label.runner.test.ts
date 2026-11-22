import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import collieSessionLabel, {
  type ExtensionApi,
  type LabelledEvent,
  type SessionContext,
  type SessionEvent,
} from "./collie-session-label.ts";

// The real runner: the default export reads `process.env` and calls the real `execFile`. The `hc`
// here is a shell script that records its arguments, one per line, with a separator line per call.

const SEPARATOR = "--call--";
const POSIX = process.platform !== "win32";
const ENV_KEYS = ["HC_TERMINAL_ID", "COLLIE_HC_BIN", "PI_SESSION_ID", "PATH"] as const;

type Handler = (event: SessionEvent, ctx: SessionContext | undefined) => Promise<void> | void;

/**
 * A fake pi runtime: `emit` runs every handler of an event and waits for what they return, as pi does.
 * Only a quit returns a promise, so after a start or a turn a test waits for the write with `idle`.
 */
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
  return { pi, emit };
}

/** Waits until every write the terminal's queue holds has run. */
async function idle(): Promise<void> {
  await globalThis.__colliePiSessionLabel?.get(process.env.HC_TERMINAL_ID ?? "")?.queue;
}

const session = (file: string): SessionContext => ({ hasUI: true, mode: "tui", sessionManager: { getSessionFile: () => file } });

let dir = "";
let record = "";
let terminalCount = 0;
let saved: Record<string, string | undefined> = {};

/** An executable `hc` in the temp folder; `before` is a shell line that runs ahead of the recording. */
function writeHc(name: string, before = ""): string {
  const file = join(dir, name);
  const lines = ["#!/bin/sh", before, `for arg in "$@"; do printf '%s\\n' "$arg" >> "${record}"; done`, `printf '%s\\n' '${SEPARATOR}' >> "${record}"`];
  writeFileSync(file, `${lines.join("\n")}\n`);
  chmodSync(file, 0o755);
  return file;
}

/** Every call the fake `hc` recorded so far, each as its list of arguments. */
function calls(): string[][] {
  if (!existsSync(record)) return [];
  const lines = readFileSync(record, "utf8").split("\n");
  lines.pop();
  const out: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line !== SEPARATOR) current.push(line);
    else {
      out.push(current);
      current = [];
    }
  }
  return out;
}

/** A terminal id of its own per test: the extension keeps its state per terminal id on `globalThis`. */
function newTerminal(): string {
  terminalCount += 1;
  const terminal = `runner-t${terminalCount}`;
  process.env.HC_TERMINAL_ID = terminal;
  return terminal;
}

describe.skipIf(!POSIX)("the real hc runner", () => {
  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    delete process.env.PI_SESSION_ID;
    dir = mkdtempSync(join(tmpdir(), "pi-label-runner-"));
    record = join(dir, "record.txt");
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    globalThis.__colliePiSessionLabel = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  test("session_start runs hc once with exactly three arguments", async () => {
    const terminal = newTerminal();
    process.env.COLLIE_HC_BIN = writeHc("hc");
    const file = join(dir, "sessions", "a.jsonl");
    const runtime = fakePi();
    collieSessionLabel(runtime.pi);
    await runtime.emit("session_start", session(file), { reason: "startup" });
    await idle();
    expect(calls()).toEqual([["label", terminal, `pi.session_file=${file}`]]);
  });

  test("a path with a space, quotes, a command substitution and a semicolon is one unchanged argument, with no shell", async () => {
    const terminal = newTerminal();
    process.env.COLLIE_HC_BIN = writeHc("hc");
    const pwned = join(dir, "pwned");
    const file = join(dir, `my sessions`, `it's "x" $(touch ${pwned}); a.jsonl`);
    const runtime = fakePi();
    collieSessionLabel(runtime.pi);
    await runtime.emit("session_start", session(file), { reason: "startup" });
    await idle();
    expect(calls()).toEqual([["label", terminal, `pi.session_file=${file}`]]);
    expect(existsSync(pwned)).toBe(false);
  });

  test("a missing hc binary neither throws nor counts as written", async () => {
    const terminal = newTerminal();
    process.env.COLLIE_HC_BIN = join(dir, "no-such-hc");
    const file = join(dir, "b.jsonl");
    const runtime = fakePi();
    collieSessionLabel(runtime.pi);
    await runtime.emit("session_start", session(file), { reason: "startup" });
    await idle();
    expect(calls()).toEqual([]);

    process.env.COLLIE_HC_BIN = writeHc("hc");
    await runtime.emit("agent_end", session(file));
    await idle();
    expect(calls()).toEqual([["label", terminal, `pi.session_file=${file}`]]);
  });

  test.each([
    ["a script that execs the sleep", "exec sleep 10"],
    ["a wrapper script that leaves a child behind", "sleep 10"],
  ])(
    "an hc that hangs (%s) is cut off at the time limit, also at quit, and does not count as written",
    async (_name, before) => {
      const terminal = newTerminal();
      process.env.COLLIE_HC_BIN = writeHc("hc-slow", before);
      const file = join(dir, "c.jsonl");
      const runtime = fakePi();
      collieSessionLabel(runtime.pi);
      // The start does not wait for hc at all.
      const started = Date.now();
      await runtime.emit("session_start", session(file), { reason: "startup" });
      expect(Date.now() - started).toBeLessThan(500);
      // The write itself is cut off at the limit (1.5 s; the bound is loose, the suite runs under load).
      await idle();
      expect(Date.now() - started).toBeLessThan(5000);
      // A quit waits once, and also for at most the limit.
      const quitAt = Date.now();
      await runtime.emit("session_shutdown", session(file), { reason: "quit" });
      expect(Date.now() - quitAt).toBeLessThan(5000);
      expect(calls()).toEqual([]);

      process.env.COLLIE_HC_BIN = writeHc("hc");
      await runtime.emit("agent_end", session(file));
      await idle();
      expect(calls()).toEqual([["label", terminal, `pi.session_file=${file}`]]);
    },
    15_000,
  );

  test("an empty COLLIE_HC_BIN counts as unset: hc on the PATH answers", async () => {
    const terminal = newTerminal();
    writeHc("hc");
    process.env.COLLIE_HC_BIN = "";
    process.env.PATH = `${dir}:${saved.PATH ?? ""}`;
    const file = join(dir, "e.jsonl");
    const runtime = fakePi();
    collieSessionLabel(runtime.pi);
    await runtime.emit("session_start", session(file), { reason: "startup" });
    await idle();
    expect(calls()).toEqual([["label", terminal, `pi.session_file=${file}`]]);
  });

  test("session_shutdown with reason quit writes the empty value", async () => {
    const terminal = newTerminal();
    process.env.COLLIE_HC_BIN = writeHc("hc");
    const file = join(dir, "d.jsonl");
    const runtime = fakePi();
    collieSessionLabel(runtime.pi);
    await runtime.emit("session_start", session(file), { reason: "startup" });
    await idle();
    await runtime.emit("session_shutdown", session(file), { reason: "quit" });
    expect(calls()).toEqual([
      ["label", terminal, `pi.session_file=${file}`],
      ["label", terminal, "pi.session_file="],
    ]);
  });
});
