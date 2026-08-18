import { spawn as spawnChild } from "node:child_process";
import type { EventEmitter } from "node:events";

type EventStream = Pick<EventEmitter, "on">;

export interface CodexAppServerProcess extends EventEmitter {
  stdin: EventStream & { write(chunk: string): boolean };
  stdout: EventStream;
  stderr: EventStream;
  kill(): boolean;
}

interface AuthStatusResponse {
  authMethod: string | null;
  authToken: string | null;
  requiresOpenaiAuth: boolean | null;
}

export interface CodexAccessToken {
  accessToken: string;
  authMethod: "chatgpt";
}

export interface CodexAuthBroker {
  status(): Promise<{ available: boolean; reason?: string }>;
  accessToken(refresh?: boolean): Promise<CodexAccessToken>;
  close(): void;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface BrokerOptions {
  spawn?: () => CodexAppServerProcess;
  requestTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Keeps Codex in charge of its own OAuth storage and refresh token. Collie receives only the
 * short-lived access token returned by app-server's compatibility auth RPC, and never reads
 * auth.json or an OS keyring directly.
 */
export class CodexAppServerAuthBroker implements CodexAuthBroker {
  private readonly spawnProcess: () => CodexAppServerProcess;
  private readonly requestTimeoutMs: number;
  private process: CodexAppServerProcess | null = null;
  private starting: Promise<void> | null = null;
  private nextId = 1;
  private stdoutBuffer = "";
  private readonly pending = new Map<number, PendingRequest>();

  constructor(options: BrokerOptions = {}) {
    this.spawnProcess =
      options.spawn ??
      (() =>
        spawnChild(process.env.COLLIE_CODEX_BIN?.trim() || "codex", ["app-server", "--listen", "stdio://"], {
          stdio: ["pipe", "pipe", "pipe"],
        }) as unknown as CodexAppServerProcess);
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  async status(): Promise<{ available: boolean; reason?: string }> {
    try {
      const auth = await this.authStatus(false, false);
      if (auth.authMethod !== "chatgpt") {
        return {
          available: false,
          reason: auth.authMethod
            ? "Codex must be signed in with ChatGPT"
            : "Codex is not signed in with ChatGPT",
        };
      }
      return { available: true };
    } catch (error) {
      return { available: false, reason: safeMessage(error, "Codex app-server is unavailable") };
    }
  }

  async accessToken(refresh = false): Promise<CodexAccessToken> {
    const auth = await this.authStatus(true, refresh);
    if (auth.authMethod !== "chatgpt") {
      throw new Error("Codex must be signed in with ChatGPT");
    }
    if (!auth.authToken) throw new Error("Codex did not provide an access token");
    return { accessToken: auth.authToken, authMethod: "chatgpt" };
  }

  close(): void {
    const process = this.process;
    this.process = null;
    this.starting = null;
    if (process) process.kill();
    this.failPending(new Error("Codex app-server closed"));
  }

  private async authStatus(includeToken: boolean, refreshToken: boolean): Promise<AuthStatusResponse> {
    return (await this.request("getAuthStatus", { includeToken, refreshToken })) as AuthStatusResponse;
  }

  private async ensureStarted(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.process) return;
    const starting = this.startProcess();
    this.starting = starting;
    try {
      await starting;
    } finally {
      if (this.starting === starting) this.starting = null;
    }
  }

  private async startProcess(): Promise<void> {
    let child: CodexAppServerProcess;
    try {
      child = this.spawnProcess();
    } catch (error) {
      throw new Error(safeMessage(error, "Could not start Codex app-server"));
    }
    this.process = child;
    child.stdout.on("data", (chunk: unknown) => this.onStdout(child, String(chunk)));
    // Drain stderr without logging it. Auth material must never reach Collie's logs.
    child.stderr.on("data", () => {});
    child.on("error", (error: Error) => this.onProcessFailure(child, error));
    child.on("exit", () => this.onProcessFailure(child, new Error("Codex app-server exited")));

    try {
      await this.sendRequest("initialize", {
        clientInfo: { name: "collie", title: "Collie", version: "0.0.0" },
      });
      this.write({ method: "initialized", params: {} });
    } catch (error) {
      // A timed-out initialize leaves a live but unusable process. Retire this exact child so the
      // next request retries from a clean handshake; its late exit must not tear down a replacement.
      if (this.process === child) this.process = null;
      child.kill();
      this.stdoutBuffer = "";
      throw error;
    }
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    await this.ensureStarted();
    return this.sendRequest(method, params);
  }

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server timed out during ${method}`));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private write(message: unknown): void {
    if (!this.process) throw new Error("Codex app-server is not running");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onStdout(child: CodexAppServerProcess, chunk: string): void {
    // A timed-out child can still flush stdout after its replacement starts. Never let stale bytes
    // enter the replacement's JSONL buffer or resolve one of its request ids.
    if (this.process !== child) return;
    this.stdoutBuffer += chunk;
    for (;;) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message: { id?: unknown; result?: unknown; error?: { message?: unknown } };
      try {
        message = JSON.parse(line) as typeof message;
      } catch {
        continue;
      }
      if (typeof message.id !== "number") continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(
            typeof message.error.message === "string"
              ? message.error.message
              : "Codex app-server request failed",
          ),
        );
      } else {
        pending.resolve(message.result);
      }
    }
  }

  private onProcessFailure(child: CodexAppServerProcess, error: Error): void {
    if (this.process !== child) return;
    this.process = null;
    this.starting = null;
    this.stdoutBuffer = "";
    this.failPending(new Error(safeMessage(error, "Codex app-server failed")));
  }

  private failPending(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
}

function safeMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  if (error.message.includes("ENOENT")) return "Codex CLI was not found";
  return error.message || fallback;
}
