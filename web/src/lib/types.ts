// Frontend mirror of the bridge's domain model (src/types.ts). Kept as a small, deliberate
// duplicate so the web app builds independently of the Bun server's source tree.

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

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
  /** "agent" for an agent-bearing pane, "shell" for a bare shell. Absent = "agent". */
  kind?: "agent" | "shell";
}

/** A Herdr workspace ("space") — a project-scoped container of tabs. */
export interface WorkspaceView {
  workspaceId: string;
  number: number;
  label: string;
  focused: boolean;
  activeTabId: string;
  tabCount: number;
  paneCount: number;
}

/** A tab within a workspace (holds one or more panes). */
export interface TabView {
  tabId: string;
  workspaceId: string;
  number: number;
  label: string;
  focused: boolean;
  paneCount: number;
}

export type BridgeStatus = "connected" | "disconnected";

export interface SnapshotResponse {
  bridge: BridgeStatus;
  agents: AgentView[];
  shellPanes: AgentView[];
  workspaces: WorkspaceView[];
  tabs: TabView[];
  ts: number;
}

export interface PaneReadResponse {
  paneId: string;
  text: string;
  truncated: boolean;
}

export interface ActionResponse {
  ok: boolean;
  error?: string;
}

export interface UploadResponse {
  ok: boolean;
  path?: string;
  error?: string;
}

/** Result of creating a new tab/space — `pane` is the fresh shell to navigate into. */
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

export interface BridgeConfig {
  push: boolean;
  vapidPublicKey: string;
}

/** Lower sorts first — "needs you" at the top. Mirrors STATUS_RANK on the server. */
export const STATUS_RANK: Record<AgentStatus, number> = {
  blocked: 0,
  working: 1,
  unknown: 2,
  idle: 3,
  done: 4,
};

export const STATUS_LABEL: Record<AgentStatus, string> = {
  blocked: "needs you",
  working: "working",
  idle: "idle",
  done: "done",
  unknown: "unknown",
};
