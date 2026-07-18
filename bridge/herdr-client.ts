import type { AgentStatus } from "./types.ts";
import { decodeReplyLine, decodeStreamLine } from "./wire.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The Herdr socket adapter. THIS IS THE ONLY FILE that knows Herdr's method names
// and wire shapes. Everything else talks to the typed methods below, so a Herdr
// API change is a one-file fix. Protocol facts are documented in HERDR_API.md.
//
// Key fact: RPC is ONE-SHOT — the server closes the connection after a single
// response. So every request opens a fresh connection, reads one line, closes.
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

let idCounter = 0;

export class HerdrClient {
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
