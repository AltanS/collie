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
  /**
   * Claude's OWN session name (set in-agent via `/rename`), derived bridge-side from the pane text.
   * Claude-only; absent for unnamed sessions and non-claude panes. Shown below an explicit `paneLabel`
   * — see {@link paneDisplayName}. Render as text only (never markup) — same XSS boundary as paneLabel.
   */
  sessionName?: string;
  /**
   * True when the agent named a session, so a journal may exist for this pane — what the History
   * affordance keys off, without a speculative fetch.
   *
   * A FLAG, not the session itself: the bridge keeps the reference server-side and re-derives it from
   * the pane id on every history request, because for some harnesses (pi) that reference is an
   * absolute filesystem path. It never accepts one from the client. "May exist" is the honest
   * reading — an agent can name a session whose log isn't readable, which the history endpoint
   * answers with `available:false, reason:"no-log"`.
   */
  hasSession?: boolean;
  /**
   * Upper bound on the lines a pane read can return (Herdr's scrollback depth + viewport). The only
   * reliable "is there more scrollback" signal — `PaneReadResponse.truncated` is always false even
   * when history was cut off, which is why "Load older" never used to render. A Claude pane reports
   * just its viewport, because the alternate screen it runs on keeps no scrollback. Absent on older
   * bridges/Herdr, which reads as "unknown" (the button then falls back to hidden).
   */
  readableLines?: number;
  /**
   * The pane's tab label, denormalised bridge-side alongside `workspaceLabel`. Absent when it says
   * nothing: Herdr names an unlabelled tab positionally ("1"), which in a single-tab space would
   * render as `project · 1` (see `meaningfulTabLabel` in bridge/activity.ts). Render as text only,
   * never markup — same XSS boundary as `paneLabel`.
   */
  tabLabel?: string;
  /**
   * What the pane's process says it is doing — its OSC title, glyph-stripped and dropped when
   * uninformative bridge-side (see `meaningfulTerminalTitle` in bridge/activity.ts). Unlike
   * `paneLabel` and `sessionName`, which are set once by hand, this follows the work as it moves.
   * Render as text only, never markup — same XSS boundary as `paneLabel`.
   */
  terminalTitle?: string;
  /**
   * Epoch ms of this agent's last status transition, as the bridge observed it. Absent on an older
   * bridge — which is exactly why triage degrades cleanly; see `triage()`.
   */
  lastActiveAt?: number;
  /**
   * Epoch ms you last opened or drove this pane through Collie. Absent as above.
   *
   * There is no "seen" flag anywhere: a `done` agent is unseen precisely when
   * `lastActiveAt > lastSeenAt`, so opening the pane clears it by construction.
   */
  lastSeenAt?: number;
}

/**
 * The name to show for a pane, in priority order: an explicit user label (herdr `pane.rename`) wins,
 * then Claude's own `/rename` session name, then the pane's terminal title, then the agent name (or
 * "shell"). The two hand-set names outrank the title because a name you chose should not be
 * overwritten by one the process is rewriting every turn; the title outranks the agent name because
 * "claude" tells you nothing when four rows say it. All three are rendered only as React text nodes
 * by callers — never markup — so they stay within the pane-output XSS boundary.
 */
export function paneDisplayName(pane: AgentView): string {
  if (pane.paneLabel) return pane.paneLabel;
  if (pane.sessionName) return pane.sessionName;
  if (pane.terminalTitle) return pane.terminalTitle;
  return pane.kind === "shell" ? "shell" : pane.agent;
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
  /** Voice input capability only. Provider URL, model, key and errors never leave the bridge. */
  transcriptionEnabled?: boolean;
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

/**
 * One renderable piece of a transcript turn. Mirrors `bridge/transcript.ts` (wire types are
 * hand-mirrored across the two sides, as with every other response here).
 */
export type TranscriptPart =
  | { kind: "text"; text: string; truncated?: boolean }
  | { kind: "thinking"; text: string; truncated?: boolean }
  | {
      kind: "tool";
      name: string;
      summary: string;
      result?: { text: string; truncated?: boolean; isError?: boolean };
    };

/**
 * One turn. `user`/`assistant` are speech; the other two are not, and render set apart so they can't
 * be mistaken for it — `summary` is Claude's own compaction summary, `note` is machine-injected
 * content that still belongs on screen (a background task finishing, a local command's output).
 */
export interface TranscriptEntry {
  uuid: string;
  ts: string;
  role: "user" | "assistant" | "summary" | "note";
  parts: TranscriptPart[];
}

/**
 * GET /api/pane/:id/history — real conversation history, read from the agent's own session log.
 *
 * This is NOT terminal scrollback and can't be: a Claude pane runs on the terminal's alternate
 * screen, which keeps no scrollback ring, so Herdr only ever holds the visible viewport. `available:
 * false` is an ordinary answer (a shell pane, a harness with no session log, or the feature off) —
 * the UI hides the History affordance rather than showing an error.
 */
export type PaneHistoryResponse =
  | { paneId: string; available: false; reason: "disabled" | "no-session" | "no-log" }
  | {
      paneId: string;
      available: true;
      /** Oldest-first, ready to render top-down. */
      entries: TranscriptEntry[];
      /** Older turns exist before `entries[0]` — page with `?before=<its uuid>`. */
      hasMore: boolean;
      total: number;
      fileTruncated: boolean;
    };

export type ActionResponse =
  | { ok: true }
  | {
      ok: false;
      error: string;
      textDelivered?: boolean;
      code?: "prompt_changed";
    };

export type UploadResponse = { ok: true; path: string } | { ok: false; error: string };

/** A successful voice response becomes editable text for review; non-2xx bridge failures throw. */
export type TranscriptionResponse = { ok: true; text: string };

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
