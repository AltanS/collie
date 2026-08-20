// Domain model for the bridge. These are OUR types, decoupled from Herdr's wire shapes
// (which live only in mux/herdr/client.ts). The rest of the app talks in these terms.

import type { AgentSessionRef, TranscriptEntry } from "./journal/types.ts";
import type { MuxCapability } from "./mux/capabilities.ts";

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
   * What the pane's own process says it is doing — its OSC title, glyph-stripped and dropped when
   * uninformative (see `meaningfulTerminalTitle`). Claude rewrites this per turn, so unlike
   * `paneLabel` and `sessionName` — both set once, by hand — it tracks the work as it moves, which
   * is what tells several agents in ONE project apart in the herd list.
   *
   * Absent when the title says nothing, and on Herdr servers too old to report it.
   */
  terminalTitle?: string;
  /**
   * A finished English sentence about this pane, composed in the bridge and rendered as text the
   * client does not interpret. Absent on almost every pane.
   *
   * PRESENTATION AND NOTHING ELSE. It never carries a harness name or a multiplexer name, it never
   * implies the pane's `agent` or `status`, and no control may be armed, hidden or shown by it. The
   * module that composes it sits beside the mux decorator and is the only thing that writes one.
   */
  hint?: string;
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
  /**
   * Which member of the pack this pane lives on — the `?h=` value completing the `(host, session,
   * paneId)` address (PACK_PROTOCOL.md §4). Present exactly when {@link SnapshotResponse.servers}
   * is; absent on every solo snapshot (§11). Pane ids are only unique per machine, which is why a
   * merged list must carry this and why the phone's per-pane cache keys on it.
   */
  host?: string;
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
  /**
   * Which member of the pack fronts this session — the `?h=` value (PACK_PROTOCOL.md §4).
   *
   * **Present exactly when {@link SnapshotResponse.servers} is**, and absent otherwise. A solo
   * instance emits neither (§11: "no `host` field is added to sessions or panes"), so a session name
   * on a solo snapshot means what it has always meant. The lead stamps this from the registry key it
   * dialled; a peer never asserts its own (see `parsePeerSnapshot`).
   */
  host?: string;
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

/** GET /api/snapshot — the current herd view. */
export interface SnapshotResponse {
  bridge: BridgeStatus;
  /** Per-device authorisation for the requesting client; absent when the feature is off. */
  device?: DeviceAuth;
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
  /**
   * Every member of the pack, the lead's own entry included (PACK_PROTOCOL.md §9.2).
   *
   * **Optional-and-absent, following `update?` rather than the always-present `sessions`** — and the
   * choice is forced, not stylistic (§11). An always-present field, even an empty array, changes
   * every solo snapshot body and therefore every solo snapshot ETag exactly once: one forced refetch
   * for every solo user, bought for a uniformity nothing needs. Absent means "no pack", which is
   * precisely true. Present ⇒ `host` is stamped on every session and every pane; absent ⇒ on none.
   */
  servers?: ServerSummary[];
  /** Notification quiet-hours: the active snooze deadline (epoch ms) or null. */
  notifications?: { snoozedUntil: number | null };
  /** Update-availability signal. Optional — a stale bridge that predates the field simply omits it,
   *  which the client reads as "no info" (see bridge/update.ts). */
  update?: UpdateStatus;
  ts: number;
}

/**
 * One member of the pack in the merged snapshot (PACK_PROTOCOL.md §9.2) — the row `pack status` and
 * the phone's host list render.
 *
 * `reachable` is not an invention: {@link SessionSummary.reachable} already models an unreachable
 * member as a *rendered state* with zeroed counts rather than a failed response. This is that
 * precedent one level up — a down peer degrades its entry, never the response (§10.2).
 */
