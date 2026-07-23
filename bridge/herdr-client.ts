import type { AgentStatus } from "./types.ts";
import { decodeReplyLine, decodeStreamLine } from "./wire.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The Herdr adapter. THIS IS THE ONLY FILE that knows Herdr's method names and
// wire shapes. Everything else talks to the typed HerdrClient interface below, so
// a Herdr API change is a one-file fix. Protocol facts are documented in HERDR_API.md.
//
// TWO TRANSPORTS, ONE INTERFACE:
//   • SocketHerdrClient — mac/Linux. Opens Herdr's Unix socket directly (the
//     verified upstream path). RPC is ONE-SHOT: the server closes the connection
//     after a single response, so every request opens a fresh connection.
//   • CliHerdrClient — Windows. Herdr does NOT expose a filesystem AF_UNIX socket
//     there; it maps the socket path onto a Windows named pipe (see that class for
//     the full why). So on Windows we shell out to the `herdr` binary per RPC.
//
// createHerdrClient() picks the right one by platform. Callers only ever see the
// HerdrClient interface — neither transport leaks past this file.
// ─────────────────────────────────────────────────────────────────────────────

/** Raw wire shape of a workspace from `workspace.list`. */
interface WireWorkspace {
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count: number;
  tab_count: number;
  active_tab_id: string;
  agent_status: AgentStatus;
}

/** Raw wire shape of a tab from `tab.list`. */
interface WireTab {
  tab_id: string;
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count: number;
  agent_status: AgentStatus;
}

/** Raw wire shape of a pane from `pane.list` (and, identically, inside `session.snapshot`). */
interface WirePane {
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
  focused: boolean;
  cwd: string;
  foreground_cwd?: string;
  agent?: string | null;
  agent_status: AgentStatus;
  /** User-set pane label (herdr `pane.rename`). Present only once set — the key disappears when
   *  cleared with `label: null`, so absent/null both read as "no label". */
  label?: string | null;
  revision: number;
  /** Scroll position (herdr ≥ 0.7.2); optional so older servers that omit it still typecheck. Unused for now. */
  scroll?: {
    offset_from_bottom: number;
    max_offset_from_bottom: number;
    viewport_rows: number;
  } | null;
}

/**
 * Raw shape of `session.snapshot` — the whole herd in one reply, superseding the three parallel
 * list calls. `agents`/`layouts`/`focused_*` are carried too but intentionally unused: agents stay
 * derived from `panes` so there's one code path. Older servers predate the method (see StateEngine).
 */
export interface WireSnapshot {
  version: string;
  protocol: number;
  workspaces: WireWorkspace[];
  tabs: WireTab[];
  panes: WirePane[];
}

/** The freshly-created shell pane returned by tab.create / workspace.create (`root_pane`). */
export interface CreatedShell {
  paneId: string;
  workspaceId: string;
  workspaceLabel?: string;
  tabId: string;
  cwd: string;
}

export interface PaneRead {
  pane_id: string;
  text: string;
  truncated: boolean;
  revision: number;
}

type ReadSource = "visible" | "recent" | "recent-unwrapped";
type ReadFormat = "text" | "ansi";

/**
 * The typed Herdr contract every consumer talks to. Both transports below implement it, so nothing
 * outside this file cares whether a call went over the socket or the CLI.
 */
export interface HerdrClient {
  listWorkspaces(): Promise<WireWorkspace[]>;
  listPanes(): Promise<WirePane[]>;
  listTabs(): Promise<WireTab[]>;
  sessionSnapshot(): Promise<WireSnapshot>;
  subscribeEvents(opts: {
    subscriptions: Array<{ type: string; pane_id?: string }>;
    onUp: () => void;
    onEvent: (event: string, data: unknown) => void;
    onDown: (reason: string) => void;
  }): { close(): void };
  createTab(workspaceId: string, opts?: { label?: string; cwd?: string }): Promise<CreatedShell>;
  createWorkspace(opts: { cwd: string; label?: string }): Promise<CreatedShell>;
  readPane(paneId: string, source: ReadSource, lines: number, format?: ReadFormat): Promise<PaneRead>;
  sendPaneText(paneId: string, text: string): Promise<void>;
  sendPaneKeys(paneId: string, keys: string[]): Promise<void>;
  closePane(paneId: string): Promise<void>;
  renamePane(paneId: string, label: string | null): Promise<void>;
  renameTab(tabId: string, label: string): Promise<void>;
  closeTab(tabId: string): Promise<void>;
  ping(): Promise<boolean>;
}

