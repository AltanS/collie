import type { JsonObject } from "../../json.ts";
import type { AgentStatus } from "../../types.ts";
import { dialHerdr, type DialMode, type SockHandle } from "../../dial.ts";
import { decodeReplyLine, decodeStreamLine, type EventData } from "../../wire.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The Herdr socket TRANSPORT. THIS IS THE ONLY FILE that knows Herdr's method
// names and wire shapes; `adapter.ts` next to it is the only file that knows
// these typed methods, and everything above that talks the mux port
// (bridge/mux/types.ts). So a Herdr API change is still a one-file fix.
// Protocol facts are documented in HERDR_API.md.
//
// Key fact: RPC is ONE-SHOT — the server closes the connection after a single
// response. So every request opens a fresh connection, reads one line, closes.
// ─────────────────────────────────────────────────────────────────────────────

/** Raw wire shape of a workspace from `workspace.list`. */
/** The repo a workspace sits in, as Herdr reports it on the workspace record itself. */
export interface WireWorkspaceWorktree {
  repo_root: string;
  repo_name?: string;
  repo_key?: string;
  checkout_path?: string;
  is_linked_worktree?: boolean;
}

export interface WireWorkspace {
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count: number;
  tab_count: number;
  active_tab_id: string;
  agent_status: AgentStatus;
  /** Present when the workspace sits in a Git work tree — probed 2026-08-28 on herdr 0.8.2. */
  worktree?: WireWorkspaceWorktree | null;
}

/**
 * Raw wire shape of a worktree from `worktree.list`.
 *
 * `open_workspace_id` is absent (not null) when nothing shows the checkout — probed 2026-08-28
 * against herdr 0.8.2, where closing the workspace dropped the key entirely.
 */
export interface WireWorktree {
  path: string;
  branch?: string | null;
  label?: string;
  is_linked_worktree: boolean;
  is_prunable: boolean;
  is_bare: boolean;
  is_detached: boolean;
  open_workspace_id?: string | null;
}

/** Raw wire shape of a tab from `tab.list`. */
export interface WireTab {
  tab_id: string;
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count: number;
  agent_status: AgentStatus;
}