export interface ServerSummary {
  /** Member id — the `?h=` value. The lead's own entry is present too. */
  id: string;
  /** Operator-chosen label. Today the member id itself, which is the `join` label slugified (§8.2). */
  name: string;
  isLead: boolean;
  /** Whether the lead's last poll of this member succeeded. Always true for the lead's own entry. */
  reachable: boolean;
  /** Version negotiation state (§7). `incompatible` is retried on a slow backoff, not the cadence. */
  protocol: "ok" | "incompatible" | "unknown";
  /** The peer's refusal reason, verbatim, when incompatible. */
  protocolDetail?: string;
  /**
   * Epoch ms, **stamped by the lead on receipt — never the peer's clock** (§10.2). The client
   * derives "stale since …" from it (stale once older than 3 × pollMs or 15 s, whichever is first);
   * `0` means this member has never answered.
   */
  lastSeenAt: number;
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
  /**
   * Newest release of a major ABOVE the running one (dotted `X.Y.Z`), or null. Reported apart from
   * `latest` because a routine `update` never crosses a major — the crossing is consented to by
   * `update --major` (ADR 0020), and the banner names that command instead.
   */
  majorAvailable: string | null;
  /** GitHub release page for `majorAvailable`, or null when there is none. */
  majorUrl: string | null;
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

/**
 * Which role this collie plays in a pack (PACK_PROTOCOL.md §3). `solo` is a lead with zero peers —
 * today's Collie, exactly — and is the only mode that needs no configuration whatsoever.
 */
export type PackMode = "solo" | "lead" | "peer";

/**
 * One operator-declared slash command (a `[[commands]]` row in their `commands.toml`). A pane any of
 * these rows address shows them INSTEAD of the shipped Agent-commands catalog; a pane none of them
 * address keeps it (ADR 0018). This is the escape hatch for commands the shipped catalog cannot know
 * about — plugin- or user-registered ones like omp's `/fork-in-herdr` — which exist only on THIS
 * operator's machine and so must never be hard-coded into `web/src/lib/agent-commands.ts`.
 */
export interface OperatorCommand {
  /** Herdr agent name this applies to, lowercased. Omitted = every agent. */
  agent?: string;
  /** Includes the leading slash. */
  command: string;
  /** One-line description shown in the palette (also searched). */
  description: string;
  /** True when tapping should insert `/cmd ` into the composer instead of submitting it. */
  takesArg: boolean;
  /** Placeholder shown after insert, e.g. `<name>`. Empty when {@link takesArg} is false. */
  argHint: string;
  /**
   * The operator marking their own row dangerous — it then gets the same two-tap confirmation a
   * shipped dangerous command gets. Only ever ADDS: a row naming a shipped command inherits that
   * command's confirm regardless (rule 3 in agent-commands.ts), and `false` cannot lift it.
   */
  confirm: boolean;
}

/**
 * One operator-declared Keys-tray preset (a `[[keys]]` row in their `keys.toml`). A pane any of
 * these rows address shows them INSTEAD of the shipped Ctrl presets; a pane none of them address
 * keeps the shipped ones (ADR 0018, the same rule `commands.toml` follows). Only the PRESETS are
 * configurable — the tray's keyboard (Esc/arrows/Enter/Tab/Space, modifiers, digits, F1–F12) is
 * fixed.
 */
export interface OperatorKeyRow {
  /** Herdr agent name this applies to, lowercased. Omitted = every agent. */
  agent?: string;
  /** The button's text, and its identity within one scope. */
  label: string;
  /**
   * The chords to send, already normalised to Herdr's `pane.send_keys` spelling. More than one is
   * sent as ONE batch, in order — the same call a composed key queue makes.
   */
  keys: string[];
  /** The operator putting their own row behind the tray's existing two-tap confirm. */
  danger: boolean;
}

/**
 * What the phone is told about the multiplexer underneath — the config surface's half of M10/06.
 *
 * THE UI READS `capabilities`, NEVER `name`. `name` rides so the app can SAY which multiplexer it is
 * (a support question, and the subject of a sentence like "zellij keeps no agent session log") and
 * for nothing else: a component that branches on it has re-welded Collie to one multiplexer, which
 * is the whole thing this milestone exists to undo. `scripts/check-mux-names.sh` enforces that.
 *
 * `capabilities` is TOTAL — every capability answered true or false, the same shape the adapter
 * declares (bridge/mux/capabilities.ts). Total rather than a list of the supported ones so a client
 * that knows a capability this bridge has never heard of can tell "absent" from "not answered": an
 * unanswered capability reads as CAPABLE on the phone, because the alternative is a mid-upgrade
 * Herdr operator watching controls vanish for the length of a page cache.
 */
export interface MuxConfig {
  /** Registry name of the multiplexer. For display and support, never a branch. */
  name: string;
  /** Every capability, answered. Mirrors the adapter's own declaration. */
  capabilities: Record<MuxCapability, boolean>;
  /** Neutral key spellings (bridge/mux/keys.ts) this multiplexer refuses, canonicalised. */
  unsupportedKeys: string[];
  /**
   * The adapter's own operator-facing reason, for the capabilities it does NOT have.
   *
   * Only the absent ones: a note explaining a capability the adapter HAS is developer
   * documentation, and the phone has nothing to render it on. This is where an explanation's words
   * come from — the adapter wrote them, they name the multiplexer, and they never blame Collie.
   */
  notes: Partial<Record<MuxCapability, string>>;
  /**
   * Where this multiplexer's mark is served — {@link MUX_LOGO_PATH}, or absent.
   *
   * A URL and not the SVG source: the bytes are cacheable, revalidated by ETag, and never touch the
   * JSON every page load re-reads. Present ONLY when the active adapter supplied a logo
   * (bridge/mux/types.ts `MuxAdapter.logo`) — absent means "this bridge has no picture for you",
   * which the header answers by rendering exactly the text it always did.
   */
  logoUrl?: string;
}

/**
 * The one path the mark is served from, spelled once.
 *
 * A CONSTANT rather than a literal at each end, because the bridge both routes it and publishes it
 * in {@link MuxConfig.logoUrl}; two spellings of one path is one release away from a broken image.
 * It is deliberately not per-multiplexer — a collie drives exactly one, so the path names the
 * question ("this bridge's mux") and the answer changes with the bridge, never with the URL.
 */
export const MUX_LOGO_PATH = "/api/mux/logo.svg";

/** GET /api/config — bridge capabilities and the build id (push setup + stale-cache detection). */
export interface BridgeConfig {
  push: boolean;
  vapidPublicKey: string;
  /** Build id of the bundle the bridge is currently serving (for stale-cache detection). */
  build?: string;
  /**
   * This collie's pack mode, so `pack status` and the UI can render it without probing behaviour.
   * **Omitted when the mode is `solo`** — absent means "no pack", which is precisely true, and keeps
   * a solo `/api/config` body byte-identical to today's (the `servers` reasoning, PACK_PROTOCOL.md
   * §11). Read it as `mode ?? "solo"`.
   */
  mode?: PackMode;
  /** The operator's own palette rows. Absent/empty when there is no `commands.toml`. */
  operatorCommands?: OperatorCommand[];
  /** The operator's own Keys-tray presets. Absent/empty when there is no `keys.toml`. */
  operatorKeys?: OperatorKeyRow[];
  /**
   * The multiplexer this collie drives, and what it can do. Absent only on a bridge older than
   * M10/06 — which a client reads as "every capability present", i.e. exactly today's Herdr app.
   */
  mux?: MuxConfig;
}

/** Rank for triage ordering — lower sorts first ("NEEDS YOU" at the top). */
export const STATUS_RANK = {
  blocked: 0,
  working: 1,
  unknown: 2,
  idle: 3,
  done: 4,
} satisfies Record<AgentStatus, number>;