/**
 * Pick the transport for this platform: the `herdr` CLI on Windows (named-pipe socket Bun can't
 * open — see {@link CliHerdrClient}), the Unix socket everywhere else. `herdrBin` is only consulted
 * on the Windows path.
 */
export function createHerdrClient(opts: {
  socketPath: string;
  herdrBin: string;
  timeoutMs?: number;
}): HerdrClient {
  if (process.platform === "win32") {
    return new CliHerdrClient(opts.socketPath, opts.herdrBin, opts.timeoutMs);
  }
  return new SocketHerdrClient(opts.socketPath, opts.timeoutMs);
}

let idCounter = 0;

// ─────────────────────────────────────────────────────────────────────────────
// mac/Linux transport: one-shot JSON-RPC over Herdr's Unix socket.
// ─────────────────────────────────────────────────────────────────────────────
export class SocketHerdrClient implements HerdrClient {
  constructor(
    private readonly socketPath: string,
    private readonly timeoutMs = 5000,
  ) {}

  /** One request, one reply, one connection. Rejects on error reply, timeout, or early close. */
  private request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = `b${++idCounter}`;
    return new Promise<T>((resolve, reject) => {
      let buf = "";
      let settled = false;
      // The live socket, once Bun.connect opens one. Hoisted so EVERY terminal path (timeout
      // included) can close it — otherwise a timeout leaves the FD dangling.
      let socket: Bun.Socket | null = null;
      // Stream-decode so a multi-byte UTF-8 codepoint split across chunk boundaries isn't
      // corrupted into replacement characters.
      const decoder = new TextDecoder("utf-8");
      // Settle BEFORE closing: socket.end() synchronously fires `close`, which re-enters finish —
      // but `settled` is already set there, so that reject is a no-op and we keep the real outcome.
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
        if (socket) {
          try {
            socket.end();
          } catch {
            /* ignore */
          }
          socket = null;
        }
      };
      const timer = setTimeout(
        () => finish(() => reject(new Error(`herdr ${method}: timed out after ${this.timeoutMs}ms`))),
        this.timeoutMs,
      );

      Bun.connect({
        unix: this.socketPath,
        socket: {
          open(s) {
            socket = s;
          },
          data(s, chunk) {
            socket = s;
            buf += decoder.decode(chunk, { stream: true });
            const nl = buf.indexOf("\n");
            if (nl < 0) return;
            const line = buf.slice(0, nl);
            finish(() => {
              try {
                resolve(decodeReplyLine<T>(line, method));
              } catch (e) {
                reject(e as Error);
              }
            });
          },
          error(_s, err) {
            finish(() => reject(err));
          },
          close() {
            finish(() => reject(new Error(`herdr ${method}: connection closed before reply`)));
          },
        },
      })
        .then((s) => {
          // Already settled (e.g. timed out) before the connection opened — close it so the FD
          // doesn't leak, and don't bother writing.
          if (settled) {
            try {
              s.end();
            } catch {
              /* ignore */
            }
            return;
          }
          socket = s;
          // Write only once the connection is established — matches the verified probe pattern.
          s.write(JSON.stringify({ id, method, params }) + "\n");
          s.flush();
        })
        .catch((err) => finish(() => reject(err)));
    });
  }

  async listWorkspaces(): Promise<WireWorkspace[]> {
    const r = await this.request<{ workspaces: WireWorkspace[] }>("workspace.list");
    return r.workspaces;
  }

  async listPanes(): Promise<WirePane[]> {
    const r = await this.request<{ panes: WirePane[] }>("pane.list");
    return r.panes;
  }

  /** All tabs across every workspace (`tab.list` with no filter returns the full set). */
  async listTabs(): Promise<WireTab[]> {
    const r = await this.request<{ tabs: WireTab[] }>("tab.list");
    return r.tabs;
  }

  /**
   * The whole herd in one round-trip (herdr ≥ 0.7.2). Replaces workspace.list + pane.list +
   * tab.list for the poll loop. An older server rejects the method with an "unknown variant" error
   * reply — StateEngine treats only that as a permanent signal to fall back to the three list calls.
   */
  async sessionSnapshot(): Promise<WireSnapshot> {
    const r = await this.request<{ type: string; snapshot: WireSnapshot }>("session.snapshot");
    return r.snapshot;
  }

  /**
   * Open a LONG-LIVED `events.subscribe` stream. Unlike every other method here (one-shot), this
   * connection stays open: after the ack, each line is an event. It exists ONLY to poke re-polls —
   * callers must not treat events as state. `onDown` fires exactly once when the stream ends for any
   * reason (error line, socket error, close, or a 5s ack timeout); `close()` is idempotent and also
   * ends it with reason "closed". Reconnect/backoff live in the caller (see EventPoker).
   */
  subscribeEvents(opts: {
    subscriptions: Array<{ type: string; pane_id?: string }>;
    onUp: () => void;
    onEvent: (event: string, data: unknown) => void;
    onDown: (reason: string) => void;
  }): { close(): void } {
    const id = `es${++idCounter}`;
    const decoder = new TextDecoder("utf-8");
    let buf = "";
    let socket: Bun.Socket | null = null;
    let down = false;
    let acked = false;

    // The single terminal path. Guarded so onDown never fires twice, and closes the FD once.
    const fireDown = (reason: string) => {
      if (down) return;
      down = true;
      clearTimeout(ackTimer);
      if (socket) {
        try {
          socket.end();
        } catch {
          /* ignore */
        }
        socket = null;
      }
      opts.onDown(reason);
    };

    // A server that accepts the connection but never acks (hung) counts as down, not healthy.
    const ackTimer = setTimeout(() => fireDown("ack timeout"), 5000);

    const handleLine = (line: string) => {
      if (line === "") return;
      let decoded;
      try {
        decoded = decodeStreamLine(line);
      } catch (e) {
        fireDown(`protocol error: ${(e as Error).message}`);
        return;
      }
      if (decoded.kind === "error") {
        fireDown(`${decoded.code}: ${decoded.message}`);
        return;
      }
      if (decoded.kind === "ack") {
        if (acked) return;
        acked = true;
        clearTimeout(ackTimer);
        opts.onUp();
        return;
      }
      opts.onEvent(decoded.event, decoded.data);
    };

    Bun.connect({
      unix: this.socketPath,
      socket: {
        open(s) {
          socket = s;
        },
        // Multiple lines can arrive per chunk (bursty events); drain ALL complete lines and keep the
        // stream open. Stream-decode so a multi-byte codepoint split across chunks isn't corrupted.
        data(s, chunk) {
          socket = s;
          buf += decoder.decode(chunk, { stream: true });
          let nl = buf.indexOf("\n");
          while (nl >= 0 && !down) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            handleLine(line);
            nl = buf.indexOf("\n");
          }
        },
        error(_s, err) {
          fireDown(err.message || "socket error");
        },
        close() {
          fireDown("connection closed");
        },
      },
    })
      .then((s) => {
        if (down) {
          try {
            s.end();
          } catch {
            /* ignore */
          }
          return;
        }
        socket = s;
        s.write(JSON.stringify({ id, method: "events.subscribe", params: { subscriptions: opts.subscriptions } }) + "\n");
        s.flush();
      })
      .catch((err) => fireDown((err as Error).message || "connect failed"));

    return { close: () => fireDown("closed") };
  }

  /**
   * Create a new tab in a workspace, opening a fresh shell pane. `cwd` is optional — omitted, the
   * tab inherits the workspace's directory (verified). `focus:false` so we never yank the desktop
   * TUI's focus. Returns the new shell pane to navigate into.
   */
  async createTab(workspaceId: string, opts: { label?: string; cwd?: string } = {}): Promise<CreatedShell> {
    const params: Record<string, unknown> = { workspace_id: workspaceId, focus: false };
    if (opts.label) params.label = opts.label;
    if (opts.cwd) params.cwd = opts.cwd;
    const r = await this.request<{ root_pane: WirePane }>("tab.create", params);
    const p = r.root_pane;
    return { paneId: p.pane_id, workspaceId: p.workspace_id, tabId: p.tab_id, cwd: p.cwd };
  }

  /**
   * Create a new workspace ("space") with a fresh shell pane rooted at `cwd`. `focus:false` to
   * leave the desktop TUI undisturbed. Returns the new shell pane (with its workspace label).
   */
  async createWorkspace(opts: { cwd: string; label?: string }): Promise<CreatedShell> {
    const params: Record<string, unknown> = { cwd: opts.cwd, focus: false };
    if (opts.label) params.label = opts.label;
    const r = await this.request<{
      workspace: WireWorkspace;
      root_pane: WirePane;
    }>("workspace.create", params);
    const p = r.root_pane;
    return {
      paneId: p.pane_id,
      workspaceId: p.workspace_id,
      workspaceLabel: r.workspace.label,
      tabId: p.tab_id,
      cwd: p.cwd,
    };
  }

  async readPane(
    paneId: string,
    source: ReadSource,
    lines: number,
    format: ReadFormat = "text",
  ): Promise<PaneRead> {
    const r = await this.request<{ read: PaneRead }>("pane.read", {
      pane_id: paneId,
      source,
      lines,
      // "text" = plain (no escapes); "ansi" = SGR color codes (verified: no cursor sequences),
      // parsed + escaped safely on the client to render a faithful, colored terminal mirror.
      format,
    });
    return r.read;
  }

  /** Type literal text into a pane's terminal (does not submit). */
  sendPaneText(paneId: string, text: string): Promise<void> {
    return this.request<void>("pane.send_text", { pane_id: paneId, text });
  }

  /** Send key names (e.g. ["Enter"]) to a pane — used to submit a reply. */
  sendPaneKeys(paneId: string, keys: string[]): Promise<void> {
    return this.request<void>("pane.send_keys", { pane_id: paneId, keys });
  }

  /** Close a pane, terminating its agent ("kill"). Resolves on Herdr's `{type:"ok"}` reply. */
  closePane(paneId: string): Promise<void> {
    return this.request<void>("pane.close", { pane_id: paneId });
  }

  /**
   * Set or clear a pane's label. `label: null` clears it (the key then disappears from pane
   * records). Resolves on Herdr's `pane_info` reply — the returned pane isn't consumed here, the
   * next snapshot poll carries the new label (pane.rename emits no event). Bad id → `pane_not_found`.
   */
  renamePane(paneId: string, label: string | null): Promise<void> {
    return this.request<void>("pane.rename", { pane_id: paneId, label });
  }

  /**
   * Set a tab's label. Unlike {@link renamePane}, `label` is a NON-null string: herdr's `tab.rename`
   * rejects `null` (`invalid type: null, expected a string`) and stores an empty string literally
   * rather than clearing to the default number — both live-verified 2026-07-19 — so a tab has no
   * "clear". Resolves on herdr's `tab_info` reply; the new label surfaces on the next snapshot poll
   * (tab.rename also emits a `tab_renamed` event, which Collie doesn't consume). Bad id → `tab_not_found`.
   */
  renameTab(tabId: string, label: string): Promise<void> {
    return this.request<void>("tab.rename", { tab_id: tabId, label });
  }

  /**
   * Close a tab, terminating EVERY pane inside it (live-verified 2026-07-19: the tab's shell/agent
   * panes all disappear with it — closing a tab is a bulk pane-close). Resolves on herdr's
   * `{type:"ok"}` reply; the closure surfaces on the next `session.snapshot` poll (tab.close also
   * emits a `tab_closed` event, which Collie doesn't consume). Bad id → `tab_not_found`.
   */
  closeTab(tabId: string): Promise<void> {
    return this.request<void>("tab.close", { tab_id: tabId });
  }

  /** Reachability check for the connected/disconnected banner. */
  async ping(): Promise<boolean> {
    try {
      await this.listWorkspaces();
      return true;
    } catch {
      return false;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Windows transport: spawn the `herdr` CLI per RPC.
//
// WHY THIS SPAWNS THE CLI INSTEAD OF OPENING THE SOCKET:
// On Windows, Herdr does NOT expose a filesystem AF_UNIX socket. It uses the Rust
// `interprocess` crate, which maps the socket path onto a Windows *named pipe*
// (`\\.\pipe\<path>`) guarded by an in-crate handshake. Bun's `Bun.connect({unix})`
// targets native AF_UNIX and can't reach a named pipe at all; even a pipe-aware raw
// client (Node net / .NET NamedPipeClientStream) gets the connection accepted and
// then immediately EOF'd, because it doesn't speak the crate's handshake. Verified
// empirically 2026-07-13. So the ONLY reliable local client for that pipe is the
// same-version `herdr` binary itself — which exposes every method Collie needs as a
// CLI subcommand and emits the identical JSON envelopes. We shell out to it.
//
// Same one-request-per-invocation shape as the socket path: one process spawn per RPC.
// `events.subscribe` has no CLI equivalent, so it degrades to a poll-only fallback
// (see subscribeEvents) — StateEngine already treats events as a mere poke, never a
// source of truth, so correctness is unaffected; only the poke latency changes.
// ─────────────────────────────────────────────────────────────────────────────

/** Outcome of one `herdr` CLI invocation: captured stdout/stderr and the process exit code. */
interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Transient Windows named-pipe drop. Herdr's `interprocess` pipe server occasionally accepts then
 * resets a connection under concurrent load — its own CLI hits it too. Matched on the CLI's error
 * text so {@link CliHerdrClient.runRetry} can retry a read-only call once instead of failing the tick.
 */
function isTransientPipeError(r: CliResult): boolean {
  const s = r.stderr;
  return (
    r.code !== 0 &&
    (s.includes("BrokenPipe") ||
      s.includes("being closed") ||
      s.includes("The pipe is being closed") ||
      s.includes("kind: BrokenPipe"))
  );
}

export class CliHerdrClient implements HerdrClient {
  /**
   * @param socketPath  Herdr's control socket/pipe path. Passed to every CLI call via
   *                    `HERDR_SOCKET_PATH` so a multi-session bridge targets the right herd.
   * @param herdrBin    Absolute path to `herdr` (or `herdr.exe`). Resolved once in config.
   * @param timeoutMs   Per-invocation wall-clock budget; a hung CLI is killed and the call rejects.
   */
  constructor(
    private readonly socketPath: string,
    private readonly herdrBin: string,
    private readonly timeoutMs = 5000,
  ) {}

  /** Spawn `herdr <args>` with the session's socket in the env, capturing stdout/stderr/exit. */
  private async run(args: string[]): Promise<CliResult> {
    const proc = Bun.spawn([this.herdrBin, ...args], {
      // Target THIS session's herd. Everything else inherits so the CLI finds its config/channel.
      env: { ...process.env, HERDR_SOCKET_PATH: this.socketPath },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });

    // Kill a hung CLI so a wedged pipe can't stall a poll tick forever (mirrors the socket timeout).
    const killer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* already exited */
      }
    }, this.timeoutMs);

    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { code, stdout, stderr };
    } finally {
      clearTimeout(killer);
    }
  }

  /**
   * Run a read-only CLI call, retrying ONCE on a transient pipe drop. Only safe for idempotent
   * reads (list/snapshot/read) — never for send/create/close, where a retry could double-apply.
   */
  private async runRetry(args: string[]): Promise<CliResult> {
    const first = await this.run(args);
    if (isTransientPipeError(first)) return this.run(args);
    return first;
  }

  /**
   * Turn a CLI result into the `result` payload of a full `{"id","result":{...}}` envelope, or throw
   * a descriptive Error. `list`/`snapshot`/`create`/`close` all print that envelope on stdout (exit
   * 0) and an `{"error":{code,message}}` envelope OR a plain `Error: ...` transport line on stderr
   * (exit ≠ 0). `method` only decorates the message and drives the `unknown variant` fallback that
   * StateEngine keys on.
   */
  private envelope<T>(r: CliResult, method: string): T {
    if (r.code === 0 && r.stdout.trim()) {
      return decodeReplyLine<T>(r.stdout.trim(), method);
    }
    throw new Error(`herdr ${method}: ${this.errText(r)}`);
  }

  /** Best-effort human-readable failure text from a CLI result (error-envelope message, else raw stderr). */
  private errText(r: CliResult): string {
    const raw = (r.stderr || r.stdout).trim();
    try {
      const parsed = JSON.parse(raw) as { error?: { code?: string; message?: string }; code?: string; message?: string };
      const err = parsed.error ?? parsed;
      if (err && (err.code || err.message)) return `${err.code ?? "error"}: ${err.message ?? ""}`.trim();
    } catch {
      /* not JSON — fall through to raw */
    }
    return raw || `exited ${r.code}`;
  }

  /** A write/create/close call: exit 0 = success; otherwise throw the decoded error. No retry (not idempotent). */
  private async runVoid(args: string[], method: string): Promise<void> {
    const r = await this.run(args);
    if (r.code !== 0) throw new Error(`herdr ${method}: ${this.errText(r)}`);
  }

  async listWorkspaces(): Promise<WireWorkspace[]> {
    const r = await this.runRetry(["workspace", "list"]);
    return this.envelope<{ workspaces: WireWorkspace[] }>(r, "workspace.list").workspaces;
  }

  async listPanes(): Promise<WirePane[]> {
    const r = await this.runRetry(["pane", "list"]);
    return this.envelope<{ panes: WirePane[] }>(r, "pane.list").panes;
  }

  /** All tabs across every workspace (`tab list` with no filter returns the full set). */
  async listTabs(): Promise<WireTab[]> {
    const r = await this.runRetry(["tab", "list"]);
    return this.envelope<{ tabs: WireTab[] }>(r, "tab.list").tabs;
  }

  /**
   * The whole herd in one round-trip (`herdr api snapshot`). Replaces the three list calls for the
   * poll loop. An older server without the method rejects it; the CLI surfaces that as an "unknown
   * variant" error, which StateEngine treats as a permanent signal to fall back to the list calls.
   */
  async sessionSnapshot(): Promise<WireSnapshot> {
    const r = await this.runRetry(["api", "snapshot"]);
    return this.envelope<{ type: string; snapshot: WireSnapshot }>(r, "session.snapshot").snapshot;
  }

  /**
   * No streaming transport exists over the CLI, so there is no live event stream on Windows. Report
   * "down" immediately and idempotently; EventPoker then keeps the engine on the fast poll cadence
   * (COLLIE_POLL_MS) and periodically retries this — a harmless, cheap no-op each time. Events were
   * only ever a poke (StateEngine polls as the source of truth), so this costs poke latency, not
   * correctness. `onUp`/`onEvent` are intentionally never called.
   */
  subscribeEvents(opts: {
    subscriptions: Array<{ type: string; pane_id?: string }>;
    onUp: () => void;
    onEvent: (event: string, data: unknown) => void;
    onDown: (reason: string) => void;
  }): { close(): void } {
    // Fire onDown on a microtask (not synchronously) so EventPoker finishes assigning `this.stream`
    // before its onDown guard runs — matching how the socket connect reported failure asynchronously.
    queueMicrotask(() => opts.onDown("no event stream on windows (cli transport) — polling"));
    return { close: () => {} };
  }

  /**
   * Create a new tab in a workspace, opening a fresh shell pane. `cwd` optional — omitted, the tab
   * inherits the workspace's directory. `--no-focus` so we never yank the desktop TUI's focus.
   */
  async createTab(workspaceId: string, opts: { label?: string; cwd?: string } = {}): Promise<CreatedShell> {
    const args = ["tab", "create", "--workspace", workspaceId, "--no-focus"];
    if (opts.label) args.push("--label", opts.label);
    if (opts.cwd) args.push("--cwd", opts.cwd);
    const r = await this.run(args);
    const p = this.envelope<{ root_pane: WirePane }>(r, "tab.create").root_pane;
    return { paneId: p.pane_id, workspaceId: p.workspace_id, tabId: p.tab_id, cwd: p.cwd };
  }

  /**
   * Create a new workspace ("space") with a fresh shell pane rooted at `cwd`. `--no-focus` to leave
   * the desktop TUI undisturbed. Returns the new shell pane (with its workspace label).
   */
  async createWorkspace(opts: { cwd: string; label?: string }): Promise<CreatedShell> {
    const args = ["workspace", "create", "--cwd", opts.cwd, "--no-focus"];
    if (opts.label) args.push("--label", opts.label);
    const r = await this.run(args);
    const decoded = this.envelope<{ workspace: WireWorkspace; root_pane: WirePane }>(r, "workspace.create");
    const p = decoded.root_pane;
    return {
      paneId: p.pane_id,
      workspaceId: p.workspace_id,
      workspaceLabel: decoded.workspace.label,
      tabId: p.tab_id,
      cwd: p.cwd,
    };
  }

  /**
   * Read pane scrollback. Unlike the JSON-returning calls, `herdr pane read` prints the pane's RAW
   * TEXT to stdout (with SGR escapes when `format:"ansi"`), not a JSON envelope — so we wrap it into
   * the {@link PaneRead} shape the rest of the bridge expects. `truncated` isn't exposed by the CLI
   * (always false); `revision` is a stub on herdr 0.7.x (always 0 — see HERDR_API.md), so 0 matches
   * what the socket path returned anyway.
   */
  async readPane(
    paneId: string,
    source: ReadSource,
    lines: number,
    format: ReadFormat = "text",
  ): Promise<PaneRead> {
    const r = await this.runRetry([
      "pane",
      "read",
      paneId,
      "--source",
      source,
      "--lines",
      String(lines),
      "--format",
      format,
    ]);
    if (r.code !== 0) throw new Error(`herdr pane.read: ${this.errText(r)}`);
    return { pane_id: paneId, text: r.stdout, truncated: false, revision: 0 };
  }

  /** Type literal text into a pane's terminal (does not submit). */
  sendPaneText(paneId: string, text: string): Promise<void> {
    return this.runVoid(["pane", "send-text", paneId, text], "pane.send_text");
  }

  /** Send key names (e.g. ["Enter"]) to a pane — used to submit a reply. Each key is a separate arg. */
  sendPaneKeys(paneId: string, keys: string[]): Promise<void> {
    return this.runVoid(["pane", "send-keys", paneId, ...keys], "pane.send_keys");
  }

  /** Close a pane, terminating its agent ("kill"). */
  closePane(paneId: string): Promise<void> {
    return this.runVoid(["pane", "close", paneId], "pane.close");
  }

  /**
   * Set or clear a pane's label. `label: null` clears it (the key then disappears from pane
   * records). The next snapshot poll carries the new label (pane.rename emits no event).
   * Bad id → `pane_not_found`.
   */
  renamePane(paneId: string, label: string | null): Promise<void> {
    const arg = label === null ? "--clear" : label;
    return this.runVoid(["pane", "rename", paneId, arg], "pane.rename");
  }

  /**
   * Set a tab's label. Unlike {@link renamePane}, `label` is a NON-null string: herdr's `tab.rename`
   * rejects `null` and stores an empty string literally rather than clearing to the default number,
   * so a tab has no "clear". The new label surfaces on the next snapshot poll. Bad id → `tab_not_found`.
   */
  renameTab(tabId: string, label: string): Promise<void> {
    return this.runVoid(["tab", "rename", tabId, label], "tab.rename");
  }

  /**
   * Close a tab, terminating EVERY pane inside it (closing a tab is a bulk pane-close). The closure
   * surfaces on the next `session.snapshot` poll. Bad id → `tab_not_found`.
   */
  closeTab(tabId: string): Promise<void> {
    return this.runVoid(["tab", "close", tabId], "tab.close");
  }

  /** Reachability check for the connected/disconnected banner. */
  async ping(): Promise<boolean> {
    try {
      await this.listWorkspaces();
      return true;
    } catch {
      return false;
    }
  }
}
