import { spawn as spawnChild } from "node:child_process";

import type { AccountIdentity, AccountStatusRun } from "./account-adapters.ts";

// ── Who is signed in on an account: the agent's own status command, run by the bridge (M101 spec 04) ──
//
// The bridge asks the agent itself, `claude auth status`, and reads three fields of its answer through
// the adapter's parser (bridge/account-adapters.ts). It opens no login file for this, ever.
//
// THE RUN IS SECURITY CODE. A process started by the bridge, so:
//   • The binary is the bridge's own harness table's word (`harnesses.launch(id).binary`), resolved on
//     the PATH the way the probe finds it. The argv after it is the adapter's fixed `status.args`.
//   • No shell: `spawn(file, args, { shell: false })`, so no character of a folder or a word is a command.
//   • Nothing from a request reaches the argv or the environment. The environment is the bridge's own
//     without its own settings (every `COLLIE_` name), with the account's variable laid over it as a
//     start sets it (nothing for Default), and the folder
//     is a stored account's cleaned folder, never a value a request carried.
//   • stdin is closed (`ignore`), so a status command that ever asked a question reads end-of-file.
//   • A timeout kills it ({@link STATUS_TIMEOUT_MS}, SIGKILL), and so does output over the cap
//     ({@link STATUS_OUTPUT_CAP}, both streams together). Either is "unknown", never an error on the page.
//   • Its output is handed to the parser and dropped. It is never logged, never written to disk, never in
//     an audit line, a journal, a receipt or a trouble ping. The identity lives in this cache, in memory.
//   • One run at a time per account (harness and folder); a read during a run shares that run.
//   • It runs only where the agent has run before: at least one of the adapter's `status.needs` names
//     exists (existence only, never opened). A status call elsewhere would create the agent's state file
//     before the agent's own first start. bridge/accounts-routes.ts holds that check.

/** How long one status run may take. Claude Code answers in about 0.3 s, with no network. */
export const STATUS_TIMEOUT_MS = 5_000;
/** The most bytes read from one run, stdout and stderr together. Over it, the run is killed. */
export const STATUS_OUTPUT_CAP = 16 * 1024;
/** How old a held identity may be before a read refreshes it in the background. */
export const IDENTITY_TTL_MS = 60_000;
/** The same while a sign-in pane of that account is open. */
export const IDENTITY_SIGN_IN_MS = 5_000;
/** The longest a list read waits for identities; what is not ready comes with the next read. */
export const IDENTITY_WAIT_MS = 1_500;
/** The most identities kept; the oldest go first. Accounts are few, so this is a guard, not a limit. */
const MAX_KEPT = 64;

/** One ask: the binary's word, its fixed words, and the environment of the run. */
export interface StatusAsk {
  binary: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
}

/** Runs one status command. Null when it did not start, timed out or printed over the cap. */
export type StatusRunner = (ask: StatusAsk) => Promise<AccountStatusRun | null>;

/** The part of a child process the runner reads. Node's `ChildProcess` is one. */
export interface StatusChild {
  stdout: { on(event: "data", listener: (chunk: Buffer) => void): void } | null;
  stderr: { on(event: "data", listener: (chunk: Buffer) => void): void } | null;
  on(event: "error", listener: (err: Error) => void): void;
  on(event: "close", listener: (code: number | null) => void): void;
  kill(signal: NodeJS.Signals): boolean;
}

/** What starts a child. Node's spawn unless a test fakes it. */
export type StatusSpawn = (
  file: string,
  args: readonly string[],
  options: { shell: false; stdio: ["ignore", "pipe", "pipe"]; env: Record<string, string>; windowsHide: true },
) => StatusChild;

export interface StatusRunnerDeps {
  /** The binary's absolute path, or null when it is not on this machine. */
  locate(binary: string): Promise<string | null>;
  spawn?: StatusSpawn;
  timeoutMs?: number;
  capBytes?: number;
}

const nodeSpawn: StatusSpawn = (file, args, options) => spawnChild(file, [...args], options);

