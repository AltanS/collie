import type { AgentStatus } from "./types.ts";

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

/** Raw wire shape of a pane from `pane.list`. */
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
  revision: number;
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

export type ReadSource = "visible" | "recent" | "recent-unwrapped";
export type ReadFormat = "text" | "ansi";

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
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(
        () => finish(() => reject(new Error(`herdr ${method}: timed out after ${this.timeoutMs}ms`))),
        this.timeoutMs,
      );

      Bun.connect({
        unix: this.socketPath,
        socket: {
          data(socket, chunk) {
            buf += chunk.toString();
            const nl = buf.indexOf("\n");
            if (nl < 0) return;
            const line = buf.slice(0, nl);
            // Settle BEFORE closing — socket.end() synchronously fires `close`, which would
            // otherwise reject this request before we resolve it.
            finish(() => {
              try {
                const msg = JSON.parse(line) as
                  | { result: T }
                  | { error: { code: string; message: string } };
                if ("error" in msg) {
                  reject(new Error(`herdr ${method}: ${msg.error.code}: ${msg.error.message}`));
                } else {
                  resolve(msg.result);
                }
              } catch (e) {
                reject(new Error(`herdr ${method}: bad reply: ${(e as Error).message}`));
              }
            });
            try {
              socket.end();
            } catch {
              /* ignore */
            }
          },
          error(_socket, err) {
            finish(() => reject(err));
          },
          close() {
            finish(() => reject(new Error(`herdr ${method}: connection closed before reply`)));
          },
        },
      })
        .then((socket) => {
          // Write only once the connection is established — matches the verified probe pattern.
          socket.write(JSON.stringify({ id, method, params }) + "\n");
          socket.flush();
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
  sendPaneText(paneId: string, text: string): Promise<unknown> {
    return this.request("pane.send_text", { pane_id: paneId, text });
  }

  /** Send key names (e.g. ["Enter"]) to a pane — used to submit a reply. */
  sendPaneKeys(paneId: string, keys: string[]): Promise<unknown> {
    return this.request("pane.send_keys", { pane_id: paneId, keys });
  }

  /** Close a pane, terminating its agent ("kill"). Returns `{type:"ok"}` on success. */
  closePane(paneId: string): Promise<unknown> {
    return this.request("pane.close", { pane_id: paneId });
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
