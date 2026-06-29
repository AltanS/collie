// Domain model for the bridge. These are OUR types, decoupled from Herdr's wire shapes
// (which live only in herdr-client.ts). The rest of the app talks in these terms.

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

/**
 * A single pane the user might want to monitor or drive. Usually an agent-bearing pane (the
 * triage home), but also a bare **shell** pane (`kind:"shell"`, `agent:"shell"`) once we surface
 * those so a freshly-created tab/space is reachable and you can launch your own agent in it.
 */
export interface AgentView {
  paneId: string;
  workspaceId: string;
  workspaceLabel: string;
  workspaceNumber: number;
  tabId: string;
  agent: string;
  status: AgentStatus;
  cwd: string;
  focused: boolean;
  /** "agent" for an agent-bearing pane, "shell" for a bare shell. Defaults to "agent" when absent. */
  kind?: "agent" | "shell";
}

/** A Herdr workspace ("space") — a project-scoped container of tabs. From `workspace.list`. */
export interface WorkspaceView {
  workspaceId: string;
  number: number;
  label: string;
  /** Whether this is the focused workspace in the desktop TUI (read-only; we never set focus). */
  focused: boolean;
  activeTabId: string;
  tabCount: number;
  paneCount: number;
}

/** A tab within a workspace (a layout/view holding one or more panes). From `tab.list`. */
export interface TabView {
  tabId: string;
  workspaceId: string;
  number: number;
  label: string;
  focused: boolean;
  paneCount: number;
}

export type BridgeStatus = "connected" | "disconnected";

// ── REST response shapes (the browser polls these; see server.ts) ──────────────

/** GET /api/snapshot — the current herd view. */
export interface SnapshotResponse {
  bridge: BridgeStatus;
  /** Agent-bearing panes, triage-sorted (the home list). */
  agents: AgentView[];
  /** Bare shell panes (no agent) — surfaced so freshly-created tabs/spaces are reachable. */
  shellPanes: AgentView[];
  /** All spaces (workspaces) and their tabs, for the space/tab navigator. */
  workspaces: WorkspaceView[];
  tabs: TabView[];
  ts: number;
}

/** GET /api/pane/:id — recent terminal output for one agent (ANSI/SGR, rendered colored). */
export interface PaneReadResponse {
  paneId: string;
  text: string;
  truncated: boolean;
}

/** POST /api/pane/:id/{reply,keys} — result of a send. `ok:false` means Herdr rejected it. */
export interface ActionResponse {
  ok: boolean;
  error?: string;
}

/** POST /api/pane/:id/upload — image saved to a host file; `path` is the absolute path to ref. */
export interface UploadResponse {
  ok: boolean;
  path?: string;
  error?: string;
}

/**
 * POST /api/tab | /api/workspace — created a new tab/space with a fresh shell. `pane` is that
 * shell, enough for the client to navigate straight into it before the next poll lands.
 */
export interface CreateResponse {
  ok: boolean;
  error?: string;
  pane?: {
    paneId: string;
    workspaceId: string;
    workspaceLabel: string;
    tabId: string;
    cwd: string;
  };
}

/** Rank for triage ordering — lower sorts first ("NEEDS YOU" at the top). */
export const STATUS_RANK: Record<AgentStatus, number> = {
  blocked: 0,
  working: 1,
  unknown: 2,
  idle: 3,
  done: 4,
};
