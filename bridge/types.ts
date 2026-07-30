// Domain model for the bridge. These are OUR types, decoupled from Herdr's wire shapes
// (which live only in herdr-client.ts). The rest of the app talks in these terms.

import type { AgentSessionRef, TranscriptEntry } from "./journal/types.ts";

// Re-exported so the wire surface has ONE import site: a consumer of PaneHistoryResponse gets the
// entry shape from here too, without reaching into an adapter module.
export type { TranscriptEntry, TranscriptPart } from "./journal/types.ts";

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
  /** User-set pane label (herdr `pane.rename`), when one is set; absent when the pane is unlabelled. */
  paneLabel?: string;
  /**
   * Claude's OWN session name, set in-agent via `/rename` and read out of the pane's rendered text
   * (see `extractClaudeSessionName` in state-engine.ts). Claude-only and derived, not a wire field —
   * absent for unnamed sessions and every non-claude pane. Display priority is `paneLabel` first.
   */
  sessionName?: string;
  /**
   * How the agent named its session (Herdr `agent_session`), when it named one at all.
   *
   * SERVER-SIDE ONLY — stripped before this pane goes on the wire (see {@link PaneWire}), because
   * pi reports a kind-`path` ref whose value is an absolute filesystem path, and the client has no
   * use for it: the history endpoint re-derives the ref from the pane id and never trusts a
   * client-supplied one. What the client gets is the presence flag `hasSession`.
   */
  agentSession?: AgentSessionRef;
  /**
   * Upper bound on the lines a `recent` read of this pane can return — Herdr's scrollback depth plus
   * the viewport. This is the ONLY reliable "is there more scrollback" signal: `PaneRead.truncated`
   * is always false even when a read cut history off, which is why the mirror's "Load older" button
   * never used to appear. A pane on the alternate screen (any Claude agent) reports just its viewport
   * here, because the alt screen keeps no scrollback ring at all. Absent on older Herdr servers.
   */
  readableLines?: number;
  /**
   * The pane's tab label, denormalised from `tab.list` exactly as `workspaceLabel` already is — so
   * every client surface (card, sidebar, palette, space view) gets it without joining `tabs[]`.
   * Absent when the label carries no information: an unlabelled tab in a single-tab space is named
   * positionally by Herdr ("1"), which would render as `project · 1`. See `meaningfulTabLabel`.
   */
  tabLabel?: string;
  /**
   * Epoch ms of this agent's last observed status transition (bridge/activity.ts). The only thing
   * that can make a pane read as unseen. Absent until the ledger has an entry, and on the very
   * first poll after a fresh install.
   */
  lastActiveAt?: number;
  /**
   * Epoch ms you last opened or drove this pane through Collie. `lastActiveAt > lastSeenAt` on a
   * `done` agent IS the "finished while you weren't looking" state — there is no stored seen flag.
   */
  lastSeenAt?: number;
}

/**
 * A pane as the BROWSER sees it: every {@link AgentView} field except the session ref, which is
 * replaced by a presence flag.
 *
 * The two shapes differ on purpose. `agentSession.value` is either an opaque id (Claude, Codex) or an
 * absolute path (pi) — the client needs neither, and shipping the path would hand out filesystem
 * layout for nothing. All the UI ever asked of that field was "may this pane have history?", which is
 * what `hasSession` answers, so the History affordance still shows without a speculative fetch.
 *
 * NOTE the `Omit` is opt-OUT: a future server-only field on AgentView goes on the wire unless it is
 * added to the omit list here. If you add one, strip it here in the same change.
 */
export type PaneWire = Omit<AgentView, "agentSession"> & {
  /** True when this pane's history is actually offerable: the agent named a session AND its harness
   *  has a journal adapter. Says nothing about whether the log is readable — a named session whose
   *  file is missing still answers `available:false` with reason `no-log`. */
  hasSession?: boolean;
};

/**
 * Strip a pane down to its wire shape. The one place the session ref leaves the bridge's hands.
 *
 * `hasJournal` is asked rather than assumed: a harness can name a session while having no adapter to
 * read it (Herdr detects more agents than Collie has journals for). Keying the flag on the ref alone
 * would advertise a History affordance that always comes back empty, so the registry gets a vote.
 */