/** Raw wire shape of a pane from `pane.list` (and, identically, inside `session.snapshot`). */
export interface WirePane {
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
  /**
   * The pane's OSC title, as the process running in it set it, and Herdr's own attempt at stripping
   * a leading status glyph off it. Both optional: older servers omit them.
   *
   * Carried on the PANE — not only on `session.snapshot`'s `agents[]` — which is why reading it
   * costs nothing architecturally: agents stay derived from `panes`, one code path (see
   * {@link WireSnapshot}).
   *
   * `terminal_title_stripped` is NOT a drop-in for display. Herdr strips the settled `✳` but leaves
   * Claude's rotating spinner frames in place (live-observed in one snapshot: `✳ Read Notes From
   * Underground` stripped, `◐ Custom UI for Collie…` not). Those frames advance on every poll, so a
   * label bound straight to it churns. `meaningfulTerminalTitle` does the strip Collie can rely on.
   */
  terminal_title?: string | null;
  terminal_title_stripped?: string | null;
  revision: number;
  /**
   * The agent's OWN session identity, as the agent reported it to Herdr (herdr ≥ 0.7.2). For Claude
   * this is `{kind:"id", value:"<uuid>"}` — the uuid naming its on-disk session log, which is how
   * Collie serves real conversation history for a pane whose terminal keeps no scrollback (see
   * transcript.ts). Optional + defensively typed: older servers omit it, and `kind` may be something
   * other than "id" for other agents.
   */
  agent_session?: {
    source?: string;
    agent?: string;
    kind?: string;
    value?: string;
  } | null;
  /**
   * Scroll geometry (herdr ≥ 0.7.2); optional so older servers that omit it still typecheck.
   *
   * `max_offset_from_bottom` is how far the pane can scroll UP — the depth of its scrollback ring —
   * so `max_offset_from_bottom + viewport_rows` is the line count a `pane.read source:"recent"` can
   * return. Live-verified on a sandbox pane (2026-07-26): 95+31 → 127 lines read, 498+31 → 530 (the
   * +1 is the trailing newline). Exact once scrollback exists; an OVER-estimate on a near-empty
   * screen, where trailing blank rows are trimmed from the read (0+31 → 4 lines read).
   *
   * This is the only trustworthy "is there more to load" signal Herdr gives us — `PaneRead.truncated`
   * is ALWAYS false, even when a read demonstrably cut scrollback off (200 requested of 6895
   * available still reports `truncated: false`). Gate on this, never on `truncated`.
   */
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

// Wire names are snake_case: `recent-unwrapped` is REJECTED by the server (`unknown variant`,
// live-probed 2026-08-03, herdr 0.7.5). Nothing called it before that probe, so the kebab spelling
// this type carried since day one was never caught. `detection` also exists (listed by the server's
// own error message); semantics unverified, so it stays out of the union until something needs it.
type ReadSource = "visible" | "recent" | "recent_unwrapped";
type ReadFormat = "text" | "ansi";

/**
 * A pane's `agent_session`, accepted only when it is a usable session ref.
 *
 * Parsed HERE because this file is the wire boundary — everything downstream branches on the domain
 * value instead of re-narrowing the raw record. `agent` is carried through so the caller can check
 * the ref still belongs to the agent currently in the pane; it is `undefined` both when the server
 * omits it and when it is empty, which is the "stay permissive with older servers" case.
 */
export type PaneAgentSession = { kind: "id" | "path"; value: string; agent?: string };

/** {@link PaneAgentSession} off a raw pane record, or null when the record can't produce one. */
export function paneAgentSession(raw: WirePane["agent_session"]): PaneAgentSession | null {
  if (raw === null || raw === undefined) return null;
  if (raw.kind !== "id" && raw.kind !== "path") return null;
  if (typeof raw.value !== "string" || raw.value === "") return null;
  const agent = typeof raw.agent === "string" && raw.agent !== "" ? raw.agent : undefined;
  return { kind: raw.kind, value: raw.value, agent };
}

/** Wire params of `tab.create`. `focus` is always false — never yank the desktop TUI's focus. */
type TabCreateParams = { workspace_id: string; focus: false; label?: string; cwd?: string };

/** Wire params of `workspace.create`. */
type WorkspaceCreateParams = { cwd: string; focus: false; label?: string };

/** What {@link HerdrClient.subscribeEvents} is asked for. */
export type SubscribeOptions = {
  subscriptions: Array<{ type: string; pane_id?: string }>;
  onUp: () => void;
  onEvent: (event: string, data: EventData) => void;
  onDown: (reason: string) => void;
};

/** The handle {@link HerdrClient.subscribeEvents} hands back. `close()` is idempotent. */
export type EventStream = { close(): void };

/**
 * The RPCs the adapter next door actually calls — the shape it depends on, rather than this class.
 *
 * Written as a `Pick` of {@link HerdrClient} so it cannot drift from the real transport: a method
 * renamed here stops compiling, and nothing can be added to the port's surface without being added
 * to the client too. The real client is what the bridge constructs (`herdrMuxFactory`); a fake of
 * this shape is what the conformance fixture drives, which is how the reference adapter is proved
 * with no Herdr on the box (M10/03). The same narrowing `server.ts` already does for the reply path.
 */
export type HerdrRpc = Pick<
  HerdrClient,
  | "ping"
  | "sessionSnapshot"
  | "listWorkspaces"
  | "listPanes"
  | "listTabs"
  | "readPane"
  | "sendPaneText"
  | "sendPaneKeys"
  | "renamePane"
  | "closePane"
  | "focusPane"
  | "createTab"
  | "renameTab"
  | "closeTab"
  | "createWorkspace"
  | "listWorktrees"
  | "createWorktree"
  | "openWorktree"
  | "removeWorktree"
  | "subscribeEvents"
>;

let idCounter = 0;

/** Per-request wall-clock budget. Exported so callers can pass it explicitly alongside a dial mode. */
export const DEFAULT_TIMEOUT_MS = 5000;

export class HerdrClient {
  constructor(
    private readonly socketPath: string,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
    /** Which dialer to use; see {@link DialMode}. `auto` picks by platform. */
    private readonly dialMode: DialMode = "auto",
  ) {}

