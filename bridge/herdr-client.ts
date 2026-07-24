import type { AgentStatus } from "./types.ts";
import { decodeReplyLine, decodeStreamLine } from "./wire.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The Herdr adapter. THIS IS THE ONLY FILE that knows Herdr's method names and
// wire shapes. Everything else talks to the typed HerdrClient class below, so a
// Herdr API change is a one-file fix. Protocol facts are documented in HERDR_API.md.
//
// ONE CLIENT, PLUGGABLE TRANSPORT:
//   • HerdrClient  — every method and its verified doc comment, written once. It
//     never touches a socket or a process; it only calls Transport.request().
//   • SocketTransport — mac/Linux. Opens Herdr's Unix socket directly (the verified
//     upstream path). RPC is ONE-SHOT: the server closes after one response, so
//     every request opens a fresh connection. Streams events.subscribe.
//   • CliTransport — Windows. Herdr does NOT expose a filesystem AF_UNIX socket
//     there; it maps the socket path onto a Windows named pipe (see that class for
//     the full why). So we shell out to the `herdr` binary per RPC. No event stream.
//
// The divergence between platforms is TRANSPORT, not semantics — which is why the
// seam is here and not one-class-per-platform. createHerdrClient() picks the transport;
// callers only ever see HerdrClient.
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

export interface SubscribeOptions {
  subscriptions: Array<{ type: string; pane_id?: string }>;
  onUp: () => void;
  onEvent: (event: string, data: unknown) => void;
  onDown: (reason: string) => void;
}

/** Handle to an open event stream; `close()` is idempotent. */
export interface StreamHandle {
  close(): void;
}

/**
 * The transport seam. A transport moves ONE request to Herdr and (optionally) streams events.
 * Everything platform-specific lives behind this — the socket vs. the CLI — so HerdrClient's methods
 * are written once on top. `request()` returns the `result` payload of Herdr's reply envelope.
 */
export interface Transport {
  request<T>(method: string, params?: Record<string, unknown>): Promise<T>;
  /**
   * Open a long-lived event stream, or return `null` when this transport cannot stream (the CLI has
   * no `events.subscribe` equivalent). A `null` return is a first-class signal to EventPoker that
   * this herd is poll-only — NOT an error to retry.
   */
  subscribeEvents(opts: SubscribeOptions): StreamHandle | null;
}

/**
 * The typed Herdr contract every consumer talks to. One implementation, transport-agnostic: each
 * method builds params and delegates to {@link Transport.request}, so a Herdr API change is one
 * method plus (on Windows) one argv-table entry — never a change duplicated across platforms.
 */
export class HerdrClient {
  constructor(private readonly transport: Transport) {}

  async listWorkspaces(): Promise<WireWorkspace[]> {
    const r = await this.transport.request<{ workspaces: WireWorkspace[] }>("workspace.list");
    return r.workspaces;
  }

  async listPanes(): Promise<WirePane[]> {
    const r = await this.transport.request<{ panes: WirePane[] }>("pane.list");
    return r.panes;
  }

  /** All tabs across every workspace (`tab.list` with no filter returns the full set). */
  async listTabs(): Promise<WireTab[]> {
    const r = await this.transport.request<{ tabs: WireTab[] }>("tab.list");
    return r.tabs;
  }

  /**
   * The whole herd in one round-trip (herdr ≥ 0.7.2). Replaces workspace.list + pane.list +
   * tab.list for the poll loop. An older server rejects the method with an "unknown variant" error
   * reply — StateEngine treats only that as a permanent signal to fall back to the three list calls.
   */
  async sessionSnapshot(): Promise<WireSnapshot> {
    const r = await this.transport.request<{ type: string; snapshot: WireSnapshot }>("session.snapshot");
    return r.snapshot;
  }