export function toPaneWire(pane: AgentView, hasJournal: (agent: string) => boolean): PaneWire {
  const { agentSession, ...rest } = pane;
  return agentSession && hasJournal(pane.agent) ? { ...rest, hasSession: true } : rest;
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

/**
 * One entry in the snapshot's `sessions` list — a herdr session this bridge fronts. Additive: a
 * single-session deployment reports exactly one (the primary), so nothing about the UI changes.
 */
export interface SessionSummary {
  /** Registry name, e.g. "default" or "collie-demo". Client passes this back as `?session=`. */
  name: string;
  /** The session cfg.socketPath points at — all pre-multi-session behaviour maps to it. */
  isPrimary: boolean;
  /** Whether this session's last poll succeeded (a stale/unreachable socket reads false). */
  reachable: boolean;
  /** Agent-pane count (0 when unreachable). */
  agents: number;
  /** Agent panes currently working / blocked (0 when unreachable). */
  working: number;
  blocked: number;
}

/**
 * Per-device authorisation state for the requesting client (see `deviceAuth()` in server.ts).
 * Reported in the snapshot so the UI can show a read-only state. Optional on the wire so an older
 * bridge (or a response from before the feature existed) simply reads as "not enforced".
 */
export interface DeviceAuth {
  /** Whether per-device authorisation is enforced at all (COLLIE_DEVICE_HEADER is set). */
  enforced: boolean;
  /** The opaque device identifier from the trusted header, or null if absent / feature off. */
  device: string | null;
  /** Whether this device may perform sensitive (terminal-driving / structural) actions. */
  authorized: boolean;
}

// ── REST response shapes (the browser polls these; see server.ts) ──────────────

export interface FirstmateEndpoint {
  session: string;
  paneId: string;
}

export interface FirstmateDecision {
  id: string;
  summary: string;
  owner: string;
  endpoint?: FirstmateEndpoint;
}

export interface FirstmateInFlight {
  id: string;
  kind: string;
  state: string;
  doing: string;
  endpoint?: FirstmateEndpoint;
}

export interface FirstmateGate {
  id: string;
  title: string;
  blockedBy: string;
  reason: string;
  owner: string;
  endpoint?: FirstmateEndpoint;
}

export interface FirstmateLanded {
  id: string;
  what: string;
  owner: string;
}

export type FirstmateChecks = "none" | "pending" | "passing" | "failing" | "unknown";

export interface FirstmatePullRequest {
  number: string;
  repo: string;
  task: string;
  url: string;
  review: string;
  mergeable: string;
  checks: FirstmateChecks;
  endpoint?: FirstmateEndpoint;
}

export type FirstmateUnavailableReason =
  | "not-executable"
  | "timeout"
  | "output-limit"
  | "command-failed"
  | "invalid-output";

interface FirstmateData {
  generatedAt: string;
  inFlight: FirstmateInFlight[];
  decisions: FirstmateDecision[];
  gates: FirstmateGate[];
  landed: FirstmateLanded[];
  prs: FirstmatePullRequest[];
  prState: "disabled" | "loading" | "ready" | "stale" | "unavailable";
  prSummary?: string;
}

export type FirstmateStatus =
  | { state: "loading" }
  | { state: "unavailable"; reason: FirstmateUnavailableReason }
  | ({ state: "ready" | "stale" } & FirstmateData);

/** GET /api/snapshot — the current herd view. */
export interface SnapshotResponse {
  bridge: BridgeStatus;
  /** Per-device authorisation for the requesting client; absent when the feature is off. */
  device?: DeviceAuth;
  /** Semantic Firstmate fleet view; absent when the trusted home is not configured. */
  firstmate?: FirstmateStatus;
  /** Agent-bearing panes, triage-sorted (the home list). */
  agents: PaneWire[];
  /** Bare shell panes (no agent) — surfaced so freshly-created tabs/spaces are reachable. */
  shellPanes: PaneWire[];
  /** All spaces (workspaces) and their tabs, for the space/tab navigator. */
  workspaces: WorkspaceView[];
  tabs: TabView[];
  /**
   * Every herdr session this bridge fronts (primary first, then alphabetical). Always present; a
   * single-session deployment lists just the primary, so the switcher UI can stay hidden.
   */
  sessions: SessionSummary[];
  /** Notification quiet-hours: the active snooze deadline (epoch ms) or null. */
  notifications?: { snoozedUntil: number | null };
  /** Update-availability signal. Optional — a stale bridge that predates the field simply omits it,
   *  which the client reads as "no info" (see bridge/update.ts). */
  update?: UpdateStatus;
  ts: number;
}

/**
 * GET /api/snapshot `update` — whether the running plugin is behind (see bridge/update.ts). Both a
 * newer upstream RELEASE (`releaseAvailable` + `latest`) and a rebuilt-but-not-restarted bridge
 * PROCESS (`bridgeStale`) surface here; the client shows one banner, `bridgeStale` taking precedence.
 */
export interface UpdateStatus {
  /** The running bridge/plugin version, captured at process start. */
  current: string;
  /** Newest upstream release (dotted `X.Y.Z`, no leading `v`), or null if unknown/none yet. */
  latest: string | null;
  /** GitHub release page for `latest` (the banner links to it), or null when `latest` is unknown. */
  latestUrl: string | null;
  /** `latest` is strictly newer than `current`. */
  releaseAvailable: boolean;
  /** The running process is behind the on-disk bridge source — needs `systemctl --user restart collie`. */
  bridgeStale: boolean;
  /** When the upstream check last completed (epoch ms), or null if it hasn't run yet. */
  checkedAt: number | null;
}

/** GET /api/pane/:id — recent terminal output for one agent (ANSI/SGR, rendered colored). */
export interface PaneReadResponse {
  paneId: string;
  text: string;
  truncated: boolean;
  /** Herdr's monotonic pane revision — passed through for the client's prompt-select race guard. */
  revision: number;
}

/**
 * GET /api/pane/:id/history — real conversation history for a pane, read from the agent's own
 * session log. This is NOT terminal scrollback: a Claude pane runs on the alternate screen, so no
 * scrollback exists to page (see transcript.ts). `available:false` is the normal answer for a pane
 * with no agent session, a non-Claude agent, or a bridge with the feature switched off.
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
      /** Turns available in the parsed window. */
      total: number;
      /** The log exceeded the read cap, so only its tail was parsed. */
      fileTruncated: boolean;
    };

