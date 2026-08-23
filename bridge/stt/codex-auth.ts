import { spawn as spawnChild } from "node:child_process";

import type { JsonValue } from "../json.ts";
import { jsonNumberField, jsonRecord, jsonStringField } from "./json.ts";
import { SttError, type SttStatus } from "./provider.ts";

// ── BORROWING THE OPERATOR'S OWN CODEX LOGIN ─────────────────────────────────────────────────
//
// Codex stays in charge of its own OAuth storage, its own refresh token and its own keyring. Collie
// asks the binary the operator already trusts for a short-lived access token and holds it in memory
// for the length of one upload. It NEVER reads and NEVER writes `~/.codex/auth.json` — ADR 0029
// rejected that shortcut explicitly, because it would make Collie a reader of another tool's secret
// store and would break silently, with a stolen-looking credential in flight, the day that file
// changes shape.
//
// The conversation is `codex app-server`'s JSON-RPC over stdio, one JSON document per line:
//
//     → {"id":1,"method":"initialize","params":{"clientInfo":{…}}}
//     ← {"id":1,"result":{…}}
//     → {"method":"initialized","params":{}}                        (a notification, no id)
//     → {"id":2,"method":"getAuthStatus","params":{"includeToken":true,"refreshToken":false}}
//     ← {"id":2,"result":{"authMethod":"chatgpt","authToken":"eyJ…"}}
//
// This is the bridge's SECOND class of long-running child, after the multiplexer runtimes in
// sessions.ts — precedent, not a first, and one an operator who never configures this provider
// never starts. The child is spawned lazily on the first demand and respawned lazily after it dies;
// nothing here spawns at construction time, so building the provider inside a snapshot poll costs
// nothing.
//
// The whole process seam is {@link CodexAppServerProcess}, four methods wide and deliberately NOT
// node's `ChildProcess`: a fake for it is twenty lines of plain object, which is what keeps the
// handshake, the id correlation, the retirement of a timed-out child and the serialized refresh
// under `bun test` instead of only under a real `codex` install.

/** The lazily-spawned `codex app-server`, reduced to the four things this module does to it. */
export interface CodexAppServerProcess {
  /** Its stdin. One JSON document per `write`, newline-terminated by the caller. */
  readonly stdin: { write(chunk: string): boolean };
  /** Register the only stdout reader. Chunks are raw bytes; framing is this module's problem. */
  onStdout(listener: (chunk: Uint8Array) => void): void;
  /** Register the stderr reader. It exists to DRAIN the pipe — see the note at the call site. */
  onStderr(listener: (chunk: Uint8Array) => void): void;
  /** Called once when the child dies, however it died. `reason` is Collie's own sentence. */
  onExit(listener: (reason: string) => void): void;
  /** Terminate it. Must tolerate being called on a child that is already gone. */
  kill(): void;
}

/** One short-lived ChatGPT access token, valid for about as long as it takes to upload a clip. */
export interface CodexAccessToken {
  accessToken: string;
}

export interface CodexAuthBroker {
  /**
   * What the last real interaction with `codex app-server` established — never a fresh one.
   *
   * The snapshot route asks this on every poll to decide whether the phone shows a microphone, and
   * a poll must never be able to spawn a child or block on a handshake. Before anything has been
   * tried it answers "not checked yet", which is the honest state.
   */
  lastKnown(): SttStatus;
  /**
   * A token, spawning and handshaking the child if that is what it takes.
   *
   * `refresh` asks Codex to renew the underlying session first. Concurrent refreshes SHARE one
   * round trip: two phones that both hit a 401 must not race two renewals at the identity provider.
   */
  accessToken(refresh?: boolean): Promise<CodexAccessToken>;
  /** Ask for real, and record the answer in {@link lastKnown}. What `collie stt test` drives. */
  probe(): Promise<SttStatus>;
  /** Kill the child and fail everything waiting on it. Safe to call twice, and on a cold broker. */
  close(): void;
}

export interface CodexAuthBrokerOptions {
  /** The binary to spawn. A bare name resolves through the service's own `PATH`. */
  codexBin: string;
  /** The spawn itself, injected so the tests never look for a real `codex` on the machine. */
  spawn?: (codexBin: string) => CodexAppServerProcess;
  /** How long one JSON-RPC round trip may take before the child is retired. */
  requestTimeoutMs?: number;
  /** What Collie calls itself in the `initialize` handshake. Local only; never on the wire. */
  clientVersion?: string;
}

/** One JSON-RPC round trip's budget. Generous for a local handshake, short enough to fail a hang. */
export const CODEX_REQUEST_TIMEOUT_MS = 10_000;

/** The state a broker reports before anything has actually been asked of Codex. */
export const CODEX_UNPROBED: SttStatus = {
  available: false,
  reason: "the Codex sign-in has not been checked yet — run `collie stt test`",
};