  /**
   * Open a LONG-LIVED `events.subscribe` stream, or return `null` on a transport that can't stream
   * (Windows/CLI). When non-null: after the ack, each line is an event; it exists ONLY to poke
   * re-polls — callers must not treat events as state. `onDown` fires exactly once when the stream
   * ends for any reason; `close()` is idempotent. Reconnect/backoff live in the caller (EventPoker).
   */
  subscribeEvents(opts: SubscribeOptions): StreamHandle | null {
    return this.transport.subscribeEvents(opts);
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
    const r = await this.transport.request<{ root_pane: WirePane }>("tab.create", params);
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
    const r = await this.transport.request<{ workspace: WireWorkspace; root_pane: WirePane }>(
      "workspace.create",
      params,
    );
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
    const r = await this.transport.request<{ read: PaneRead }>("pane.read", {
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
    return this.transport.request<void>("pane.send_text", { pane_id: paneId, text });
  }

  /** Send key names (e.g. ["Enter"]) to a pane — used to submit a reply. */
  sendPaneKeys(paneId: string, keys: string[]): Promise<void> {
    return this.transport.request<void>("pane.send_keys", { pane_id: paneId, keys });
  }

  /** Close a pane, terminating its agent ("kill"). Resolves on Herdr's `{type:"ok"}` reply. */
  closePane(paneId: string): Promise<void> {
    return this.transport.request<void>("pane.close", { pane_id: paneId });
  }

  /**
   * Set or clear a pane's label. `label: null` clears it (the key then disappears from pane
   * records). Resolves on Herdr's `pane_info` reply — the returned pane isn't consumed here, the
   * next snapshot poll carries the new label (pane.rename emits no event). Bad id → `pane_not_found`.
   */
  renamePane(paneId: string, label: string | null): Promise<void> {
    return this.transport.request<void>("pane.rename", { pane_id: paneId, label });
  }

  /**
   * Set a tab's label. Unlike {@link renamePane}, `label` is a NON-null string: herdr's `tab.rename`
   * rejects `null` (`invalid type: null, expected a string`) and stores an empty string literally
   * rather than clearing to the default number — both live-verified 2026-07-19 — so a tab has no
   * "clear". Resolves on herdr's `tab_info` reply; the new label surfaces on the next snapshot poll
   * (tab.rename also emits a `tab_renamed` event, which Collie doesn't consume). Bad id → `tab_not_found`.
   */
  renameTab(tabId: string, label: string): Promise<void> {
    return this.transport.request<void>("tab.rename", { tab_id: tabId, label });
  }

  /**
   * Close a tab, terminating EVERY pane inside it (live-verified 2026-07-19: the tab's shell/agent
   * panes all disappear with it — closing a tab is a bulk pane-close). Resolves on herdr's
   * `{type:"ok"}` reply; the closure surfaces on the next `session.snapshot` poll (tab.close also
   * emits a `tab_closed` event, which Collie doesn't consume). Bad id → `tab_not_found`.
   */
  closeTab(tabId: string): Promise<void> {
    return this.transport.request<void>("tab.close", { tab_id: tabId });
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

/** Which transport to use. `auto` = CLI on Windows, socket elsewhere; the others force it. */
export type TransportMode = "auto" | "cli" | "socket";

/**
 * Build a HerdrClient over the right transport. `auto` (the default) picks the `herdr` CLI on
 * Windows — where Herdr's socket is a named pipe Bun can't open (see {@link CliTransport}) — and the
 * Unix socket everywhere else. `cli`/`socket` force one regardless of platform, which is how someone
 * on macOS/Linux can exercise the Windows path (COLLIE_HERDR_TRANSPORT). `herdrBin` is only consulted
 * by the CLI transport.
 */
export function createHerdrClient(opts: {
  socketPath: string;
  herdrBin: string;
  transport?: TransportMode;
  timeoutMs?: number;
}): HerdrClient {
  const mode = opts.transport ?? "auto";
  const useCli = mode === "cli" || (mode === "auto" && process.platform === "win32");
  const transport: Transport = useCli
    ? new CliTransport(opts.socketPath, opts.herdrBin, opts.timeoutMs)
    : new SocketTransport(opts.socketPath, opts.timeoutMs);
  return new HerdrClient(transport);
}

let idCounter = 0;

// ─────────────────────────────────────────────────────────────────────────────
// mac/Linux transport: one-shot JSON-RPC over Herdr's Unix socket, plus the
// long-lived events.subscribe stream.
// ─────────────────────────────────────────────────────────────────────────────
export class SocketTransport implements Transport {
  constructor(
    private readonly socketPath: string,
    private readonly timeoutMs = 5000,
  ) {}

  /** One request, one reply, one connection. Rejects on error reply, timeout, or early close. */
  request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
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

  /**
   * The socket streams, so this always returns a handle. After the ack each line is an event;
   * `onDown` fires exactly once when the stream ends for any reason (error line, socket error,
   * close, or a 5s ack timeout); `close()` is idempotent and ends it with reason "closed".
   */
  subscribeEvents(opts: SubscribeOptions): StreamHandle {
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
// One process spawn per RPC. `events.subscribe` has no CLI equivalent, so subscribeEvents
// returns null (see below) — StateEngine already treats events as a mere poke, never a
// source of truth, so correctness is unaffected; only poke latency changes.
// ─────────────────────────────────────────────────────────────────────────────

/** Outcome of one `herdr` CLI invocation: captured stdout/stderr and the process exit code. */
export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawns one `herdr` invocation and captures its result. Injected into {@link CliTransport} so the
 * argv table — the one part neither reader can verify by eye — is exercised by `bun test` with a
 * fake runner, instead of shelling out for real.
 */
export type CliRunner = (
  bin: string,
  args: string[],
  env: Record<string, string | undefined>,
  timeoutMs: number,
) => Promise<CliResult>;

/** How to interpret a CLI invocation's output for a given method. */
type ResultKind = "json" | "text" | "void";

/** Per-method CLI mapping: how to build argv from the JSON-RPC params, and how to read the result. */
interface CliSpec {
  argv: (params: Record<string, unknown>) => string[];
  kind: ResultKind;
}

const str = (v: unknown): string => String(v ?? "");

// method → (argv builder, result kind). The single source of truth for the Windows CLI surface;
// adding a Herdr method means one entry here plus the typed method on HerdrClient.
const CLI_SPECS: Record<string, CliSpec> = {
  "workspace.list": { kind: "json", argv: () => ["workspace", "list"] },
  "pane.list": { kind: "json", argv: () => ["pane", "list"] },
  "tab.list": { kind: "json", argv: () => ["tab", "list"] },
  "session.snapshot": { kind: "json", argv: () => ["api", "snapshot"] },
  "tab.create": {
    kind: "json",
    argv: (p) => {
      const args = ["tab", "create", "--workspace", str(p.workspace_id), "--no-focus"];
      if (p.label) args.push("--label", str(p.label));
      if (p.cwd) args.push("--cwd", str(p.cwd));
      return args;
    },
  },
  "workspace.create": {
    kind: "json",
    argv: (p) => {
      const args = ["workspace", "create", "--cwd", str(p.cwd), "--no-focus"];
      if (p.label) args.push("--label", str(p.label));
      return args;
    },
  },
  "pane.read": {
    kind: "text",
    argv: (p) => [
      "pane",
      "read",
      str(p.pane_id),
      "--source",
      str(p.source),
      "--lines",
      str(p.lines),
      "--format",
      str(p.format),
    ],
  },
  "pane.send_text": { kind: "void", argv: (p) => ["pane", "send-text", str(p.pane_id), str(p.text)] },
  "pane.send_keys": {
    kind: "void",
    argv: (p) => ["pane", "send-keys", str(p.pane_id), ...(p.keys as string[])],
  },
  "pane.close": { kind: "void", argv: (p) => ["pane", "close", str(p.pane_id)] },
  "pane.rename": {
    kind: "void",
    // herdr's socket clears a label with `label:null`; the CLI clears it with `--clear`.
    argv: (p) => ["pane", "rename", str(p.pane_id), p.label === null ? "--clear" : str(p.label)],
  },
  "tab.rename": { kind: "void", argv: (p) => ["tab", "rename", str(p.tab_id), str(p.label)] },
  "tab.close": { kind: "void", argv: (p) => ["tab", "close", str(p.tab_id)] },
};

/**
 * Default runner: spawn `herdr <args>` with the session's socket in the env, capturing
 * stdout/stderr/exit, killing a hung CLI at `timeoutMs`. A missing binary is translated to an
 * actionable message rather than a raw ENOENT, since that's the one setup error a Windows user hits.
 */
const defaultCliRunner: CliRunner = async (bin, args, env, timeoutMs) => {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn([bin, ...args], { env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  } catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code === "ENOENT") {
      throw new Error(
        `herdr not found at "${bin}" — set HERDR_BIN_PATH or COLLIE_HERDR_BIN to the herdr executable`,
      );
    }
    throw new Error(`herdr spawn failed ("${bin}"): ${err.message ?? String(e)}`);
  }

  // Kill a hung CLI so a wedged pipe can't stall a poll tick forever (mirrors the socket timeout).
  const killer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      /* already exited */
    }
  }, timeoutMs);

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
};

export class CliTransport implements Transport {
  /**
   * @param socketPath  Herdr's control socket/pipe path. Passed to every CLI call via
   *                    `HERDR_SOCKET_PATH` so a multi-session bridge targets the right herd.
   * @param herdrBin    Absolute path to `herdr` (or `herdr.exe`). Resolved once in config.
   * @param timeoutMs   Per-invocation wall-clock budget; a hung CLI is killed and the call rejects.
   * @param runner      Spawns one invocation; injected so the argv table is unit-testable.
   */
  constructor(
    private readonly socketPath: string,
    private readonly herdrBin: string,
    private readonly timeoutMs = 5000,
    private readonly runner: CliRunner = defaultCliRunner,
  ) {}

  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const spec = CLI_SPECS[method];
    if (!spec) throw new Error(`herdr ${method}: no CLI mapping (unsupported on the Windows transport)`);

    const r = await this.runner(this.herdrBin, spec.argv(params), { ...process.env, HERDR_SOCKET_PATH: this.socketPath }, this.timeoutMs);

    if (spec.kind === "void") {
      if (r.code !== 0) throw new Error(`herdr ${method}: ${this.errText(r)}`);
      return undefined as T;
    }

    if (spec.kind === "text") {
      // `herdr pane read` prints the pane's RAW TEXT to stdout, not a JSON envelope — so synthesize
      // the {read} envelope the rest of the bridge expects. `revision` is a stub on herdr 0.7.x
      // (always 0), matching what the socket path returned anyway.
      if (r.code !== 0) throw new Error(`herdr ${method}: ${this.errText(r)}`);
      return {
        read: {
          pane_id: str(params.pane_id),
          text: r.stdout,
          truncated: approximateTruncated(r.stdout, Number(params.lines)),
          revision: 0,
        },
      } as T;
    }

    // json: the CLI prints a full `{"id","result":{...}}` envelope on stdout (exit 0), or an error
    // envelope / plain transport line on stderr (exit ≠ 0). decodeReplyLine unwraps `result` and
    // throws the error message — which carries "unknown variant" for the session.snapshot fallback.
    if (r.code === 0 && r.stdout.trim()) return decodeReplyLine<T>(r.stdout.trim(), method);
    throw new Error(`herdr ${method}: ${this.errText(r)}`);
  }

  /** The CLI has no streaming transport; poll-only. Null tells EventPoker so — not an error to retry. */
  subscribeEvents(_opts: SubscribeOptions): StreamHandle | null {
    return null;
  }

  /** Human-readable failure text from a CLI result (error-envelope message, else raw stderr). */
  private errText(r: CliResult): string {
    const raw = (r.stderr || r.stdout).trim();
    try {
      const parsed = JSON.parse(raw) as {
        error?: { code?: string; message?: string };
        code?: string;
        message?: string;
      };
      const err = parsed.error ?? parsed;
      if (err && (err.code || err.message)) return `${err.code ?? "error"}: ${err.message ?? ""}`.trim();
    } catch {
      /* not JSON — fall through to raw */
    }
    return raw || `exited ${r.code}`;
  }
}

/**
 * Approximate herdr's `truncated` flag, which the CLI doesn't expose. If a `--lines N` read comes
 * back with at least N lines, older scrollback almost certainly exists beyond the window, so report
 * truncated — that's what gates agent-chat's "load older lines" button. An exact count isn't
 * possible without the flag; this errs toward showing the button rather than hiding history.
 */
function approximateTruncated(text: string, requestedLines: number): boolean {
  if (!Number.isFinite(requestedLines) || requestedLines <= 0) return false;
  const lines = text.split(/\r?\n/);
  // A trailing newline yields a final empty element that isn't a real line.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.length >= requestedLines;
}