/**
 * POST /api/pane/:id/{reply,keys} — result of a send. Discriminated on `ok`: a failure always
 * carries the reason Herdr rejected it. `textDelivered` distinguishes the reply partial-failure case
 * (text was typed but the submit keypress failed) so the client knows NOT to resend — resending would
 * duplicate the already-typed text. Absent/false ⇒ nothing landed, so a resend is safe.
 */
export type ActionResponse =
  | { ok: true }
  | {
      ok: false;
      error: string;
      textDelivered?: boolean;
      code?: "prompt_changed";
    };

/** POST /api/pane/:id/upload — image saved to a host file; `path` is the absolute path to ref. */
export type UploadResponse = { ok: true; path: string } | { ok: false; error: string };

/** A freshly-created shell pane — enough for the client to navigate into before the next poll. */
export interface CreatedPane {
  paneId: string;
  workspaceId: string;
  workspaceLabel: string;
  tabId: string;
  cwd: string;
}

/**
 * POST /api/tab | /api/workspace — created a new tab/space with a fresh shell. On success `pane`
 * is that shell, so the client can navigate straight into it before the next poll lands.
 */
export type CreateResponse = { ok: true; pane: CreatedPane } | { ok: false; error: string };

/** GET /api/config — bridge capabilities and the build id (push setup + stale-cache detection). */
export interface BridgeConfig {
  push: boolean;
  vapidPublicKey: string;
  /** Build id of the bundle the bridge is currently serving (for stale-cache detection). */
  build?: string;
}

/** Rank for triage ordering — lower sorts first ("NEEDS YOU" at the top). */
export const STATUS_RANK: Record<AgentStatus, number> = {
  blocked: 0,
  working: 1,
  unknown: 2,
  idle: 3,
  done: 4,
};