interface PendingRequest {
  resolve(value: JsonValue): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** What `getAuthStatus` said, after narrowing. Both fields are absent-able on the wire. */
interface AuthStatus {
  authMethod: string | null;
  authToken: string | null;
}

export function createCodexAuthBroker(options: CodexAuthBrokerOptions): CodexAuthBroker {
  return new CodexAppServerAuthBroker(options);
}

class CodexAppServerAuthBroker implements CodexAuthBroker {
  private readonly codexBin: string;
  private readonly spawnProcess: (codexBin: string) => CodexAppServerProcess;
  private readonly requestTimeoutMs: number;
  private readonly clientVersion: string;

  private child: CodexAppServerProcess | null = null;
  private starting: Promise<void> | null = null;
  private refreshing: Promise<CodexAccessToken> | null = null;
  private nextId = 1;
  private buffer = "";
  private decoder = new TextDecoder();
  private readonly pending = new Map<number, PendingRequest>();
  private known: SttStatus = CODEX_UNPROBED;
  private closed = false;

  constructor(options: CodexAuthBrokerOptions) {
    this.codexBin = options.codexBin;
    this.spawnProcess = options.spawn ?? spawnCodexAppServer;
    this.requestTimeoutMs = options.requestTimeoutMs ?? CODEX_REQUEST_TIMEOUT_MS;
    this.clientVersion = options.clientVersion ?? "0.0.0";
  }

  lastKnown(): SttStatus {
    return this.known;
  }

  async probe(): Promise<SttStatus> {
    try {
      await this.authenticatedStatus(false, false);
      return this.known;
    } catch (err) {
      return err instanceof SttError ? { available: false, reason: err.message } : { available: false };
    }
  }

  async accessToken(refresh = false): Promise<CodexAccessToken> {
    if (!refresh) return this.fetchToken(false);
    // A refresh in flight is a refresh everyone joins. Serialized behind this one tail rather than
    // a lock, because the only thing that must not happen twice is the round trip itself.
    const inflight = this.refreshing;
    if (inflight !== null) return inflight;
    const started = this.fetchToken(true).finally(() => {
      if (this.refreshing === started) this.refreshing = null;
    });
    this.refreshing = started;
    return started;
  }

  close(): void {
    this.closed = true;
    const child = this.child;
    this.child = null;
    this.starting = null;
    this.buffer = "";
    child?.kill();
    this.failPending(new SttError("unavailable", "the Codex app-server was shut down"));
  }

  /** A token, with the authMethod already judged. Records the outcome in {@link lastKnown}. */
  private async fetchToken(refresh: boolean): Promise<CodexAccessToken> {
    const auth = await this.authenticatedStatus(true, refresh);
    if (auth.authToken === null || auth.authToken === "") {
      throw this.remember("Codex did not hand back an access token");
    }
    return { accessToken: auth.authToken };
  }

  /**
   * `getAuthStatus`, with the one judgement this provider is allowed to make about the answer.
   *
   * Only a ChatGPT login will do. An API-key login is refused BY NAME rather than tried: the
   * transcription endpoint this provider talks to is part of the ChatGPT product, an API key would
   * be rejected there after the audio had already been uploaded, and "Codex is signed in with an
   * API key" is a sentence the operator can act on.
   */
  private async authenticatedStatus(includeToken: boolean, refreshToken: boolean): Promise<AuthStatus> {
    const auth = readAuthStatus(await this.request("getAuthStatus", { includeToken, refreshToken }));
    if (auth.authMethod === "chatgpt") {
      this.known = { available: true };
      return auth;
    }
    if (auth.authMethod === "apikey" || auth.authMethod === "api_key") {
      throw this.remember(
        "Codex is signed in with an API key, and this transcription endpoint only accepts a " +
          "ChatGPT sign-in — run `codex login` and pick ChatGPT, or use the openai-compatible provider",
      );
    }
    if (auth.authMethod === null) throw this.remember("Codex is not signed in — run `codex login`");
    throw this.remember(`Codex is signed in with "${auth.authMethod}", not with ChatGPT`);
  }

  /** Record a refusal as the last known state and return it as the error to throw. */
  private remember(reason: string): SttError {
    this.known = { available: false, reason };
    return new SttError("unavailable", reason);
  }

  private async request(method: string, params: JsonValue): Promise<JsonValue> {
    if (this.closed) throw new SttError("unavailable", "speech-to-text was shut down");
    await this.ensureStarted();
    return this.send(method, params);
  }

  private async ensureStarted(): Promise<void> {
    const starting = this.starting;
    if (starting !== null) return starting;
    if (this.child !== null) return;
    const attempt = this.start();
    this.starting = attempt;
    try {
      await attempt;
    } finally {
      if (this.starting === attempt) this.starting = null;
    }
  }