  /** One request, one reply, one connection. Rejects on error reply, timeout, or early close. */
  private request<T>(method: string, params: JsonObject = {}): Promise<T> {
    const id = `b${++idCounter}`;
    return new Promise<T>((resolve, reject) => {
      let buf = "";
      let settled = false;
      // The live socket, once the dial opens one. Hoisted so EVERY terminal path (timeout
      // included) can close it — otherwise a timeout leaves the FD dangling.
      let socket: SockHandle | null = null;
      // Aborts a dial that is still connecting — a timeout that fires mid-connect has no socket
      // to end() yet, and without this the pending OS handle lives until the connect settles.
      let cancelDial: (() => void) | null = null;
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
        } else if (cancelDial) {
          // Timed out (or failed) while still connecting — abort the in-flight dial.
          try {
            cancelDial();
          } catch {
            /* ignore */
          }
        }
        cancelDial = null;
      };
      const timer = setTimeout(
        () => finish(() => reject(new Error(`herdr ${method}: timed out after ${this.timeoutMs}ms`))),
        this.timeoutMs,
      );

      const dialed = dialHerdr(this.socketPath, {
        onDial(cancel) {
          cancelDial = cancel;
        },
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
              reject(e);
            }
          });
        },
        error(_s, err) {
          finish(() => reject(err));
        },
        close() {
          finish(() => reject(new Error(`herdr ${method}: connection closed before reply`)));
        },
      }, this.dialMode);

      // One catch for BOTH the dial failing and anything the post-connect block throws — the
      // `.then(…).catch(…)` this replaces funnelled them to the same `finish(reject)`.
      void (async () => {
        try {
          const s = await dialed;
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
          // A long request (a big paste, a wide pane's text) can exceed what the socket accepts in
          // one go; the dialer owns that continuation, so there is nothing to retry here (dial.ts,
          // write-drain.ts). A connection that dies mid-write lands in close/error above and
          // rejects like any other transport failure.
          s.write(JSON.stringify({ id, method, params }) + "\n");
          s.flush();
        } catch (err) {
          finish(() => reject(err));
        }
      })();
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
  subscribeEvents(opts: SubscribeOptions): EventStream {
    const id = `es${++idCounter}`;
    const decoder = new TextDecoder("utf-8");
    let buf = "";
    let socket: SockHandle | null = null;
    let cancelDial: (() => void) | null = null;
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
      } else if (cancelDial) {
        // Ack timeout (or close()) while the dial was still connecting — abort it so repeated
        // reconnect attempts can't stack pending OS handles.
        try {
          cancelDial();
        } catch {
          /* ignore */
        }
      }
      cancelDial = null;
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
        fireDown(`protocol error: ${e instanceof Error ? e.message : String(e)}`);
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

    const dialed = dialHerdr(this.socketPath, {
      onDial(cancel) {
        cancelDial = cancel;
      },
      open(s) {
        socket = s;
      },
      // Multiple lines can arrive per chunk (bursty events); drain ALL complete lines and keep the
      // stream open. Stream-decode so a multi-byte codepoint split across chunks isn't corrupted.
      data(s, chunk) {
        socket = s;
        buf += decoder.decode(chunk, { stream: true });
        let nl = buf.indexOf("\n");
        while (nl >= 0) {
          if (down) break;
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
    }, this.dialMode);

    // One catch for BOTH the dial failing and anything the post-connect block throws — the
    // `.then(…).catch(…)` this replaces funnelled them to the same `fireDown`.
    void (async () => {
      try {
        const s = await dialed;
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
      } catch (err) {
        fireDown((err instanceof Error ? err.message : String(err)) || "connect failed");
      }
    })();

    return { close: () => fireDown("closed") };
  }

  /**
   * Create a new tab in a workspace, opening a fresh shell pane. `cwd` is optional — omitted, the
   * tab inherits the workspace's directory (verified). `focus:false` so we never yank the desktop
   * TUI's focus. Returns the new shell pane to navigate into.
   */
  async createTab(workspaceId: string, opts: { label?: string; cwd?: string } = {}): Promise<CreatedShell> {
    // Optional keys are ASSIGNED, not spread — an empty-string label must stay omitted (herdr
    // stores "" literally), which a `label: opts.label` field would not do.
    const params: TabCreateParams = { workspace_id: workspaceId, focus: false };
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
    // See createTab: an empty label stays omitted.
    const params: WorkspaceCreateParams = { cwd: opts.cwd, focus: false };
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

  /**
   * The worktrees of the repo at `cwd` — including the repo's own checkout, which comes back with
   * `is_linked_worktree: false`.
   *
   * Takes a PATH, not a workspace: probed 2026-08-28 against herdr 0.8.2, `worktree.list --cwd`
   * answers for a repo nothing has open, which is what lets the sheet list a worktree before there
   * is any space to name it by.
   */
  async listWorktrees(cwd: string): Promise<WireWorktree[]> {
    const r = await this.request<{ worktrees: WireWorktree[] }>("worktree.list", { cwd });
    return r.worktrees;
  }

  /**
   * Create a worktree on a new branch and open it as its own workspace. `focus:false`, so the
   * operator's own screen stays where they left it (the phone navigates itself).
   *
   * NOT ATOMIC, and the caller must know: probed 2026-08-28 against herdr 0.8.2 in a session with no
   * window server, the checkout was created and the OPEN failed with `worktree_open_failed` — the
   * branch exists, nothing shows it. A retry then fails as `worktree_create_failed` (the path is
   * taken), so the recovery is to open it, never to create it again.
   */
  async createWorktree(opts: { cwd: string; branch: string }): Promise<CreatedShell> {
    const r = await this.request<{ workspace: WireWorkspace; root_pane: WirePane }>(
      "worktree.create",
      { cwd: opts.cwd, branch: opts.branch, focus: false },
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

  /**
   * Show a worktree that already exists on disk, by its checkout path.
   *
   * `cwd` (the repo) is required alongside it: probed 2026-08-28, `worktree.open` with `path` alone
   * answers `not_git_worktree`. A worktree already open answers `already_open: true` with the space
   * showing it — an answer, not a refusal.
   */
  async openWorktree(opts: {
    cwd: string;
    path: string;
  }): Promise<{ shell: CreatedShell; alreadyOpen: boolean }> {
    const r = await this.request<{
      workspace: WireWorkspace;
      root_pane: WirePane;
      already_open?: boolean;
    }>("worktree.open", { cwd: opts.cwd, path: opts.path, focus: false });
    const p = r.root_pane;
    return {
      shell: {
        paneId: p.pane_id,
        workspaceId: p.workspace_id,
        workspaceLabel: r.workspace.label,
        tabId: p.tab_id,
        cwd: p.cwd,
      },
      alreadyOpen: r.already_open === true,
    };
  }

  /**
   * Remove the worktree a workspace is showing, closing the workspace with it.
   *
   * Addressed by WORKSPACE — herdr has no path-addressed removal, so a checkout nothing shows
   * cannot be removed through the socket at all. `force:false` refuses a dirty checkout with
   * `dirty_worktree_requires_force` (probed 2026-08-28); `forced` in the reply reports what
   * actually happened.
   */
  async removeWorktree(opts: {
    workspaceId: string;
    force: boolean;
  }): Promise<{ path: string; forced: boolean }> {
    const r = await this.request<{ path: string; forced?: boolean }>("worktree.remove", {
      workspace_id: opts.workspaceId,
      force: opts.force,
    });
    return { path: r.path, forced: r.forced === true };
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
   * Put a pane in front of the operator, on their own screen.
   *
   * ONE call does the whole act: live-probed 2026-08-25 against the `collie-demo` sandbox session,
   * `pane.focus {pane_id}` answered `pane_info` and the next `session.snapshot` reported
   * `focused_pane_id`, `focused_tab_id` AND `focused_workspace_id` all moved with it — so the tab and
   * the workspace need no calls of their own (`tab.focus` / `workspace.focus` exist and are not used).
   * A pane that has gone away answers `pane_not_found`, probed read-only against the live server the
   * same day, which the adapter's `GONE_CODES` turns into the contract's `gone`.
   */
  focusPane(paneId: string): Promise<void> {
    return this.request<void>("pane.focus", { pane_id: paneId });
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
