// Frontend mirror of the bridge's domain model (bridge/types.ts). Kept as a small, deliberate
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
  /** User-set pane label (herdr `pane.rename`), when one is set; absent when the pane is unlabelled. */
  paneLabel?: string;
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

/**
 * Per-device authorisation for this client (mirrors DeviceAuth in bridge/types.ts). Present in the
 * snapshot only when the feature is enabled on the bridge; absent = not enforced.
 */
export interface DeviceAuth {
  /** Whether per-device authorisation is enforced at all. */
  enforced: boolean;
  /** The opaque device identifier from the trusted header, or null if absent / feature off. */
  device: string | null;
  /** Whether this device may perform sensitive (terminal-driving / structural) actions. */
  authorized: boolean;
}

/**
 * True when device auth is enforced and this device is NOT authorised — i.e. the UI should drop to
 * read-only. False when the feature is off, the device is allowlisted, or the state isn't known yet.
 */
export function isReadOnly(device: DeviceAuth | undefined): boolean {
  return !!device && device.enforced && !device.authorized;
}

/**
 * One entry in the snapshot's session registry — a named Herdr session the bridge is fanning out.
 * Order is primary-first, then alphabetical. An unreachable session (crashed / stale socket) reports
 * `reachable: false` with zeroed counts and renders greyed-out, non-clickable in the switcher.
 */
export interface SessionSummary {
  /** Registry name, e.g. "default", "collie-demo". */
  name: string;
  /** The `cfg.socketPath` session — all no-`?s=` requests map to it. */
  isPrimary: boolean;
  /** Whether the last poll of this session's socket succeeded. */
  reachable: boolean;
  /** Agent-pane count (0 when unreachable). */
  agents: number;
  working: number;
  blocked: number;
}

/**
 * Version / upgrade status for the running Collie (mirrors UpdateInfo in bridge/types.ts). Optional
 * on the snapshot — an older bridge omits it entirely, which the client treats as "no info" (the
 * update banner renders nothing). `latest` is null when the newest upstream release isn't known.
 */
export interface UpdateInfo {
  /** The version this bridge is running, e.g. "0.11.0". */
  current: string;
  /** Newest upstream release, e.g. "0.12.0", or null when unknown. */
  latest: string | null;
  /** GitHub release page for `latest` (the banner links to it), or null when `latest` is unknown. */
  latestUrl: string | null;
  /** A newer release than `current` exists upstream — the update action will fetch it. */
  releaseAvailable: boolean;
  /** The running bridge PROCESS is behind the on-disk code — a `systemctl restart` picks it up. */
  bridgeStale: boolean;
  /** When the upstream check last ran (epoch ms), or null if it hasn't. */
  checkedAt: number | null;
}

export interface SnapshotResponse {
  bridge: BridgeStatus;
  /** Per-device authorisation for the requesting client; absent when the feature is off. */
  device?: DeviceAuth;
  agents: AgentView[];
  shellPanes: AgentView[];
  workspaces: WorkspaceView[];
  tabs: TabView[];
  /** Notification quiet-hours: the active snooze deadline (epoch ms) or null. Absent on older bridges. */
  notifications?: { snoozedUntil: number | null };
  /** The bridge's session registry (primary-first). Absent on a single-session / older bridge. */
  sessions?: SessionSummary[];
  /** Version / upgrade status. Absent on an older bridge that doesn't report it. */
  update?: UpdateInfo;
  ts: number;
}

export interface PaneReadResponse {
  paneId: string;
  text: string;
  truncated: boolean;
  /** Herdr's monotonic pane revision — the prompt-select race guard checks a tapped menu against it. */
  revision: number;
  /** Set to true by the client when the server returns 304 Not Modified. Never sent over the wire. */
  notModified?: boolean;
}

export type ActionResponse =
  | { ok: true }
  | { ok: false; error: string; textDelivered?: boolean };

export type UploadResponse = { ok: true; path: string } | { ok: false; error: string };

/** A freshly-created shell pane — enough to navigate into before the next poll lands. */
export interface CreatedPane {
  paneId: string;
  workspaceId: string;
  workspaceLabel: string;
  tabId: string;
  cwd: string;
}

/** Result of creating a new tab/space — on success `pane` is the fresh shell to navigate into. */
export type CreateResponse = { ok: true; pane: CreatedPane } | { ok: false; error: string };

export interface BridgeConfig {
  push: boolean;
  vapidPublicKey: string;
  /** Build id of the bundle the bridge is currently serving (for stale-cache detection). */
  build?: string;
}

/**
 * Notification type preferences (GET/POST /api/notifications/prefs). Which agent statuses push, set
 * bridge-wide (fans out to every device, like the snooze). Mirrors NotifyPrefs in bridge/notify-prefs.ts.
 */
export interface NotifyPrefs {
  /** Push when an agent becomes blocked (waiting on your input). Default on. */
  blocked: boolean;
  /** Push when an agent finishes its task. Default off. */
  done: boolean;
  /** Push when a new Collie version is available (a restart or upgrade is waiting). Default on. */
  updates: boolean;
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