/** The real runner: one child per ask, no shell, closed stdin, a kill on the timeout and on the cap. */
export function statusRunner(deps: StatusRunnerDeps): StatusRunner {
  const timeoutMs = deps.timeoutMs ?? STATUS_TIMEOUT_MS;
  const cap = deps.capBytes ?? STATUS_OUTPUT_CAP;
  const spawn = deps.spawn ?? nodeSpawn;
  return async (ask) => {
    const file = await deps.locate(ask.binary);
    if (file === null) return null;
    let child: StatusChild;
    try {
      child = spawn(file, ask.args, { shell: false, stdio: ["ignore", "pipe", "pipe"], env: { ...ask.env }, windowsHide: true });
    } catch {
      return null;
    }
    return new Promise((resolve) => {
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let bytes = 0;
      let failed = false;
      // The one place this promise settles: an error and a close may both arrive, and only the first counts.
      let settle: ((run: AccountStatusRun | null) => void) | null = resolve;
      const finish = (run: AccountStatusRun | null): void => {
        clearTimeout(timer);
        settle?.(run);
        settle = null;
      };
      const stop = (): void => {
        failed = true;
        child.kill("SIGKILL");
        finish(null);
      };
      const timer = setTimeout(stop, timeoutMs);
      const take = (into: Buffer[]) => (chunk: Buffer) => {
        if (failed) return;
        bytes += chunk.length;
        if (bytes > cap) {
          stop();
          return;
        }
        into.push(chunk);
      };
      child.stdout?.on("data", take(out));
      child.stderr?.on("data", take(err));
      child.on("error", () => finish(null));
      child.on("close", (code) => {
        if (failed) return finish(null);
        finish({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
      });
    });
  };
}

/** What one identity read needs, all of it from the bridge's own table and store. */
export interface IdentityAsk extends StatusAsk {
  /** The account's key: harness and cleaned folder. */
  key: string;
  parse(run: AccountStatusRun): AccountIdentity | null;
  /** How old a held identity may be before this read starts a refresh. */
  maxAge: number;
}

interface Kept {
  at: number;
  identity: AccountIdentity | null;
}

/**
 * The identities the bridge holds, in memory only: per account, the last answer (an unreadable one as
 * null) and when it came.
 *
 * STALE WHILE IT REFRESHES. A read of an account that has a held answer gets it at once, whatever its
 * age, and an answer older than the read's `maxAge` starts one refresh in the background. Only an
 * account with no held answer (the first read since the bridge started, or the first after a drop)
 * waits for a run, and the list read caps that wait ({@link IDENTITY_WAIT_MS}).
 *
 * A DROP IS NEVER FOLLOWED BY THE OLD ANSWER. A drop means the login may have changed: the held answer is
 * forgotten, and a run that was under way when it came does not write its older answer back. A read after
 * a drop waits for a run that started after it, as a first read does.
 */
export class AccountIdentities {
  private readonly kept = new Map<string, Kept>();
  private readonly running = new Map<string, { gen: number; done: Promise<AccountIdentity | null> }>();
  private readonly gens = new Map<string, number>();

  constructor(private readonly deps: { run: StatusRunner; now: () => number }) {}

  /** The held identity, whatever its age: undefined when none is held, null for unknown. Starts nothing. */
  peek(key: string): AccountIdentity | null | undefined {
    return this.kept.get(key)?.identity;
  }

  /** Forget one account's identity, so the next read waits for a new run. */
  drop(key: string): void {
    this.kept.delete(key);
    this.gens.set(key, (this.gens.get(key) ?? 0) + 1);
  }

  /** A promise that settles when the account's run under way, if any, has ended. For tests and callers that must wait. */
  async idle(key: string): Promise<void> {
    await this.running.get(key)?.done;
  }

  /** The held identity at once (a refresh starts when it is older than `maxAge`), else one run's answer. */
  async read(ask: IdentityAsk): Promise<AccountIdentity | null> {
    const hit = this.kept.get(ask.key);
    if (hit !== undefined) {
      if (this.deps.now() - hit.at >= ask.maxAge) void this.start(ask);
      return hit.identity;
    }
    return this.start(ask);
  }

  /** The run for `ask`: the one under way since the last drop, else a new one. One at a time per account. */
  private start(ask: IdentityAsk): Promise<AccountIdentity | null> {
    const gen = this.gens.get(ask.key) ?? 0;
    const busy = this.running.get(ask.key);
    if (busy !== undefined && busy.gen === gen) return busy.done;
    // A run from before a drop is still under way: wait for it, then start again, so runs never overlap
    // and its older answer is never the one returned.
    if (busy !== undefined) return busy.done.then(() => this.start(ask));
    const done = this.runOnce(ask, gen);
    this.running.set(ask.key, { gen, done });
    void done.finally(() => {
      if (this.running.get(ask.key)?.done === done) this.running.delete(ask.key);
    });
    return done;
  }

  private async runOnce(ask: IdentityAsk, gen: number): Promise<AccountIdentity | null> {
    let identity: AccountIdentity | null = null;
    try {
      const run = await this.deps.run({ binary: ask.binary, args: ask.args, env: ask.env });
      identity = run === null ? null : ask.parse(run);
    } catch {
      identity = null;
    }
    if ((this.gens.get(ask.key) ?? 0) === gen) this.keep(ask.key, identity);
    return identity;
  }

  private keep(key: string, identity: AccountIdentity | null): void {
    this.kept.delete(key);
    this.kept.set(key, { at: this.deps.now(), identity });
    for (const old of this.kept.keys()) {
      if (this.kept.size <= MAX_KEPT) break;
      this.kept.delete(old);
    }
  }
}

/**
 * The answers of `asks` that arrive within `ms`, in order; a slow one is undefined here and keeps
 * running, so its answer lands in the cache for the next read.
 */
export async function settledWithin<T>(asks: readonly Promise<T>[], ms: number): Promise<(T | undefined)[]> {
  const out: (T | undefined)[] = asks.map(() => undefined);
  const all = Promise.all(
    asks.map((ask, i) =>
      ask.then(
        (value) => {
          out[i] = value;
          return value;
        },
        () => undefined,
      ),
    ),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  await Promise.race([all, late]);
  clearTimeout(timer);
  return [...out];
}