  private async start(): Promise<void> {
    let child: CodexAppServerProcess;
    try {
      child = this.spawnProcess(this.codexBin);
    } catch (err) {
      throw this.remember(spawnFailure(err instanceof Error ? err : null, this.codexBin));
    }
    this.child = child;
    this.buffer = "";
    this.decoder = new TextDecoder();
    child.onStdout((chunk) => this.onStdout(child, chunk));
    // Drained and discarded, never logged: app-server writes diagnostics here, and a diagnostic
    // that quoted a token would put it in the journal forever. An UNREAD pipe would also fill and
    // wedge the child, so the listener has to exist even though it does nothing.
    child.onStderr(() => {});
    child.onExit((reason) => this.onDeath(child, reason));

    try {
      await this.send("initialize", {
        clientInfo: { name: "collie", title: "Collie", version: this.clientVersion },
      });
      this.write({ method: "initialized", params: {} });
    } catch (err) {
      // A timed-out initialize leaves a live but unusable child. Retire THIS one so the next demand
      // handshakes from scratch, and make sure its late exit cannot tear down the replacement.
      if (this.child === child) this.child = null;
      child.kill();
      this.buffer = "";
      throw err;
    }
  }

  private send(method: string, params: JsonValue): Promise<JsonValue> {
    const id = this.nextId++;
    return new Promise<JsonValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(this.remember(`the Codex app-server did not answer \`${method}\` in time`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof SttError ? err : new SttError("unavailable"));
      }
    });
  }

  private write(message: JsonValue): void {
    const child = this.child;
    if (child === null) throw this.remember("the Codex app-server is not running");
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onStdout(child: CodexAppServerProcess, chunk: Uint8Array): void {
    // A retired child can still flush stdout after its replacement has started. Stale bytes must
    // never enter the replacement's frame buffer, and a stale id must never resolve a live request.
    if (this.child !== child) return;
    this.buffer += this.decoder.decode(chunk, { stream: true });
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim() !== "") this.onFrame(line);
    }
  }

  private onFrame(line: string): void {
    let parsed: JsonValue;
    try {
      // SAFETY: `JSON.parse` output IS a JsonValue by construction, and every field below is read
      // through `bridge/stt/json.ts` before it is believed.
      parsed = JSON.parse(line) as JsonValue;
    } catch {
      return; // Not a frame Collie wrote or can read. app-server also logs here occasionally.
    }
    const frame = jsonRecord(parsed);
    if (frame === null) return;
    const id = jsonNumberField(frame.id);
    if (id === null) return; // A notification, or an answer to a request this process did not send.
    const request = this.pending.get(id);
    if (request === undefined) return;
    clearTimeout(request.timer);
    this.pending.delete(id);
    const failure = jsonRecord(frame.error);
    if (failure !== null) {
      request.reject(this.remember(jsonStringField(failure.message) ?? "the Codex app-server refused"));
      return;
    }
    request.resolve(frame.result ?? null);
  }

  private onDeath(child: CodexAppServerProcess, reason: string): void {
    if (this.child !== child) return;
    this.child = null;
    this.starting = null;
    this.buffer = "";
    this.failPending(this.remember(reason));
  }

  private failPending(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
}

/** `getAuthStatus`'s answer, narrowed. Anything unreadable degrades to "not signed in". */
function readAuthStatus(result: JsonValue): AuthStatus {
  const record = jsonRecord(result);
  if (record === null) return { authMethod: null, authToken: null };
  return {
    authMethod: jsonStringField(record.authMethod),
    authToken: jsonStringField(record.authToken),
  };
}

/** A spawn that never happened, said in words an operator can act on. */
function spawnFailure(err: Error | null, codexBin: string): string {
  if (err !== null && err.message.includes("ENOENT")) {
    return `\`${codexBin}\` was not found on this machine's PATH`;
  }
  return `\`${codexBin} app-server\` could not be started`;
}

/**
 * The real spawn, and the only place in this feature that touches `node:child_process`.
 *
 * It adapts node's `ChildProcess` down to {@link CodexAppServerProcess} by hand rather than casting
 * one to the other: the adapter is where the "a missing pipe is a dead child" and "an `error` event
 * and an `exit` event are the same news" judgements live, and both belong in code a reader can see.
 */
function spawnCodexAppServer(codexBin: string): CodexAppServerProcess {
  const child = spawnChild(codexBin, ["app-server", "--listen", "stdio://"], {
    stdio: ["pipe", "pipe", "pipe"],
    // No shell, and no inherited stdio: the binary name comes from settings an operator wrote, and
    // a shell would turn a stray character in it into a command.
    shell: false,
  });
  const { stdin, stdout, stderr } = child;
  if (stdin === null || stdout === null || stderr === null) {
    child.kill();
    throw new Error("the Codex app-server did not expose its standard streams");
  }
  // A child whose stdin closes under us must not take the bridge down with an unhandled EPIPE.
  stdin.on("error", () => {});
  return {
    stdin: { write: (chunk) => stdin.write(chunk) },
    onStdout: (listener) => {
      stdout.on("data", listener);
    },
    onStderr: (listener) => {
      stderr.on("data", listener);
    },
    onExit: (listener) => {
      child.on("error", (err: Error) => listener(spawnFailure(err, codexBin)));
      child.on("exit", () => listener("the Codex app-server exited"));
    },
    kill: () => {
      child.kill();
    },
  };
}
